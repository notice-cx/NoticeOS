import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import { ChevronDown, Link2, ListPlus, Lock, Plus, Square, X } from "lucide-react";
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
import {
  TASK_CARD_LIMITS,
  TASK_MEASURABILITIES,
  TASK_MEASURABILITY_LABELS,
  TASK_REVENUE_FAMILIES,
  TASK_REVENUE_FAMILY_LABELS,
  isTaskMeasurability,
  isTaskRevenueFamily,
  scoreTaskCard,
  taskCardOf,
  taskCardProblem,
  type TaskCard,
  type TaskMeasurability,
  type TaskRevenueFamily,
} from "@noticeos/contract/task-card";
import { TASK_CHANGE_CLASSES, TASK_CHANGE_CLASS_LABELS, type TaskChangeClass } from "@noticeos/contract/task-change-class";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { Badge } from "@/components/ui/badge";
import { Button, type ButtonProps } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { pillChoiceClass, pillChoiceStateClass, pillControlClass, pillPickerStateClass } from "@/components/ui/pill";
import { WhyItRanks } from "@/components/viz/WhyItRanks";
import { useCreateTask, useTasksLive, useTaskProjects } from "@/hooks/useTasks";
import { taskPath } from '@/lib/task-path';
import { operatorRateOf } from "@/hooks/useOperatorRate";
import { useSettings } from "@/hooks/useSettings";
import { useSiteIcons } from "@/hooks/useSiteIcons";
import { useWork } from "@/hooks/useWork";
import { ApiError, type NewTask } from "@/lib/api";
import type { TaskHandoffKind } from "@/lib/task-handoff";
import { cn } from "@/lib/utils";
import { MarkdownText } from "@/routes/tasks/task-markdown";
import { taskMetadataValue } from "@noticeos/contract/task-metadata";

/** Where the toast's Open link points after a task is filed: the task's own
 * page, where every other task id in the Tower leads. */
export const filedTaskPath = taskPath;

const FIELD = cn(fieldClass, "w-full py-1.5");

/** The types `bd create -t` accepts. */
const TASK_TYPES = ["task", "bug", "feature", "chore"] as const;

/** What a handoff's `noticeos_kind` is, in the operator's words. The composer
 * never shows the metadata itself — it shows what the metadata means, which is
 * the one thing about it the operator can check. */
const LINKED_NOUN: Record<TaskHandoffKind, string> = {
  finding: "a finding",
  query: "a query decision",
  page: "a page decision",
  alert: "an alert",
};

/** The likelihoods a press sets, in percent; any other is typed beside them. */
export const LIKELIHOOD_PILLS = [30, 55, 75, 90] as const;

/** The signal horizons a press sets; any other is typed in days beside them. */
export const SIGNAL_PILLS = [
  { label: "2 wk", days: 14 },
  { label: "4 wk", days: 28 },
  { label: "8 wk", days: 56 },
] as const;

const SCORE = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Why the task is worth doing, as typed. Numbers stay text, so a blank field
 * is a missing figure and never a zero. */
export interface WhyDraft {
  valuePerMonth: string;
  /** A percent, 1–99. */
  likelihood: string;
  reviewMinutes: string;
  daysToSignal: string;
  measurability: TaskMeasurability | "";
  revenueFamily: TaskRevenueFamily | "";
  killState: string;
  killDate: string;
  note: string;
}

type WhyField = keyof WhyDraft;

export const EMPTY_WHY: WhyDraft = {
  valuePerMonth: "",
  likelihood: "",
  reviewMinutes: "",
  daysToSignal: "",
  measurability: "",
  revenueFamily: "",
  killState: "",
  killDate: "",
  note: "",
};

/** The contract's field names (`card.kill.date`) as this section's fields. */
const WHY_FIELD: Readonly<Record<string, WhyField>> = {
  "card.valuePerMonth": "valuePerMonth",
  "card.likelihood": "likelihood",
  "card.reviewMinutes": "reviewMinutes",
  "card.daysToSignal": "daysToSignal",
  "card.measurability": "measurability",
  "card.revenueFamily": "revenueFamily",
  "card.kill": "killState",
  "card.kill.state": "killState",
  "card.kill.date": "killDate",
  "card.note": "note",
};

