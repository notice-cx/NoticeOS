// Adding a site: the pure half. The draft the add screen fills in, what it
// refuses, and the exact writes Add performs; the screen
// (src/components/AddSite.tsx) renders it. The screen asks for the domain
// alone; every other answer is the default (`emptyDraft`), changeable on the
// asset's Settings tab.
//
// One asset is two writes: the store row (POST /api/assets, the join key
// everything else hangs off) and one changeset of config entries through the
// write lane (PUT /api/config). The row goes first: its `409 asset_exists` is
// the only authoritative answer to "is this id taken", and an orphaned row is
// visible on `/assets` while an orphaned config entry is invisible. See
// `planWrites` and `lib/asset-operations.ts`.

import type {
  AssetStatusValue,
  FileJsonInsertOp,
  FileJsonSetOp,
  JsonValue,
} from "./changeset";
import { changesetSlug } from "./changeset";
import { entityMoveOps, type EntityRow } from "./entities";
import type { LaneScope } from "./integrations";

import { ASSET_ID_MAX, DISPLAY_NAME_MAX, ASSET_ID_RE, DOMAIN_RE } from '@noticeos/contract/configuration';
export { ASSET_ID_MAX, DISPLAY_NAME_MAX, ASSET_ID_RE, DOMAIN_RE } from '@noticeos/contract/configuration';

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/** How the OS gets this asset's nightly numbers. */
export type CollectionMode = "push" | "pull";

/** What a fetched endpoint speaks. `envelope` is the pulse envelope;
 * `prometheus` is a metrics page the counters lane scrapes. */
export type PullFormat = "envelope" | "prometheus";

/** One total the asset's card shows (`config/counters.json` → `cards[]`). */
export interface CounterCardDraft {
  /** The pulse metric key the reading is stored under (`signups`). */
  metric: string;
  /** What the card prints under the number ("Accounts"). */
  label: string;
}

export interface AssetDraft {
  displayName: string;
  domain: string;
  /** Which legal entity owns the asset — the `slug` of a row in
   * `config/entities.json`, or `""` for nobody has said. Create adds this
   * asset's id to that entity's own list. */
  entity: string;
  status: AssetStatusValue;
  /** 1 = the OS only watches this asset. The store's own default. */
  senseOnly: 0 | 1;
  collection: CollectionMode;
  pullUrl: string;
  pullFormat: PullFormat;
  counters: CounterCardDraft[];
}

/** A fresh draft. The two defaults that are decisions rather than blanks:
 * `onboarding`, and `senseOnly: 1` (the store's own column default). */
export function emptyDraft(): AssetDraft {
  return {
    displayName: "",
    domain: "",
    entity: "",
    status: "onboarding",
    senseOnly: 1,
    collection: "push",
    pullUrl: "",
    pullFormat: "envelope",
    counters: [],
  };
}

/** The stages a NEW asset may start in. `retired` is missing on purpose: an
 * asset created decommissioned is not a state, it is a typo. */
export const CREATABLE_STATUSES: AssetStatusValue[] = [
  "pre-launch",
  "onboarding",
  "baselining",
  "live",
];

// ---------------------------------------------------------------------------
// The id, derived from the domain
// ---------------------------------------------------------------------------

/**
 * The asset id the store will hold, derived from what the operator typed.
 * Every site's id is its domain, so the id is derived and shown, never typed:
 * paste a full URL and the scheme, `www.`, path, port and trailing dot all
 * come off. Returns `""` when nothing usable is left.
 */
