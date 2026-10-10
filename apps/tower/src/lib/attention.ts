// The pure answers about one open alert that Home's Alerts list and /alerts
// both read, so a group cannot be a group on one surface and four rows on
// another, and an alert files the same task wherever it is filed.

import type { AttentionItem } from "@shared/wall";
import { translateAlert } from "@shared/alert-language";
import type { TaskHandoff } from "@/lib/task-handoff";

/**
 * The sites behind a grouped row, as one hover string.
 *
 * A group's headline states the COUNT, not the names — four site names in a
 * row is the wall of text the group exists to remove. The names still have to
 * be one gesture away: a `title` is the one affordance both a pointer and a
 * screen reader reach without a click.
 */
export function memberNames(item: AttentionItem): string | undefined {
  return item.members && item.members.length > 1
    ? item.members.map((member) => member.assetDisplayName).join(", ")
    : undefined;
}

/** A grouped row has no single site, so the surfaces drop the site label
 * rather than print the representative's name over four sites' fact. */
export function isGrouped(item: AttentionItem): boolean {
  return (item.members?.length ?? 0) > 1;
}

/** The alert's kind in words, as the filed task says it. */
export function kindLabel(item: AttentionItem): string {
  if (item.kind === "opportunity") return "Opportunity";
  if (item.kind === "milestone") return "Milestone";
  return "Anomaly";
}

/**
 * The task an alert row files: the `alert` handoff kind.
 *
 * The key is `flags.id`, not the rule id: a rule fires repeatedly on one site,
 * and only the flag id names the firing on screen. `rule:` carries the
 * `rule_id`, so `bd list -l rule:watch-window-closed` still gathers the family.
 *
 * The TITLE is the TRANSLATED headline — what happened in plain words with its
 * magnitude — never the rule's stored `message`, the statistics line the desk
 * keeps behind the evidence glyph. A grouped row files nothing: it stands for
 * several sites that each have their own flag, so there is no single firing to
 * name.
 */
export function alertTaskHandoff(item: AttentionItem): TaskHandoff {
  const alert = translateAlert(item);
  return {
    asset: item.asset,
    kind: "alert",
    key: String(item.id),
    rule: item.ruleId,
    title: alert.headline,
    summary:
      `From the NoticeOS alert for ${item.asset} (${kindLabel(item)}, ${item.severity}, rule ${item.ruleId}): ` +
      `${alert.headline}${alert.hint ? ` ${alert.hint}` : ""}`,
    // An error is ground already being lost; a warning is a condition to look
    // at. The same reading `ExecutiveInsightRow` gives its two loudest kinds.
    priority: item.severity === "error" ? 1 : 2,
  };
}
