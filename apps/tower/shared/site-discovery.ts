// THE CONNECT PANEL'S SITE LIST: what the account holds, matched to the
// portfolio's assets by domain, and the one press that saves the matches and
// collects them (bead `ro-ujb9.96.7.2`, epic `ro-ujb9.96.7`).
//
// Pure, so the rules are tested without a browser. Three rules decide a row:
//
//   1. A MATCH IS A SUGGESTION. An account site whose host is the asset's own
//      domain (`siteHost`, the rule the Bing collector itself uses) is ticked,
//      and nothing is written until the operator presses Start — which writes
//      exactly what the ticked rows show.
//   2. NOTHING IS DROPPED. An asset the account lists no site for is a row that
//      says so; an account site no asset claims is listed under the rows; a
//      site the provider will not serve yet (an unverified Bing site) is listed,
//      never ticked; an asset the lane does not collect is a row saying why.
//   3. THE WRITE IS THE DATA SOURCES TAB'S. Each confirmed site becomes the
//      `asset-lane` field ops `laneFieldOp` builds for that tab
//      (`shared/lane-mapping-ops.ts`), guarded by what the register holds now,
//      and a field already holding the value is not written again.
//   4. AN UNTICKED BOX IS NOT A DECISION (bead `ro-ujb9.96.7.18`). A row the
//      scheduled job collects anyway (a domain match, a mapped site, a
//      portfolio candidate) that the operator unticks is either given a
//      reason — and saved as the Data sources row's own Not using in the same
//      press — or it stays collected on schedule and the row says so. No
//      reason is ever picked for the operator.
//
// Built for every provider kind the epic adds: a row is an ASSET with one entry
// per lane the provider collects (Google's GA4 + Search Console arrive as two
// lanes on one row), and a portfolio provider (DataForSEO) lists its own
// candidates with the asset each one is.

import type { DiscoveredSite, SiteDiscovery, SiteSpendPreview } from "@noticeos/contract/site-discovery";
import { siteHost } from "@noticeos/contract/site-discovery";
import { DATAFORSEO_BASELINE } from "./site-markets";
import type { FileJsonSetOp, JsonValue } from "./changeset";
import { declineOps } from "./lane-decline";
import { laneFieldOp } from "./lane-mapping-ops";

/** One portfolio asset as the panel matches it (the `…/sites` route builds it
 * from the assets table and the register). */
export interface SitesAsset {
  id: string;
  label: string;
  domain: string | null;
  /** The lifecycle stage (`assets.status`). */
  status: string;
  /** Per lane the provider collects: the register's cell — its posture, its
   * note (null when the key is absent) and the mapping fields it already
   * holds — or null when the asset has no entry. The posture and note are the
   * guards a "Not using" from this panel writes against (bead
   * `ro-ujb9.96.7.18`). `funnels` is a PostHog entry's saved funnel list as
   * held, absent when the key is (bead `ro-ujb9.96.7.8`): the guard a
   * picked-up funnel list is written against, and never over. */
  cells: Record<string, { status: string; note?: string | null; mapping: Record<string, string | number>; funnels?: JsonValue } | null>;
}

/** `GET /api/integrations/:provider/sites`. */
export interface SitesPayload {
  discovery: SiteDiscovery;
  assets: SitesAsset[];
  /** A metered provider's spend preview; null for every free one. */
  spend: SiteSpendPreview | null;
  /** The lanes whose scheduled job collects an asset nothing is mapped for by
   * matching its own domain (Bing's fallback, `LANE_MAPPING`). On any other
   * lane — Mediavine, PostHog — a domain match is only a suggestion until
   * Start writes it. Absent: none. */
  domainMatch?: readonly string[];
}

/**
 * How one lane of one asset stands:
 *  - `mapped`   — the register already names a site the account lists;
 *  - `matched`  — the account lists a site on the asset's own domain;
 *  - `listed`   — a portfolio provider collects this asset (DataForSEO);
 *  - `not-ready`— the matching site is listed but the provider will not serve
 *                 it yet (Bing: not verified);
 *  - `unlisted` — the account lists nothing for it (`choices` may offer one).
 */
export type SiteLaneState = "mapped" | "matched" | "listed" | "not-ready" | "unlisted";

export interface SiteLane {
  lane: string;
  state: SiteLaneState;
  /** The site this lane would be collected from, before any pick. */
  site: DiscoveredSite | null;
  /** Ready sites of this lane that no asset claims, for an unlisted row. */
  choices: DiscoveredSite[];
  /** The register's mapping fields as held now; null when there is no cell. */
  saved: Record<string, string | number> | null;
}

