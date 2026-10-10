// Can the OS get out? Asked before any property is accused of being dark, so
// the OS's own blindness is never reported as six properties' outage.
//
// workerd wraps every connection-level failure in the same sentence, so the
// error string cannot be attributed. What is decisive is the presence of a
// status: any HTTP status proves a packet left this machine and came back, so
// that failure is the property's and this module is never consulted. Only
// `status === null` is ambiguous, and only that case pays for a probe. Two
// beacons from two operators: egress is up the moment either answers with any
// status, and down only when every one fails at the transport level. Requests
// go out under this OS's own honest User-Agent.

import { type OpenAlert, appendReading, holdCondition, raiseAlertUnlessOpen, readOpenAlert } from './alert-store.js';
import { readOsAssetId } from './os-asset.js';
import { isRecord } from './shared.js';

/** The one flag the OS files against itself when it cannot reach the network.
 * It lives on asset #0's row: the subject of this alert is the OS. The
 * `egress_checks` rows this gate writes have a second reader, `runFreshnessCheck`
 * (src/db.ts), which subtracts the dark spans they evidence from a property's
 * silence. */
export const EGRESS_DOWN_RULE_ID = 'os-egress-down';

/**
 * The reference sites, in the order they are asked: endpoints whose whole job
 * is to answer cheaply, run by two independent operators. Never one of our own
 * origins, which would fail exactly when a property is down.
 */
export const EGRESS_BEACONS = [
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://www.google.com/generate_204',
] as const;

/**
 * Honest identification with a contact URL, and a product token distinct from
 * the hygiene lane's.
 */
export const EGRESS_USER_AGENT =
  'NoticeOS-Egress/1.0 (+https://www.notice.cx; connectivity self-check)';

/**
 * Per-beacon ceiling, a third of the hygiene lane's: this is the question asked
 * while a lane is already waiting, not the work.
 */
const BEACON_TIMEOUT_MS = 5_000;

/**
 * How long one verdict stands before the next failure re-asks. Re-asking is the
 * point: an outage can begin mid-sweep. The window only bounds the cost.
 */
export const EGRESS_VERDICT_TTL_MS = 5 * 60_000;

/** One beacon's answer. `status === null` means nothing came back at all. */
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
 * The collectors that ask the gate. Each keeps its own entry on the one flag,
 * so the alert counts what the outage left dark across all of them and the
 * first lane through again does not retract it while others are still owed.
 */
export const EGRESS_LANES = [
  'pull',
  'hygiene',
  'google-signals',
  'bing-signals',
  'signal-dumps',
  'dataforseo',
  'posthog',
  // The hourly home-page check (hygiene.ts `runUptimeChecks`).
  'uptime',
] as const;
export type EgressLaneId = (typeof EGRESS_LANES)[number];

/** One collector's share of an outage: what its runs left unmeasured and have
 * not measured since. */
export interface EgressLaneRecord {
  /** The properties, in the order they first went unmeasured. */
  unmeasuredAssets: string[];
  /** Per property, the parts of it (a report family) the collector named when
   * it gave up; a property with no entry here went unmeasured whole. A scoped
   * run clears exactly what it re-collected. */
  parts?: Record<string, string[]>;
  /** The run that last added to this record. */
  lastFailedAt: string;
}

/** What the os-egress-down flag persists, rewritten by every gated run that owes it. */
interface EgressFlagInputs {
  rule: typeof EGRESS_DOWN_RULE_ID;
  /** Every beacon that failed on the most recent down verdict, with its error. */
  beacons: { url: string; error: string }[];
  /** Every collector's unmeasured properties, de-duplicated: the number the
   * alert leads with. Derived from `lanes`. */
  unmeasuredAssets: string[];
  /** Per collector, what it is still owed. The flag stays open while any is. */
  lanes: Partial<Record<string, EgressLaneRecord>>;
  /** Down verdicts since this flag opened — 1 on the run that fired it. */
  failureCount: number;
  /** The most recent down verdict; the row's `fired_at` stays the FIRST one. */
  lastFailedAt: string;
  /** When a reference site first answered again after the last down verdict,
   * or null while the connection is still out. Set means the flag is open only
   * for the collectors that have not re-run yet. */
  connectionBackAt: string | null;
  evaluatedAt: string;
}

/** The open flag's stored inputs as the gate needs them, whatever shape an
 * older writer left them in. */
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
  /** The same fetcher the lane uses, so a test that kills the network kills
   * the beacons with it. */
  fetchImpl?: typeof fetch;
  /** The lane run's instant, ISO UTC, carried on every row and flag write this
   * gate makes. */
  at: string;
  /** Wall clock, read only for the verdict TTL: a run's own timestamp is frozen
   * and cannot notice an outage that starts mid-sweep. */
  clock?: () => number;
}

