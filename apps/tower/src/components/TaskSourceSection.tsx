import { useOwnerToast } from '@/lib/browser-context';
import { Check, ClipboardCopy } from "lucide-react";
import { type ReactNode } from "react";
import { Link } from "react-router-dom";

import type { TaskHubConnection, TaskHubSpoke } from "@shared/settings";
import initialFreezeRegister from "../../../../docs/templates/project-freeze-register.md?raw";
import {
  TASK_SOURCES_PATH,
  BEADS,
  taskSourceConnection,
  type TaskSourcePayload,
} from "@shared/task-source";
import { EmptyState } from "@/components/EmptyState";
import { StateChip } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { pillControlClass } from "@/components/ui/pill";
import { useCopyFlash } from "@/hooks/useCopyFlash";
import { useNow } from "@/hooks/useNow";
import { useTaskSource } from "@/hooks/useTaskSource";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

// Core task hub status and project management (D32). Hub availability never
// controls whether Tasks exists; reads and writes retain their own failures.

export function TaskSourceRows({ payload, nowMs, anchor = "task-source-status" }: {
  payload: TaskSourcePayload;
  nowMs: number;
  anchor?: string;
}) {
  return (
    <section id={anchor} aria-label="Task database" className="flex flex-col gap-2">
      {payload.sources.map((status) => {
        const kind = taskSourceConnection(status, nowMs);
        const label = kind === "not-connected" ? "No projects" : kind === "collecting" ? "Waiting for first read" :
          kind === "overdue" ? "Stale" : kind === "failing" ? "Unavailable" : "Available";
        const tone = kind === "failing" ? "critical" : kind === "overdue" || kind === "not-connected" ? "caution" :
          kind === "working" ? "affirmative" : "na";
        return (
          <div key={status.id} className="flex flex-wrap items-center gap-3" data-task-hub-state={kind}>
            <span className="font-medium">Task database</span>
            <StateChip tone={tone} label={label} subject={`tasks:${status.id}`} />
            <span className="text-sm text-muted-foreground tabular-nums">{status.projects} {status.projects === 1 ? "project" : "projects"}</span>
            {status.failing > 0 && kind !== "failing" ? <span className="text-sm text-warn tabular-nums">{status.failing} unavailable</span> : null}
          </div>
        );
      })}
    </section>
  );
}

/** Status lives beside Task projects in Settings, separate from providers. */
export function TaskSourceSection() {
  const { data, isError } = useTaskSource();
  const now = useNow();
  return data ? <TaskSourceRows payload={data} nowMs={now} /> : (
    <StateChip tone={isError ? "caution" : "na"} label={isError ? "Task database status unavailable" : "Checking task database"} subject={`tasks:${BEADS}`} />
  );
}

export const NO_HUB_CONNECTION =
  "This build does not carry the connection details. config/beads.README.md has the command.";

/** `bd init` for one project against this machine's task hub, or null where
 * the build carries no connection. `bd` derives the database from the prefix,
 * so `--database` is a flag only when the project's two names differ. */
export function taskProjectInitCommand(spoke: Pick<TaskHubSpoke, "prefix" | "database">, hub: TaskHubConnection | null, explicitDatabase = false): string | null {
  if (hub === null) return null;
  // These are the register's identifiers, never arbitrary shell arguments.
  if (!/^[a-z]{2,8}$/u.test(spoke.prefix) || !/^[a-z][a-z0-9_]*$/u.test(spoke.database)) return null;
  if (hub.initCommand) return `${hub.initCommand} --repo . --prefix ${spoke.prefix} --database ${spoke.database}`;
  const database = !explicitDatabase && spoke.database === spoke.prefix ? "" : ` --database ${spoke.database}`;
  return `bd init --server --external --server-host ${hub.host} --server-port ${hub.port} ` +
    `--server-user ${hub.user} --prefix ${spoke.prefix}${database} ` +
    `--non-interactive --skip-agents --skip-hooks`;
}

/**
 * What is left to do on the host once a task project is saved —
 * `config/beads.README.md`'s own onboarding steps, filled in with the project.
 * Drawn after an Add on Settings → Task projects.
 *
 * It is the one place a project's setup uses the machinery's own words (doc
 * 17): a command has to be copied verbatim into a terminal, so its flags are
 * quoted exactly and every block says what it is and where it runs.
 *
 * TITLES AND THE TEXT TO PASTE, NOTHING ELSE (bead `ro-ujb9.96.6.3`). The text
 * to paste already does the right thing: the command carries `--external`, the
 * legacy config edit is drawn as a diff; the host helper performs that edit
 * itself. Repository preparation preserves existing instructions and starts
 * absent measurement state as unknown; the host entry comes from the row.
 */
