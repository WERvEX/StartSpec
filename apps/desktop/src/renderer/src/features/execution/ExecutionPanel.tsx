import {
  AGENT_NAMES,
  type ExecTask,
  type ExecTaskStatus,
  type ExecutionRun,
  isPresetAgent,
  type Precheck,
  type PrecheckItem,
} from "@km0/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowUp, Check, FolderGit2, Info, Loader2, Play, RotateCcw, Square, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/cn";
import { call, errorMessage } from "@/lib/ipc";
import { useIpcQuery } from "@/lib/queries";
import { projectKey } from "../project/useProject";
import { runnerKey } from "../runner/RunnerPanel";
import { executionKey } from "./ExecutionWatcher";

const usd = (value: number) => (value === 0 ? "$0" : value < 0.01 ? "<$0.01" : `$${value.toFixed(value < 1 ? 3 : 2)}`);

const TASK_TONE: Record<ExecTaskStatus, "neutral" | "accent" | "success" | "warning" | "danger"> = {
  waiting: "neutral",
  awaiting: "warning",
  running: "accent",
  passed: "success",
  unjudged: "neutral",
  failed: "danger",
  blocked: "warning",
  cancelled: "neutral",
};
const RUN_TONE = {
  running: "accent",
  stopping: "warning",
  finished: "success",
  cancelled: "neutral",
  failed: "danger",
  interrupted: "warning",
} as const;
const DONE = new Set<ExecTaskStatus>(["passed", "unjudged", "failed", "blocked", "cancelled"]);

/** Run the routed tasks from KM0: check first, start, follow each task, stop, and redo what did not pass. */
export function ExecutionPanel({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const status = useIpcQuery("execution.status");
  const settings = useIpcQuery("execution.settings.get");
  const runs = useQuery({ queryKey: executionKey(projectId), queryFn: () => call("execution.list", { projectId }) });
  const verdicts = useQuery({ queryKey: runnerKey(projectId), queryFn: () => call("runner.list", { projectId }) });
  const [checking, setChecking] = useState(false);
  const [stopTarget, setStopTarget] = useState<ExecutionRun | null>(null);
  const start = useMutation({
    mutationFn: (input: { seqs?: number[]; reuse?: string | null }) =>
      call("execution.start", { projectId, seqs: input.seqs ?? [], reuse: input.reuse ?? null }),
    onSuccess: (run) => {
      setChecking(false);
      queryClient.setQueryData<ExecutionRun[]>(executionKey(projectId), (list) => [
        run,
        ...(list ?? []).filter((item) => item.id !== run.id),
      ]);
      void queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
    },
  });
  const stop = useMutation({
    mutationFn: (runRef: number) => call("execution.stop", { projectId, runRef }),
    onSuccess: () => setStopTarget(null),
  });

  const available = status.data?.available ?? false;
  const list = runs.data ?? [];
  const running = list.some((run) => run.status === "running" || run.status === "stopping");
  const custom = settings.data?.kind === "custom";
  const direct = settings.data?.kind === "direct";
  const rejectedSeqs = (run: ExecutionRun) => {
    const imported = verdicts.data?.find((item) => item.id === run.importedRunRef);
    const rejected = imported?.results.filter((result) => result.accepted === false).map((result) => result.seq) ?? [];
    const unfinished = run.tasks.filter((task) => ["failed", "blocked", "cancelled"].includes(task.status));
    return [...new Set([...rejected, ...unfinished.map((task) => task.seq)])].sort((a, b) => a - b);
  };

  return (
    <section
      aria-label={t("execution.title")}
      className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-medium">
            <Play className="size-4" />
            {t("execution.title")}
            {custom ? <Badge tone="warning">{t("execution.custom")}</Badge> : null}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {available
              ? t(custom ? "execution.introCustom" : direct ? "execution.introDirect" : "execution.intro")
              : status.data?.reason}
          </p>
        </div>
        <Button variant="primary" disabled={!available || running || start.isPending} onClick={() => setChecking(true)}>
          <Play />
          {t("execution.start")}
        </Button>
      </div>
      {start.error && !checking ? <p className="text-sm text-danger">{errorMessage(start.error)}</p> : null}

      {list.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {list.slice(0, 5).map((run) => (
            <RunCard
              key={run.id}
              run={run}
              redo={rejectedSeqs(run)}
              busy={start.isPending || running}
              onStop={() => setStopTarget(run)}
              onRedo={(seqs) => start.mutate({ seqs, reuse: run.runId })}
            />
          ))}
        </ul>
      ) : null}

      <PrecheckDialog
        projectId={projectId}
        open={checking}
        starting={start.isPending}
        startError={start.error ? errorMessage(start.error) : null}
        onCancel={() => {
          setChecking(false);
          start.reset();
        }}
        onStart={() => start.mutate({})}
      />
      <ConfirmDialog
        open={stopTarget !== null}
        title={t("execution.stopTitle")}
        description={t("execution.stopBody")}
        confirmLabel={t("execution.stop")}
        cancelLabel={t("execution.keepRunning")}
        danger
        pending={stop.isPending}
        onCancel={() => setStopTarget(null)}
        onConfirm={() => stopTarget && stop.mutate(stopTarget.id)}
      />
    </section>
  );
}

