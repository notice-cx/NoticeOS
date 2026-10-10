// HOME'S FIRST-RUN GUIDE, DERIVED FROM WHAT THE STORE ALREADY HOLDS (bead
// `ro-ujb9.123`). No onboarding state is stored: whether the guide shows, which
// site it follows and which step is next are all read off the wall payload's
// site cards and each source's one status (`connection-status.ts`).
//
// Plausible's waiting screen is the model: the guide stays until the first number arrives, then Home is
// the dashboard.

import { connectHref, firstToConnect } from "./connect-panel";
import { integrationLabel } from "./integrations";
import { cardHasMoney, type AssetCard } from "./wall";

/**
 * Has this site collected a number yet: a day of users or search clicks, a
 * nightly report, money on the ledger or a day's revenue estimate, or a
 * source's recorded successful collection. Any one ends its setup.
 */
export function siteHasFirstNumber(card: AssetCard): boolean {
  return card.activeUsers.series.length > 0
    || card.searchClicks.series.length > 0
    || card.firstReportAt !== null
    || card.pulseReceivedAt !== null
    || cardHasMoney(card)
    || card.netByMonth.some((point) => point.v !== null)
    || (card.dailyRevenue?.amountMinor ?? null) !== null
    || card.dataSources.some((source) => source.verification?.kind === "collection-success");
}

/**
 * WHERE A SITE OPENS (bead `ro-ujb9.96.7.4`; docs/reports/2026-09-23-ux-flow-
 * audit.html, "Configure an asset's sources": "While setup is unfinished, the
 * asset opens on Data sources"). Until its first number a site's Overview has
 * nothing to draw and its next action is on Data sources, so the sidebar, the
 * Sites table and the command palette open it there; from the first number on
 * they open its Overview. The same rule ends Home's guide (`firstRunSite`); a
 * new Sentry project opens on its setup guide the same way.
 */
export function siteOpensOn(card: AssetCard): "overview" | "sources" {
  return siteHasFirstNumber(card) ? "overview" : "sources";
}

/** The address of a site, or of a place in it — `/alerts`, `#timeline` —
 * with the id encoded. Every link into a site is built on this (bead
 * `ro-ujb9.199`); a link that means "open this site" is {@link sitePath}. */
export function siteAddress(id: string, place = ""): string {
  return `/assets/${encodeURIComponent(id)}${place}`;
}

/** The address a link to this site goes to: `siteOpensOn`'s tab. */
export function sitePath(card: AssetCard): string {
  return siteAddress(card.id, siteOpensOn(card) === "overview" ? "" : "/sources");
}

/**
 * The site Home's guide follows — or `null` once ANY site has its first
 * number, from which moment Home is the dashboard. Before that it follows the
 * newest site (cards arrive in the order sites were added, so the last one),
 * and before any site exists it follows none.
 */
export function firstRunSite(cards: readonly AssetCard[]): { site: AssetCard | null } | null {
  if (cards.some(siteHasFirstNumber)) return null;
  return { site: cards.at(-1) ?? null };
}

export type FirstRunStepKey = "add" | "connect" | "number";

export interface FirstRunStep {
  key: FirstRunStepKey;
  /** Done steps are ticked; the one current step is the screen's primary
   * action; the rest are plain links. */
  state: "done" | "current" | "next";
  title: string;
  /** Where the step goes. `null` for Add (it opens over Home), for a done
   * step, and for a step with nowhere to go yet. */
  to: string | null;
}

/** What a site's source reads as, as far as the guide cares. */
export interface GuideReading {
  id: string;
  label: string;
  kind: string;
  provider: string | null;
}

/** A provider's source that has a connection on it, whatever its health:
 * the step asked for a connection and it was made. */
const CONNECTED = new Set(["not-checked", "key-accepted", "collecting", "working", "overdue", "failing"]);

/**
 * The three steps for the site the guide follows. Step 2 opens that site's
 * first source still to connect in the connect panel — the same source its
 * Data sources lead with — and step 3 opens its Overview, where the first
 * number appears.
 */
export function firstRunSteps(
  site: Pick<AssetCard, "id" | "displayName"> | null,
  readings: readonly GuideReading[],
): FirstRunStep[] {
  if (site === null) {
    return [
      { key: "add", state: "current", title: "Add your first site", to: null },
      { key: "connect", state: "next", title: "Connect a source", to: "/integrations" },
      { key: "number", state: "next", title: "See your first number", to: null },
    ];
  }
  const overview = `/assets/${encodeURIComponent(site.id)}`;
  const connected = readings.find((one) => one.provider !== null && CONNECTED.has(one.kind)) ?? null;
  const next = connected === null ? firstToConnect(readings) : null;
  return [
    { key: "add", state: "done", title: `${site.displayName} added`, to: null },
    connected !== null
      ? { key: "connect", state: "done", title: `${integrationLabel(connected.id, connected.label)} connected`, to: null }
      : next !== null && next.provider !== null
        ? { key: "connect", state: "current", title: `Connect ${integrationLabel(next.id, next.label)}`, to: connectHref(next.provider, site.id) }
        : { key: "connect", state: "current", title: "Connect a source", to: `${overview}/sources` },
    { key: "number", state: connected !== null ? "current" : "next", title: "See your first number", to: overview },
  ];
}
