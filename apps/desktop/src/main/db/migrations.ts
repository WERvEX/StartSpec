/**
 * Ordered schema migrations. Append new entries; never edit one that has shipped.
 * Timestamps are ISO-8601 UTC strings; JSON columns are validated with zod when read.
 */
import type { Database } from "./sql";

export interface Migration {
  id: number;
  name: string;
  sql: string;
  /** Data changes SQL alone cannot express; runs after `sql`, in the same transaction. */
  run?: (db: Database) => void;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "initial",
    sql: `
CREATE TABLE preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE llm_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  base_url TEXT,
  model TEXT NOT NULL,
  api_key_encrypted TEXT,
  api_key_hint TEXT,
  structured_mode TEXT NOT NULL DEFAULT 'auto' CHECK (structured_mode IN ('auto', 'json_schema', 'tool', 'prompt')),
  temperature REAL,
  price_in_per_mtok REAL,
  price_out_per_mtok REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  path TEXT CHECK (path IN ('fast', 'light', 'full')),
  stage TEXT NOT NULL DEFAULT 'triage',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  repo_path TEXT,
  triage_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE question_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  round_no INTEGER NOT NULL,
  questions_json TEXT NOT NULL,
  answers_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'superseded')),
  created_at TEXT NOT NULL,
  answered_at TEXT,
  UNIQUE (project_id, stage, round_no)
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  stage TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'recommended', 'ai')),
  rationale TEXT,
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  needs_review INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, key)
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('prd', 'tech_design', 'brief')),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  sections_json TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL CHECK (origin IN ('generated', 'edited', 'revised')),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, kind, version)
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  doc_version INTEGER,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  features_json TEXT,
  score INTEGER,
  tier TEXT CHECK (tier IN ('T1', 'T2', 'T3')),
  agent TEXT,
  model TEXT,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  override_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_ids_json TEXT NOT NULL,
  agent TEXT NOT NULL,
  files_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  preference INTEGER NOT NULL DEFAULT 0,
  capabilities_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE model_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('T1', 'T2', 'T3')),
  model_id TEXT NOT NULL,
  price_in_per_mtok REAL,
  price_out_per_mtok REAL,
  UNIQUE (agent_id, tier)
);

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  profile_id INTEGER REFERENCES llm_profiles(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  mode TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL,
  latency_ms INTEGER NOT NULL,
  error_kind TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX llm_calls_project ON llm_calls (project_id);

CREATE TABLE search_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('bocha', 'mcp_stdio', 'mcp_http')),
  config_json TEXT NOT NULL,
  secret_encrypted TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    name: "discussion_state",
    sql: `
CREATE TABLE stage_states (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'ready', 'complete')),
  rounds_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, stage)
);