function RunCard({
  run,
  redo,
  busy,
  onStop,
  onRedo,
}: {
  run: ExecutionRun;
  redo: number[];
  busy: boolean;
  onStop: () => void;
  onRedo: (seqs: number[]) => void;
}) {
  const { t, i18n } = useTranslation();
  const live = run.status === "running" || run.status === "stopping";
  const done = run.tasks.filter((task) => DONE.has(task.status)).length;
  const started = new Date(run.startedAt).toLocaleString(i18n.language);
  return (
    <li aria-label={t("execution.runLabel", { runId: run.runId })} className="rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <Badge tone={RUN_TONE[run.status]}>
            {live ? <Loader2 className="size-3 animate-spin" /> : null}
            {t(`execution.status.${run.status}`)}
          </Badge>
          <code className="text-xs">{run.runId}</code>
          <span className="text-xs text-muted">{started}</span>
          {run.reuse ? <Badge>{t("execution.redoOf", { seqs: run.seqs.join(", "), runId: run.reuse })}</Badge> : null}
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className={cn(run.budget !== null && run.cost > run.budget && "text-danger")}>
            {run.budget !== null
              ? t("execution.costOfBudget", { cost: usd(run.cost), budget: usd(run.budget) })
              : t("execution.cost", { cost: usd(run.cost) })}
          </span>
          {live ? (
            <Button size="sm" disabled={run.status === "stopping"} onClick={onStop}>
              <Square />
              {run.status === "stopping" ? t("execution.stopping") : t("execution.stop")}
            </Button>
          ) : null}
        </div>
      </div>
      {run.tasks.length > 0 ? (
        <div className="px-3 pt-2">
          <Progress
            value={done}
            max={run.tasks.length}
            label={t("execution.progress", { done, total: run.tasks.length })}
          />
          <p className="mt-1 text-xs text-muted">{t("execution.progress", { done, total: run.tasks.length })}</p>
        </div>
      ) : null}
      {run.tasks.length > 0 ? (
        <ul className="divide-y divide-border px-3">
          {run.tasks.map((task) => (
            <TaskRow key={task.taskId} task={task} />
          ))}
        </ul>
      ) : null}
      {run.error ? (
        <p role="alert" className="mx-3 my-2 whitespace-pre-wrap rounded bg-danger/5 p-2 text-xs text-danger">
          {run.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        {run.log.length > 0 ? (
          <details className="min-w-0 flex-1 text-xs">
            <summary className="cursor-pointer text-muted">{t("execution.log")}</summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-sunken p-2 font-mono whitespace-pre-wrap">
              {run.log.slice(-20).join("\n")}
            </pre>
          </details>
        ) : (
          <span />
        )}
        {run.importedRunRef !== null ? <span className="text-xs text-muted">{t("execution.imported")}</span> : null}
        {!live && redo.length > 0 && run.executor !== "custom" ? (
          <Button size="sm" disabled={busy} onClick={() => onRedo(redo)}>
            <RotateCcw />
            {t("execution.redo", { seqs: redo.join(", ") })}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** A preset's name, or a custom agent's id. */
const agentName = (id: string) => (isPresetAgent(id) ? AGENT_NAMES[id] : id);

function TaskRow({ task }: { task: ExecTask }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm">
      <span className="w-6 text-muted">{task.seq}</span>
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      {task.agent || task.tier ? (
        <span className="text-xs text-muted">
          {[task.agent ? agentName(task.agent) : null, task.tier, task.model].filter(Boolean).join(" · ")}
        </span>
      ) : null}
      {task.escalations.length > 0 ? (
        <Badge
          tone="warning"
          title={task.escalations.map((item) => `${item.from}→${item.to}: ${item.detail}`).join("\n")}
        >
          <ArrowUp className="size-3" />
          {task.escalations.map((item) => item.to).join(" → ")}
        </Badge>
      ) : null}
      <span className="w-14 text-right text-xs text-muted">{usd(task.cost)}</span>
      <Badge tone={TASK_TONE[task.status]} title={task.detail || undefined}>
        {task.status === "running" ? <Loader2 className="size-3 animate-spin" /> : null}
        {t(`execution.taskStatus.${task.status}`)}
      </Badge>
      {task.status === "awaiting" ? (
        <p className="w-full pl-9 text-xs text-muted">{t("execution.awaitingHint")}</p>
      ) : null}
    </li>
  );
}

function PrecheckDialog({
  projectId,
  open,
  starting,
  startError,
  onCancel,
  onStart,
}: {
  projectId: number;
  open: boolean;
  starting: boolean;
  startError: string | null;
  onCancel: () => void;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const check = useQuery({
    queryKey: ["execution.precheck", projectId],
    queryFn: () => call("execution.precheck", { projectId }),
    enabled: open,
    gcTime: 0,
  });
  const linkRepo = useMutation({
    mutationFn: async () => {
      const path = await call("repo.pick", undefined);
      if (path) await call("project.setRepo", { id: projectId, path });
      return path;
    },
    onSuccess: () => {
      void check.refetch();
      void queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
    },
  });
  const data: Precheck | undefined = check.data;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      title={t("execution.precheck.title")}
      description={t("execution.precheck.body")}
      wide
      footer={
        <>
          <Button onClick={onCancel}>{t("execution.precheck.cancel")}</Button>
          <Button variant="primary" disabled={!data?.ok || starting || check.isFetching} onClick={onStart}>
            {starting ? <Loader2 className="animate-spin" /> : <Play />}
            {t("execution.precheck.start")}
          </Button>
        </>
      }
    >
      {check.isFetching && !data ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" />
          {t("execution.precheck.checking")}
        </p>
      ) : null}
      {check.error ? <p className="text-sm text-danger">{errorMessage(check.error)}</p> : null}
      {data ? (
        <ul className="flex flex-col gap-2.5 text-sm">
          {data.items.map((item) => (
            <PrecheckRow key={item.id} item={item} onLinkRepo={() => linkRepo.mutate()} linking={linkRepo.isPending} />
          ))}
        </ul>
      ) : null}
      {linkRepo.error ? <p className="mt-2 text-sm text-danger">{errorMessage(linkRepo.error)}</p> : null}
      {startError ? <p className="mt-2 text-sm text-danger">{startError}</p> : null}
    </Dialog>
  );
}

function PrecheckRow({ item, onLinkRepo, linking }: { item: PrecheckItem; onLinkRepo: () => void; linking: boolean }) {
  const { t } = useTranslation();
  const icon = item.ok ? (
    item.id === "ladder" ? (
      <Info className="mt-0.5 size-4 shrink-0 text-muted" />
    ) : (
      <Check className="mt-0.5 size-4 shrink-0 text-success" />
    )
  ) : item.blocking ? (
    <X className="mt-0.5 size-4 shrink-0 text-danger" />
  ) : (
    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
  );
  return (
    <li className="flex items-start gap-2">
      {icon}
      <div className="min-w-0 flex-1">
        <span className="font-medium">{t(`execution.precheck.items.${item.id}`)}</span>
        <p className="break-words text-muted">{item.detail}</p>
        {!item.ok && item.fix === "project" ? (
          <Button size="sm" className="mt-1" disabled={linking} onClick={onLinkRepo}>
            <FolderGit2 />
            {t("execution.precheck.linkRepo")}
          </Button>
        ) : null}
        {!item.ok && (item.fix === "settings.execution" || item.fix === "settings.models") ? (
          <Link
            to="/settings"
            search={{ tab: item.fix === "settings.execution" ? "execution" : "models" }}
            className="mt-1 inline-block text-accent underline"
          >
            {t(item.fix === "settings.execution" ? "execution.precheck.toExecution" : "execution.precheck.toModels")}
          </Link>
        ) : null}
      </div>
    </li>
  );
}
