import { isSettingUp } from "@shared/asset-setup";
import type { AssetCard } from "@shared/wall";
import type { StateTone } from "@/components/StateChip";
import type { WallIssue } from "@/lib/wall-issues";

/**
 * A site's one health word. One derivation, so Home's strip and the site's
 * own header can never call the same site two things. The word is a verdict
 * and the colour follows it: only the two problem words wear a tone. Order: a
 * site still being set up is "Setting up" whatever else is true of it; then
 * the worst open problem wins; then monitor-only names the automation
 * posture; then on track.
 */
export type SiteHealthKey = "setting-up" | "off-track" | "at-risk" | "monitor-only" | "on-track";

export interface SiteHealth {
  key: SiteHealthKey;
  word: string;
  tone: StateTone;
}

/** Each health key's word and tone, for a filter chip or a legend. */
export const SITE_HEALTH: Readonly<Record<SiteHealthKey, { word: string; tone: StateTone }>> = {
  "setting-up": { word: "Setting up", tone: "na" },
  "off-track": { word: "Off track", tone: "critical" },
  "at-risk": { word: "At risk", tone: "caution" },
  "monitor-only": { word: "Monitor only", tone: "neutral" },
  "on-track": { word: "On track", tone: "affirmative" },
};

export function siteHealth(
  card: Pick<AssetCard, "id" | "status" | "senseOnly" | "openError" | "openWarn">,
  issues: readonly Pick<WallIssue, "assets" | "severity">[] = [],
): SiteHealth {
  const mine = issues.filter((issue) => issue.assets.includes(card.id));
  const key: SiteHealthKey = isSettingUp(card.status)
    ? "setting-up"
    : card.openError > 0 || mine.some((issue) => issue.severity === "error")
      ? "off-track"
      : card.openWarn > 0 || mine.some((issue) => issue.severity === "warn")
        ? "at-risk"
        : card.senseOnly
          ? "monitor-only"
          : "on-track";
  return { key, ...SITE_HEALTH[key] };
}