ALTER TABLE question_rounds ADD COLUMN review INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 3,
    name: "document_versions",
    // No document was written before this migration, so the table is rebuilt rather than altered.
    sql: `
DROP TABLE documents;

CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('prd', 'tech_design', 'brief')),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('generated', 'edited', 'revised', 'restored')),
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, kind, version)
);
`,
  },
  {
    id: 4,
    name: "routing",
    // Agents start enabled in hand-off order; Claude Code comes with its model IDs, prices are left to the user.
    sql: `
CREATE TABLE routing_plans (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  based_on_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX tasks_project ON tasks (project_id, seq);

INSERT INTO agents (id, enabled, preference) VALUES
  ('claude_code', 1, 0),
  ('codex', 1, 1),
  ('cursor', 1, 2),
  ('pi', 1, 3),
  ('dsh', 1, 4),
  ('zcode', 1, 5),
  ('generic', 1, 6);

INSERT INTO model_catalog (agent_id, tier, model_id) VALUES
  ('claude_code', 'T1', 'claude-haiku-5-5'),
  ('claude_code', 'T2', 'claude-sonnet-5-5'),
  ('claude_code', 'T3', 'claude-opus-5-5');
`,
  },
  {
    id: 5,
    name: "research_and_repo_scan",
    sql: `
ALTER TABLE question_rounds ADD COLUMN research_json TEXT;
ALTER TABLE projects ADD COLUMN repo_scan_json TEXT;
`,
  },
  {
    id: 6,
    name: "agent_capabilities_and_failures",
    // Starting strengths only; the user edits them under Settings → Agents.
    sql: `
ALTER TABLE tasks ADD COLUMN failures_json TEXT NOT NULL DEFAULT '[]';

UPDATE agents SET capabilities_json = '["backend","debugging","testing","docs","devops"]' WHERE id = 'claude_code';
UPDATE agents SET capabilities_json = '["backend","testing"]' WHERE id = 'codex';
UPDATE agents SET capabilities_json = '["frontend"]' WHERE id = 'cursor';
`,
  },
  {
    id: 7,
    name: "runner_runs",
    // Runs of KM0 Runner imported for acceptance; a verdict is kept here even when the run folder is gone.
    sql: `
CREATE TABLE runner_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  path TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  write_back_pending INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, run_id)
);

CREATE TABLE runner_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_ref INTEGER NOT NULL REFERENCES runner_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  diff TEXT,
  verdict_json TEXT,
  UNIQUE (run_ref, seq)
);
`,
  },
  {
    id: 8,
    name: "model_registry",
    // A registry downloaded or imported after install; the bundled one is used when this is older.
    sql: `
CREATE TABLE model_registry (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  origin TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
`,
  },
  {
    id: 9,
    name: "providers_models_custom_agents",
    // Profiles become a provider (endpoint, key, billing) plus a model with the same id, so role
    // assignments and the call log keep pointing at the right model. The per-agent model catalog
    // becomes models of one provider per agent. Agents gain what custom agents need.
    sql: `
CREATE TABLE providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('openai', 'anthropic')),
  base_url TEXT,
  api_key_encrypted TEXT,
  api_key_hint TEXT,
  billing_json TEXT NOT NULL DEFAULT '{"mode":"token"}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  model_id TEXT NOT NULL,
  canonical_id TEXT,
  context_window INTEGER,
  structured_mode TEXT NOT NULL DEFAULT 'auto' CHECK (structured_mode IN ('auto', 'json_schema', 'tool', 'prompt')),
  temperature REAL,
  price_in_per_mtok REAL,
  price_out_per_mtok REAL,
  price_cache_read_per_mtok REAL,
  tier_label TEXT CHECK (tier_label IN ('T1', 'T2', 'T3')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO providers (id, name, kind, base_url, api_key_encrypted, api_key_hint, created_at, updated_at)
  SELECT id, name, provider, base_url, api_key_encrypted, api_key_hint, created_at, updated_at FROM llm_profiles;
INSERT INTO models (id, provider_id, name, model_id, structured_mode, temperature, price_in_per_mtok,
    price_out_per_mtok, created_at, updated_at)
  SELECT id, id, name, model, structured_mode, temperature, price_in_per_mtok, price_out_per_mtok, created_at, updated_at
  FROM llm_profiles;

CREATE TABLE llm_calls_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  profile_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  mode TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL,
  latency_ms INTEGER NOT NULL,
  error_kind TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO llm_calls_next SELECT * FROM llm_calls;
DROP TABLE llm_calls;
ALTER TABLE llm_calls_next RENAME TO llm_calls;
CREATE INDEX llm_calls_project ON llm_calls (project_id);
DROP TABLE llm_profiles;

ALTER TABLE agents ADD COLUMN name TEXT;
ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'preset' CHECK (kind IN ('preset', 'custom'));
ALTER TABLE agents ADD COLUMN instruction_file TEXT;
ALTER TABLE agents ADD COLUMN launch_template TEXT;
ALTER TABLE agents ADD COLUMN native_vendor TEXT;
ALTER TABLE agents ADD COLUMN api_kinds_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE agent_models (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  model_ref INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  UNIQUE (agent_id, model_ref)
);
`,
    run: migrateModelCatalog,
  },
  {
    id: 10,
    name: "routing_strategy_and_run_records",
    // A project's strategy level and budget; every run KM0 learns from, keyed by the registry model so
    // the same model through two providers shares its record.
    sql: `
ALTER TABLE projects ADD COLUMN strategy_level INTEGER NOT NULL DEFAULT 3 CHECK (strategy_level BETWEEN 1 AND 5);
ALTER TABLE projects ADD COLUMN budget_usd REAL;

CREATE TABLE run_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  native INTEGER NOT NULL,
  kind TEXT NOT NULL,
  band TEXT NOT NULL,
  passed INTEGER NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  source TEXT NOT NULL CHECK (source IN ('user', 'acceptance')),
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  task_id INTEGER,
  ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX run_records_model ON run_records (model_key);
CREATE INDEX run_records_ref ON run_records (ref);
`,
  },
  {
    id: 11,
    name: "execution_runs",
    // Runs KM0 started itself; their live state is read from the run directory's progress.jsonl.
    sql: `
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  executor TEXT NOT NULL CHECK (executor IN ('runner', 'custom')),
  status TEXT NOT NULL,
  run_dir TEXT NOT NULL,
  seqs_json TEXT NOT NULL DEFAULT '[]',
  reuse TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  error TEXT,
  cost REAL NOT NULL DEFAULT 0,
  log_json TEXT NOT NULL DEFAULT '[]',
  runner_run_ref INTEGER REFERENCES runner_runs(id) ON DELETE SET NULL
);
CREATE INDEX runs_project ON runs (project_id);
`,
  },
  {
    id: 12,
    name: "direct_execution",
    // Claude Desktop joins the presets switched off, able to run the models Claude Code has; runs may now be
    // `direct` (KM0 hands each task to its agent), which the old CHECK did not allow, so the table is rebuilt.
    sql: `
INSERT OR IGNORE INTO agents (id, name, enabled, preference)
  SELECT 'claude_desktop', 'Claude Desktop', 0, COALESCE(MAX(preference), -1) + 1 FROM agents;
INSERT OR IGNORE INTO agent_models (agent_id, model_ref)
  SELECT 'claude_desktop', model_ref FROM agent_models WHERE agent_id = 'claude_code';

CREATE TABLE runs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  executor TEXT NOT NULL CHECK (executor IN ('runner', 'direct', 'custom')),
  status TEXT NOT NULL,
  run_dir TEXT NOT NULL,
  seqs_json TEXT NOT NULL DEFAULT '[]',
  reuse TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  error TEXT,
  cost REAL NOT NULL DEFAULT 0,
  log_json TEXT NOT NULL DEFAULT '[]',
  runner_run_ref INTEGER REFERENCES runner_runs(id) ON DELETE SET NULL
);
INSERT INTO runs_new SELECT * FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX runs_project ON runs (project_id);
`,
  },
];

