import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import { ChevronDown, Link2, ListPlus, Lock, Plus, X } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import type { TaskHubSpoke } from "@shared/settings";
import {
  READ_ONLY_TASKS_HINT,
  taskWritesAvailable,
  type TaskCreated,
  type TasksCapabilities,
} from "@shared/tasks";
import { DEMO_READ_ONLY } from '@shared/demo-viewer';
import { PRIORITY_BANDS } from "@shared/work";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { Badge } from "@/components/ui/badge";
import { Button, type ButtonProps } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { useCreateTask, useTasksLive, useTaskProjects } from "@/hooks/useTasks";
import { taskPath } from '@/lib/task-path';
import { useSettings } from "@/hooks/useSettings";
import { useWork } from "@/hooks/useWork";
import { ApiError, type NewTask } from "@/lib/api";
import type { TaskHandoffKind } from "@/lib/task-handoff";
import { cn } from "@/lib/utils";
import { taskMetadataValue } from "@noticeos/contract/task-metadata";

/**
 * Where the toast's Open link points after a task is filed: the task's own page
 * (`ro-l1ed.3`), which is where every other bead id in the Tower already leads —
 * the finding's filing badge, the decision rows, the timeline's resolved refs.
 * The id is also stated in the toast text, so the one thing the operator can act
 * on is readable whether or not they follow the link.
 */
export const filedTaskPath = taskPath;

/** The desk's field chrome (`components/ui/field`), full width with the extra
 * vertical room a stacked composer reads better in. */
const FIELD = cn(fieldClass, "w-full py-1.5");

/** `bd -t`. The four the lane's `bd create` accepts and an operator files. */
const TASK_TYPES = ["task", "bug", "feature", "chore"] as const;

/** What a handoff's `noticeos_kind` is, in the operator's words. The composer
 * never shows the metadata itself — it shows what the metadata MEANS, which is
 * the one thing about it the operator can check. */
const LINKED_NOUN: Record<TaskHandoffKind, string> = {
  finding: "a finding",
  query: "a query decision",
  page: "a page decision",
  alert: "an alert",
};

/**
 * What the composer opens with. Every field is optional because "New task" from
 * the Tasks index prefills nothing; a handoff surface hands over a
 * `TaskHandoffPrefill`, which satisfies this exactly (`src/lib/task-handoff.ts`
 * is the one place the values are computed).
 */
export interface TaskComposerPrefill {
  /** The `config/beads.json` spoke — preselected in the Project select. */
  project?: string;
  title?: string;
  type?: string;
  priority?: number;
  /** The handoff join (`noticeos-handoff`, `asset:`, `rule:`, `key:`). Added and
   * LOCKED: they are the contract the poller and the badge read, not the
   * operator's own taxonomy. */
  labels?: string[];
  description?: string;
  acceptance?: string;
  /** Rides hidden and is filed verbatim; the composer states only what it links
   * this task to. */
  metadata?: Record<string, unknown>;
}

export interface TaskComposerProps {
  open: boolean;
  onClose: () => void;
  prefill?: TaskComposerPrefill | null;
  /** The surface that opened it, after the id exists — so a row can invalidate
   * whatever read carries its `HandoffBeadBadge`. */
  onFiled?: (created: TaskCreated) => void;
  /** File somewhere other than the lane. The component gallery passes a fake,
   * so the demo is a real form that never touches the operator's task hub —
   * the same escape hatch `KnobEditor` takes for the same reason. */
  onFile?: (input: NewTask) => Promise<TaskCreated>;
  /** The spokes the Project select offers. Defaults to `/api/settings`'
   * `taskHub.spokes`, which is `config/beads.json` as the Tower reads it — the
   * fallback for a row that has no project list of its own. A caller already
   * holding that map (the Tasks index reads it in the work snapshot) passes it
   * instead, so its select and its project filter cannot disagree and the page
   * opens no second read of the same file. */
  projects?: ComposerProject[];
}

/** What the composer reads off a spoke: the asset it files against and the
 * prefix a parent epic must carry. Narrower than `TaskHubSpoke` on purpose —
 * `database` and `repo` are the lane's business, and demanding them would stop
 * a caller holding only the board's own project rows from passing them. */
export type ComposerProject = Pick<TaskHubSpoke, "asset" | "prefix">;

