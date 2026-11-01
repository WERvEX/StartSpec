import { z } from "zod";
import { DocumentKind } from "./documents";
import { ProviderKind } from "./llm";
import { type BillingMode, EffectivePrice } from "./models";
import { AbilityKind, DifficultyBand, Estimate } from "./registry";

export const Tier = z.enum(["T1", "T2", "T3"]);
export type Tier = z.infer<typeof Tier>;
export const TIERS: readonly Tier[] = ["T1", "T2", "T3"];

/**
 * The coding agents KM0 hands work to: the presets below, which KM0 has adapters for, and agents the
 * user defines. `generic` is a plain Markdown prompt for anything else.
 */
export const AgentId = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,39}$/, "An agent ID is lower-case letters, digits, '-' and '_'.");
export type AgentId = z.infer<typeof AgentId>;

export const PRESET_AGENT_IDS = [
  "claude_code",
  "claude_desktop",
  "codex",
  "cursor",
  "pi",
  "dsh",
  "zcode",
  "generic",
] as const;
export type PresetAgentId = (typeof PRESET_AGENT_IDS)[number];

export const AGENT_NAMES: Record<PresetAgentId, string> = {
  claude_code: "Claude Code",
  claude_desktop: "Claude Desktop",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
  dsh: "DSH",
  zcode: "ZCode",
  generic: "Generic",
};

export const isPresetAgent = (id: string): id is PresetAgentId => (PRESET_AGENT_IDS as readonly string[]).includes(id);

/**
 * What each preset is: the vendors whose official tool it is (their models run best in it), and the
 * API formats it can be pointed at (empty: it brings its own models or takes any).
 */
export const PRESET_AGENTS: Record<PresetAgentId, { nativeVendors: string[]; apiKinds: ProviderKind[] }> = {
  claude_code: { nativeVendors: ["anthropic"], apiKinds: ["anthropic"] },
  claude_desktop: { nativeVendors: ["anthropic"], apiKinds: ["anthropic"] },
  codex: { nativeVendors: ["openai"], apiKinds: ["openai"] },
  cursor: { nativeVendors: ["cursor"], apiKinds: [] },
  pi: { nativeVendors: [], apiKinds: [] },
  dsh: { nativeVendors: ["deepseek"], apiKinds: [] },
  zcode: { nativeVendors: ["z-ai"], apiKinds: [] },
  generic: { nativeVendors: [], apiKinds: [] },
};

/** What an agent is good at. A task needs at most one of these; see `taskCapability` in core. */
export const Capability = z.enum(["frontend", "backend", "debugging", "testing", "docs", "devops"]);
export type Capability = z.infer<typeof Capability>;
export const CAPABILITIES: readonly Capability[] = Capability.options;

/** What a task touches; the model only describes it, the tier is computed from it by rules. */
export const TaskFeatures = z.object({
  /** single_file: one file · few_files: 2–5 files · many_files: more than 5 · new_subsystem: a new module or service. */
  scope: z.enum(["single_file", "few_files", "many_files", "new_subsystem"]),
  ambiguity: z.enum(["low", "medium", "high"]),
  /** follow: do as written · judgement: some choices · design: needs design decisions. */
  reasoning: z.enum(["follow", "judgement", "design"]),
  context: z.enum(["small", "large"]),
  /** Existing tests can check the result. */
  hasTests: z.boolean(),
  risks: z.array(z.enum(["data_migration", "security", "production"])),
  /** fix: find and fix a bug; the other kinds say what the task mostly produces. */
  kind: z.enum(["code", "fix", "test", "docs", "boilerplate", "config"]),
});
export type TaskFeatures = z.infer<typeof TaskFeatures>;
export type TaskRisk = TaskFeatures["risks"][number];

const Points = z.number().int().min(0).max(20);

/**
 * The tunable part of the tier rules: points per feature value and the highest score for T1 and T2.
 * The hard rules (docs, risks, fixes, design) stay fixed. KM0 Runner's `calibrate` writes this file.
 */
export const RoutingRules = z
  .object({
    featurePoints: z.object({
      scope: z.object({ single_file: Points, few_files: Points, many_files: Points, new_subsystem: Points }),
      ambiguity: z.object({ low: Points, medium: Points, high: Points }),
      reasoning: z.object({ follow: Points, judgement: Points, design: Points }),
      context: z.object({ small: Points, large: Points }),
      hasTests: z.object({ true: Points, false: Points }),
    }),
    tierLimits: z.object({ T1: Points, T2: Points }),
  })
  .refine((rules) => rules.tierLimits.T1 <= rules.tierLimits.T2, {
    message: "The T1 limit must not exceed the T2 limit.",
    path: ["tierLimits"],
  });