/** Why a row cannot be collected here, drawn as a chip rather than a sentence. */
export type SiteExclusion = "not-using" | "not-applicable" | "pre-launch" | "no-domain";

export interface SiteRow {
  asset: SitesAsset;
  lanes: SiteLane[];
  excluded: SiteExclusion | null;
  /** Ticked when the panel opens: a mapped or matched, collectable row — and
   * the asset the panel was opened from, whenever it can be collected. */
  checked: boolean;
  /** The provider's scheduled job collects this asset WITHOUT anything being
   * written here (bead `ro-ujb9.96.7.18`): the register maps a site the
   * account lists, the account holds one on the asset's own domain (Bing's
   * fallback), or the portfolio provider covers it (DataForSEO's weekly
   * sweep). Unticking such a row does not stop it being collected — only
   * "Not using", with a reason, does. */
  scheduled: boolean;
  /** The asset the panel was opened from (an asset's source row). */
  preselected: boolean;
}

export interface SitePlan {
  provider: string;
  kind: "account" | "portfolio";
  rows: SiteRow[];
  /** Account sites no row claims — listed, never dropped. */
  others: DiscoveredSite[];
}

/** The lanes a provider's rows carry, in its own declared order. */
function lanesOf(payload: SitesPayload): string[] {
  const fromCells = [...new Set(payload.assets.flatMap((asset) => Object.keys(asset.cells)))];
  const fromSites = payload.discovery.ok ? payload.discovery.sites.map((site) => site.lane) : [];
  return [...new Set([...fromCells, ...fromSites])];
}

/** The site to prefer when one host has several: https before http, the site
 * root before a path, then the provider's own order. */
