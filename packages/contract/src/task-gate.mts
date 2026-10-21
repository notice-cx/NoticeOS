// How a human gate reads: the ask it holds, not the mechanism's name. `bd`
// titles every gate "Gate: human" and has no reason field; `bd gate create
// --reason` writes the ask into the description as
// `Ad-hoc gate blocking <id>\n\nReason: <text>`. Every reader that shows a
// gate titles it with that reason through this one module.
//
// Authored TypeScript: `pnpm generate` writes the `.mjs` and `.d.mts`
// beside it.

/** A gate's reason is free text an operator typed, and the route caps a title
 * at 512. Bounded here so a long reason costs the gate its tail rather than
 * costing the whole project its snapshot. */
export const GATE_REASON_MAX = 400;

/** Relationships that keep dependent work from being ready. */
export const TASK_BLOCKING_DEPENDENCIES: readonly string[] = ["blocks", "waits-for", "conditional-blocks"];

/** The recorded reason, unchanged apart from the title's length bound. */
export function gateReason(description: unknown): string | null {
  if (typeof description !== "string") return null;
  const match = /(?:^|\n)Reason:[ \t]*([\s\S]+)$/.exec(description);
  const reason = match ? (match[1] ?? "").trim() : "";
  return reason === "" ? null : reason.slice(0, GATE_REASON_MAX);
}

export interface GateTitleContext {
  readonly id?: string;
  readonly tasks?: readonly unknown[];
  readonly dependents?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The reason names the requested action. A generic or absent title without a
 * reason uses known blocked work as context; that context grants no approval. */
export function gateTitle(title: unknown, description: unknown, context: GateTitleContext = {}): string {
  const reason = gateReason(description);
  if (reason !== null) return reason;
  const own = typeof title === 'string' ? title.trim() : '';
  if (own && !/^(?:gate(?:\s*:\s*human)?|human)$/iu.test(own)) return own;
  const target = typeof description === 'string' ? /^Ad-hoc gate blocking ([A-Za-z0-9][A-Za-z0-9._-]*)/u.exec(description)?.[1] : undefined;
  const tasks = [...(context.tasks ?? []), ...(Array.isArray(context.dependents) ? context.dependents : [])].map(record);
  const held = tasks.find(task => target !== undefined && task.id === target)
    ?? tasks.find(task => typeof context.id === 'string' && Array.isArray(task.dependencies) && task.dependencies.some((edge: unknown) => {
      const dependency = record(edge);
      return (dependency.depends_on_id ?? dependency.id) === context.id
        && TASK_BLOCKING_DEPENDENCIES.includes(String(dependency.type ?? dependency.dependency_type ?? 'blocks'));
    }))
    ?? (Array.isArray(context.dependents) ? record(context.dependents[0]) : undefined);
  const heldTitle = typeof held?.title === 'string' ? held.title.trim() : '';
  const subject = heldTitle || target;
  return subject ? `Review approval for ${subject}`.slice(0, GATE_REASON_MAX) : 'Review approval request';
}

/**
 * Whether a task is in the operator's Waiting on you: an open human gate, which
 * a person approves, or a ready task labelled `human`, which a person answers
 * or dismisses. A parked or closed task waits on nobody, and a timer or GitHub
 * gate resolves itself. A photographed gate carries no await type; every gate
 * the photograph keeps is a human one.
 */
export function waitsOnPerson(task: {
  readonly issueType: string;
  readonly awaitType?: string | null;
  readonly status: string;
  readonly labels: readonly string[];
  readonly ready: boolean;
  readonly choice?: unknown;
}): boolean {
  if (task.status === "deferred" || task.status === "closed") return false;
  const gate = task.issueType === "gate" || (task.awaitType ?? null) !== null;
  return gate ? (task.awaitType ?? "human") === "human" : task.choice == null && task.issueType !== "epic" && task.labels.includes("human") && task.ready;
}
