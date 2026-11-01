import {
  breakDown,
  DEFAULT_ROUTING_RULES,
  type DiscussionLlm,
  EMPTY_REGISTRY,
  type Language,
  modelKey,
  PATH_STAGES,
  planTotals,
  routeTask,
  type StrategyContext,
} from "@km0/core";
import {
  type AgentConfig,
  AppError,
  type DocumentKind,
  type ModelRegistry,
  PATH_DOCUMENTS,
  type ProjectPath,
  type ProjectStage,
  type RoutedTask,
  type RoutingPlan,
  type RoutingRules,
  SectionRef,
  type StrategyLevel,
  TaskFailure,
  TaskFeatures,
  TaskOverride,
  type Tier,
  Triage,
} from "@km0/shared";
import { z } from "zod";
import { type Database, nowIso, transaction } from "../db/sql";
import type { AgentStore } from "./agent-store";
import { latestDocument } from "./document-service";
import { KeyedLock } from "./lock";
import { describeProject, readDecisions } from "./project-service";
import type { NewRecord, RunRecordStore } from "./run-records";

interface ProjectRow {
  title: string;
  description: string;
  path: ProjectPath | null;
  stage: ProjectStage;
  triage_json: string | null;
  repo_scan_json: string | null;
  strategy_level: number;
  budget_usd: number | null;
}

/** What routing reads besides the database: the registry, this install's run records and quota state. */
export interface RoutingSources {
  registry: () => ModelRegistry;
  records: RunRecordStore | null;
  pastQuota: () => StrategyContext["pastQuota"];
}

const NO_SOURCES: RoutingSources = { registry: () => EMPTY_REGISTRY, records: null, pastQuota: () => undefined };

/** One attempt of a KM0 Runner run: the model it ran, as the Runner names it. */
export interface RunnerAttempt {
  model: string;
}

interface TaskRow {
  id: number;
  seq: number;
  title: string;
  spec_json: string;
  features_json: string;
  depends_on_json: string;
  override_json: string | null;
  failures_json: string;
}

const TaskSpec = z.object({
  goal: z.string(),
  acceptance: z.array(z.string()),
  files: z.array(z.string()),
  decisionKeys: z.array(z.string()),
  sections: z.array(SectionRef),
  testCommand: z.string().nullable().optional(),
});
const BasedOn = z.array(z.object({ kind: z.enum(["prd", "tech_design", "brief"]), version: z.number().int() }));
const Seqs = z.array(z.number().int());
const Failures = z.array(TaskFailure);

/** The agent behind an attempt of a run: the direct executor names it; KM0 Runner's attempts are pi's. */
const attemptAgent = (attempt: RunnerAttempt) => {
  const agent = (attempt as { agent?: unknown }).agent;
  return typeof agent === "string" && agent ? agent : "pi";
};

/**
 * Task breakdown and routing. The planner proposes tasks and describes them; difficulty, agents,
 * models and costs are computed each time the plan is read, so changes to the agents and models, the
 * strategy level, the user's overrides, recorded runs and the registry apply at once.
 */
export class RoutingService {
  private readonly locks = new KeyedLock<number>();

  constructor(
    private readonly db: Database,
    private readonly llmFor: (projectId: number) => DiscussionLlm,
    private readonly language: () => Language,
    private readonly agents: AgentStore,
    private readonly rules: () => RoutingRules = () => DEFAULT_ROUTING_RULES,
    private readonly sources: RoutingSources = NO_SOURCES,
  ) {}

  /** The configured agents, as routing sees them. */
  agentConfigs(): AgentConfig[] {
    return this.agents.list();
  }

  get(projectId: number): RoutingPlan | null {
    const project = this.project(projectId);
    const plan = this.db.prepare("SELECT * FROM routing_plans WHERE project_id = ?").get(projectId) as
      | { based_on_json: string; created_at: string }
      | undefined;
    if (!plan) return null;
    const agents = this.agents.list();
    const level = project.strategy_level as StrategyLevel;
    const options = {
      rules: this.rules(),
      registry: this.sources.registry(),
      records: this.sources.records?.all() ?? [],
      level,
      pastQuota: this.sources.pastQuota(),
    };
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY seq")
      .all(projectId) as unknown as TaskRow[];
    const tasks = rows.map((row) => {
      const spec = TaskSpec.parse(JSON.parse(row.spec_json));
      return routeTask(
        {
          id: row.id,
          seq: row.seq,
          title: row.title,
          ...spec,
          dependsOn: Seqs.parse(JSON.parse(row.depends_on_json)),
          features: TaskFeatures.parse(JSON.parse(row.features_json)),
          override: row.override_json ? TaskOverride.parse(JSON.parse(row.override_json)) : null,
          failures: Failures.parse(JSON.parse(row.failures_json)),
        },
        agents,
        this.language(),
        options,
      );
    });
    const basedOn = BasedOn.parse(JSON.parse(plan.based_on_json));
    const current = this.documentVersions(projectId, project.path ?? "full");
    const outdated =
      current.length !== basedOn.length ||
      current.some((doc) => basedOn.find((item) => item.kind === doc.kind)?.version !== doc.version);
    return {
      projectId,
      createdAt: plan.created_at,
      tasks,
      level,
      budget: project.budget_usd,
      ...planTotals(tasks, project.budget_usd),
      basedOn,
      outdated,
    };
  }