const PRESET_NAMES: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
  dsh: "DSH",
  zcode: "ZCode",
  generic: "Generic",
};

/** The 0.1 catalog typed a model ID and price per agent and tier; each becomes a model of a provider named after the agent. */
function migrateModelCatalog(db: Database): void {
  const now = new Date().toISOString();
  for (const [id, name] of Object.entries(PRESET_NAMES)) {
    db.prepare("UPDATE agents SET name = ? WHERE id = ?").run(name, id);
  }
  const rows = db
    .prepare("SELECT agent_id, tier, model_id, price_in_per_mtok, price_out_per_mtok FROM model_catalog")
    .all() as {
    agent_id: string;
    tier: string;
    model_id: string;
    price_in_per_mtok: number | null;
    price_out_per_mtok: number | null;
  }[];
  const taken = (table: "providers" | "models", name: string) =>
    Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE name = ?`).get(name));
  const unique = (table: "providers" | "models", name: string) => {
    let candidate = name;
    for (let n = 2; taken(table, candidate); n += 1) candidate = `${name} (${n})`;
    return candidate;
  };
  const providers = new Map<string, number>();
  for (const row of rows) {
    let providerId = providers.get(row.agent_id);
    if (providerId === undefined) {
      const kind = row.agent_id === "claude_code" ? "anthropic" : "openai";
      const result = db
        .prepare("INSERT INTO providers (name, kind, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(unique("providers", PRESET_NAMES[row.agent_id] ?? row.agent_id), kind, now, now);
      providerId = Number(result.lastInsertRowid);
      providers.set(row.agent_id, providerId);
    }
    const model = db
      .prepare(
        `INSERT INTO models (provider_id, name, model_id, price_in_per_mtok, price_out_per_mtok, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        providerId,
        unique("models", row.model_id),
        row.model_id,
        row.price_in_per_mtok,
        row.price_out_per_mtok,
        now,
        now,
      );
    db.prepare("INSERT INTO agent_models (agent_id, model_ref) VALUES (?, ?)").run(
      row.agent_id,
      Number(model.lastInsertRowid),
    );
  }
  db.exec("DROP TABLE model_catalog");
}
