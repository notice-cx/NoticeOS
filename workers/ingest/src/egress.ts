// Can the OS get out? — asked before any property is accused of being dark
// (beads ro-034).
//
// THE INCIDENT. 2026-08-08, the operator's home internet was down for the night.
// Every nightly lane in this OS runs from that machine, so every one of them was
// fetching into a wall. The 04:00 hygiene sweep fired ~15 flags across six
// properties (`hygiene-home-unreachable`, `hygiene-robots-ai` reporting the file
// "vanished", `hygiene-sitemap` unreachable) and the 02:30 pull lane fired
// `asset-pull-failed` on two more. Not one property had changed anything. The OS
// had reported its own blindness as six other people's outage, and every alert
// was of the kind an operator has to open before learning it was nothing.
//
// WHY NOT READ THE ERROR. workerd wraps a connection-level failure as
// "internal error; reference = 0123…" — the same sentence for a dead uplink, a
// refused connection, and DNS that never resolved. There is nothing in the string
// to attribute. What IS decisive is the presence of a status: an HTTP status of
// ANY kind — 403, 404, even 500 — proves a packet left this machine, reached an
// origin, and came back, so that failure is the property's and this module is
// never consulted about it. Only `status === null` is ambiguous, and only that
// case pays for a probe. That single rule is what keeps the gate from ever making
// the lanes quieter about a real outage.
//
// TWO BEACONS, TWO OPERATORS. Cloudflare's trace endpoint and Google's
// generate_204, on purpose: one company having a bad afternoon must not read as
// this house's uplink being down. Egress is UP the moment either answers with any
// status at all; it is DOWN only when every one of them fails at the transport
// level, which is the same evidence the property fetch produced and therefore the
// only honest reason to stop blaming the property.
//
// WHAT THIS MODULE IS NOT: it is not a health check on the beacons and it stores
// nothing about them beyond whether they answered us. Requests go out under this
// OS's own honest User-Agent, the same posture src/hygiene.ts takes toward the
// properties it reads.

import { type OpenAlert, appendReading, holdCondition, raiseAlertUnlessOpen, readOpenAlert } from './alert-store.js';
import { readOsAssetId } from './os-asset.js';

/** rule id stamped on the ONE flag the OS files against itself when it cannot
 * reach the network. It lives on asset #0's row: the subject of this alert is
 * the OS, and a flag on a property would be the very mistake it exists to stop.
 *
 * The `egress_checks` rows this gate writes have a second reader:
 * `runFreshnessCheck` (src/db.ts) subtracts the dark spans they evidence from a
 * property's silence before accusing it of staleness (ro-6le), so a change to
 * what a row MEANS here changes what an ingest-freshness flag says there. */
export const EGRESS_DOWN_RULE_ID = 'os-egress-down';

/**
 * The reference sites, in the order they are asked. Both are endpoints whose
 * whole job is to answer cheaply and say nothing (a plaintext trace, a 204), run
 * by two independent operators. Neither is a property of this portfolio — asking
 * one of our own origins whether we can reach the internet would fail exactly
 * when a property is down, which is the case this gate has to get right.
 */
export const EGRESS_BEACONS = [
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://www.google.com/generate_204',
] as const;

/**
 * Who we say we are, same contract as `HYGIENE_USER_AGENT`: honest
 * identification with a contact URL, and a distinct product token so a beacon
 * operator reading their logs can tell a connectivity self-check apart from this
 * OS reading a property.
 */
export const EGRESS_USER_AGENT =
  'NoticeOS-Egress/1.0 (+https://www.notice.cx; connectivity self-check)';

/**
 * Per-beacon ceiling. Deliberately a third of the hygiene lane's 15s: this
 * request is not the work, it is the question asked before deciding whose fault
 * the work's failure was, and it is asked while a lane is already waiting.
 */
const BEACON_TIMEOUT_MS = 5_000;

/**
 * How long one verdict stands before the next failure re-asks.
 *
 * Re-asking at all is the point: an outage can begin in the middle of a sweep,
 * and a verdict cached for the whole run would let the properties checked after
 * it starts get flagged anyway. The window only bounds the cost — six properties
 * failing six fetches each is 36 questions, and they are all the same question.
 */
export const EGRESS_VERDICT_TTL_MS = 5 * 60_000;

