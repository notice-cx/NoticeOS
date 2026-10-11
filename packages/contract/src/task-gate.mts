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

/**
 * The ask inside a gate's description, or null for a gate created without a
 * reason — which keeps that gate's own title as the fallback rather than
 * inventing a label for it.
 */
export function gateReason(description: unknown): string | null {
  if (typeof description !== "string") return null;
  const match = /(?:^|\n)Reason:[ \t]*([\s\S]+)$/.exec(description);
  const reason = match ? (match[1] ?? "").trim() : "";
  return reason === "" ? null : reason.slice(0, GATE_REASON_MAX);
}

/** The title a human gate is shown by: the ask it holds, or its own title when
 * it holds none. */
export function gateTitle(title: string, description: unknown): string {
  return gateReason(description) ?? title;
}
