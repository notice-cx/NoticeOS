// The arithmetic of Arrange: which site a drop moves onto, the order a move
// leaves, and the words a change is named by. The write itself is
// `moveAsset` (`asset` takes the place `to` holds, every site between moves
// one place toward the place it left), so a drop "above" or "below" a row is
// turned into that one target here.

import type { ShownOnSurface } from "@shared/site-display";

export type RowEdge = "top" | "bottom";

/** Which edge of a row the pointer is nearer. */
export function rowDropEdge(rect: { top: number; height: number }, clientY: number): RowEdge {
  return clientY < rect.top + rect.height / 2 ? "top" : "bottom";
}

/**
 * The site `asset` moves onto for a drop on `onto`'s top or bottom edge, or
 * null when the drop would leave it where it is (on itself, or on the edge it
 * already touches). Moving down onto a row's bottom edge, or up onto its top
 * edge, takes that row's place; the other two take the place of the row next
 * to it.
 */
export function siteDropTarget(order: readonly string[], asset: string, onto: string, edge: RowEdge): string | null {
  const from = order.indexOf(asset);
  const at = order.indexOf(onto);
  if (from < 0 || at < 0 || from === at) return null;
  const landing = from < at ? (edge === "bottom" ? at : at - 1) : edge === "top" ? at : at + 1;
  return landing === from ? null : (order[landing] ?? null);
}

/** The order a move leaves: `asset` in the place `to` held. */
export function movedOrder(order: readonly string[], asset: string, to: string): string[] {
  const at = order.indexOf(to);
  if (at < 0 || !order.includes(asset)) return [...order];
  const rest = order.filter((id) => id !== asset);
  rest.splice(at, 0, asset);
  return rest;
}

const WHERE: Readonly<Record<ShownOnSurface, string>> = {
  list: "on Home and the Sites list",
  tv: "on the TV",
  work: "in Work this week",
};

/** What a switch change is named by in its toast: "Meadow Board hidden on
 * the TV". */
export function shownOnLabel(name: string, surface: ShownOnSurface, on: boolean): string {
  return `${name} ${on ? "shown" : "hidden"} ${WHERE[surface]}`;
}