export function TaskProjectSteps({
  spoke,
  hub,
  onDismiss,
}: {
  spoke: TaskHubSpoke;
  hub: TaskHubConnection | null;
  /** Settings closes the list after an Add. */
  onDismiss?: () => void;
}) {
  const checkout = spoke.repo || "the project checkout";
  const usesHostHelper = Boolean(hub?.initCommand);
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3"
      data-project-checklist={spoke.asset}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground">
          {spoke.asset} is mapped — {usesHostHelper ? "three" : "four"} steps left
        </h4>
        {onDismiss ? (
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            Done
          </Button>
        ) : null}
      </div>

      <ChecklistStep n={1} title="Initialize a new task database">
        <CommandBlock command={taskProjectInitCommand(spoke, hub)} label={`Terminal · run in ${checkout}`} fallback={NO_HUB_CONNECTION} />
      </ChecklistStep>
      {!usesHostHelper ? <ChecklistStep n={2} title="Keep it on the shared database">
        <CommandBlock
          removed="sync.remote: …"
          command={"no-git-ops: true\nimport.auto: false"}
          label={`File · ${checkout}/.beads/config.yaml`}
        />
      </ChecklistStep> : null}
      <ChecklistStep n={usesHostHelper ? 2 : 3} title={hub?.contextCommand ? "Prepare project instructions" : "Review measurement windows"}>
        <CommandBlock
          command={hub?.contextCommand ?? initialFreezeRegister}
          label={hub?.contextCommand ? `Terminal · run in ${checkout}` : `New file · ${checkout}/docs/freeze-register.md`}
        />
      </ChecklistStep>
      <ChecklistStep n={usesHostHelper ? 3 : 4} title="Link the checkout here">
        <CommandBlock
          command={JSON.stringify({ asset: spoke.asset, prefix: spoke.prefix, database: spoke.database, repo: "/path/to/checkout" }, null, 2)}
          label="File · installation/task-host.json · repositories"
        />
      </ChecklistStep>
    </div>
  );
}

/** One numbered step: its title, and the block to copy. */
function ChecklistStep({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2.5" data-checklist-step={n}>
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-[11px] font-medium text-muted-foreground">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h5 className="text-xs font-medium text-foreground">{title}</h5>
        {children}
      </div>
    </div>
  );
}

/**
 * The exact text to paste, labelled with where it goes, with Copy — a block an
 * operator can use without reading any prose.
 *
 * `removed` draws a line to delete above the text to add, as a diff: struck and
 * marked `−` in the error tone, the added lines marked `+`. Copy copies only
 * what is added — the removed line is an instruction, not a paste.
 */
export function CommandBlock({
  command,
  label,
  fallback,
  removed,
}: {
  command: string | null;
  label: string;
  fallback?: string;
  removed?: string;
}) {
  const toast = useOwnerToast();
  const [copied, flashCopied] = useCopyFlash();
  if (command === null) {
    return <span className="text-xs leading-snug text-muted-foreground">{fallback}</span>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-background p-2" data-command-block>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all text-[11px] uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${copied ? "Copied" : "Copy"} — ${label}`}
          onClick={() => {
            void copyText(command)
              .then(() => flashCopied())
              .catch(() => toast.error("Copy failed — select the text instead"));
          }}
        >
          {copied ? <Check aria-hidden className="size-3.5" /> : <ClipboardCopy aria-hidden className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {removed ? (
        <pre className="font-mono text-[11px] leading-relaxed text-error" data-command-removed>
          <span aria-hidden>− </span>
          <del>{removed}</del>
        </pre>
      ) : null}
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
        {removed
          ? command
              .split("\n")
              .map((line) => `+ ${line}`)
              .join("\n")
          : command}
      </pre>
    </div>
  );
}

/**
 * An unread or unconfigured core hub leads to the existing project settings.
 * This is not an empty queue and never hides known tasks.
 */
export function TaskHubUnavailable() {
  return (
    <div className="rounded-[10px] border border-border bg-card p-4" data-task-hub-unavailable>
      <EmptyState
        title="No task projects available"
        hint={
          <Link
            to={TASK_SOURCES_PATH}
            className={cn(
              "inline-flex items-center font-medium text-foreground underline-offset-4 hover:underline",
              pillControlClass,
            )}
          >
            Manage task projects →
          </Link>
        }
      />
    </div>
  );
}