/**
 * FILE A TASK WITH A BUTTON (D19, bead `ro-l1ed.4`).
 *
 * Every handoff the Tower copies ends in a `bd create` command, and until now
 * the only way to run it was to paste it into a terminal standing in the right
 * repo. That last step is the one that fails: filing from the wrong directory
 * files against the wrong asset, and the `bd` the operator would run is the
 * same `bd` the local task lane already runs for them.
 *
 * WHAT THIS DOES NOT CHANGE — and the reason it is a composer rather than a
 * one-click file. `config/beads.README.md` §"Observations are not commitments"
 * is unamended: a finding is an observation regenerated every run, and a bead is
 * a commitment somebody made. The judgment step is preserved exactly; the paste
 * is what got replaced. So this opens with the values filled in, shows what it
 * is about to file, and files only when a person presses the button.
 *
 * THE HANDOFF LABELS AND METADATA ARE LOCKED. They are the join the poller reads
 * and the `HandoffBeadBadge` renders (`docs/playbooks/task-key-chain.md`); an
 * operator editing `key:` by hand would file a bead that never reappears on the
 * row that raised it. Everything an operator legitimately owns — title, project,
 * type, priority, parent, their own labels, the description, the acceptance
 * criteria — is editable, because a task filed with somebody else's words is a
 * task nobody reads cold. A locked label wears a lock, and the join is one
 * "Linked to a finding" chip — no footnote explains either (bead
 * `ro-ujb9.96.6.11`).
 *
 * TITLE, THEN ENTER (Linear's composer; docs/reports/2026-09-23-ux-flow-audit.html
 * finding 10). The first screen is the title, the project and the priority —
 * the project already chosen when the board or the handoff knows it — and
 * Enter files. Type, parent, labels, description and acceptance criteria wait
 * under More, which opens by itself when a handoff filled any of them, so the
 * operator still sees everything that is about to be filed.
 *
 * COPY MARKDOWN STAYS. It is the AGENT's path and it carries the whole
 * evidence brief, not just the bead; and in a deployed build with no lane it is
 * the only path, which is why the trigger disables with the lane's own sentence
 * instead of disappearing.
 */