/** Nothing typed anywhere in the section: the task files without a card. */
export function whyIsEmpty(draft: WhyDraft): boolean {
  return Object.values(draft).every((value) => value.trim() === "");
}

function figure(text: string): number | undefined {
  return text.trim() === "" ? undefined : Number(text);
}

/** The card the section describes, before the contract has checked it. The
 * likelihood is typed as a percent and sent as a fraction. */
function whyCandidate(draft: WhyDraft): Record<string, unknown> {
  const percent = figure(draft.likelihood);
  return {
    valuePerMonth: figure(draft.valuePerMonth),
    // Rounded, so 55 is sent as 0.55 rather than a binary neighbour of it.
    likelihood: percent === undefined ? undefined : Number((percent / 100).toFixed(4)),
    reviewMinutes: figure(draft.reviewMinutes),
    daysToSignal: figure(draft.daysToSignal),
    measurability: isTaskMeasurability(draft.measurability) ? draft.measurability : undefined,
    ...(isTaskRevenueFamily(draft.revenueFamily) ? { revenueFamily: draft.revenueFamily } : {}),
    ...(draft.killState.trim() !== "" || draft.killDate !== ""
      ? { kill: { state: draft.killState.trim(), date: draft.killDate } }
      : {}),
    ...(draft.note.trim() !== "" ? { note: draft.note.trim() } : {}),
  };
}

/** The card a filled section makes, or null while the contract refuses it. */
export function whyCard(draft: WhyDraft): TaskCard | null {
  return whyIsEmpty(draft) ? null : taskCardOf(whyCandidate(draft));
}

/** The first field at fault and the line shown under it, or null. */
export function whyProblem(draft: WhyDraft): { field: WhyField; message: string } | null {
  if (whyIsEmpty(draft)) return null;
  const problem = taskCardProblem(whyCandidate(draft));
  if (problem === null) return null;
  const field = WHY_FIELD[problem.field] ?? "valuePerMonth";
  if (draft[field].trim() === "" || problem.rule === "empty") return { field, message: "Required" };
  if (problem.field === "card.likelihood" && problem.rule.startsWith("between")) {
    const { min, max } = TASK_CARD_LIMITS.likelihood;
    return { field, message: `Must be between ${Math.round(min * 100)} and ${Math.round(max * 100)}` };
  }
  return { field, message: `Must be ${problem.rule}` };
}

/** A Done when text as the editor's lines: each line's own words, without
 * the dash or box it may have been written with. */
export function acceptanceLines(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]\s+)?(?:\[[ xX]\]\s*)?/, "").trim())
    .filter((line) => line !== "");
  return lines.length > 0 ? lines : [""];
}

/** The editor's lines as the checklist a task's Done when holds, blank lines
 * dropped. */
export function acceptanceText(lines: readonly string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => `- [ ] ${line}`)
    .join("\n");
}

/** What the composer opens with. A handoff surface hands over a
 * `TaskHandoffPrefill` (`src/lib/task-handoff.ts` computes the values). */
export interface TaskComposerPrefill {
  /** The `config/beads.json` spoke — preselected in the Project select. */
  project?: string;
  title?: string;
  type?: string;
  priority?: number;
  /** The handoff join (`noticeos-handoff`, `asset:`, `rule:`, `key:`). Added and
   * locked: they are the contract the poller and the badge read, not the
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
  /** Called after the id exists, so a row can invalidate the read that
   * carries its `HandoffBeadBadge`. */
  onFiled?: (created: TaskCreated) => void;
  /** File somewhere other than the lane; the component gallery passes a fake. */
  onFile?: (input: NewTask) => Promise<TaskCreated>;
  /** The spokes the Project select offers. Defaults to the settings'
   * `taskHub.spokes`; a caller already holding that map passes it instead, so
   * its select and its project filter cannot disagree. */
  projects?: ComposerProject[];
}

/** Narrower than `TaskHubSpoke` on purpose: a caller holding only the board's
 * own project rows can pass them. */
export type ComposerProject = Pick<TaskHubSpoke, "asset" | "prefix">;

