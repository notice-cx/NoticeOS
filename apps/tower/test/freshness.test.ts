import { describe, expect, it } from "vitest";
import { ageMs, formatAge, isAmber } from "@shared/freshness";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(NOW - h * HOUR).toISOString();

describe("ageMs", () => {
  it("is null for missing or unparseable timestamps", () => {
    expect(ageMs(NOW, null)).toBeNull();
    expect(ageMs(NOW, undefined)).toBeNull();
    expect(ageMs(NOW, "not-a-date")).toBeNull();
  });

  it("computes a non-negative age", () => {
    expect(ageMs(NOW, hoursAgo(2))).toBe(2 * HOUR);
    // future timestamps clamp to 0 rather than going negative
    expect(ageMs(NOW, new Date(NOW + 5_000).toISOString())).toBe(0);
  });
});

describe("isAmber (amber past 2× cadence)", () => {
  it("is fresh below the 2× threshold", () => {
    expect(isAmber(NOW, hoursAgo(40), 24)).toBe(false);
    expect(isAmber(NOW, hoursAgo(48), 24)).toBe(false); // exactly 2× is not yet amber
  });

  it("is amber above the 2× threshold", () => {
    expect(isAmber(NOW, hoursAgo(49), 24)).toBe(true);
  });

  it("treats missing data as amber (an absent age is never fresh)", () => {
    expect(isAmber(NOW, null, 24)).toBe(true);
  });
});

describe("formatAge", () => {
  it("renders compact units and an em dash for unknown", () => {
    // The em dash STAYS here on purpose (bead ro-kukv.10). The badge's "never"
    // belongs to the badge; this helper is shared with fifteen sites that
    // interpolate it as "{age} ago", where a word would read "never ago".
    expect(formatAge(null)).toBe("—");
    expect(formatAge(5_000)).toBe("5s");
    expect(formatAge(5 * 60_000)).toBe("5m");
    expect(formatAge(3 * HOUR)).toBe("3h");
    expect(formatAge(2 * 86_400_000)).toBe("2d");
  });

  it("never yields a word, so no call site can render 'never ago'", () => {
    // One table over every `formatAge` call site in the app, each with the
    // template it renders and whether that site can be handed a null age. The
    // acceptance criterion is mechanical: no output of any row contains a word,
    // and "never ago" appears nowhere.
    const callSites: {
      where: string;
      render: (age: string) => string;
      nullable: boolean;
    }[] = [
      { where: "AgeBadge.tsx:—", render: (a) => a, nullable: true },
      { where: "alert-language.ts:979", render: (a) => `deploy ${a} before`, nullable: false },
      { where: "ScheduledLanes.tsx:83", render: (a) => `Scheduler silent · last firing ${a} ago`, nullable: false },
      { where: "ScheduledLanes.tsx:91", render: (a) => `age ${a}`, nullable: false },
      { where: "ScheduledLanes.tsx:92", render: (a) => `age ${a}`, nullable: false },
      { where: "ScheduledLanes.tsx:233", render: (a) => `${a} ago`, nullable: false },
      { where: "PanelReviewBadge.tsx:70", render: (a) => a, nullable: true },
      { where: "PanelReviewBadge.tsx:78", render: (a) => a, nullable: true },
      { where: "PanelReviewBadge.tsx:85", render: (a) => a, nullable: true },
      { where: "EvidencePopover.tsx:151", render: (a) => `· ${a} ago`, nullable: false },
      { where: "Timeline.tsx:103", render: (a) => `${a} ago`, nullable: false },
      { where: "AssetsBand.tsx:488", render: (a) => `Updated ${a} ago`, nullable: false },
      { where: "AttentionBand.tsx:491", render: (a) => `${a} ago`, nullable: false },
      { where: "AttentionBand.tsx:544", render: (a) => `3× in ${a}`, nullable: false },
      { where: "WallRoute.tsx:57", render: (a) => `updated ${a} ago`, nullable: false },
      { where: "TasksRoute.tsx:950", render: (a) => a, nullable: false },
      { where: "HomeRoute.tsx:661", render: (a) => a, nullable: false },
      { where: "HomeRoute.tsx:816", render: (a) => `${a} ago`, nullable: false },
      { where: "AssetDetailRoute.tsx:3261", render: (a) => `${a} ago`, nullable: false },
      { where: "AssetDetailRoute.tsx:3273", render: (a) => `${a} ago`, nullable: false },
      { where: "AssetDetailRoute.tsx:3954", render: (a) => `${a} ago`, nullable: false },
      { where: "TaskRoute.tsx:1251", render: (a) => `${a} ago`, nullable: false },
    ];
    const ages = [null, 0, 5_000, 5 * 60_000, 3 * HOUR, 2 * 86_400_000];
    for (const site of callSites) {
      // `nullable` records which sites can actually be handed an absent age;
      // every site is fed one regardless, because the guarantee being pinned
      // is that no input to this helper can produce a word at all.
      const label = `${site.where}${site.nullable ? " (nullable)" : ""}`;
      for (const ms of ages) {
        const line = site.render(formatAge(ms));
        expect(line, label).not.toContain("never");
        expect(line, label).not.toMatch(/[A-Za-z]{4,}\s+ago/);
      }
    }
  });
});