export interface EgressFinalizeOptions {
  /** Which of this collector's earlier unmeasured entries the run answered
   * for. Omitted means all of them; a scoped run passes the slice it covered.
   * `part` is null for an entry that named the whole property. */
  covers?: (asset: string, part: string | null) => boolean;
}

/**
 * One run's egress gate: the cached verdict, the properties it caused to be
 * skipped, and this collector's entry on the single self-flag it files at the
 * end. Lazy: nothing is probed until a fetch has come back empty-handed, so a
 * healthy night costs nothing.
 */
export class EgressGate {
  private readonly env: IngestEnv;
  private readonly lane: EgressLaneId;
  private readonly fetchImpl: typeof fetch;
  private readonly at: string;
  private readonly clock: () => number;
  private verdict: EgressVerdict | null = null;
  /** The most recent down verdict: the flag's evidence, even when the run later
   * saw the connection come back. */
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
   * settled once, at {@link finalize}, because what this collector is owed
   * depends on everything the run went on to measure.
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
   * Note that a property went unchecked this run. Idempotent per asset. `part`
   * names the piece of it that was skipped when the collector can say.
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
   * the run actually measured. A run that never had to ask still asks once
   * when the open flag is waiting on it (this collector has an entry to clear,
   * or nothing has yet seen the connection come back); otherwise a night on
   * which every property answered would never probe and the entry would stand
   * forever.
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
   * Ask the beacons in order, stopping at the first HTTP status: the healthy
   * check costs one request, and only a real outage pays for the rest.
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

  /** Store the reading; a suppressed alert still needs a row. */
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
    const asset = await readOsAssetId(this.env);
    return asset === null ? null : await readOpenEgressFlag(this.env, asset);
  }

  /**
   * Fire, refresh or retract the single os-egress-down flag as an ongoing
   * condition observed once per lane run: the first observation inserts and
   * every one after becomes the alert's newest reading, while `fired_at` stays
   * the moment the connection went. A refresh changes this collector's entry
   * and the evidence it saw; every other collector's entry is carried through,
   * and the headline count is their union. The flag is retracted only by an up
   * verdict that leaves no collector owed anything. One collector at a time:
   * the read, the merge and the write are one transaction that holds the
   * condition, so two lanes sharing a tick merge rather than overwrite.
   */
  private async settle(
    verdict: EgressVerdict,
    covers: (asset: string, part: string | null) => boolean,
  ): Promise<{ fired: number; refreshed: number; resolved: number }> {
    const none = { fired: 0, refreshed: 0, resolved: 0 };
    const asset = await readOsAssetId(this.env);
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
        // Back as of this run when it saw the connection fail and then answer;
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

/** The open os-egress-down alert, as its newest reading states it. */
async function readOpenEgressFlag(env: IngestEnv, asset: string): Promise<OpenAlert | null> {
  return env.STORE.read((tx) => readOpenAlert(tx, asset, EGRESS_DOWN_RULE_ID));
}

/**
 * What the open flag says one collector is still owed, or null when nothing is
 * open or that collector has no entry.
 */
export async function openEgressLaneRecord(
  env: IngestEnv,
  lane: EgressLaneId,
): Promise<EgressLaneRecord | null> {
  const asset = await readOsAssetId(env);
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

/** The count, not the list: the list is one popover away in the inputs. */
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

// ---------------------------------------------------------------------------
// The provider-collector half
// ---------------------------------------------------------------------------
//
// The hygiene and pull lanes read a status off their own fetch before asking
// the gate. The provider collectors cannot: their fetches are buried inside
// token mints, discovery calls and retry ladders. So the lane wraps its fetcher
// once and asks afterwards whether a given error is exactly what that fetcher
// threw: the same `status === null` rule, read by identity.

/**
 * The code a collector's run result carries for a family or property it did
 * not measure because the OS could not get out. Never written to a provider's
 * run table: the only durable trace is the `egress_checks` row and the flag.
 */
export const EGRESS_DOWN_CODE = 'os_egress_down';

/** A lane's fetcher, taught which of its failures came back with no status. */
export interface TransportWatch {
  /** Hand this to every provider call the lane makes. */
  readonly fetch: typeof fetch;
  /** True only for an error that fetcher itself threw: the request produced no
   * response at all. */
  statusless(error: unknown): boolean;
}

/** Wrap a lane's fetcher. The error is rethrown untouched; identity is the evidence. */
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
 * never come back, and is the OS's own connection what is down? Only a
 * status-less failure pays for the (cached) probe.
 */
export async function egressExplains(
  gate: EgressGate,
  transport: TransportWatch,
  error: unknown,
): Promise<boolean> {
  return transport.statusless(error) && (await gate.isDown());
}

/**
 * One beacon GET. Never throws: a failed beacon is the reading. The body is
 * dropped unread, and `redirect: 'manual'` because a 301 already proves egress.
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