function preferred(sites: DiscoveredSite[]): DiscoveredSite | null {
  const rank = (site: DiscoveredSite) => (site.ref.startsWith("https://") ? 0 : 1) * 2 + (/^https?:\/\/[^/]+\/?$/.test(site.ref) ? 0 : 1);
  return [...sites].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Does this saved mapping name that site? Every field the site writes must
 * already hold the site's value. */
function holds(saved: Record<string, string | number> | null, site: DiscoveredSite): boolean {
  const entries = Object.entries(site.mapping);
  return saved !== null && entries.length > 0 && entries.every(([field, value]) => saved[field] === value);
}

function exclusionOf(asset: SitesAsset, lanes: string[], kind: SitePlan["kind"], listed: boolean): SiteExclusion | null {
  const cells = lanes.map((lane) => asset.cells[lane]).filter((cell) => cell !== null && cell !== undefined);
  if (cells.length > 0 && cells.every((cell) => cell!.status === "not-applicable")) return "not-applicable";
  if (cells.length > 0 && cells.every((cell) => cell!.status === "skipped" || cell!.status === "not-applicable")) return "not-using";
  if (!asset.domain) return "no-domain";
  if (kind === "portfolio" && !listed) return asset.status === "pre-launch" ? "pre-launch" : "no-domain";
  return null;
}

/**
 * The panel's rows: every portfolio asset, matched to the account's sites.
 * `preselect` is the asset the panel was opened from; it leads the list.
 */
export function planSites(payload: SitesPayload, preselect: string | null = null): SitePlan {
  const discovery = payload.discovery;
  const sites = discovery.ok ? discovery.sites : [];
  const kind = discovery.ok ? discovery.kind : "account";
  const lanes = lanesOf(payload);
  const claimed = new Set<DiscoveredSite>();

  // First pass: what each asset's lanes already point at or match by domain.
  const drafts = payload.assets.map((asset) => {
    const host = siteHost(asset.domain);
    const own = sites.filter((site) => kind === "portfolio" ? site.asset === asset.id : false);
    const entries = lanes.map((lane) => {
      const cell = asset.cells[lane];
      const saved = cell === undefined || cell === null ? null : cell.mapping;
      const ofLane = sites.filter((site) => site.lane === lane);
      if (kind === "portfolio") {
        const site = own.find((entry) => entry.lane === lane) ?? null;
        return { lane, saved, site, state: (site ? "listed" : "unlisted") as SiteLaneState };
      }
      const mapped = ofLane.find((site) => holds(saved, site)) ?? null;
      const onDomain = host === null ? [] : ofLane.filter((site) => site.host === host);
      const ready = preferred(onDomain.filter((site) => site.ready));
      const site = mapped ?? ready ?? preferred(onDomain);
      const state: SiteLaneState = mapped ? "mapped" : ready ? "matched" : site ? "not-ready" : "unlisted";
      return { lane, saved, site, state };
    });
    for (const entry of entries) if (entry.site) claimed.add(entry.site);
    return { asset, entries, listed: own.length > 0 };
  });

  const unclaimed = sites.filter((site) => !claimed.has(site));
  const domainMatch = new Set(payload.domainMatch ?? []);
  const rows: SiteRow[] = drafts.map(({ asset, entries, listed }) => {
    const excluded = exclusionOf(asset, lanes, kind, listed);
    const siteLanes: SiteLane[] = entries.map((entry) => ({
      ...entry,
      choices: entry.state === "unlisted" && kind === "account" ? unclaimed.filter((site) => site.lane === entry.lane && site.ready) : [],
    }));
    const collectable = excluded === null && siteLanes.some((lane) => lane.site !== null && lane.site.ready);
    const suggested = siteLanes.some((lane) => lane.state === "mapped" || lane.state === "matched" || lane.state === "listed");
    // Collected on schedule with nothing written: a saved mapping, the
    // portfolio's own membership, or a domain match on a lane that falls back
    // to one (bead `ro-ujb9.96.7.6`: a Mediavine or PostHog match is not).
    const onSchedule = siteLanes.some((lane) => lane.state === "mapped" || lane.state === "listed" || (lane.state === "matched" && domainMatch.has(lane.lane)));
    const preselected = preselect === asset.id;
    return { asset, lanes: siteLanes, excluded, checked: collectable && (suggested || preselected), scheduled: excluded === null && onSchedule, preselected };
  });

  // The asset the panel was opened for first, then what will be collected,
  // then the rest; the portfolio's own order within each.
  const order = (row: SiteRow) => (row.preselected ? 0 : row.checked ? 1 : row.excluded ? 3 : 2);
  rows.sort((a, b) => order(a) - order(b));
  return { provider: discovery.provider, kind, rows, others: kind === "account" ? unclaimed : [] };
}

/** What the operator has chosen on the list: which rows are ticked, and, for a
 * row the account listed nothing for, which of the unclaimed sites they picked. */
export interface SiteSelection {
  checked: ReadonlySet<string>;
  /** asset → lane → the picked site's ref. */
  picks: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** asset → the reason the operator picked for an unticked scheduled row
   * (bead `ro-ujb9.96.7.18`), in their words. Absent: nothing chosen yet. */
  declined?: Readonly<Record<string, string>>;
}

export function initialSelection(plan: SitePlan): SiteSelection {
  return { checked: new Set(plan.rows.filter((row) => row.checked).map((row) => row.asset.id)), picks: {}, declined: {} };
}

/**
 * What one row will come to when Start is pressed (bead `ro-ujb9.96.7.18`):
 *  - `collect`    — ticked: its mapping saved and its first collection run now;
 *  - `not-using`  — unticked with a reason: saved as the Data sources row's own
 *                   Not using, so the scheduled job stops collecting it;
 *  - `undecided`  — unticked with no reason yet, and the scheduled job still
 *                   collects it: the row has to say so, because an unticked
 *                   box reads as "not collected" and it is not;
 *  - null         — unticked and nothing collects it anyway, or it cannot be
 *                   collected here at all (a chip on the row says why).
 * A reason is never assumed: `undecided` stays undecided until one is picked.
 */
export type RowDecision = "collect" | "not-using" | "undecided";

export function rowDecision(row: SiteRow, selection: SiteSelection): RowDecision | null {
  if (!rowCollectable(row, selection)) return null;
  if (selection.checked.has(row.asset.id)) return "collect";
  if (!row.scheduled || !row.lanes.some((lane) => row.asset.cells[lane.lane])) return null;
  return selection.declined?.[row.asset.id] === undefined ? "undecided" : "not-using";
}

/** The site a row's lane will be collected from under the current selection. */
export function chosenSite(row: SiteRow, lane: SiteLane, selection: SiteSelection): DiscoveredSite | null {
  const pick = selection.picks[row.asset.id]?.[lane.lane];
  if (pick !== undefined) return lane.choices.find((site) => site.ref === pick) ?? null;
  return lane.site !== null && lane.site.ready ? lane.site : null;
}

/** Can this row be ticked now? It must be collectable and have a ready site. */
export function rowCollectable(row: SiteRow, selection: SiteSelection): boolean {
  return row.excluded === null && row.lanes.some((lane) => chosenSite(row, lane, selection) !== null);
}

/** Account sites still unclaimed once the operator's picks are taken out. */
export function unclaimedSites(plan: SitePlan, selection: SiteSelection): DiscoveredSite[] {
  const picked = new Set(Object.values(selection.picks).flatMap((lanes) => Object.values(lanes)));
  return plan.others.filter((site) => !picked.has(site.ref));
}

export interface StartPlan {
  /** The `asset-lane` writes, one per field that changes. Empty when every
   * confirmed site is already mapped (or the lane needs no mapping). */
  ops: FileJsonSetOp[];
  /** The assets whose first collection runs now. */
  assets: string[];
  /** The assets saved as Not using in the same press (bead `ro-ujb9.96.7.18`). */
  declined: string[];
}

/**
 * What one press of Start writes and collects: for every ticked, collectable
 * row, each chosen site's mapping fields through the Data sources tab's own
 * `laneFieldOp` — skipping a field that already holds the value — and the row's
 * asset in the collection. For every unticked row the scheduled job would
 * still collect and the operator gave a reason for, the Data sources row's own
 * Not using (`declineOps`, shared/lane-decline.ts) on each of its lanes, in the
 * same changeset. An unticked row with no reason writes nothing: it is still
 * collected on schedule, and says so.
 */
export function startPlan(plan: SitePlan, selection: SiteSelection): StartPlan {
  const ops: FileJsonSetOp[] = [];
  const assets: string[] = [];
  const declined: string[] = [];
  for (const row of plan.rows) {
    const decision = rowDecision(row, selection);
    if (decision === "not-using") {
      const reason = selection.declined![row.asset.id]!;
      for (const lane of row.lanes) {
        const cell = row.asset.cells[lane.lane];
        if (!cell) continue;
        ops.push(...declineOps(row.asset.id, lane.lane, { status: cell.status, note: cell.note ?? null }, reason));
      }
      declined.push(row.asset.id);
      continue;
    }
    if (decision !== "collect") continue;
    assets.push(row.asset.id);
    for (const lane of row.lanes) {
      const site = chosenSite(row, lane, selection);
      // No cell: the register has no entry for this lane, so there is nothing
      // the Data sources tab could write either — the lane's own fallback
      // (Bing's domain match) is what collects it.
      if (site === null || lane.saved === null) continue;
      for (const [field, value] of Object.entries(site.mapping)) {
        const held = lane.saved[field] ?? null;
        if (held === value) continue;
        ops.push(laneFieldOp(row.asset.id, lane.lane, field, held, value));
      }
      // PostHog's saved funnels (bead `ro-ujb9.96.7.8`), picked up from the
      // project — written only where the entry holds none, never over a list
      // somebody already chose.
      const held = row.asset.cells[lane.lane]?.funnels;
      if (site.funnels && site.funnels.length > 0 && (held === undefined || (Array.isArray(held) && held.length === 0))) {
        ops.push(laneFieldOp(row.asset.id, lane.lane, "funnels", held ?? null, site.funnels as unknown as JsonValue));
      }
    }
  }
  return { ops, assets, declined };
}

/** How many funnels a row brings from its project, under the current choice. */
export function rowFunnels(row: SiteRow, selection: SiteSelection): number {
  return row.lanes.reduce((sum, lane) => sum + (chosenSite(row, lane, selection)?.funnels?.length ?? 0), 0);
}

/** A DataForSEO row's market, in words: the saved codes, else the baseline. */
export function marketOf(lane: SiteLane): { locationCode: number; languageCode: string } {
  const location = lane.saved?.locationCode;
  const language = lane.saved?.languageCode;
  return {
    locationCode: typeof location === "number" ? location : DATAFORSEO_BASELINE.locationCode,
    languageCode: typeof language === "string" ? language : DATAFORSEO_BASELINE.languageCode,
  };
}

/** What the confirmed sites' first week is likely to cost, and at most. */
export function spendFor(spend: SiteSpendPreview, sites: number): { weekUsd: number | null; ceilingUsd: number; afterUsd: number | null } {
  const weekUsd = spend.perSiteWeekUsd === null ? null : spend.perSiteWeekUsd * sites;
  return { weekUsd, ceilingUsd: spend.perSiteCeilingUsd * sites, afterUsd: weekUsd === null ? null : spend.spentUsd + weekUsd };
}