/** One beacon's answer. `status === null` is the only failure that matters here:
 * it means nothing came back at all. */
export interface BeaconReading {
  url: string;
  status: number | null;
  error?: string;
}

/** A probe round's conclusion, cached for {@link EGRESS_VERDICT_TTL_MS}. */
export interface EgressVerdict {
  /** True when at least one beacon answered with any HTTP status. */
  up: boolean;
  /** The beacons asked, in order. Short on an `up` verdict (see `probe`). */
  beacons: BeaconReading[];
  /** The clock reading this verdict was formed at — TTL arithmetic only. */
  checkedAtMs: number;
}

/** What a run's gate did, reported back through the lane's own result. */
export interface EgressRunOutcome {
  /** False when the gate was never consulted — the healthy night's shape. */
  checked: boolean;
  /** The last verdict the run acted on; null when it never had to ask. */
  up: boolean | null;
  /** Probe rounds spent (the TTL's only observable effect). */
  probes: number;
  /** 1 when this run OPENED the os-egress-down flag. */
  fired: number;
  /** 1 when it rewrote an already-open one with this run's evidence. */
  refreshed: number;
  /** 1 when this run retracted the open flag: the connection answered, and no
   * collector is still owed a re-check of what the outage left unmeasured. */
  resolved: number;
  /** The properties this run left unmeasured because it could not get out. */
  unmeasuredAssets: string[];
}

/** A run that asked nothing: the gate was never consulted and never finalized. */
export const EGRESS_NOT_ASKED: EgressRunOutcome = {
  checked: false,
  up: null,
  probes: 0,
  fired: 0,
  refreshed: 0,
  resolved: 0,
  unmeasuredAssets: [],
};

/**
 * The collectors that ask the gate. Each keeps its OWN entry on the one flag
 * (bead `ro-aed0.5`): before that, every lane rewrote the flag's count with its
 * own, so the alert showed whichever lane ran last — an undercount of what the
 * outage actually left dark — and the first lane to get through again retracted
 * it while the others were still owed their re-collection.
 */
export const EGRESS_LANES = [
  'pull',
  'hygiene',
  'google-signals',
  'bing-signals',
  'signal-dumps',
  'dataforseo',
  'posthog',
  // The hourly home-page check (hygiene.ts `runUptimeChecks`, bead ro-ujb9.165).
  'uptime',
] as const;
export type EgressLaneId = (typeof EGRESS_LANES)[number];

/** One collector's share of an outage: what its runs left unmeasured and have
 * not measured since. It stays on the flag until that collector covers it again. */
export interface EgressLaneRecord {
  /** The properties, in the order they first went unmeasured. */
  unmeasuredAssets: string[];
  /**
   * Per property, the parts of it (a report family) the collector named when it
   * gave up. A property with no entry here went unmeasured WHOLE. Kept because a
   * collector's own scoped runs cover families, not whole properties, and must
   * clear exactly what they re-collected — and because the DataForSEO daily
   * re-collection (bead `ro-aed0.6`) re-runs exactly these families, never one
   * that failed at the provider.
   */
  parts?: Record<string, string[]>;
  /** The run that last added to this record. */
  lastFailedAt: string;
}

/** What the os-egress-down flag persists, rewritten by every gated run that owes it. */
interface EgressFlagInputs {
  rule: typeof EGRESS_DOWN_RULE_ID;
  /** Every beacon that failed on the most recent down verdict, with its error
   * verbatim — the operator's evidence that this was the uplink and not a property. */
  beacons: { url: string; error: string }[];
  /** EVERY collector's unmeasured properties, de-duplicated — the number the
   * alert leads with. Derived from `lanes`, and kept flat so a reader that
   * predates the per-collector entries still reads the right total. */
  unmeasuredAssets: string[];
  /** Per collector, what it is still owed. The flag stays open while any is. */
  lanes: Partial<Record<string, EgressLaneRecord>>;
  /** Down verdicts since this flag opened — 1 on the run that fired it. */
  failureCount: number;
  /** The most recent down verdict; the row's `fired_at` stays the FIRST one. */
  lastFailedAt: string;
  /**
   * When a reference site first answered again after the last down verdict, or
   * null while the connection is still out. Set means the outage itself is over
   * and the flag is open only for the collectors that have not re-run yet — the
   * Tower says "connection back", not "connection down", off this field.
   */
  connectionBackAt: string | null;
  evaluatedAt: string;
}

