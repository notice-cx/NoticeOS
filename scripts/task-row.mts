// Pure Beads row normalization shared by standalone and hosted readers.
import type { LiveTask, LiveEpic, TaskDependency, TaskComment } from "../apps/tower/shared/tasks";
import { gateTitle } from "../packages/contract/src/task-gate.mjs";

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function instant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function whole(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? (value as number) : fallback;
}

/** `bd`'s default priority band. Named rather than inlined so a row missing the
 * field lands in the same band the CLI would have put it in. */
const DEFAULT_PRIORITY = 2;

function dependencies(value: unknown): TaskDependency[] {
  if (!Array.isArray(value)) return [];
  const out: TaskDependency[] = [];
  for (const entry of value) {
    const row = entry as Record<string, unknown>;
    // `bd list` reports a plain edge (`depends_on_id` + `type`); `bd show`
    // embeds the whole issue (`id` + `dependency_type`). Same edge, two shapes.
    const id = text(row.depends_on_id) || text(row.id);
    const type = text(row.type) || text(row.dependency_type, "blocks");
    if (id === "") continue;
    out.push({ id, type, title: text(row.title) || null, status: text(row.status) || null });
  }
  return out;
}

/** The epic this bead hangs off. `bd` reports it as a field on a list row and
 * as a parent-child dependency edge on a show row; both are read so a task page
 * and an index agree about where a bead belongs. */
function parentOf(row: Record<string, unknown>, deps: TaskDependency[]): string | null {
  const direct = text(row.parent);
  if (direct !== "") return direct;
  const edge = deps.find((dep) => dep.type === "parent-child");
  return edge?.id ?? null;
}

export function toLiveTask(row: unknown, ready: ReadonlySet<string>): LiveTask {
  const source = (row ?? {}) as Record<string, unknown>;
  const id = text(source.id);
  const deps = dependencies(source.dependencies);
  const metadata = source.metadata;
  const awaitType = text(source.await_type) || null;
  const title = text(source.title, id);
  return {
    id,
    // A human gate is titled by the ask it holds — `bd` titles every one
    // "Gate: human" — through the same reader the runner's snapshot uses, so
    // the live board and the snapshot never title one gate two ways (bead
    // ro-ujb9.201). A gate with no reason keeps its own title.
    title: awaitType === "human" ? gateTitle(title, source.description) : title,
    status: text(source.status, "open"),
    priority: whole(source.priority, DEFAULT_PRIORITY),
    issueType: text(source.issue_type, "task"),
    assignee: text(source.assignee) || null,
    updatedAt: instant(source.updated_at),
    closedAt: instant(source.closed_at),
    parent: parentOf(source, deps),
    deferUntil: instant(source.defer_until),
    description: text(source.description),
    acceptance: text(source.acceptance_criteria),
    labels: Array.isArray(source.labels)
      ? source.labels.filter((label): label is string => typeof label === "string")
      : [],
    ready: ready.has(id),
    dependencies: deps,
    comments: whole(source.comment_count, 0),
    metadata:
      metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : null,
    createdAt: instant(source.created_at),
    startedAt: instant(source.started_at),
    closeReason: text(source.close_reason) || null,
    awaitType,
  };
}

export function toEpic(row: unknown): LiveEpic | null {
  const source = (row ?? {}) as Record<string, unknown>;
  const epic = (source.epic ?? {}) as Record<string, unknown>;
  const id = text(epic.id);
  if (id === "") return null;
  return {
    id,
    title: text(epic.title, id),
    status: text(epic.status, "open"),
    priority: whole(epic.priority, DEFAULT_PRIORITY),
    total: whole(source.total_children, 0),
    closed: whole(source.closed_children, 0),
    eligibleForClose: source.eligible_for_close === true,
  };
}

export function toComment(row: unknown): TaskComment {
  const source = (row ?? {}) as Record<string, unknown>;
  return {
    id: text(source.id),
    author: text(source.author, "unknown"),
    text: typeof source.text === "string" ? source.text : "",
    createdAt: instant(source.created_at),
  };
}

export { text as taskRowText };
