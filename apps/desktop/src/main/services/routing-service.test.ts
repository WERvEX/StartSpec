import { createSimulatedLlm } from "@km0/core";
import bundledRegistry from "@km0/registry/model-registry.json";
import { ModelRegistry } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { AgentStore } from "./agent-store";
import { DocumentService } from "./document-service";
import { ProjectService } from "./project-service";
import { RoutingService } from "./routing-service";
import { RunRecordStore } from "./run-records";
import { PlainSecretStore } from "./secrets";
import { SettingsStore } from "./settings-store";

function setup() {
  const db = openDatabase(":memory:");
  const llm = createSimulatedLlm();
  const language = () => "zh-CN" as const;
  const registry = ModelRegistry.parse(bundledRegistry);
  const records = new RunRecordStore(db);
  const settings = new SettingsStore(
    db,
    new PlainSecretStore(),
    () => registry,
    () => records.all(),
  );
  const agents = new AgentStore(db, () => settings.listModels());
  return {
    db,
    settings,
    agents,
    records,
    projects: new ProjectService(db, () => llm, language),
    documents: new DocumentService(
      db,
      () => llm,
      language,
      () => undefined,
    ),
    routing: new RoutingService(db, () => llm, language, agents, undefined, {
      registry: () => registry,
      records,
      pastQuota: () => settings.pastQuota(),
    }),
  };
}

describe("agent catalog", () => {
  it("starts with every agent enabled in order and Claude Code's models filled in", () => {
    const { agents } = setup();
    const list = agents.list();
    expect(list.map((agent) => agent.id)).toEqual([
      "claude_code",
      "codex",
      "cursor",
      "pi",
      "dsh",
      "zcode",
      "generic",
      "claude_desktop",
    ]);
    // Claude Desktop (1.1) comes switched off: it only takes tasks someone asks it to, through KM0's MCP server.
    expect(list.filter((agent) => !agent.enabled).map((agent) => agent.id)).toEqual(["claude_desktop"]);
    expect(list.at(-1)?.models.map((model) => model.modelId)).toEqual(list[0]?.models.map((model) => model.modelId));
    // The models KM0 0.1 shipped for Claude Code, labelled by their registry ability, priced by the registry.
    expect(list[0]?.models.map((model) => [model.modelId, model.tier, model.native, model.price.source])).toEqual([
      ["claude-haiku-5-5", "T1", true, "registry"],
      ["claude-sonnet-5-5", "T2", true, "registry"],
      ["claude-opus-5-5", "T3", true, "registry"],
    ]);
  });

  it("starts with what each agent is good at and saves changes to it", () => {
    const { agents } = setup();
    const capabilities = Object.fromEntries(agents.list().map((agent) => [agent.id, agent.capabilities]));
    expect(capabilities).toMatchObject({
      claude_code: ["backend", "debugging", "testing", "docs", "devops"],
      codex: ["backend", "testing"],
      cursor: ["frontend"],
      generic: [],
    });
    const codex = agents.list().find((agent) => agent.id === "codex");
    if (!codex) throw new Error("codex missing");
    const refs: number[] = [];
    const saved = agents.update("codex", true, refs, ["frontend", "frontend", "debugging"]);
    expect(saved.find((agent) => agent.id === "codex")?.capabilities).toEqual(["frontend", "debugging"]);
    // Leaving them out keeps what is stored.
    const kept = agents.update("codex", false, refs);
    expect(kept.find((agent) => agent.id === "codex")?.capabilities).toEqual(["frontend", "debugging"]);
  });

  it("saves models and prices, and reorders by swapping neighbours", () => {
    const { agents, settings } = setup();
    const provider = settings.createProvider({ name: "OpenAI", kind: "openai" });
    const gpt = settings.createModel({
      providerId: provider.id,
      modelId: "gpt-x",
      priceInPerMTok: 2,
      priceOutPerMTok: 8,
    });
    expect(agents.update("codex", false, [gpt.id, gpt.id]).find((agent) => agent.id === "codex")).toMatchObject({
      enabled: false,
      models: [{ modelRef: gpt.id, modelId: "gpt-x", priceInPerMTok: 2, priceOutPerMTok: 8 }],
    });
    // Claude Code takes Anthropic-format providers only.
    expect(() => agents.update("claude_code", true, [gpt.id])).toThrow(/anthropic/);
    expect(
      agents
        .move("codex", "up")
        .map((agent) => agent.id)
        .slice(0, 2),
    ).toEqual(["codex", "claude_code"]);
    expect(agents.move("codex", "up").map((agent) => agent.id)[0]).toBe("codex");
    expect(agents.move("generic", "down").at(-1)?.id).toBe("generic");
  });
});

