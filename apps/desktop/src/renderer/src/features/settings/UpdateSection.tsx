import type { UpdateState } from "@km0/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Download, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/ipc";
import { useIpcMutation, useIpcQuery } from "@/lib/queries";

/** Keeps the update state current from `update.state` events. */
export function useUpdateState() {
  const queryClient = useQueryClient();
  const state = useIpcQuery("update.state");
  useEffect(
    () => window.km0.on("update.state", (next: UpdateState) => queryClient.setQueryData(["update.state"], next)),
    [queryClient],
  );
  return state;
}

/** Updating KM0 from its GitHub Releases: check, download, restart, all in this page. */
export function UpdateSection() {
  const { t, i18n } = useTranslation();
  const state = useUpdateState();
  const preferences = useIpcQuery("settings.preferences.get");
  const savePreferences = useIpcMutation("settings.preferences.set", ["settings.preferences.get"]);
  // Held here so the box flips on click, not after the save comes back.
  const [autoUpdate, setAutoUpdate] = useState<boolean | null>(null);
  const check = useIpcMutation("update.check");
  const download = useIpcMutation("update.download");
  const install = useIpcMutation("update.install");
  const data = state.data;
  if (!data) return null;
  const error = check.error ?? download.error ?? install.error;
  const when = data.checkedAt ? new Date(data.checkedAt).toLocaleString(i18n.language) : null;

  return (
    <section
      aria-label={t("settings.about.update.title")}
      className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4"
    >
      <h2 className="text-sm font-semibold">{t("settings.about.update.title")}</h2>
      {data.status === "unsupported" ? (
        <p className="text-sm text-muted">{data.detail}</p>
      ) : (
        <>
          <p role="status" className="text-sm">
            {data.status === "checking" ? (
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                {t("settings.about.update.checking")}
              </span>
            ) : data.status === "available" ? (
              t("settings.about.update.available", { version: data.version })
            ) : data.status === "downloading" ? (
              t("settings.about.update.downloading", { version: data.version, percent: data.percent ?? 0 })
            ) : data.status === "downloaded" ? (
              t("settings.about.update.downloaded", { version: data.version })
            ) : data.status === "current" ? (
              t("settings.about.update.current", { when })
            ) : data.status === "error" ? (
              <span className="text-danger">{t("settings.about.update.failed", { detail: data.detail })}</span>
            ) : (
              t("settings.about.update.idle", { version: data.currentVersion })
            )}
          </p>
          {data.feed ? (
            <p className="text-xs text-muted">{t("settings.about.update.feed", { url: data.feed })}</p>
          ) : null}
          {data.status === "downloading" ? (
            <Progress value={data.percent ?? 0} max={100} label={t("settings.about.update.progress")} />
          ) : null}
          {data.notes &&
          (data.status === "available" || data.status === "downloaded" || data.status === "downloading") ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted">{t("settings.about.update.notes")}</summary>
              <div className="mt-1 max-h-48 overflow-auto rounded bg-sunken p-2 whitespace-pre-wrap">{data.notes}</div>
            </details>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {data.status === "available" ? (
              <Button
                size="sm"
                variant="primary"
                disabled={download.isPending}
                onClick={() => download.mutate(undefined)}
              >
                <Download />
                {t("settings.about.update.download")}
              </Button>
            ) : data.status === "downloaded" ? (
              <Button
                size="sm"
                variant="primary"
                disabled={install.isPending}
                onClick={() => install.mutate(undefined)}
              >
                <RotateCcw />
                {t("settings.about.update.install")}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={data.status === "checking" || data.status === "downloading" || check.isPending}
                onClick={() => check.mutate(undefined)}
              >
                <RefreshCw />
                {t("settings.about.update.check")}
              </Button>
            )}
          </div>
          {error ? <p className="text-sm text-danger">{errorMessage(error)}</p> : null}
          {preferences.data ? (
            <label className="flex w-fit items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoUpdate ?? preferences.data.autoUpdate}
                onChange={(event) => {
                  setAutoUpdate(event.target.checked);
                  savePreferences.mutate({ autoUpdate: event.target.checked });
                }}
              />
              {t("settings.about.update.auto")}
            </label>
          ) : null}
        </>
      )}
    </section>
  );
}

/** App-wide: a toast the first time a newer version is found, pointing to the About page. */
export function UpdateWatcher() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const announced = useRef<string | null>(null);
  useEffect(
    () =>
      window.km0.on("update.state", (next: UpdateState) => {
        if (next.status !== "available" || !next.version || announced.current === next.version) return;
        announced.current = next.version;
        toast({
          kind: "info",
          message: t("settings.about.update.available", { version: next.version }),
          action: {
            label: t("settings.about.update.open"),
            onClick: () => void navigate({ to: "/settings", search: { tab: "about" } }),
          },
        });
      }),
    [t, toast, navigate],
  );
  return null;
}
