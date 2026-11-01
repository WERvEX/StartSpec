import type { ExecutorSettings, McpSetup, ToolCheck } from "@km0/shared";
import { AlertTriangle, Check, Copy, FolderOpen, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { useFiles } from "@/lib/files";
import { errorMessage } from "@/lib/ipc";
import { useIpcMutation, useIpcQuery } from "@/lib/queries";

/** `KEY=value` per line ↔ an environment map; blank lines and lines without `=` are skipped. */
const envToText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
function textToEnv(text: string): Record<string, string> | null {
  const env: Record<string, string> = {};
  for (const line of text.split("\n").map((item) => item.trim())) {
    if (!line) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    if (index <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
    env[key] = line.slice(index + 1);
  }
  return env;
}

function ToolLine({ label, check }: { label: string; check: ToolCheck | undefined }) {
  const { t } = useTranslation();
  if (!check) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {check.ok ? (
        <Check className="size-4 shrink-0 text-success" />
      ) : check.found ? (
        <AlertTriangle className="size-4 shrink-0 text-warning" />
      ) : (
        <X className="size-4 shrink-0 text-danger" />
      )}
      <span className="font-medium">{label}</span>
      {check.version ? <Badge>{check.version}</Badge> : null}
      {check.command ? <code className="truncate text-xs text-muted">{check.command}</code> : null}
      {!check.found && !check.problem ? <span className="text-muted">{t("settings.execution.notFound")}</span> : null}
      {check.problem ? <p className="w-full pl-6 text-xs text-muted">{check.problem}</p> : null}
    </div>
  );
}

/** The entry to add under `mcpServers` in Claude Desktop's claude_desktop_config.json. */
export const desktopConfig = (mcp: McpSetup) =>
  JSON.stringify({ mcpServers: { km0: { command: mcp.command, args: mcp.args, env: mcp.env } } }, null, 2);

/** The same server added to Claude Code, for a chat in Claude Code rather than Claude Desktop. */
export function claudeMcpAdd(mcp: McpSetup): string {
  const quote = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`);
  const env = Object.entries(mcp.env).map(([key, value]) => `--env ${key}=${value}`);
  return ["claude mcp add km0", ...env, "--", quote(mcp.command), ...mcp.args.map(quote)].join(" ");
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${t("settings.execution.copy")} ${label}`}
          onClick={() =>
            void navigator.clipboard.writeText(text).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            })
          }
        >
          {done ? <Check /> : <Copy />}
          {done ? t("settings.execution.copied") : t("settings.execution.copy")}
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto rounded bg-sunken p-2 font-mono text-xs whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  );
}

/**
 * How hand-off packages are run from KM0: KM0 Runner by default; straight to each task's agent (Claude Code,
 * Claude Desktop through KM0's MCP server); or a command of the user's own.
 */