export type RoutingRules = z.infer<typeof RoutingRules>;

/** The rules in force, and whether they are imported ones rather than KM0's defaults. */
export const RoutingRulesState = z.object({ rules: RoutingRules, custom: z.boolean() });
export type RoutingRulesState = z.infer<typeof RoutingRulesState>;

/** One of the models an agent can run: a user's model, with what a run on it costs and its tier label. */
export const TierModel = z.object({
  /** The model entry (Settings → Models). */
  modelRef: z.number().int(),
  providerId: z.number().int(),
  providerKind: ProviderKind,
  /** As passed to the agent. */
  modelId: z.string(),
  name: z.string(),
  canonicalId: z.string().nullable(),
  vendor: z.string().nullable(),
  /** The agent is the official tool of the model's vendor. */
  native: z.boolean(),
  price: EffectivePrice,
  /** USD per million tokens, kept for cost estimates; null when unknown. */
  priceInPerMTok: z.number().nonnegative().nullable(),
  priceOutPerMTok: z.number().nonnegative().nullable(),
  /** Display label: where the model's ability sits among the user's models, unless the user set one. */
  tier: Tier,
  contextWindow: z.number().int().nullable(),
});
export type TierModel = z.infer<typeof TierModel>;

export const AgentConfig = z.object({
  id: AgentId,
  name: z.string(),
  kind: z.enum(["preset", "custom"]),
  enabled: z.boolean(),
  /** Lower comes first. */
  preference: z.number().int(),
  /** The models it can run; routing picks among them per task. */
  models: z.array(TierModel),
  /** Kinds of work the agent is preferred for when everything else is equal. */
  capabilities: z.array(Capability),
  nativeVendors: z.array(z.string()),
  /** API formats the agent can use; empty means any. */
  apiKinds: z.array(ProviderKind),
  /** Custom agents: the project instructions file it reads, and the command that starts it. */
  instructionFile: z.string().nullable(),
  launchTemplate: z.string().nullable(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export type { BillingMode };

export const CostRange = z.object({ low: z.number(), high: z.number() });
export type CostRange = z.infer<typeof CostRange>;

/**
 * Dispatch strategy levels, from aggressive (cheapest that is likely enough to pass) to conservative.
 * Each asks the first run to pass with at least `target` probability, judging the model by the
 * `quantile` of what is known about it: below 0.5, a model known only vaguely needs a larger margin.
 */
export const StrategyLevel = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
export type StrategyLevel = z.infer<typeof StrategyLevel>;
export const STRATEGY_LEVELS: readonly StrategyLevel[] = [1, 2, 3, 4, 5];
export const LEVEL_SETTINGS: Record<StrategyLevel, { target: number; quantile: number }> = {
  1: { target: 0.5, quantile: 0.5 },
  2: { target: 0.6, quantile: 0.5 },
  3: { target: 0.7, quantile: 0.35 },
  4: { target: 0.8, quantile: 0.25 },
  5: { target: 0.9, quantile: 0.1 },
};
export const DEFAULT_LEVEL: StrategyLevel = 3;
/** Tasks with a risk are routed at least this conservatively. */
export const RISK_LEVEL: StrategyLevel = 4;
/** A vendor's own agent is chosen over another agent running the same model when it is at most this much less likely to pass. */
export const NATIVE_MARGIN = 0.05;

export const TaskOverride = z.object({
  /** The strategy level for this task instead of the project's. */
  level: StrategyLevel.optional(),
  agent: AgentId.optional(),
  /** The model entry to use; with `agent`, the exact combination. */
  modelRef: z.number().int().optional(),
  /** KM0 0.1: a tier or a model ID typed by hand. A tier limits the choice to models with that label. */
  tier: Tier.optional(),
  model: z.string().trim().min(1).max(200).optional(),
});
export type TaskOverride = z.infer<typeof TaskOverride>;

/** Failed runs on one tier that move a task to the next tier. */
export const ESCALATE_AFTER = 2;

/**
 * One run that did not pass, on the tier the task ran on. `user`: recorded by hand; enough of them lift the
 * task a tier. `runner`: KM0 Runner already climbed to that tier and KM0's acceptance rejected the work, so the
 * next hand-off starts one tier above it at once.
 */
export const TaskFailure = z.object({
  /** The tier label of the model that failed. */
  tier: Tier,
  at: z.string(),
  source: z.enum(["user", "runner"]).default("user"),
  reason: z.string().optional(),
  /** The combination that failed; missing on failures recorded by KM0 0.1, which only knew the tier. */
  agent: AgentId.optional(),
  modelRef: z.number().int().optional(),
});
export type TaskFailure = z.infer<typeof TaskFailure>;

export const SectionRef = z.object({ kind: DocumentKind, sectionId: z.string() });
export type SectionRef = z.infer<typeof SectionRef>;

/** Why a combination cannot take a task at all. */
export const OptionExclusion = z.enum(["context", "quota", "risk_floor", "failed", "weaker", "native", "disabled"]);
export type OptionExclusion = z.infer<typeof OptionExclusion>;

/** One agent and model that could take a task, with its chances and cost. */
export const RouteOption = z.object({
  agent: AgentId,
  agentName: z.string(),
  modelRef: z.number().int(),
  modelId: z.string(),
  modelName: z.string(),
  tier: Tier,
  native: z.boolean(),
  /** Chance the first run passes: expected, a 90% interval, and at the strategy level's quantile. */
  pass: z.object({ mean: z.number(), low: z.number(), high: z.number(), atLevel: z.number() }),
  /** One run; null when the model has no price. */
  cost: CostRange.nullable(),
  /** Expected cost until a run passes, climbing the escalation chain from this option; null when a step has no price. */
  expectedCost: z.number().nullable(),
  /** Where the ability comes from: leaderboards (measured or only general indices), a guess from the price, plus local records. */
  coverage: z.enum(["measured", "inferred", "none", "unmatched"]),
  localRecords: z.number().int(),
  /** Matches the capability the task needs, as set under Settings → Agents. */
  capable: z.boolean(),
  excluded: OptionExclusion.nullable(),
});
export type RouteOption = z.infer<typeof RouteOption>;

export const RoutedTask = z.object({
  id: z.number().int(),
  seq: z.number().int(),
  title: z.string(),
  goal: z.string(),
  /** EARS acceptance criteria. */
  acceptance: z.array(z.string()),
  files: z.array(z.string()),
  /** seq numbers of tasks that must be done first. */
  dependsOn: z.array(z.number().int()),
  decisionKeys: z.array(z.string()),
  sections: z.array(SectionRef),
  /** Checks the task from the repository root; the planner's, else the repository's. Null when unknown. */
  testCommand: z.string().nullable(),
  features: TaskFeatures,
  score: z.number().int(),
  /** Tier from the rules, before any override. */
  ruleTier: Tier,
  tier: Tier,
  /** Why the rules picked the tier, one line per factor, then any lift from failed runs. */
  reasons: z.array(z.string()),
  /** Failed runs, oldest first. Enough of them on one tier lift the task to the next. */
  failures: z.array(TaskFailure),
  /** The tier before failed runs lifted it; null when they did not. */
  escalatedFrom: Tier.nullable(),
  /** Failed often enough on T3 that a person has to decide. */
  needsHuman: z.boolean(),
  /** What the task needs the agent to be good at; null when nothing in particular. */
  capability: Capability.nullable(),
  /** The ability the chances are computed from: the capability, or general. */
  abilityKind: AbilityKind,
  /** The strategy level in force, and where it comes from. */
  level: StrategyLevel,
  levelSource: z.enum(["project", "task", "risk"]),
  /** The difficulty band of the task, and its difficulty on the registry's scale. */
  band: DifficultyBand.shape.id,
  difficulty: Estimate,
  agent: AgentId,
  /** Why this combination, in a sentence. */
  agentReason: z.string(),
  /** The model entry chosen; null when no agent has a model. */
  modelRef: z.number().int().nullable(),
  /** As passed to the agent; null when no model is configured. */
  model: z.string().nullable(),
  /** The chosen combination; null when there is none. */
  choice: RouteOption.nullable(),
  /** Its first run meets the level's target. */
  meetsTarget: z.boolean(),
  /** Where the task goes after a failed run, in order. */
  chain: z.array(RouteOption),
  /** Every combination considered, cheapest expected cost first, with why any is ruled out. */
  options: z.array(RouteOption),
  /** Cheaper combinations not chosen, and why, one line each. */
  passedOver: z.array(z.string()),
  /** Leaderboards and local records behind the chances, in a line. */
  evidence: z.string(),
  /** Estimated tokens and cost of one run; cost is null when the model has no price. */
  tokens: z.object({ input: CostRange, output: CostRange }),
  cost: CostRange.nullable(),
  /** Expected cost through the escalation chain; null when unknown. */
  expectedCost: z.number().nullable(),
  /** The same at each strategy level, 1 to 5, for budget advice. */
  levelCosts: z.array(z.number().nullable()),
  /** One run on the strongest combination, for the comparison. */
  costStrongest: CostRange.nullable(),
  /** Large enough that splitting it first is advised. */
  splitSuggested: z.boolean(),
  override: TaskOverride.nullable(),
});
export type RoutedTask = z.infer<typeof RoutedTask>;

export const RoutingPlan = z.object({
  projectId: z.number().int(),
  createdAt: z.string(),
  tasks: z.array(RoutedTask),
  /** The project's strategy level and budget. */
  level: StrategyLevel,
  budget: z.number().nullable(),
  totals: z.object({
    cost: CostRange.nullable(),
    /** Sum of expected costs through the escalation chains. */
    expectedCost: z.number().nullable(),
    costStrongest: CostRange.nullable(),
    /** Share saved against running everything on the strongest combination, from the middle of both ranges. */
    saving: z.number().nullable(),
    /** Tasks left out of the totals because their model has no price. */
    unpriced: z.number().int(),
    /** Tasks whose chosen combination misses the level's target. */
    belowTarget: z.number().int(),
  }),
  /** Over budget: tasks that could move to a cheaper level, largest saving first, enough to fit when possible. */
  budgetAdvice: z
    .object({
      over: z.number(),
      fits: z.boolean(),
      moves: z.array(
        z.object({ taskId: z.number().int(), seq: z.number().int(), level: StrategyLevel, saving: z.number() }),
      ),
    })
    .nullable(),
  tierCounts: z.object({ T1: z.number().int(), T2: z.number().int(), T3: z.number().int() }),
  /** Document versions the plan was made from; a newer version means it may be out of date. */
  basedOn: z.array(z.object({ kind: DocumentKind, version: z.number().int() })),
  outdated: z.boolean(),
});
export type RoutingPlan = z.infer<typeof RoutingPlan>;

const ProjectId = z.number().int().positive();

export const OverrideTaskInput = z.object({
  projectId: ProjectId,
  taskId: z.number().int().positive(),
  /** null clears every override of the task. */
  override: TaskOverride.nullable(),
});

export const TaskRef = z.object({ projectId: ProjectId, taskId: z.number().int().positive() });

export const UpdateAgentInput = z.object({
  id: AgentId,
  enabled: z.boolean(),
  /** The model entries it can run. */
  models: z.array(z.number().int()),
  /** Left out keeps the stored capabilities. */
  capabilities: z.array(Capability).optional(),
});

/** An agent the user adds: anything that can be started with a command or pasted into. */
export const CustomAgentInput = z.object({
  name: z.string().trim().min(1).max(60),
  /** Project instructions file it reads, such as AGENTS.md; null when none. */
  instructionFile: z.string().trim().min(1).max(200).nullable().default(null),
  /** The command that starts it on a task; {prompt}, {task_file} and {model} are filled in. Null when it is pasted into. */
  launchTemplate: z.string().trim().min(1).max(1000).nullable().default(null),
  apiKinds: z.array(ProviderKind).default([]),
  /** The vendor whose official tool it is, such as "google" for Gemini CLI; null when none. */
  nativeVendor: z.string().trim().min(1).max(60).nullable().default(null),
  capabilities: z.array(Capability).default([]),
});
export type CustomAgentInput = z.input<typeof CustomAgentInput>;

export const MoveAgentInput = z.object({ id: AgentId, direction: z.enum(["up", "down"]) });

export const StrategyInput = z.object({
  projectId: ProjectId,
  level: StrategyLevel,
  /** USD for the whole project; null for none. */
  budget: z.number().positive().max(1_000_000).nullable(),
});

/** A run's result recorded by hand. */
export const RecordRunInput = z.object({
  projectId: ProjectId,
  taskId: z.number().int().positive(),
  passed: z.boolean(),
});
