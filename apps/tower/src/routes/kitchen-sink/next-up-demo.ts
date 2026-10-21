import type { AssetCard, OperatorPosture, WallNextUp } from "@shared/wall";

// Next up's invented decisions and held work, spread over the gallery's own
// sites so each row draws a site the gallery has a card for.

/** Five decisions, the top one holding work, and three held tasks, one urgent. */
export function nextUpDemo(assets: readonly Pick<AssetCard, "id">[], capturedAt: string): WallNextUp {
  const site = (index: number) => assets[index % Math.max(assets.length, 1)]?.id ?? "example.com";
  return {
    decisions: [
      { id: "pl-4f2", title: "Pick which recipe page keeps the canonical address", asset: site(0), ask: "choose", ageDays: 12, releases: 3 },
      { id: "mo-9a1", title: "Approve the new pricing copy", asset: site(1), ask: "approve", ageDays: 9, releases: null },
      { id: "la-2c7", title: "Answer the sitemap question", asset: site(2), ask: "answer", ageDays: 6, releases: null },
      { id: "pl-7d3", title: "Answer the redirect question", asset: site(0), ask: "answer", ageDays: 4, releases: null },
      { id: "mo-1e8", title: "Choose the newsletter day", asset: site(1), ask: "choose", ageDays: null, releases: null },
    ],
    oldestAgeDays: 12,
    working: [
      { id: "mo-5b0", title: "Restore the checkout button", asset: site(1), who: "claude", sinceHours: 2, urgent: true },
      { id: "pl-3a9", title: "Resize the recipe images", asset: site(0), who: "codex", sinceHours: 5, urgent: false },
      { id: "la-8f4", title: "Rewrite the about page", asset: site(2), who: "Dana", sinceHours: 26, urgent: false },
    ],
    capturedAt,
  };
}

/** An inbox the snapshot counted in full. */
export function nextUpOperator(capturedAt: string): OperatorPosture {
  return { waiting: 5, urgent: 1, measuredProjects: 3, urgentMeasuredProjects: 3, projectCount: 3, capturedAt };
}
