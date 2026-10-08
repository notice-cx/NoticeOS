import { isSettingUp } from "@shared/asset-setup";
import type { AssetCard } from "@shared/wall";
import type { StateTone } from "@/components/StateChip";
import type { WallIssue } from "@/lib/wall-issues";

/**
 * A SITE'S ONE HEALTH WORD (D44; doc 21 § Home — the sites strip, and the
 * Overview's verdict pill; prior art Linear's project health: on track, at
 * risk, off track — docs/briefs/2026-10-08-home-overview-redesign.md § overview).
 *
 * One derivation, so Home's strip and the site's own header can never call
 * the same site two things. The word is a VERDICT and the colour follows it:
 * only the two problem words wear a tone, so a strip of healthy sites is
 * quiet (doc 14: colour is meaning; doc 21 principle 5).
 *
 * Order: a site still being set up is "Setting up" whatever else is true of
 * it (nothing measured can be off track); then the worst open problem wins;
 * then monitor-only names the automation posture; then on track.
 */
export type SiteHealthKey = "setting-up" | "off-track" | "at-risk" | "monitor-only" | "on-track";

export interface SiteHealth {
  key: SiteHealthKey;
  word: string;
  tone: StateTone;
}

const WORDS: Record<SiteHealthKey, { word: string; tone: StateTone }> = {
  "setting-up": { word: "Setting up", tone: "na" },
  "off-track": { word: "Off track", tone: "critical" },
  "at-risk": { word: "At risk", tone: "caution" },
  "monitor-only": { word: "Monitor only", tone: "neutral" },
  "on-track": { word: "On track", tone: "affirmative" },
};

export function siteHealth(
  card: Pick<AssetCard, "id" | "status" | "senseOnly" | "openError" | "openWarn">,
  issues: readonly WallIssue[] = [],
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
  return { key, ...WORDS[key] };
}