/** The open flag's stored inputs as the gate needs them, whatever shape an
 * older writer left them in (a flag opened before `lanes` existed reads as one
 * with no collector entries, so the first up verdict retracts it as it always did). */
interface PriorEgressInputs {
  beacons: { url: string; error: string }[];
  lanes: Record<string, EgressLaneRecord>;
  failureCount: number;
  lastFailedAt: string | null;
  connectionBackAt: string | null;
}

export interface EgressGateOptions {
  /** Which collector this run is — the key of its entry on the flag. */
  lane: EgressLaneId;
  /** Override the outbound fetcher — the SAME one the lane uses, so a test that
   * kills the network kills the beacons with it. */
  fetchImpl?: typeof fetch;
  /**
   * The lane run's instant, ISO UTC. Every egress row and every flag write this
   * gate makes carries it, so an egress reading and the property readings it
   * explains can never look like they were about different moments.
   */
  at: string;
  /**
   * Wall clock, read ONLY for the verdict TTL above and never for a stored
   * value. Injected so a test can hold time still or push it past the window;
   * the lanes leave it alone, because a run's own timestamp is frozen and a
   * frozen clock cannot notice an outage that starts mid-sweep.
   */
  clock?: () => number;
}

export interface EgressFinalizeOptions {
  /**
   * Which of this collector's EARLIER unmeasured entries the run answered for.
   * Omitted means all of them: a full sweep's result replaces the collector's
   * entry outright, so what it measured drops off and what it missed again stays.
   * A scoped run — one property on demand — passes the slice it covered, so the
   * properties it never tried are still owed. `part` is null for an entry that
   * named the whole property.
   */
  covers?: (asset: string, part: string | null) => boolean;
}

/**
 * One run's egress gate: the cached verdict, the properties it caused to be
 * skipped, and this collector's entry on the single self-flag it files at the end.
 *
 * Created once per lane run and consulted only from the `status === null`
 * branches. It is deliberately LAZY — nothing is probed until a fetch has
 * actually come back empty-handed. An eager check at sweep start would cost two
 * requests on every healthy night to learn what the property fetches were about
 * to prove anyway, and it would spend them before the lane had a question.
 */
export class EgressGate {
  private readonly env: IngestEnv;
  private readonly lane: EgressLaneId;
  private readonly fetchImpl: typeof fetch;
  private readonly at: string;
  private readonly clock: () => number;
  private verdict: EgressVerdict | null = null;
  /** The most recent DOWN verdict — the flag's evidence, even when the run
   * later saw the connection come back. */
  private lastDown: EgressVerdict | null = null;
  /** property -> the parts of it left unmeasured; null = the whole property. */
  private readonly unmeasured = new Map<string, Set<string> | null>();
  private probes = 0;

  constructor(env: IngestEnv, opts: EgressGateOptions) {
    this.env = env;
    this.lane = opts.lane;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.at = opts.at;
    this.clock = opts.clock ?? Date.now;
  }

  /** Probe rounds spent so far. */
  get probeRounds(): number {
    return this.probes;
  }

  /** The properties this run recorded as unmeasured, in the order they failed. */
  get unmeasuredAssets(): string[] {
    return [...this.unmeasured.keys()];
  }

  /**
   * The current verdict, probing at most once per {@link EGRESS_VERDICT_TTL_MS}.
   * Every completed round is recorded in `egress_checks`. The flag itself is
   * settled once, at {@link finalize}: whether this collector is still owed a
   * re-check depends on everything the run went on to measure, which a probe in
   * the middle of it cannot know.
   */
  async check(): Promise<EgressVerdict> {
    const now = this.clock();
    if (this.verdict !== null && now - this.verdict.checkedAtMs < EGRESS_VERDICT_TTL_MS) {
      return this.verdict;
    }
    const beacons = await this.probe();
    const verdict: EgressVerdict = {
      up: beacons.some((beacon) => beacon.status !== null),
      beacons,
      checkedAtMs: now,
    };
    this.probes += 1;
    this.verdict = verdict;
    if (!verdict.up) this.lastDown = verdict;
    await this.record(verdict);
    return verdict;
  }

