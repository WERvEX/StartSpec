import type { ConfigBundleV1 } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { AgentStore } from "./agent-store";
import { ConfigService } from "./config-service";
import { SearchStore } from "./search-store";
import { PlainSecretStore } from "./secrets";
import { SettingsStore } from "./settings-store";

function install() {
  const db = openDatabase(":memory:");
  const secrets = new PlainSecretStore();
  const settings = new SettingsStore(db, secrets);
  const agents = new AgentStore(db, () => settings.listModels());
  const search = new SearchStore(db, secrets, {});
  return {
    settings,
    agents,
    search,
    config: new ConfigService(settings, agents, search, () => "2026-10-18T00:00:00Z"),
  };
}

function configured() {
  const app = install();
  const relay = app.settings.createProvider({
    name: "Relay",
    kind: "openai",
    baseUrl: "https://relay.example/v1",
    apiKey: "sk-relay-123456",
    billing: { mode: "relay", multiplier: 0.6 },
  });
  const anthropic = app.settings.createProvider({ name: "Anthropic", kind: "anthropic" });
  const router = app.settings.createModel({ providerId: relay.id, modelId: "m1", name: "Fast" });
  const planner = app.settings.createModel({ providerId: anthropic.id, modelId: "claude-opus-5-5", name: "Strong" });
  const gpt = app.settings.createModel({
    providerId: relay.id,
    modelId: "gpt-x",
    priceInPerMTok: 1,
    priceOutPerMTok: 4,
  });
  app.settings.setRoles({ router: router.id, planner: planner.id });
  app.settings.setPreferences({ language: "en", theme: "dark" });
  app.agents.update("codex", false, [gpt.id], ["frontend"]);
  app.agents.move("zcode", "up");
  app.agents.createCustom({
    name: "Gemini CLI",
    instructionFile: "GEMINI.md",
    launchTemplate: "gemini -m {model} -p {prompt}",
    nativeVendor: "google",
    capabilities: ["frontend"],
  });
  app.search.create({ name: "Bocha", config: { kind: "bocha" }, secret: "sk-bocha-999999" });
  return app;
}