export function TaskComposer({
  open,
  onClose,
  prefill = null,
  onFiled,
  onFile,
  projects,
}: TaskComposerProps) {
  const demoReadonly = useDemoReadonly();
  const toast = useOwnerToast();
  const titleId = useId();
  const fieldId = useId();
  const navigate = useNavigate();
  const settings = useSettings();
  const { data: work } = useWork({ enabled: projects === undefined });
  const createTask = useCreateTask();
  const capability = useTasksLive();
  const catalog = useTaskProjects();
  const hostedFields = capability.projectSelection === true && !onFile;

  const spokes = projects ?? (hostedFields ? (catalog.data ?? []).map(row => ({ asset: row.logicalKey, prefix: row.prefix, name: row.displayName })) : settings.data?.taskHub.spokes ?? []);
  const projectName = (spoke: Pick<TaskHubSpoke, "asset"> & { name?: string }) =>
    spoke.name ?? work?.projects.find((entry) => entry.asset === spoke.asset)?.name ?? spoke.asset;
  const lockedLabels = useMemo(() => prefill?.labels ?? [], [prefill]);
  const linkedKind = readKind(prefill?.metadata);

  const [project, setProject] = useState(prefill?.project ?? "");
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [type, setType] = useState(prefill?.type ?? "task");
  const [priority, setPriority] = useState(prefill?.priority ?? 2);
  const [parent, setParent] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [labelDraft, setLabelDraft] = useState("");
  const [description, setDescription] = useState(prefill?.description ?? "");
  const [acceptance, setAcceptance] = useState(prefill?.acceptance ?? "");
  const [more, setMore] = useState(prefilledMore(prefill));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filing, setFiling] = useState(false);
  const unsupported = hostedFields && !taskWritesAvailable(capability);

  // Seeded once per OPENING, and the guard is load-bearing.
  //
  // A row builds its prefill fresh on every render (`taskHandoffPrefill(...)`
  // is a call, not a memo), so an effect keyed on the prefill object would
  // re-run whenever anything above re-rendered — a poll landing, a toast
  // appearing — and silently throw away what the operator had typed. Keyed on
  // `open` alone it would still not re-seed for a caller that toggles `open`
  // without unmounting. Hence the latch: reset on close, seed on the way in.
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current) return;
    seeded.current = true;
    setProject(prefill?.project ?? (spokes.length === 1 ? spokes[0]!.asset : ""));
    setTitle(prefill?.title ?? "");
    setType(prefill?.type ?? "task");
    setPriority(prefill?.priority ?? 2);
    setParent("");
    setLabels([]);
    setLabelDraft("");
    setDescription(prefill?.description ?? "");
    setAcceptance(prefill?.acceptance ?? "");
    setMore(prefilledMore(prefill));
    setErrors({});
    // `spokes` is read once per opening, like the prefill: a project list that
    // arrives after the operator started typing must not reset the form.
  }, [open, prefill]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || demoReadonly) return null;

  const spoke = spokes.find((entry) => entry.asset === project) ?? null;

  function addLabel() {
    const value = labelDraft.trim();
    if (!value) return;
    if (lockedLabels.includes(value) || labels.includes(value)) {
      setLabelDraft("");
      return;
    }
    setLabels((current) => [...current, value]);
    setLabelDraft("");
  }

  async function file() {
    if (unsupported) return;
    const next: Record<string, string> = {};
    const cleanTitle = title.trim();
    if (!project) {
      next.project = "Choose the site whose repo this task belongs to.";
    }
    if (!cleanTitle) {
      next.title = "A task needs a title somebody could read cold.";
    }
    const cleanParent = parent.trim();
    // The prefix comes from the spoke, never from what was typed: an `ro-` epic
    // named on an `mp-` task is a parent `bd` cannot resolve, and the refusal
    // would arrive from the hub as a shell error rather than as a field.
    if (cleanParent && spoke && !cleanParent.startsWith(`${spoke.prefix}-`)) {
      next.parent = `An epic in ${spoke.asset} starts with \`${spoke.prefix}-\`.`;
    }
    setErrors(next);
    // A refused field that lives under More opens More, so the error is seen.
    if (next.parent) setMore(true);
    if (Object.keys(next).length > 0) return;

    const input: NewTask = {
      project,
      title: cleanTitle,
      type,
      priority,
      labels: [...lockedLabels, ...labels],
      ...(cleanParent ? { parent: cleanParent } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(acceptance.trim() ? { acceptance: acceptance.trim() } : {}),
      ...(prefill?.metadata ? { metadata: prefill.metadata } : {}),
    };

    setFiling(true);
    try {
      const created = onFile
        ? await onFile(input)
        : await createTask.mutateAsync(input);
      toast.success(`Filed ${created.id}`, {
        description: cleanTitle,
        action: {
          label: "Open",
          onClick: () => navigate(filedTaskPath(created.id, hostedFields ? created.project : undefined)),
        },
      });
      onFiled?.(created);
      onClose();
    } catch (err) {
      // The lane returns `bd`'s own stderr; showing it beats a generic failure,
      // because what an operator does next depends on whether the hub is down
      // or the parent id was wrong.
      setErrors({ form: fileFailureMessage(err) });
    } finally {
      setFiling(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" data-task-composer>
      <button
        type="button"
        aria-label="Close the task composer"
        onClick={onClose}
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full max-w-lg flex-col border-l border-border bg-card shadow-xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 id={titleId} className="text-base font-semibold">
              File a task
            </h2>
            {/* What the hidden metadata MEANS, as one chip — never the
                metadata itself. */}
            {linkedKind ? (
              <span
                className="inline-flex w-fit items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
                data-composer-linked={linkedKind}
              >
                <Link2 className="size-3" aria-hidden />
                Linked to {LINKED_NOUN[linkedKind]}
              </span>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
          >
            <X aria-hidden />
          </Button>
        </header>

        <div
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
          onKeyDown={(event) => {
            // ⌘/Ctrl+Enter files from any field, the textareas included.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void file();
            }
          }}
        >
          <Field id={`${fieldId}-title`} label="Title" error={errors.title}>
            <input
              id={`${fieldId}-title`}
              className={cn(FIELD, "text-base")}
              value={title}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                // Title, then Enter: the whole of a quick file.
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void file();
              }}
              placeholder="What should be true when this is done"
              data-composer-title
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <Field id={`${fieldId}-project`} label="Project" error={errors.project}>
              <div className="flex items-center gap-2">
                {spoke ? (
                  <PropertyFavicon
                    domain={spoke.asset}
                    displayName={projectName(spoke)}
                  />
                ) : null}
                <select
                  id={`${fieldId}-project`}
                  className={FIELD}
                  value={project}
                  onChange={(event) => setProject(event.target.value)}
                  data-composer-project
                >
                  <option value="">Choose a project…</option>
                  {spokes.map((entry) => (
                    <option key={entry.asset} value={entry.asset}>
                      {projectName(entry)} ({entry.prefix}-)
                    </option>
                  ))}
                </select>
              </div>
            </Field>
            <Field id={`${fieldId}-priority`} label="Priority">
              <select
                id={`${fieldId}-priority`}
                className={FIELD}
                value={String(priority)}
                onChange={(event) => setPriority(Number(event.target.value))}
                data-composer-priority
              >
                {PRIORITY_BANDS.map((band, index) => (
                  <option key={band} value={String(index)}>
                    {band}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {lockedLabels.length > 0 || labels.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" data-composer-labels>
              {lockedLabels.map((label) => (
                <Badge
                  key={label}
                  variant="secondary"
                  className="gap-1 font-mono text-[11px]"
                  data-composer-locked-label={label}
                >
                  <Lock className="size-3" aria-hidden />
                  <span className="sr-only">Locked label </span>
                  {label}
                </Badge>
              ))}
              {labels.map((label) => (
                <Badge
                  key={label}
                  variant="outline"
                  className="gap-1 pr-1 font-mono text-[11px]"
                  data-composer-label={label}
                >
                  {label}
                  <button
                    type="button"
                    aria-label={`Remove label ${label}`}
                    onClick={() =>
                      setLabels((current) =>
                        current.filter((entry) => entry !== label),
                      )
                    }
                    className="rounded-sm px-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </Badge>
              ))}
            </div>
          ) : null}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit px-1.5 text-muted-foreground"
            aria-expanded={more}
            onClick={() => setMore((current) => !current)}
            data-composer-more
          >
            <ChevronDown className={cn("motion-safe:transition-transform", more && "rotate-180")} aria-hidden />
            More
          </Button>

          {more ? (
            <div className="flex flex-col gap-3" data-composer-more-fields>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id={`${fieldId}-type`} label="Type">
                  <select
                    id={`${fieldId}-type`}
                    className={FIELD}
                    value={type}
                    onChange={(event) => setType(event.target.value)}
                    data-composer-type
                  >
                    {TASK_TYPES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id={`${fieldId}-parent`} label="Parent epic" error={errors.parent}>
                  <input
                    id={`${fieldId}-parent`}
                    className={cn(FIELD, "font-mono")}
                    value={parent}
                    onChange={(event) => setParent(event.target.value)}
                    placeholder={spoke ? `${spoke.prefix}-…` : "epic id"}
                    data-composer-parent
                    disabled={hostedFields}
                  />
                </Field>
              </div>

              <Field id={`${fieldId}-labels`} label="Labels">
                <div className="flex items-center gap-2">
                  <input
                    id={`${fieldId}-labels`}
                    className={FIELD}
                    value={labelDraft}
                    onChange={(event) => setLabelDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addLabel();
                    }}
                    placeholder="Add a label"
                    data-composer-label-draft
                    disabled={hostedFields}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addLabel}
                    disabled={hostedFields || labelDraft.trim() === ""}
                  >
                    <Plus aria-hidden /> Add
                  </Button>
                </div>
              </Field>

              <Field id={`${fieldId}-description`} label="Description">
                <textarea
                  id={`${fieldId}-description`}
                  className={cn(FIELD, "min-h-24 resize-y")}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="What, why with the numbers, where"
                  data-composer-description
                />
              </Field>

              <Field id={`${fieldId}-acceptance`} label="Done when">
                <textarea
                  id={`${fieldId}-acceptance`}
                  className={cn(FIELD, "min-h-16 resize-y")}
                  value={acceptance}
                  onChange={(event) => setAcceptance(event.target.value)}
                  placeholder="The proof that it is done"
                  data-composer-acceptance
                  disabled={hostedFields}
                />
              </Field>
            </div>
          ) : null}
        </div>

        <footer className="flex flex-col gap-2 border-t border-border px-4 py-3">
          {errors.form ? (
            <p className="text-xs text-error" role="alert" data-composer-error>
              {errors.form}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              onClick={() => void file()}
              disabled={filing || unsupported}
              data-composer-submit
            >
              {filing ? "Filing…" : "File task"}
            </Button>
          </div>
        </footer>
        {unsupported ? <p className="px-4 pb-3 text-sm text-muted-foreground">Tasks are read-only in this workspace.</p> : null}
      </aside>
    </div>,
    document.body,
  );
}

/** What a refused file says out loud. The lane hands `bd`'s own stderr back in
 * the refusal, and that sentence is more useful than any wording invented here:
 * "unknown parent" and "cannot reach the hub" ask for different next moves. */
function fileFailureMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : "Could not file the task";
}

/** A label, its control, and — only when a file was refused — the reason, on
 * the field that caused it. No hint line: a field that needs one is a field
 * to rename, default or move under More. */
function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <span className="text-[11px] leading-snug text-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** More opens by itself when a handoff filled anything that lives under it —
 * the operator reviews what is about to be filed before pressing the button. */
function prefilledMore(prefill: TaskComposerPrefill | null): boolean {
  if (!prefill) return false;
  return Boolean(
    (prefill.description ?? "").trim() ||
      (prefill.acceptance ?? "").trim() ||
      (prefill.type && prefill.type !== "task"),
  );
}

export interface FileTaskButtonProps
  extends Pick<TaskComposerProps, "prefill" | "onFiled" | "onFile" | "projects"> {
  /** The word on the button. "File task" beside a Copy Markdown; "New task" on
   * the index, where there is no row to file FROM. */
  label?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  /** What the button is filing, for the accessible name — the row's own
   * subject, so a table of eight of these does not read as eight "File task". */
  subject?: string;
  /** Stand in for `useTasksLive()`. The component gallery runs inside `os:up`,
   * which HAS the lane, so the read-only face could not otherwise be shown at
   * all — and a state nothing renders is a state nobody reviews. */
  capabilities?: TasksCapabilities;
}

/**
 * The trigger, everywhere: one button, one composer, one disabled sentence.
 *
 * It owns the open state so a row does not have to, and it renders the composer
 * only while open — which is also why a table of forty rows costs forty buttons
 * and no forms.
 *
 * READ-ONLY BUILDS. `useTasksLive()` is the one question that decides whether a
 * write can happen at all; a deployed Tower has no `bd` and no route to the hub.
 * The button stays visible and goes disabled with what to do on hover, because
 * the alternative — hiding it — would leave an operator on the deployed Tower
 * wondering where the button went. Copy Markdown is beside it and remains the
 * way, exactly as before.
 */
export function FileTaskButton({
  prefill = null,
  onFiled,
  onFile,
  projects,
  label = "File task",
  variant = "ghost",
  size = "sm",
  className,
  subject,
  capabilities,
}: FileTaskButtonProps) {
  const demoReadonly = useDemoReadonly();
  const [open, setOpen] = useState(false);
  const lane = useTasksLive();
  // An explicit answer wins (the gallery's read-only demo); otherwise a fake
  // writer stands in for the lane, so a demo is a real form even where there is
  // no lane at all; otherwise the lane itself decides.
  const capability =
    capabilities ?? (onFile ? { live: true, reason: null } : lane);
  const enabled = !demoReadonly && taskWritesAvailable(capability);

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        disabled={!enabled}
        onClick={() => setOpen(true)}
        title={enabled ? undefined : !demoReadonly ? READ_ONLY_TASKS_HINT : DEMO_READ_ONLY}
        aria-label={subject ? `${label} for ${subject}` : label}
        data-file-task
      >
        <ListPlus aria-hidden />
        {label}
      </Button>
      {/* Mounted only while open. A decision table renders forty of these
          buttons; forty mounted composers would be forty `/api/settings`
          subscriptions and forty portals for a form nobody asked for. */}
      {open ? (
        <TaskComposer
          open
          onClose={() => setOpen(false)}
          prefill={prefill}
          onFiled={onFiled}
          onFile={onFile}
          projects={projects}
        />
      ) : null}
    </>
  );
}

/** The handoff kind off a prefill's metadata (`noticeos_kind`, or the
 * `reindex_kind` of a bead filed before the rename), or null. Reads the value rather
 * than trusting it: the metadata is `Record<string, unknown>` at this boundary
 * because the lane accepts any object, and an unknown kind renders no line
 * rather than an empty "Linked to". */
function readKind(
  metadata: Record<string, unknown> | undefined,
): TaskHandoffKind | null {
  const kind = taskMetadataValue(metadata, "kind");
  return typeof kind === "string" && kind in LINKED_NOUN
    ? (kind as TaskHandoffKind)
    : null;
}

export default TaskComposer;