  /** The gate's whole question, as a lane asks it. */
  async isDown(): Promise<boolean> {
    return !(await this.check()).up;
  }

  /**
   * Note that a property went unchecked this run. Idempotent per asset: one
   * property can fail all three hygiene checks in one night and is still one
   * property nobody measured. `part` names the piece of it that was skipped (a
   * report family) when the collector can say; without it the whole property is.
   */
  recordUnmeasured(asset: string, part?: string): void {
    if (!this.unmeasured.has(asset)) {
      this.unmeasured.set(asset, part === undefined ? null : new Set([part]));
      return;
    }
    const parts = this.unmeasured.get(asset);
    if (parts === null || parts === undefined) return;
    if (part === undefined) this.unmeasured.set(asset, null);
    else parts.add(part);
  }

  /**
   * End of the lane run. Settles this collector's entry on the flag with what
   * the run actually measured — which is why the flag is written here and not at
   * probe time: the entry names what went unmeasured, and that does not exist
   * until the run is over.
   *
   * A run that never had to ask still asks ONCE when the open flag is waiting on
   * it: when this collector has an entry to clear, or when nothing has yet seen
   * the connection come back. Without that, a night on which every property
   * answered — the exact shape of recovery — would never probe, the entry would
   * stand forever, and the up reading that closes the dark span in
   * `egress_checks` would never be written. A collector with nothing owed, once
   * another has already seen the connection back, costs nothing.
   */
  async finalize(options: EgressFinalizeOptions = {}): Promise<EgressRunOutcome> {
    if (this.verdict === null) {
      const open = await this.openFlag();
      if (open !== null && owesProbe(readPriorInputs(open.ruleInputs), this.lane)) {
        await this.check();
      }
    }

    const verdict = this.verdict;
    const base = {
      checked: verdict !== null,
      up: verdict?.up ?? null,
      probes: this.probes,
      unmeasuredAssets: this.unmeasuredAssets,
    };
    // A run that never asked has nothing to say: no measurement is not a verdict.
    if (verdict === null) return { ...base, fired: 0, refreshed: 0, resolved: 0 };
    return { ...base, ...(await this.settle(verdict, options.covers ?? (() => true))) };
  }

  /**
   * Ask the beacons in order, stopping at the first HTTP status. Any status is
   * the whole proof, so a second opinion about a question already answered is a
   * request spent on nothing — the healthy check costs ONE request, and only a
   * real outage pays for the rest (whose errors then become the flag's evidence).
   */
  private async probe(): Promise<BeaconReading[]> {
    const readings: BeaconReading[] = [];
    for (const url of EGRESS_BEACONS) {
      const reading = await probeBeacon(this.fetchImpl, url);
      readings.push(reading);
      if (reading.status !== null) break;
    }
    return readings;
  }