describe("routing", () => {
  it("needs a finished discussion and written documents", async () => {
    const { projects, routing } = setup();
    let project = await projects.create("从零做一个团队内部的需求管理平台", null);
    await expect(routing.plan(project.id)).rejects.toMatchObject({ kind: "conflict" });
    for (let stage = 0; stage < 4; stage += 1) project = await projects.advance(project.id, true);
    await expect(routing.plan(project.id)).rejects.toMatchObject({
      kind: "conflict",
      message: "Write the documents before breaking the work into tasks.",
    });
    expect(routing.get(project.id)).toBeNull();
  });

  it("breaks the work into tasks and routes them by difficulty, strategy level and overrides", async () => {
    const { projects, documents, routing, agents, settings } = setup();
    let project = await projects.create("从零做一个团队内部的需求管理平台", null);
    for (let stage = 0; stage < 4; stage += 1) project = await projects.advance(project.id, true);
    await documents.generate(project.id, "prd", false);
    await documents.generate(project.id, "tech_design", false);

    let plan = await routing.plan(project.id);
    expect((await projects.get(project.id)).stage).toBe("routing");
    expect(plan).toMatchObject({ level: 3, budget: null });
    expect(plan.tasks.map((task) => [task.seq, task.band, task.agent])).toEqual([
      [1, "lt15m", "claude_code"],
      [2, "15m-1h", "claude_code"],
      [3, "gt4h", "claude_code"],
    ]);
    // Harder tasks never get a weaker model.
    const ability = (task: (typeof plan.tasks)[number]) => task.choice?.pass.mean ?? 0;
    const opus = plan.tasks[2];
    expect(opus?.model).toBe("claude-opus-5-5");
    expect(plan.tasks[2]).toMatchObject({
      splitSuggested: true,
      dependsOn: [1, 2],
      sections: [
        { kind: "tech_design", sectionId: "data_model" },
        { kind: "tech_design", sectionId: "security" },
      ],
    });
    expect(ability(plan.tasks[0] as never)).toBeGreaterThan(0.5);
    // Registry prices: every task is priced, and cheaper than running everything on the strongest model.
    expect(plan.totals.unpriced).toBe(0);
    expect(plan.totals.saving).toBeGreaterThan(0);
    expect(plan.totals.expectedCost).toBeGreaterThan(0);
    expect(plan).toMatchObject({
      outdated: false,
      basedOn: [
        { kind: "prd", version: 1 },
        { kind: "tech_design", version: 1 },
      ],
    });

    // The project's level moves every task; a budget below the plan suggests cheaper levels.
    const aggressive = await routing.setStrategy(project.id, 1, null);
    const conservative = await routing.setStrategy(project.id, 5, 0.01);
    for (const [index, task] of (conservative?.tasks ?? []).entries()) {
      expect(task.expectedCost ?? 0).toBeGreaterThanOrEqual(aggressive?.tasks[index]?.expectedCost ?? 0);
    }
    expect(conservative?.budgetAdvice?.moves.length).toBeGreaterThan(0);
    await routing.setStrategy(project.id, 3, null);

    const first = plan.tasks[0]?.id ?? 0;
    const provider = settings.createProvider({ name: "OpenAI", kind: "openai" });
    const gpt = settings.createModel({
      providerId: provider.id,
      modelId: "gpt-x",
      priceInPerMTok: 1,
      priceOutPerMTok: 4,
    });
    agents.update("codex", true, [gpt.id]);
    plan = await routing.override(project.id, first, { agent: "codex", modelRef: gpt.id, level: 5 });
    expect(plan.tasks[0]).toMatchObject({ agent: "codex", model: "gpt-x", level: 5, levelSource: "task" });
    expect(plan.tasks[0]?.agentReason).toBe("手动指定");
    plan = await routing.override(project.id, first, null);
    expect(plan.tasks[0]).toMatchObject({ agent: "claude_code", override: null, level: 3 });
    await expect(routing.override(project.id, 999, null)).rejects.toMatchObject({ kind: "not_found" });

    // Two failed runs on a combination move the task up its chain; clearing them puts it back.
    const start = plan.tasks[0]?.model;
    plan = await routing.record(project.id, first, false);
    expect(plan.tasks[0]?.failures).toMatchObject([{ agent: "claude_code", source: "user" }]);
    expect(plan.tasks[0]?.choice?.localRecords).toBe(1);
    plan = await routing.record(project.id, first, false);
    expect(plan.tasks[0]?.model).not.toBe(start);
    expect(plan.tasks[0]?.escalatedFrom).not.toBeNull();
    plan = await routing.clearFailures(project.id, first);
    expect(plan.tasks[0]).toMatchObject({ model: start, failures: [], escalatedFrom: null });
    expect(plan.tasks[0]?.choice?.localRecords).toBe(0);
    // A pass is recorded too, and does not count as a failure.
    plan = await routing.record(project.id, first, true);
    expect(plan.tasks[0]).toMatchObject({ failures: [], model: start });
    expect(settings.listModels().find((model) => model.modelId === start)?.ability).toMatchObject({
      runs: 1,
      passed: 1,
    });
    await expect(routing.record(project.id, 999, false)).rejects.toMatchObject({ kind: "not_found" });

    // A newer document version makes the plan worth redoing.
    await documents.generate(project.id, "prd", false);
    expect(routing.get(project.id)?.outdated).toBe(true);
    plan = await routing.plan(project.id);
    expect(plan.outdated).toBe(false);
  });

  it("learns from KM0's verdicts on KM0 Runner's attempts and starts a rejected task higher", async () => {
    const { projects, routing, records } = setup();
    let project = await projects.create("修复登录页按钮上的错别字", null);
    project = await projects.advance(project.id, true);
    const plan = await routing.plan(project.id);
    const task = plan.tasks[0];
    const attempts = [{ model: "anthropic/claude-haiku-5-5" }, { model: "claude-sonnet-5-5" }];
    const verdict = { tier: "T2" as const, reason: "没改按钮", attempts, byUser: false, ref: "runner:r1:01" };
    await routing.setRunnerVerdict(project.id, 1, "2026-01-01T00:00:00Z", { ...verdict, accepted: false });
    expect(records.all().map((record) => [record.modelKey, record.passed])).toEqual([
      ["anthropic/claude-haiku-5.5", false],
      ["anthropic/claude-sonnet-5.5", false],
    ]);
    const lifted = routing.get(project.id)?.tasks[0];
    expect(lifted?.failures).toMatchObject([{ source: "runner", reason: "没改按钮" }]);
    expect(lifted?.choice?.pass.mean ?? 0).toBeGreaterThan(task?.choice?.pass.mean ?? 1);
    // The user overrules KM0: the same verdict now counts as a pass, double, and the task goes back.
    await routing.setRunnerVerdict(project.id, 1, "2026-01-01T00:00:00Z", { ...verdict, accepted: true, byUser: true });
    expect(records.all().map((record) => [record.passed, record.weight])).toEqual([
      [false, 2],
      [true, 2],
    ]);
    expect(routing.get(project.id)?.tasks[0]?.failures).toEqual([]);
  });

  it("plans the fast path straight from its decisions", async () => {
    const { projects, routing } = setup();
    let project = await projects.create("修复登录页按钮上的错别字", null);
    project = await projects.advance(project.id, true);
    expect(project.stage).toBe("routing");
    const plan = await routing.plan(project.id);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({ tier: "T1", agent: "claude_code" });
    expect(plan.basedOn).toEqual([]);
  });
});