export function assetIdFromDomain(domain: string): string {
  let value = domain.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.replace(/^[^/@]*@/, "");
  value = value.split(/[/?#]/)[0] ?? "";
  value = value.replace(/:\d+$/, "");
  value = value.replace(/^www\./, "");
  value = value.replace(/\.+$/, "");
  return value;
}

/**
 * The top-level names a site's name is NOT made of: the generic endings a
 * reader skips when saying a site's name out loud. `fieldnotes.com` is
 * "Fieldnotes", but `tide-tables.cafe` and `journey.example` keep their
 * endings, because on a domain hack the ending IS half the name. A two-label public
 * suffix (`co.uk`) comes off whole.
 */
const GENERIC_ENDINGS: ReadonlySet<string> = new Set([
  "com", "net", "org", "io", "co", "app", "dev", "ai", "info", "biz", "xyz",
  "site", "online", "website", "tech", "us", "uk", "ca", "de", "eu", "au", "nz",
  "fr", "es", "it", "nl", "se", "ch", "at", "be", "ie", "in", "jp", "br", "mx",
]);
const GENERIC_SECOND_LEVELS: ReadonlySet<string> = new Set(["co", "com", "org", "net", "ac", "gov"]);

/**
 * A site's name, read off its domain: `journey.example` → "Journey Example",
 * `second-site.com` → "Second Site", `shop.example.com` → "Shop Example". A
 * starting name, not a verdict: the site's own name replaces it when the site
 * answers (`shared/site-name.ts`). Returns `""` when the domain leaves no id.
 */
export function siteNameFromDomain(domain: string): string {
  const labels = assetIdFromDomain(domain).split(".").filter((label) => label.length > 0);
  if (labels.length === 0) return "";
  if (labels.length > 2 && GENERIC_SECOND_LEVELS.has(labels.at(-2)!) && labels.at(-1)!.length === 2) {
    labels.splice(-2, 2);
  } else if (labels.length > 1 && GENERIC_ENDINGS.has(labels.at(-1)!)) {
    labels.pop();
  }
  const name = labels
    .flatMap((label) => label.split(/[-_]+/))
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return name.slice(0, DISPLAY_NAME_MAX).trim();
}

/** What the add screen knows about a site before Add: the domain, the name it
 * will be saved under, and whether the site has launched yet. */
export interface SiteAnswers {
  domain: string;
  /** The inferred name — the site's own when it answered, else the domain's. */
  displayName: string;
  /** The one optional answer: a site that has not launched starts in the
   * `pre-launch` stage, which the paid collectors and the report-freshness
   * check skip, so a site with nothing to measure yet raises no alarm and buys
   * no metered collection. */
  prelaunch: boolean;
}

/** The draft a one-screen add creates: `emptyDraft` with the answers the
 * screen has — Monitor only, pushed nightly reports, no totals and every data
 * source Not set up. */
export function siteDraft(answers: SiteAnswers): AssetDraft {
  return {
    ...emptyDraft(),
    domain: answers.domain,
    displayName: answers.displayName,
    status: answers.prelaunch ? "pre-launch" : "onboarding",
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** One refusal, addressed to the field that can fix it. `field` is the input's
 * own id so the screen can render it beside that field. */
export interface FieldIssue {
  field: string;
  /** A short state, never a paragraph. */
  message: string;
  /** Set when the refusal is "this site is already here": the id of the asset
   * the operator can open instead. */
  existing?: string;
}

export interface ValidationContext {
  /** Every asset id the wall payload knows. The cheap, local duplicate check;
   * the store's 409 is the authoritative one and lands on the same field. */
  existingIds: string[];
}

function trimmed(value: string): string {
  return value.trim();
}

/** Is this a URL the fetch lane could actually call? http/https only — a
 * `file://` or a bare hostname is a typo, not an endpoint. */
export function isFetchableUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    parsed.hostname.length > 0
  );
}

/** A metric key the pulse envelope can carry: the shape every existing key in
 * `config/counters.json` already has. */
export const METRIC_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The one refusal the domain field can carry, or null. Empty is not a
 * refusal: it is a field nobody has typed in yet, and Add stays unavailable
 * until it is filled. */
export function domainIssue(domain: string, context: ValidationContext): FieldIssue | null {
  if (trimmed(domain).length === 0) return null;
  const id = assetIdFromDomain(domain);
  if (id.length === 0 || !DOMAIN_RE.test(id) || !ASSET_ID_RE.test(id)) {
    return { field: "domain", message: "Not a domain — like example.com" };
  }
  if (id.length > ASSET_ID_MAX) return { field: "domain", message: "Too long for a site id" };
  if (context.existingIds.includes(id)) {
    return { field: "domain", message: "Already added", existing: id };
  }
  return null;
}

/** The refusals one list of card totals carries, one per field. */
export function counterIssues(counters: readonly CounterCardDraft[]): FieldIssue[] {
  const issues: FieldIssue[] = [];
  counters.forEach((card, index) => {
    if (trimmed(card.metric).length === 0) {
      issues.push({ field: `counter-metric-${index}`, message: "Metric key needed" });
    } else if (!METRIC_KEY_RE.test(trimmed(card.metric))) {
      issues.push({ field: `counter-metric-${index}`, message: "Letters, digits and _ only" });
    }
    if (trimmed(card.label).length === 0) {
      issues.push({ field: `counter-label-${index}`, message: "Label needed" });
    }
  });
  return issues;
}

/** Every refusal a whole draft carries, in field order — the guard before
 * Add. The checks stay whole so the write path refuses a draft it could not
 * honestly write, however it was composed. */
export function validateDraft(
  draft: AssetDraft,
  context: ValidationContext,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const name = trimmed(draft.displayName);
  if (name.length === 0) issues.push({ field: "displayName", message: "Name needed" });
  else if (name.length > DISPLAY_NAME_MAX) {
    issues.push({ field: "displayName", message: `At most ${DISPLAY_NAME_MAX} characters` });
  }
  const domain =
    trimmed(draft.domain).length === 0
      ? { field: "domain", message: "Domain needed" }
      : domainIssue(draft.domain, context);
  if (domain !== null) issues.push(domain);
  if (!CREATABLE_STATUSES.includes(draft.status)) {
    issues.push({ field: "status", message: "Not a starting stage" });
  }
  if (draft.collection === "pull" && !isFetchableUrl(draft.pullUrl)) {
    issues.push({ field: "pullUrl", message: "A full https:// URL" });
  }
  issues.push(...counterIssues(draft.counters));
  return issues;
}

// ---------------------------------------------------------------------------
// The writes
// ---------------------------------------------------------------------------

/** The body `POST /api/assets` takes. Kept structural rather than importing the
 * client's `NewAsset`, so this module stays free of `src/`. */
export interface StoreRowWrite {
  id: string;
  displayName: string;
  domain: string;
  status: AssetStatusValue;
  senseOnly: 0 | 1;
}

export interface PlannedWrites {
  id: string;
  row: StoreRowWrite;
  /** The one changeset, in file order. Never empty: every asset gets an
   * integrations entry. Not every op is an insert: the owning entity is a set
   * on a row that already exists. */
  ops: (FileJsonInsertOp | FileJsonSetOp)[];
  slug: string;
}

/** Which catalog lanes a non-OS asset is asked about: the ones the register's
 * own scope rule says can apply to it. */
export function applicableLanes<T extends { id: string; scope: LaneScope }>(
  catalog: T[],
): T[] {
  return catalog.filter((lane) => lane.scope === "property" || lane.scope === "both");
}

/** Today, as the register writes a date. */
function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The totals on one asset's card, as the one insert `config/counters.json`
 * takes for it — the op Add sends when totals were asked for, and the op the
 * asset's Settings tab sends when they are added later. Blank rows are dropped;
 * `null` when nothing is left to write. */
export function countersEntryOp(
  id: string,
  cards: readonly CounterCardDraft[],
): FileJsonInsertOp | null {
  const counters = cards
    .map((card) => ({ metric: trimmed(card.metric), label: trimmed(card.label) }))
    .filter((card) => card.metric.length > 0 && card.label.length > 0);
  if (counters.length === 0) return null;
  return {
    kind: "file-json-insert",
    file: "config/counters.json",
    pointer: `/assets/${id}`,
    value: { cards: counters } as JsonValue,
  };
}

/** One asset's metrics endpoint, as the one insert `config/pull.json` takes:
 * the op Add sends for a fetched asset, and the op the asset's Settings tab
 * sends when an asset that sends its own reports switches to being fetched. */
export function pullEntryOp(id: string, url: string, format: PullFormat): FileJsonInsertOp {
  return {
    kind: "file-json-insert",
    file: "config/pull.json",
    // RFC 6902's append token — `config/pull.json` is an array, and the entry
    // carries its own `asset` id so removing it later can address it.
    pointer: "/-",
    value: { asset: id, url: trimmed(url), enabled: true, format } as JsonValue,
  };
}

/**
 * Everything Add will do, decided before it is pressed. `catalog` is the lane
 * list from `GET /api/settings` (`sources.rows`) and `entities` is that
 * payload's entity list, in file order; the ops address a row by its position.
 */
export function planWrites(
  draft: AssetDraft,
  catalog: { id: string; label: string; scope: LaneScope }[],
  entities: readonly EntityRow[],
  at: Date = new Date(),
): PlannedWrites {
  const id = assetIdFromDomain(draft.domain);
  const since = isoDate(at);
  const entity = trimmed(draft.entity);
  const owner = entities.find((row) => row.slug === entity) ?? null;

  const row: StoreRowWrite = {
    id,
    displayName: trimmed(draft.displayName),
    domain: id,
    status: draft.status,
    senseOnly: draft.senseOnly,
  };

  const lanes = applicableLanes(catalog);
  const cells: Record<string, JsonValue> = {};
  for (const lane of lanes) {
    // Every source starts Not set up; declining one is a decision made on its
    // Data sources row. No note key: a blank note is one the `asset-lane`
    // register refuses, so the first reason arrives as a first write
    // (`expectAbsent`) and its Undo takes the key off again (`undeclineOps`).
    cells[lane.id] = { status: "needs-setup", since };
  }

  const ops: (FileJsonInsertOp | FileJsonSetOp)[] = [
    {
      kind: "file-json-insert",
      file: "config/integrations.json",
      pointer: `/assets/${id}`,
      value: cells as JsonValue,
    },
    // The panel roster, in the same changeset: membership is an invariant
    // (every asset has a row, and validation refuses a roster whose keys
    // differ from `config/integrations.json`'s). `enabled: false` is the only
    // honest starting value. `config/serp-panel.json` is deliberately not
    // written: an absent asset is skipped silently there, and a panel is a
    // weekly bill plus a review obligation — a decision made later.
    {
      kind: "file-json-insert",
      file: "config/signal-panels.json",
      pointer: `/assets/${id}`,
      // No note: `no-lane-yet` is what would enable the row, and the Growth
      // tab refuses turning it on before a live search source exists.
      value: {
        enabled: false,
        reason: "no-lane-yet",
        since,
      } as JsonValue,
    },
  ];

  const counters = countersEntryOp(id, draft.counters);
  if (counters !== null) ops.push(counters);

  // Who owns it: a set on the entity's existing row, built by the same
  // function the asset's Identity card uses to move an asset later.
  if (owner !== null) {
    ops.push(...entityMoveOps(entities, id, owner.slug));
  }

  if (draft.collection === "pull") {
    ops.push(pullEntryOp(id, draft.pullUrl, draft.pullFormat));
  }

  return { id, row, ops, slug: changesetSlug("add-asset", id) };
}