  /** Store the reading, on Postgres (`noticeos.egress_checks`, bead
   * ro-ujb9.76.5.1). D1's db/0023 says why a suppressed alert needs a row. */
  private async record(verdict: EgressVerdict): Promise<void> {
    await this.env.STORE.write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.egress_checks (workspace_id, observed_at, up, detail)
         VALUES ($1, $2::timestamptz, $3, $4::jsonb)`,
        [tx.workspaceId, this.at, verdict.up, JSON.stringify({ beacons: verdict.beacons })],
      ),
    );
  }

  /** The open self-flag, or null when none is open (or there is no OS row). */
  private async openFlag(): Promise<OpenAlert | null> {
    const asset = await osAssetId(this.env);
    return asset === null ? null : await readOpenEgressFlag(this.env, asset);
  }

  /**
   * Fire, refresh or retract the single os-egress-down flag, mirroring
   * `firePullFailure` (src/pull.ts), because it is the same shape of fact: an
   * ONGOING condition observed once per lane run. A week-long outage is one
   * problem, not fourteen lane runs' worth, so the first observation INSERTs
   * (guarded by NOT EXISTS against an open flag with this rule) and every one
   * after becomes that alert's newest reading (`noticeos.flag_evidence`, bead
   * ro-ujb9.76.5.2; D1 rewrote the row), while `fired_at` stays the moment the
   * connection went.
   *
   * What a refresh changes is THIS collector's entry and the evidence it saw;
   * every other collector's entry is carried through untouched, and the headline
   * count is their union. The flag is retracted only by an up verdict that
   * leaves no collector owed anything — "the connection is back" and "the
   * outage's gaps are filled" are two facts, and the alert keeps the second.
   *
   * ONE COLLECTOR AT A TIME. Two lanes share a tick (the 02:30 pull and Bing
   * run together), and each carries the other's entries through, so the read,
   * the merge and the write are one transaction that holds the condition: a
   * second collector waits and then merges onto the first one's reading, rather
   * than overwriting its entry — which is the bug this whole record exists to
   * fix. (D1 got there with a compare-and-swap retried five times.) The
   * readings are stamped by the store, one instant each, because two
   * collectors can settle at one lane instant.
   */
  private async settle(
    verdict: EgressVerdict,
    covers: (asset: string, part: string | null) => boolean,
  ): Promise<{ fired: number; refreshed: number; resolved: number }> {
    const none = { fired: 0, refreshed: 0, resolved: 0 };
    const asset = await osAssetId(this.env);
    if (asset === null) return none;

    return this.env.STORE.write(async (tx) => {
      await holdCondition(tx, asset, EGRESS_DOWN_RULE_ID);
      const open = await readOpenAlert(tx, asset, EGRESS_DOWN_RULE_ID);
      const prior = readPriorInputs(open?.ruleInputs ?? null);
      const lanes = { ...prior.lanes };
      const entry = nextLaneRecord(prior.lanes[this.lane], this.unmeasured, covers, this.at);
      if (entry === null) delete lanes[this.lane];
      else lanes[this.lane] = entry;
      const owed = Object.keys(lanes).length > 0;

      if (verdict.up && !owed) {
        if (open === null) return none;
        const resolved = await tx.execute(
          `UPDATE noticeos.flags SET resolved_at = $1::timestamptz
            WHERE flag_id = $2 AND resolved_at IS NULL`,
          [this.at, open.flagId],
        );
        return { ...none, resolved: resolved > 0 ? 1 : 0 };
      }

      const lastDown = this.lastDown;
      const inputs: EgressFlagInputs = {
        rule: EGRESS_DOWN_RULE_ID,
        beacons:
          lastDown === null
            ? prior.beacons
            : lastDown.beacons.map((beacon) => ({
                url: beacon.url,
                error: beacon.error ?? 'no response',
              })),
        unmeasuredAssets: unionOfLanes(lanes),
        lanes,
        failureCount: prior.failureCount + (lastDown === null ? 0 : 1),
        lastFailedAt: lastDown === null ? (prior.lastFailedAt ?? this.at) : this.at,
        // Back as of THIS run when it saw the connection fail and then answer;
        // otherwise the earlier sighting stands. A down verdict clears it.
        connectionBackAt: verdict.up
          ? lastDown === null
            ? (prior.connectionBackAt ?? this.at)
            : this.at
          : null,
        evaluatedAt: this.at,
      };
      const message = egressFlagMessage(inputs);
      const serialized = JSON.stringify(inputs);

      if (open === null) {
        const flagId = await raiseAlertUnlessOpen(tx, {
          asset,
          firedAt: this.at,
          severity: 'warn',
          kind: 'anomaly',
          metric: null,
          message,
          ruleId: EGRESS_DOWN_RULE_ID,
          ruleInputs: serialized,
        });
        return { ...none, fired: flagId === null ? 0 : 1 };
      }

      await appendReading(tx, [open.flagId], { observedAt: null, severity: 'warn', message, ruleInputs: serialized });
      return { ...none, refreshed: 1 };
    });
  }
}

/**
 * Asset #0's id, read from the store rather than written down here
 * (`./os-asset.ts`, the one reader). A store with no OS row gets no flag —
 * this alert would have no subject.
 */
const osAssetId = readOsAssetId;

/** The open os-egress-down alert, as its newest reading states it. */
async function readOpenEgressFlag(env: IngestEnv, asset: string): Promise<OpenAlert | null> {
  return env.STORE.read((tx) => readOpenAlert(tx, asset, EGRESS_DOWN_RULE_ID));
}

/**
 * What the open flag says one collector is still owed, or null when nothing is
 * open or that collector has no entry. Read by a collector deciding whether it
 * has an outage's gaps to fill — the DataForSEO daily re-collection (bead
 * `ro-aed0.6`) runs only the families listed here, and nothing when it is null.
 */
export async function openEgressLaneRecord(
  env: IngestEnv,
  lane: EgressLaneId,
): Promise<EgressLaneRecord | null> {
  const asset = await osAssetId(env);
  if (asset === null) return null;
  const open = await readOpenEgressFlag(env, asset);
  if (open === null) return null;
  return readPriorInputs(open.ruleInputs).lanes[lane] ?? null;
}

/** Does this collector's run owe the open flag a probe? See `finalize`. */
function owesProbe(prior: PriorEgressInputs, lane: EgressLaneId): boolean {
  return prior.lanes[lane] !== undefined || prior.connectionBackAt === null;
}

/**
 * This collector's entry after a run: the earlier entry minus what the run
 * covered, plus what the run itself left unmeasured. Null when nothing is owed.
 */
function nextLaneRecord(
  prior: EgressLaneRecord | undefined,
  run: ReadonlyMap<string, Set<string> | null>,
  covers: (asset: string, part: string | null) => boolean,
  at: string,
): EgressLaneRecord | null {
  const owed = new Map<string, Set<string> | null>();
  for (const asset of prior?.unmeasuredAssets ?? []) {
    const parts = prior?.parts?.[asset];
    if (parts === undefined || parts.length === 0) {
      if (!covers(asset, null)) owed.set(asset, null);
      continue;
    }
    const kept = parts.filter((part) => !covers(asset, part));
    if (kept.length > 0) owed.set(asset, new Set(kept));
  }
  for (const [asset, parts] of run) {
    if (!owed.has(asset)) {
      owed.set(asset, parts === null ? null : new Set(parts));
      continue;
    }
    const held = owed.get(asset);
    if (held === null || held === undefined) continue;
    if (parts === null) owed.set(asset, null);
    else for (const part of parts) held.add(part);
  }
  if (owed.size === 0) return null;

  const record: EgressLaneRecord = {
    unmeasuredAssets: [...owed.keys()],
    lastFailedAt: run.size > 0 || prior === undefined ? at : prior.lastFailedAt,
  };
  const parts: Record<string, string[]> = {};
  for (const [asset, held] of owed) if (held !== null) parts[asset] = [...held];
  if (Object.keys(parts).length > 0) record.parts = parts;
  return record;
}

/** Every collector's unmeasured properties, once each, in first-seen order. */
function unionOfLanes(lanes: Partial<Record<string, EgressLaneRecord>>): string[] {
  const all = new Set<string>();
  for (const record of Object.values(lanes)) {
    for (const asset of record?.unmeasuredAssets ?? []) all.add(asset);
  }
  return [...all];
}

/** The stored message — the count, not the list: six property names would not
 * fit a glance, and the list is one popover away in the inputs. */
function egressFlagMessage(inputs: EgressFlagInputs): string {
  const n = inputs.unmeasuredAssets.length;
  return inputs.connectionBackAt === null
    ? `OS egress down — ${n} properties unmeasured`
    : `OS connection back — ${n} properties not yet re-checked`;
}

/** Parse whatever the open flag holds, keeping only well-formed fields. */
function readPriorInputs(ruleInputs: string | null): PriorEgressInputs {
  const prior: PriorEgressInputs = {
    beacons: [],
    lanes: {},
    failureCount: 0,
    lastFailedAt: null,
    connectionBackAt: null,
  };
  if (!ruleInputs) return prior;
  let raw: unknown;
  try {
    raw = JSON.parse(ruleInputs);
  } catch {
    return prior;
  }
  if (!isRecord(raw)) return prior;
  if (Array.isArray(raw.beacons)) {
    prior.beacons = raw.beacons.flatMap((beacon) =>
      isRecord(beacon) && typeof beacon.url === 'string'
        ? [{ url: beacon.url, error: typeof beacon.error === 'string' ? beacon.error : 'no response' }]
        : [],
    );
  }
  if (typeof raw.failureCount === 'number' && Number.isFinite(raw.failureCount)) {
    prior.failureCount = raw.failureCount;
  }
  if (typeof raw.lastFailedAt === 'string') prior.lastFailedAt = raw.lastFailedAt;
  if (typeof raw.connectionBackAt === 'string') prior.connectionBackAt = raw.connectionBackAt;
  if (isRecord(raw.lanes)) {
    for (const [lane, value] of Object.entries(raw.lanes)) {
      const record = readLaneRecord(value);
      if (record !== null) prior.lanes[lane] = record;
    }
  }
  return prior;
}

function readLaneRecord(value: unknown): EgressLaneRecord | null {
  if (!isRecord(value) || !Array.isArray(value.unmeasuredAssets)) return null;
  const assets = value.unmeasuredAssets.filter((asset): asset is string => typeof asset === 'string');
  if (assets.length === 0) return null;
  const record: EgressLaneRecord = {
    unmeasuredAssets: assets,
    lastFailedAt: typeof value.lastFailedAt === 'string' ? value.lastFailedAt : '',
  };
  if (isRecord(value.parts)) {
    const parts: Record<string, string[]> = {};
    for (const asset of assets) {
      const named = value.parts[asset];
      if (!Array.isArray(named)) continue;
      const list = named.filter((part): part is string => typeof part === 'string');
      if (list.length > 0) parts[asset] = list;
    }
    if (Object.keys(parts).length > 0) record.parts = parts;
  }
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// The provider-collector half (beads ro-aed0.1–.4)
// ---------------------------------------------------------------------------
//
// The hygiene and pull lanes read a status off their own fetch before asking
// the gate. The provider collectors — Google, Bing, the nightly archive,
// DataForSEO, PostHog (`ro-aed0.8`) — cannot: their fetches are buried inside token mints, discovery
// calls and retry ladders that turn every failure into an error object before
// the lane sees it. So the lane wraps its fetcher ONCE and asks afterwards
// whether a given error is exactly what that fetcher threw. That is the same
// `status === null` rule, read by identity instead of by variable, and it keeps
// a malformed key, a D1 write or a provider's own error sentence from ever
// being mistaken for a dead uplink.

/**
 * The code a collector's run result carries for a family or property it did not
 * measure because the OS could not get out. It is never written to a provider's
 * run table — the only durable trace of that night is the `egress_checks` row
 * and the one `os-egress-down` flag, which is the whole point.
 */
export const EGRESS_DOWN_CODE = 'os_egress_down';

/** A lane's fetcher, taught which of its failures came back with no status. */
export interface TransportWatch {
  /** Hand this to every provider call the lane makes. */
  readonly fetch: typeof fetch;
  /**
   * True only for an error that fetcher itself threw: the request produced no
   * response at all. Anything with a status — a 401, a 503, a body that would
   * not parse — was an answer from the far side and is never the uplink's.
   */
  statusless(error: unknown): boolean;
}

/** Wrap a lane's fetcher. Identity is the evidence, so the error is rethrown
 * untouched — every caller's existing handling sees exactly what it saw before. */
export function watchTransport(fetchImpl: typeof fetch): TransportWatch {
  const failures = new WeakSet<object>();
  const watched = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      if (typeof error === 'object' && error !== null) failures.add(error);
      throw error;
    }
  }) as typeof fetch;
  return {
    fetch: watched,
    statusless: (error) => typeof error === 'object' && error !== null && failures.has(error),
  };
}

/**
 * The one question a collector asks before it blames a provider: did this call
 * never come back, AND is the OS's own connection what is down? Only a
 * status-less failure pays for the (cached) probe, so a healthy night and a
 * provider that answered with an error never touch the gate.
 */
export async function egressExplains(
  gate: EgressGate,
  transport: TransportWatch,
  error: unknown,
): Promise<boolean> {
  return transport.statusless(error) && (await gate.isDown());
}

/**
 * One beacon GET. Never throws: a beacon that fails is the reading, not an
 * exception — this whole module exists to turn a failed request into a fact.
 * The body is dropped unread (`redirect: 'manual'` for the same reason: a 301
 * already proves egress, so following it would spend a request to learn nothing).
 */
async function probeBeacon(fetchImpl: typeof fetch, url: string): Promise<BeaconReading> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'user-agent': EGRESS_USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(BEACON_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return { url, status: response.status };
  } catch (error) {
    return {
      url,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