describe("ConfigService", () => {
  it("leaves keys out unless asked", () => {
    const { config } = configured();
    const plain = config.export(false);
    expect(JSON.stringify(plain)).not.toContain("sk-");
    expect(plain).toMatchObject({ format: "km0-config", version: 2, includesSecrets: false });
    expect(plain.roles).toEqual({ router: "Fast", planner: "Strong" });

    const full = config.export(true);
    expect(full.providers.find((provider) => provider.name === "Relay")?.apiKey).toBe("sk-relay-123456");
    expect(full.searchServices[0]?.secret).toBe("sk-bocha-999999");
  });

  it("restores everything on a fresh install", () => {
    const source = configured();
    const bundle = source.config.export(true);
    const target = install();
    const summary = target.config.import(bundle);
    expect(summary).toEqual({
      providersCreated: 2,
      // The seeded Claude Code provider is updated in place.
      providersUpdated: 1,
      modelsCreated: 3,
      modelsUpdated: 3,
      searchCreated: 1,
      searchUpdated: 0,
      agentsUpdated: 8,
      agentsCreated: 1,
      localServersDisabled: 0,
      rolesSet: true,
    });
    const names = (id: number | null) => target.settings.listModels().find((model) => model.id === id)?.name;
    const roles = target.settings.getRoles();
    expect([names(roles.router), names(roles.planner)]).toEqual(["Fast", "Strong"]);
    expect(target.settings.getPreferences()).toEqual({ language: "en", theme: "dark", autoUpdate: true });
    expect(target.agents.list().map((agent) => agent.id)).toEqual(source.agents.list().map((agent) => agent.id));
    expect(target.agents.list().find((agent) => agent.id === "codex")).toMatchObject({
      enabled: false,
      models: [expect.objectContaining({ modelId: "gpt-x", priceInPerMTok: 0.6, priceOutPerMTok: 2.4 })],
      capabilities: ["frontend"],
    });
    expect(target.agents.list().find((agent) => agent.kind === "custom")).toMatchObject({
      name: "Gemini CLI",
      instructionFile: "GEMINI.md",
      nativeVendors: ["google"],
    });
    expect(target.settings.listProviders().find((provider) => provider.name === "Relay")).toMatchObject({
      hasApiKey: true,
      billing: { mode: "relay", multiplier: 0.6 },
    });
    expect(target.search.list()[0]).toMatchObject({ name: "Bocha", hasSecret: true });
    expect(target.config.export(true)).toEqual(bundle);
  });

  it("merges by name and keeps stored keys when the file has none", () => {
    const app = configured();
    const bundle = app.config.export(false);
    const fast = bundle.models.find((model) => model.name === "Fast");
    if (fast) fast.modelId = "m2";
    const summary = app.config.import(bundle);
    expect(summary).toMatchObject({ providersCreated: 0, modelsCreated: 0, agentsCreated: 0, searchUpdated: 1 });
    expect(app.settings.listModels().find((item) => item.name === "Fast")).toMatchObject({ modelId: "m2" });
    expect(app.settings.listProviders().find((item) => item.name === "Relay")?.hasApiKey).toBe(true);
    expect(app.search.list()[0]?.hasSecret).toBe(true);
  });

  it("reads files from KM0 0.1, turning profiles and typed agent models into providers and models", () => {
    const app = install();
    const old: ConfigBundleV1 = {
      format: "km0-config",
      version: 1,
      exportedAt: "2026-10-01T00:00:00Z",
      includesSecrets: true,
      profiles: [
        {
          name: "DeepSeek",
          provider: "openai",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          apiKey: "sk-old-key-1234",
          structuredMode: "tool",
          temperature: null,
          priceInPerMTok: 0.15,
          priceOutPerMTok: 0.6,
        },
      ],
      roles: { router: "DeepSeek", planner: null },
      preferences: { language: "zh-CN" },
      agents: [
        {
          id: "codex",
          enabled: true,
          models: { T1: null, T2: { modelId: "gpt-6-sol", priceInPerMTok: 2, priceOutPerMTok: 8 }, T3: null },
          capabilities: ["backend"],
        },
      ],
      searchServices: [],
    };
    const summary = app.config.import(old);
    expect(summary).toMatchObject({ providersCreated: 2, modelsCreated: 2, agentsUpdated: 1, rolesSet: true });
    expect(app.settings.profileForRole("router")).toMatchObject({
      model: "deepseek-v4-flash",
      apiKey: "sk-old-key-1234",
      structuredMode: "tool",
    });
    expect(app.agents.list().find((agent) => agent.id === "codex")?.models[0]).toMatchObject({
      modelId: "gpt-6-sol",
      priceInPerMTok: 2,
    });
  });

  it("imports a local MCP server disabled unless its command is already trusted here", () => {
    const app = install();
    const local = {
      name: "Local",
      enabled: true,
      config: {
        kind: "mcp_stdio" as const,
        command: "npx",
        args: ["-y", "search-a"],
        toolName: "search",
        queryArg: "query",
      },
    };
    const bundle = { ...app.config.export(false), searchServices: [local] };
    expect(app.config.import(bundle).localServersDisabled).toBe(1);
    expect(app.search.list()[0]?.enabled).toBe(false);

    // Once the user enables it, importing the same command again leaves it enabled.
    const id = app.search.list()[0]?.id as number;
    app.search.update(id, { ...local, enabled: true });
    expect(app.config.import(bundle).localServersDisabled).toBe(0);
    expect(app.search.list()[0]?.enabled).toBe(true);

    // A different command is disabled again.
    const changed = { ...local, config: { ...local.config, args: ["-y", "something-else"] } };
    expect(app.config.import({ ...bundle, searchServices: [changed] }).localServersDisabled).toBe(1);
    expect(app.search.list()[0]?.enabled).toBe(false);
  });
});