/**
 * Files a task through the local task lane. A finding is an observation and a
 * task is a commitment somebody made, so this opens with the values filled
 * in, shows what it is about to file, and files only on a press. The handoff
 * labels and metadata are locked: they are the join the poller reads and the
 * `HandoffBeadBadge` renders. Title, project and priority are the first
 * screen and Enter files; the rest waits under More, which opens by itself
 * when a handoff filled any of it. Why the task is worth doing is optional as
 * a whole: an empty section files no card, and a started one files only once
 * the contract accepts every figure. Copy Markdown remains the agent's path
 * and the only path where there is no lane.
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
  const operatorRateUsdPerMin = operatorRateOf(settings.data);
  const { data: work } = useWork({ enabled: projects === undefined });
  const createTask = useCreateTask();
  const capability = useTasksLive();
  const catalog = useTaskProjects();
  const iconsOf = useSiteIcons();
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
  const [previewing, setPreviewing] = useState(false);
  const [lines, setLines] = useState<string[]>(() => acceptanceLines(prefill?.acceptance ?? ""));
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const lineRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [changeClass, setChangeClass] = useState<TaskChangeClass | null>(null);
  const [why, setWhy] = useState<WhyDraft>(EMPTY_WHY);
  const [whyTried, setWhyTried] = useState(false);
  const [more, setMore] = useState(prefilledMore(prefill));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filing, setFiling] = useState(false);
  const unsupported = hostedFields && !taskWritesAvailable(capability);

  // Seeded once per opening. A row builds its prefill fresh on every render,
  // so an effect keyed on it would throw away what the operator typed; keyed
  // on `open` alone it would not re-seed for a caller that toggles `open`
  // without unmounting. Hence the latch.
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
    setPreviewing(false);
    setLines(acceptanceLines(prefill?.acceptance ?? ""));
    setChangeClass(null);
    setWhy(EMPTY_WHY);
    setWhyTried(false);
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

  // A line added or removed takes the focus once it is drawn.
  useEffect(() => {
    if (focusLine === null) return;
    lineRefs.current[focusLine]?.focus();
    setFocusLine(null);
  }, [focusLine, lines.length]);

  if (!open || demoReadonly) return null;

  const spoke = spokes.find((entry) => entry.asset === project) ?? null;
  // The rule follows the typing once File task has been pressed.
  const whyShown = whyTried ? whyProblem(why) : null;
  const whyError = (field: WhyField) => (whyShown?.field === field ? whyShown.message : undefined);
  const card = whyCard(why);
  const score = card ? scoreTaskCard(card, { operatorRateUsdPerMin }) : null;
  const setWhyField = <K extends WhyField>(key: K, value: WhyDraft[K]) =>
    setWhy((current) => ({ ...current, [key]: value }));

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

  function insertLine(at: number) {
    setLines((current) => [...current.slice(0, at), "", ...current.slice(at)]);
    setFocusLine(at);
  }

  function removeLine(at: number) {
    setLines((current) => current.filter((_, index) => index !== at));
    setFocusLine(Math.max(0, at - 1));
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
    // A parent from another project is one `bd` cannot resolve, and the
    // refusal would arrive as a shell error rather than as a field.
    if (cleanParent && spoke && !cleanParent.startsWith(`${spoke.prefix}-`)) {
      next.parent = `An epic in ${spoke.asset} starts with \`${spoke.prefix}-\`.`;
    }
    const refusedWhy = whyProblem(why);
    setWhyTried(true);
    setErrors(next);
    // A refused field that lives under More opens More, so the error is seen.
    if (next.parent || refusedWhy) setMore(true);
    if (Object.keys(next).length > 0 || refusedWhy) return;

    const acceptance = acceptanceText(lines);
    const input: NewTask = {
      project,
      title: cleanTitle,
      type,
      priority,
      labels: [...lockedLabels, ...labels],
      ...(cleanParent ? { parent: cleanParent } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(acceptance ? { acceptance } : {}),
      ...(prefill?.metadata ? { metadata: prefill.metadata } : {}),
      ...(card ? { card } : {}),
      ...(changeClass ? { changeClass } : {}),
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
            {/* What the hidden metadata means, as one chip — never the
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
                    icons={iconsOf(spoke.asset)}
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

              <div className="flex flex-col gap-1">
                <span id={`${fieldId}-class`} className="text-xs font-medium text-foreground">
                  Kind of change
                </span>
                <div
                  role="group"
                  aria-labelledby={`${fieldId}-class`}
                  className="inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-md border border-border p-0.5"
                  data-composer-change-class={changeClass ?? ""}
                >
                  {[null, ...TASK_CHANGE_CLASSES].map((value) => (
                    <button
                      key={value ?? "none"}
                      type="button"
                      aria-pressed={changeClass === value}
                      onClick={() => setChangeClass(value)}
                      className={cn("inline-flex items-center rounded-sm border px-2 py-1 text-xs", pillControlClass, pillPickerStateClass(changeClass === value))}
                    >
                      {value === null ? "Not recorded" : TASK_CHANGE_CLASS_LABELS[value]}
                    </button>
                  ))}
                </div>
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

              <Field
                id={`${fieldId}-description`}
                label="Description"
                aside={
                  <div role="group" aria-label="Description view" className="inline-flex items-center gap-0.5 rounded-md border border-border p-0.5">
                    {[false, true].map((preview) => (
                      <button
                        key={String(preview)}
                        type="button"
                        aria-pressed={previewing === preview}
                        onClick={() => setPreviewing(preview)}
                        className={cn("inline-flex items-center rounded-sm border px-2 py-0.5 text-xs", pillControlClass, pillPickerStateClass(previewing === preview))}
                        data-composer-description-mode={preview ? "preview" : "write"}
                      >
                        {preview ? "Preview" : "Write"}
                      </button>
                    ))}
                  </div>
                }
                hint="Markdown: tables, images and checklists work; task ids and paths become links"
              >
                {previewing ? (
                  <div className={cn(FIELD, "min-h-24 overflow-x-auto")} data-composer-preview>
                    {description.trim() ? (
                      <MarkdownText source={description} />
                    ) : (
                      <span className="text-muted-foreground">Nothing to preview</span>
                    )}
                  </div>
                ) : (
                  <textarea
                    id={`${fieldId}-description`}
                    className={cn(FIELD, "min-h-24 resize-y")}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="What, why with the numbers, where"
                    data-composer-description
                  />
                )}
              </Field>

              <Field id={`${fieldId}-acceptance-0`} label="Done when">
                <div className="flex flex-col gap-1.5" data-composer-acceptance>
                  {lines.map((line, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Square className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <input
                        id={`${fieldId}-acceptance-${index}`}
                        ref={(node) => {
                          lineRefs.current[index] = node;
                        }}
                        className={FIELD}
                        value={line}
                        aria-label={index === 0 ? undefined : `Done when, line ${index + 1}`}
                        onChange={(event) => {
                          const value = event.target.value;
                          setLines((current) => current.map((entry, at) => (at === index ? value : entry)));
                        }}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey) return;
                          // Enter starts the next line; Backspace on an empty one joins it to the line above.
                          if (event.key === "Enter") {
                            event.preventDefault();
                            insertLine(index + 1);
                          } else if (event.key === "Backspace" && line === "" && lines.length > 1) {
                            event.preventDefault();
                            removeLine(index);
                          }
                        }}
                        placeholder={index === 0 ? "The proof that it is done" : undefined}
                        data-composer-acceptance-line={index}
                        disabled={hostedFields}
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-fit px-1.5 text-muted-foreground"
                    onClick={() => insertLine(lines.length)}
                    disabled={hostedFields}
                    data-composer-acceptance-add
                  >
                    <Plus aria-hidden /> Another line
                  </Button>
                </div>
              </Field>

              <section
                aria-labelledby={`${fieldId}-why`}
                className="flex flex-col gap-3 border-t border-border pt-3"
                data-composer-why
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <h3 id={`${fieldId}-why`} className="m-0 text-xs font-semibold text-foreground">
                    Why it is worth doing
                  </h3>
                  <span className="text-micro text-muted-foreground">ranks the task · an agent can fill it in later</span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id={`${fieldId}-value`} label="Predicted change, a month" error={whyError("valuePerMonth")}>
                    <Affixed prefix="$" suffix="est.">
                      <input
                        id={`${fieldId}-value`}
                        type="number"
                        inputMode="decimal"
                        step="any"
                        className={cn(FIELD, "tabular-nums")}
                        value={why.valuePerMonth}
                        onChange={(event) => setWhyField("valuePerMonth", event.target.value)}
                        aria-invalid={whyError("valuePerMonth") ? true : undefined}
                        data-composer-why-field="valuePerMonth"
                      />
                    </Affixed>
                  </Field>
                  <Field id={`${fieldId}-review`} label="Your minutes to review" error={whyError("reviewMinutes")}>
                    <Affixed suffix="min">
                      <input
                        id={`${fieldId}-review`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        className={cn(FIELD, "tabular-nums")}
                        value={why.reviewMinutes}
                        onChange={(event) => setWhyField("reviewMinutes", event.target.value)}
                        aria-invalid={whyError("reviewMinutes") ? true : undefined}
                        data-composer-why-field="reviewMinutes"
                      />
                    </Affixed>
                  </Field>
                </div>

                <Field id={`${fieldId}-likelihood`} label="Likely to pay off" error={whyError("likelihood")}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {LIKELIHOOD_PILLS.map((percent) => {
                      const picked = why.likelihood.trim() !== "" && Number(why.likelihood) === percent;
                      return (
                        <button
                          key={percent}
                          type="button"
                          aria-pressed={picked}
                          onClick={() => setWhyField("likelihood", String(percent))}
                          className={cn(pillChoiceClass, pillChoiceStateClass(picked), "tabular-nums")}
                        >
                          {percent}%
                        </button>
                      );
                    })}
                    <Affixed suffix="%">
                      <input
                        id={`${fieldId}-likelihood`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={99}
                        className={cn(FIELD, "w-20 tabular-nums")}
                        value={why.likelihood}
                        onChange={(event) => setWhyField("likelihood", event.target.value)}
                        aria-invalid={whyError("likelihood") ? true : undefined}
                        data-composer-why-field="likelihood"
                      />
                    </Affixed>
                  </div>
                </Field>

                <Field id={`${fieldId}-signal`} label="Signal in" error={whyError("daysToSignal")}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {SIGNAL_PILLS.map((pill) => {
                      const picked = why.daysToSignal.trim() !== "" && Number(why.daysToSignal) === pill.days;
                      return (
                        <button
                          key={pill.days}
                          type="button"
                          aria-pressed={picked}
                          onClick={() => setWhyField("daysToSignal", String(pill.days))}
                          className={cn(pillChoiceClass, pillChoiceStateClass(picked))}
                        >
                          {pill.label}
                        </button>
                      );
                    })}
                    <Affixed suffix="days">
                      <input
                        id={`${fieldId}-signal`}
                        type="number"
                        inputMode="numeric"
                        min={TASK_CARD_LIMITS.daysToSignal.min}
                        max={TASK_CARD_LIMITS.daysToSignal.max}
                        className={cn(FIELD, "w-20 tabular-nums")}
                        value={why.daysToSignal}
                        onChange={(event) => setWhyField("daysToSignal", event.target.value)}
                        aria-invalid={whyError("daysToSignal") ? true : undefined}
                        data-composer-why-field="daysToSignal"
                      />
                    </Affixed>
                  </div>
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id={`${fieldId}-measured`} label="Measured as" error={whyError("measurability")}>
                    <select
                      id={`${fieldId}-measured`}
                      className={FIELD}
                      value={why.measurability}
                      onChange={(event) => {
                        const value = event.target.value;
                        setWhyField("measurability", isTaskMeasurability(value) ? value : "");
                      }}
                      aria-invalid={whyError("measurability") ? true : undefined}
                      data-composer-why-field="measurability"
                    >
                      <option value="">Choose…</option>
                      {TASK_MEASURABILITIES.map((value) => (
                        <option key={value} value={value}>
                          {TASK_MEASURABILITY_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id={`${fieldId}-family`} label="Revenue family" error={whyError("revenueFamily")}>
                    <select
                      id={`${fieldId}-family`}
                      className={FIELD}
                      value={why.revenueFamily}
                      onChange={(event) => {
                        const value = event.target.value;
                        setWhyField("revenueFamily", isTaskRevenueFamily(value) ? value : "");
                      }}
                      data-composer-why-field="revenueFamily"
                    >
                      <option value="">Not recorded</option>
                      {TASK_REVENUE_FAMILIES.map((value) => (
                        <option key={value} value={value}>
                          {TASK_REVENUE_FAMILY_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <Field id={`${fieldId}-kill`} label="Kill criterion" error={whyError("killState") ?? whyError("killDate")}>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
                    <input
                      id={`${fieldId}-kill`}
                      className={FIELD}
                      value={why.killState}
                      onChange={(event) => setWhyField("killState", event.target.value)}
                      placeholder="a state"
                      aria-invalid={whyError("killState") ? true : undefined}
                      data-composer-why-field="killState"
                    />
                    <input
                      type="date"
                      aria-label="Kill date"
                      className={cn(FIELD, "tabular-nums")}
                      value={why.killDate}
                      onChange={(event) => setWhyField("killDate", event.target.value)}
                      aria-invalid={whyError("killDate") ? true : undefined}
                      data-composer-why-field="killDate"
                    />
                  </div>
                </Field>

                <Field id={`${fieldId}-note`} label="Note" error={whyError("note")}>
                  <input
                    id={`${fieldId}-note`}
                    className={FIELD}
                    value={why.note}
                    onChange={(event) => setWhyField("note", event.target.value)}
                    placeholder="why the money moves"
                    aria-invalid={whyError("note") ? true : undefined}
                    data-composer-why-field="note"
                  />
                </Field>

                <div className="flex flex-col gap-2" data-composer-score={score ? SCORE.format(score.score) : ""}>
                  {card && score ? (
                    <>
                      <span className="text-xs font-medium tabular-nums text-foreground">
                        Score {SCORE.format(score.score)} · policy {score.policy}
                      </span>
                      <WhyItRanks size="sm" card={card} score={score} />
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">Fill the five figures to rank it.</span>
                  )}
                </div>
              </section>
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

/** The lane hands `bd`'s own stderr back, and that sentence is more useful
 * than any wording invented here. */
function fileFailureMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : "Could not file the task";
}

/** A label, its control, and — only when a file was refused — the reason, on
 * the field that caused it. A hint line is for what the control cannot show
 * itself (the Markdown the description accepts); a field that needs one to be
 * filled in is a field to rename, default or move under More. */
function Field({
  id,
  label,
  error,
  aside,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  /** Drawn on the label's line, at its end: a toggle for the control. */
  aside?: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-foreground">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {hint ? <span className="text-micro text-muted-foreground">{hint}</span> : null}
      {error ? (
        <span className="text-[11px] leading-snug text-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** A figure's control with its unit before or after it, a step lighter. */
function Affixed({ prefix, suffix, children }: { prefix?: string; suffix?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {prefix ? <span className="text-sm text-muted-foreground" aria-hidden>{prefix}</span> : null}
      {children}
      {suffix ? <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span> : null}
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
  /** The word on the button. */
  label?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  /** What the button is filing, for the accessible name. */
  subject?: string;
  /** Stand in for `useTasksLive()`, so the gallery can show the read-only face. */
  capabilities?: TasksCapabilities;
}

/**
 * The trigger: one button, one composer mounted only while open, and in a
 * build with no lane a disabled button with what to do on hover rather than
 * no button at all.
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
      {/* Mounted only while open: a table of forty rows must not cost forty
          settings subscriptions and forty portals. */}
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

/** The handoff kind off a prefill's metadata, or null. The metadata is
 * `Record<string, unknown>` at this boundary, so the value is read, not
 * trusted, and an unknown kind renders no line. */
function readKind(
  metadata: Record<string, unknown> | undefined,
): TaskHandoffKind | null {
  const kind = taskMetadataValue(metadata, "kind");
  return typeof kind === "string" && kind in LINKED_NOUN
    ? (kind as TaskHandoffKind)
    : null;
}

export default TaskComposer;