  /** Break the work into tasks with the planner, replacing any earlier plan and its overrides. */
  plan(projectId: number): Promise<RoutingPlan> {
    return this.locks.run(projectId, async () => {
      const project = this.project(projectId);
      const path = project.path ?? "full";
      const discussing = project.stage === "triage" || (PATH_STAGES[path] as string[]).includes(project.stage);
      if (discussing) throw new AppError("conflict", "Finish the discussion before breaking the work into tasks.");
      const documents = PATH_DOCUMENTS[path].map((kind) => ({ kind, doc: latestDocument(this.db, projectId, kind) }));
      if (documents.some((item) => !item.doc)) {
        throw new AppError("conflict", "Write the documents before breaking the work into tasks.");
      }

      const planned = await breakDown(this.llmFor(projectId), {
        language: this.language(),
        path,
        title: project.title,
        description: describeProject(project.description, project.repo_scan_json),
        triage: project.triage_json ? Triage.parse(JSON.parse(project.triage_json)) : null,
        decisions: readDecisions(this.db, projectId),
        documents: documents.map(({ kind, doc }) => ({ kind, sections: doc?.sections ?? [] })),
      });

      transaction(this.db, () => {
        const now = nowIso();
        this.db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
        for (const task of planned) {
          const spec = {
            goal: task.goal,
            acceptance: task.acceptance,
            files: task.files,
            decisionKeys: task.decisionKeys,
            sections: task.sections,
            testCommand: task.testCommand,
          };
          this.db
            .prepare(
              `INSERT INTO tasks (project_id, doc_version, seq, title, spec_json, features_json, depends_on_json, created_at, updated_at)
               VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              projectId,
              task.seq,
              task.title,
              JSON.stringify(spec),
              JSON.stringify(task.features),
              JSON.stringify(task.dependsOn),
              now,
              now,
            );
        }
        this.db
          .prepare(
            `INSERT INTO routing_plans (project_id, based_on_json, created_at) VALUES (?, ?, ?)
             ON CONFLICT (project_id) DO UPDATE SET based_on_json = excluded.based_on_json, created_at = excluded.created_at`,
          )
          .run(projectId, JSON.stringify(this.documentVersions(projectId, path)), now);
        this.db.prepare("UPDATE projects SET stage = 'routing', updated_at = ? WHERE id = ?").run(now, projectId);
      });
      return this.get(projectId) as RoutingPlan;
    });
  }

  /** Set or clear the user's choice of tier, agent or model for one task. */
  override(projectId: number, taskId: number, override: TaskOverride | null): Promise<RoutingPlan> {
    return this.locks.run(projectId, async () => {
      this.project(projectId);
      const owned = this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND project_id = ?").get(taskId, projectId);
      if (!owned) throw new AppError("not_found", `Task ${taskId} does not exist.`);
      const empty = !override || Object.values(override).every((value) => value === undefined);
      this.db
        .prepare("UPDATE tasks SET override_json = ?, updated_at = ? WHERE id = ?")
        .run(empty ? null : JSON.stringify(override), nowIso(), taskId);
      return this.get(projectId) as RoutingPlan;
    });
  }

  /** The project's strategy level and budget. */
  setStrategy(projectId: number, level: StrategyLevel, budget: number | null): Promise<RoutingPlan | null> {
    return this.locks.run(projectId, async () => {
      this.project(projectId);
      this.db
        .prepare("UPDATE projects SET strategy_level = ?, budget_usd = ?, updated_at = ? WHERE id = ?")
        .run(level, budget, nowIso(), projectId);
      return this.get(projectId);
    });
  }

  /**
   * Record one run of the task by hand, on the combination it is routed to now. Both outcomes teach
   * the model's ability; enough failures move the task up its escalation chain.
   */
  record(projectId: number, taskId: number, passed: boolean): Promise<RoutingPlan> {
    return this.locks.run(projectId, async () => {
      const failures = this.failures(projectId, taskId);
      const task = this.get(projectId)?.tasks.find((item) => item.id === taskId);
      if (!task) throw new AppError("not_found", `Task ${taskId} does not exist.`);
      if (!task.choice) throw new AppError("conflict", "The task has no agent and model to record a run for.");
      this.sources.records?.add({
        ...this.runRecord(task, task.choice.agent, task.choice.modelRef, passed, 1),
        source: "user",
        projectId,
        taskId,
        ref: null,
      });
      if (!passed) {
        failures.push({
          tier: task.tier,
          at: nowIso(),
          source: "user",
          agent: task.choice.agent,
          modelRef: task.choice.modelRef,
        });
        this.saveFailures(taskId, failures);
      }
      return this.get(projectId) as RoutingPlan;
    });
  }

  /**
   * KM0's verdict on a KM0 Runner run of one task, keyed by when it was judged. Every attempt becomes a
   * run record (the last passed when the work was accepted); a rejection also rules out the model the
   * Runner finished on, so the next hand-off starts higher.
   */
  setRunnerVerdict(
    projectId: number,
    seq: number,
    judgedAt: string,
    verdict: {
      accepted: boolean;
      tier: Tier | null;
      reason: string;
      attempts: RunnerAttempt[];
      /** The user overruled KM0, which counts double. */
      byUser: boolean;
      ref: string;
    },
  ): Promise<void> {
    return this.locks.run(projectId, async () => {
      const row = this.db.prepare("SELECT id FROM tasks WHERE project_id = ? AND seq = ?").get(projectId, seq) as
        | { id: number }
        | undefined;
      // The plan was made again since the run: its tasks are new and owe nothing to the old run.
      if (!row) return;
      const task = this.get(projectId)?.tasks.find((item) => item.id === row.id);
      const last = verdict.attempts.at(-1);
      const finished = last ? this.modelFor(last.model) : null;
      if (task && this.sources.records) {
        const records: NewRecord[] = verdict.attempts.flatMap((attempt, index) => {
          const model = this.modelFor(attempt.model);
          if (!model) return [];
          const passed = verdict.accepted && index === verdict.attempts.length - 1;
          return [
            {
              // KM0 Runner runs pi; the direct executor says which agent did the work.
              ...this.runRecord(task, attemptAgent(attempt), model.modelRef, passed, verdict.byUser ? 2 : 1),
              source: "acceptance" as const,
              projectId,
              taskId: row.id,
              ref: verdict.ref,
            },
          ];
        });
        this.sources.records.replace(verdict.ref, records);
      }
      const kept = this.failures(projectId, row.id).filter(
        (failure) => !(failure.source === "runner" && failure.at === judgedAt),
      );
      if (!verdict.accepted) {
        const tier = verdict.tier ?? finished?.tier ?? task?.tier ?? "T1";
        kept.push({
          tier,
          at: judgedAt,
          source: "runner",
          reason: verdict.reason,
          ...(finished ? { modelRef: finished.modelRef } : {}),
        });
      }
      this.saveFailures(row.id, kept);
    });
  }

  /** Forget a task's failed runs, which also undoes any move they caused, and the runs recorded for it by hand. */
  clearFailures(projectId: number, taskId: number): Promise<RoutingPlan> {
    return this.locks.run(projectId, async () => {
      this.failures(projectId, taskId);
      this.saveFailures(taskId, []);
      this.sources.records?.clearTask(projectId, taskId);
      return this.get(projectId) as RoutingPlan;
    });
  }

  /** A record of one run of the task on a model: keyed by the registry model, with the task's kind of work and difficulty. */
  private runRecord(task: RoutedTask, agent: string, modelRef: number, passed: boolean, weight: number) {
    const config = this.agents.list();
    const model = config.flatMap((item) => item.models).find((item) => item.modelRef === modelRef);
    const owner = config.find((item) => item.id === agent);
    return {
      modelKey: modelKey({ canonicalId: model?.canonicalId ?? null, id: modelRef }),
      agent,
      native: Boolean(model?.vendor && owner?.nativeVendors.includes(model.vendor)),
      kind: task.abilityKind,
      band: task.band,
      passed,
      weight,
    };
  }

  /** The user's model a KM0 Runner attempt ran, from the Runner's `provider/model` name or the bare model ID. */
  private modelFor(name: string) {
    const models = this.agents.list().flatMap((item) => item.models);
    const bare = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
    return models.find((item) => item.modelId === name) ?? models.find((item) => item.modelId === bare) ?? null;
  }

  private failures(projectId: number, taskId: number): TaskFailure[] {
    this.project(projectId);
    const row = this.db
      .prepare("SELECT failures_json FROM tasks WHERE id = ? AND project_id = ?")
      .get(taskId, projectId) as { failures_json: string } | undefined;
    if (!row) throw new AppError("not_found", `Task ${taskId} does not exist.`);
    return Failures.parse(JSON.parse(row.failures_json));
  }

  private saveFailures(taskId: number, failures: TaskFailure[]): void {
    this.db
      .prepare("UPDATE tasks SET failures_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(failures), nowIso(), taskId);
  }

  private project(projectId: number): ProjectRow {
    const row = this.db
      .prepare(
        `SELECT title, description, path, stage, triage_json, repo_scan_json, strategy_level, budget_usd
         FROM projects WHERE id = ?`,
      )
      .get(projectId) as ProjectRow | undefined;
    if (!row) throw new AppError("not_found", `Project ${projectId} does not exist.`);
    return row;
  }

  private documentVersions(projectId: number, path: ProjectPath): { kind: DocumentKind; version: number }[] {
    return PATH_DOCUMENTS[path].flatMap((kind) => {
      const doc = latestDocument(this.db, projectId, kind);
      return doc ? [{ kind, version: doc.version }] : [];
    });
  }
}