export function ExecutionTab() {
  const { t } = useTranslation();
  const files = useFiles();
  const settings = useIpcQuery("execution.settings.get");
  const status = useIpcQuery("execution.status");
  const save = useIpcMutation("execution.settings.set", ["execution.settings.get", "execution.status"]);
  const [draft, setDraft] = useState<ExecutorSettings | null>(null);
  const [envText, setEnvText] = useState("");

  useEffect(() => {
    if (settings.data && !draft) {
      setDraft(settings.data);
      setEnvText(envToText(settings.data.customEnv));
    }
  }, [settings.data, draft]);

  if (!draft || !status.data) return null;
  const env = textToEnv(envText);
  const dirty = JSON.stringify({ ...draft, customEnv: env ?? {} }) !== JSON.stringify(settings.data);
  const set = (patch: Partial<ExecutorSettings>) => setDraft({ ...draft, ...patch });
  const text = (value: string) => (value.trim() ? value : null);
  const browse = async (key: "runsDir" | "configFile" | "customCwd") => {
    const path = await files.choosePath(
      key === "configFile"
        ? {
            mode: "open",
            title: t("settings.execution.configFile"),
            extensions: ["yaml", "yml", "json"],
            memoryKey: "runner-config",
          }
        : { mode: "folder", title: t(`settings.execution.${key}`), memoryKey: `execution-${key}` },
    );
    if (path) set({ [key]: path });
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">{t("settings.execution.intro")}</p>
      {!status.data.available ? (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm"
        >
          <AlertTriangle className="size-4 shrink-0" />
          {status.data.reason}
        </p>
      ) : null}

      <fieldset className="grid gap-2 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold">{t("settings.execution.kind")}</legend>
        {(["runner", "direct", "custom"] as const).map((kind) => (
          <label
            key={kind}
            className={cn(
              "flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm",
              draft.kind === kind ? "border-accent bg-accent/5" : "border-border bg-panel",
            )}
          >
            <span className="flex items-center gap-2 font-medium">
              <input type="radio" name="executor" checked={draft.kind === kind} onChange={() => set({ kind })} />
              {t(`settings.execution.kinds.${kind}`)}
              {kind === "custom" ? <Badge tone="warning">{t("settings.execution.unverified")}</Badge> : null}
            </span>
            <span className="text-xs text-muted">{t(`settings.execution.kindHints.${kind}`)}</span>
          </label>
        ))}
      </fieldset>

      {draft.kind === "runner" ? (
        <section
          aria-label={t("settings.execution.kinds.runner")}
          className="flex flex-col gap-4 rounded-lg border border-border bg-panel p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-2">
              <ToolLine label="KM0 Runner" check={status.data.runner} />
              <ToolLine label="pi" check={status.data.pi} />
            </div>
            <Button size="sm" variant="ghost" onClick={() => void status.refetch()} disabled={status.isFetching}>
              <RefreshCw className={cn(status.isFetching && "animate-spin")} />
              {t("settings.execution.recheck")}
            </Button>
          </div>
          <Field
            label={t("settings.execution.runnerCommand")}
            htmlFor="runnerCommand"
            hint={t("settings.execution.runnerCommandHint")}
          >
            <Input
              id="runnerCommand"
              placeholder={t("settings.execution.automatic")}
              value={draft.runnerCommand ?? ""}
              onChange={(event) => set({ runnerCommand: text(event.target.value) })}
            />
          </Field>
          <PathField
            id="runsDir"
            label={t("settings.execution.runsDir")}
            value={draft.runsDir}
            placeholder={status.data.runsDir}
            onChange={(value) => set({ runsDir: value })}
            onBrowse={status.data.available ? () => void browse("runsDir") : null}
          />
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="mb-1.5 text-xs font-medium text-muted">{t("settings.execution.config")}</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="config"
                checked={draft.configFile === null}
                onChange={() => set({ configFile: null })}
              />
              {t("settings.execution.configGenerated")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="config"
                checked={draft.configFile !== null}
                onChange={() => set({ configFile: draft.configFile ?? "" })}
              />
              {t("settings.execution.configOwn")}
            </label>
            {draft.configFile !== null ? (
              <PathField
                id="configFile"
                label={t("settings.execution.configFile")}
                value={draft.configFile || null}
                placeholder="runner.yaml"
                onChange={(value) => set({ configFile: value ?? "" })}
                onBrowse={status.data.available ? () => void browse("configFile") : null}
              />
            ) : (
              <p className="text-xs text-muted">{t("settings.execution.configGeneratedHint")}</p>
            )}
          </fieldset>
        </section>
      ) : draft.kind === "direct" ? (
        <>
          <section
            aria-label={t("settings.execution.kinds.direct")}
            className="flex flex-col gap-4 rounded-lg border border-border bg-panel p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-2">
                <ToolLine label="Claude Code" check={status.data.claude} />
              </div>
              <Button size="sm" variant="ghost" onClick={() => void status.refetch()} disabled={status.isFetching}>
                <RefreshCw className={cn(status.isFetching && "animate-spin")} />
                {t("settings.execution.recheck")}
              </Button>
            </div>
            <p className="text-xs text-muted">{t("settings.execution.claudeLogin")}</p>
            <Field
              label={t("settings.execution.claudeCommand")}
              htmlFor="claudeCommand"
              hint={t("settings.execution.claudeCommandHint")}
            >
              <Input
                id="claudeCommand"
                placeholder={t("settings.execution.automatic")}
                value={draft.claudeCommand ?? ""}
                onChange={(event) => set({ claudeCommand: text(event.target.value) })}
              />
            </Field>
            <PathField
              id="runsDir"
              label={t("settings.execution.runsDir")}
              value={draft.runsDir}
              placeholder={status.data.runsDir}
              onChange={(value) => set({ runsDir: value })}
              onBrowse={status.data.available ? () => void browse("runsDir") : null}
            />
          </section>
          <section
            aria-label="Claude Desktop"
            className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4"
          >
            <h3 className="text-sm font-semibold">Claude Desktop</h3>
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
              {(t("settings.execution.desktopSteps", { returnObjects: true }) as string[]).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {status.data.mcp ? (
              <>
                <CopyBlock label={t("settings.execution.desktopConfig")} text={desktopConfig(status.data.mcp)} />
                <CopyBlock label={t("settings.execution.claudeCodeMcp")} text={claudeMcpAdd(status.data.mcp)} />
              </>
            ) : null}
          </section>
        </>
      ) : (
        <section
          aria-label={t("settings.execution.kinds.custom")}
          className="flex flex-col gap-4 rounded-lg border border-border bg-panel p-4"
        >
          <p className="flex items-start gap-2 text-sm text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {t("settings.execution.customWarning")}
          </p>
          <Field
            label={t("settings.execution.customTemplate")}
            htmlFor="customTemplate"
            hint={t("settings.execution.customTemplateHint")}
          >
            <Textarea
              id="customTemplate"
              rows={3}
              className="font-mono text-xs"
              value={draft.customTemplate ?? ""}
              onChange={(event) => set({ customTemplate: text(event.target.value) })}
            />
          </Field>
          <PathField
            id="customCwd"
            label={t("settings.execution.customCwd")}
            value={draft.customCwd}
            placeholder={t("settings.execution.customCwdDefault")}
            onChange={(value) => set({ customCwd: value })}
            onBrowse={status.data.available ? () => void browse("customCwd") : null}
          />
          <Field
            label={t("settings.execution.customEnv")}
            htmlFor="customEnv"
            hint={t("settings.execution.customEnvHint")}
            error={env ? undefined : t("settings.execution.invalidEnv")}
          >
            <Textarea
              id="customEnv"
              rows={3}
              className="font-mono text-xs"
              value={envText}
              onChange={(event) => setEnvText(event.target.value)}
            />
          </Field>
        </section>
      )}

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          disabled={!dirty || !env || save.isPending || (draft.configFile !== null && !draft.configFile)}
          onClick={() =>
            save.mutate(
              { ...draft, configFile: draft.configFile || null, customEnv: env ?? {} },
              { onSuccess: (saved) => setDraft(saved) },
            )
          }
        >
          {t("settings.execution.save")}
        </Button>
        {save.error ? <span className="text-sm text-danger">{errorMessage(save.error)}</span> : null}
      </div>
    </div>
  );
}

function PathField({
  id,
  label,
  value,
  placeholder,
  onChange,
  onBrowse,
}: {
  id: string;
  label: string;
  value: string | null;
  placeholder: string;
  onChange: (value: string | null) => void;
  onBrowse: (() => void) | null;
}) {
  const { t } = useTranslation();
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex gap-2">
        <Input
          id={id}
          placeholder={placeholder}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value.trim() ? event.target.value : null)}
        />
        {onBrowse ? (
          <Button aria-label={`${t("settings.execution.browse")} ${label}`} onClick={onBrowse}>
            <FolderOpen />
            {t("settings.execution.browse")}
          </Button>
        ) : null}
      </div>
    </Field>
  );
}
