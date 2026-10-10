// POST /api/revenue — the revenue/cost ledger lane (docs/12 checklist #6).
//
// Operator-authed. Accepts a CSV export (text/csv) or a JSON array of the same
// rows: kind,asset,period,family,amount,source,ref,booking_state,note, plus the
// optional external_id / supersedes_external_id and coverage fields. Each row is validated
// against the same CHECK constraints the migration enforces before insert;
// results are reported per row.
//
// IDEMPOTENT SINCE db/0018 (the 2026-07 audit's finding 1, bead ro-dql). Every row carries a
// stable, source-namespaced `external_id` under a unique index, so the same
// export posted twice books the money once:
//
//   * an identical replay is `already_imported` — nothing is written, the
//     existing row's id comes back, and the ledger total does not move;
//   * a replay of the same id carrying a DIFFERENT figure, currency or
//     replacement link is `conflicting_replay` and is refused. It is not an
//     edit: rows in this store are history, and a restated figure is a
//     reconciliation — a new row that supersedes the old one (db/README, 0001
//     §ledger). Silently overwriting would erase the very estimate the
//     reconciliation is supposed to be measured against.
//
// Reconciliation links by id rather than by match: `supersedes_external_id`
// names the estimate's stable id and the route resolves it to `supersedes_id`.
//
// ONE ENTRY, ONE CURRENT FIGURE (bead ro-ujb9.69). A correction replaces an
// entry only when both describe the same thing — same asset, period, kind,
// family and currency — and only the entry that is current right now, the head
// of its chain. Anything else is refused per row: `supersedes_mismatch` names
// the fields that differ, `already_superseded` names the entry that replaced
// the target (supersede that one instead), and two rows in one upload that
// replace the same entry are both `duplicate_supersedes`. Without these rules a
// cost for another property could hide a revenue estimate, and two corrections
// of one estimate would both count, so the effective total would add them up.
//
// The head check is enforced by the write itself, not only by the read before
// it: a correction is inserted by one `INSERT … SELECT … WHERE` that re-checks
// the target's identity and that nothing supersedes it yet, and gives way (ON
// CONFLICT DO NOTHING) to a correction another upload booked on the store's
// one-successor index (0001_baseline.sql `ledger_entries_one_successor`) while
// this one was reading. A 0-row result is a per-row refusal, so two concurrent
// uploads correcting one estimate book exactly one correction and the other
// hears which rule it broke.
//
// Every entry is shown by its workspace's number (`entry_number`), never the
// store's own identity, which only links a correction to its target.
//
// The wire states major units and currency; the STORE keeps minor units only: db/0020 dropped the
// `amount REAL` mirror 0018 had kept for the read models that still summed
// dollars, so this route converts once, at the boundary, and writes
// `amount_minor` alone (bead ro-k5s).
//
// Coverage is supplied as fields. Only uploads with none of those fields use
// the unchanged legacy note rule; unreadable partial coverage is reported for
// review while preserving the conservative financial view's eligibility.

import {
  LedgerInputRow,
  type LedgerInputRow as LedgerRow,
} from '@noticeos/contract';
import { currencyMinorDigits, minorToMajorUnits } from '@noticeos/contract/money';
import { MEDIAVINE_SOURCES, mediavineCoverage } from '@noticeos/contract/ledger-coverage';
import type { Transaction, WorkspaceStore } from '@noticeos/postgres';
import { knownAssetIds } from '../asset-registry.js';
import { authenticateOperator } from '../auth.js';
import { csvToRows } from '../csv.js';
import { json, zodIssues } from '../responses.js';

export type RowResult =
  | { index: number; ok: true; imported: boolean; id: number | null; review?: { code: string; message: string } }
  | {
      index: number;
      ok: false;
      error: string;
      detail?: string;
      issues?: ReturnType<typeof zodIssues>;
    };

export class LedgerImportConflict extends Error {
  constructor(detail: string) { super(detail); this.name = 'LedgerImportConflict'; }
}

export interface LedgerImportSummary {
  inserted: number;
  alreadyImported: number;
  failed: number;
  reviewRequired: number;
  results: RowResult[];
}

/** What an entry IS. A correction may only replace an entry with the same
 * identity; the figure and booking state are what it is allowed to change. */
type Identity = {
  asset: string;
  period: string;
  kind: string;
  family: string;
  currency: string;
};

const IDENTITY_FIELDS = ['asset', 'period', 'kind', 'family', 'currency'] as const;

/** Structured coverage, or the conservative legacy-note compatibility result. */
interface Coverage {
  start: string | null;
  end: string | null;
  complete: boolean | null;
  explicit: boolean;
  review: boolean;
}

function coverageOf(row: LedgerRow): Coverage {
  const explicit = row.coverage_start !== undefined || row.coverage_end !== undefined || row.coverage_complete !== undefined;
  if (explicit) return {
    start: row.coverage_start ?? null, end: row.coverage_end ?? null,
    complete: row.coverage_complete ?? null, explicit, review: false,
  };
  const legacy = mediavineCoverage({
    kind: row.kind, family: row.family, source: row.source ?? null, note: row.note ?? null,
  }, row.period);
  // Separator variants must remain conservative, but their partial coverage
  // should be visible for review even when the old parser recognizes no marker.
  const partial = row.kind === 'revenue' && row.family === 'ads' &&
    MEDIAVINE_SOURCES.includes(row.source ?? '') && /\bPARTIAL\b/i.test(row.note ?? '');
  return { start: null, end: legacy.end, complete: null, explicit, review: legacy.unreadable || (legacy.end === null && partial) };
}

/** Content relevant to replay consistency; notes are presentation only. */
interface Booked extends Identity {
  bookingState: string;
  amountMinor: number;
  coverage: Coverage;
  /** The stable id of the entry this row replaces, or null. */
  supersedes: string | null;
}

interface StoredRow {
  /** The store's own identity: what a correction's link names. Never shown. */
  entry_id: bigint;
  /** The entry's number in its workspace: what the route reports. */
  number: number;
  external_id: string;
  kind: string;
  asset: string;
  period: string;
  family: string;
  currency: string;
  booking_state: string;
  amount_minor: number;
  coverage_start: string | null;
  coverage_end: string | null;
  coverage_complete: boolean | null;
  /** The number of the entry this one replaces, or null when unlinked. */
  supersedes_number: number | null;
  /** The external id of the entry it replaces (null when unlinked, or when
   * the linked entry predates stable ids). */
  supersedes_external_id: string | null;
  /** Whether an entry already supersedes this one. */
  superseded: boolean;
}

/** A per-workspace number or an amount in cents from the store (int8), as the
 * number the route has always answered with. */
function exact(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${value} is past 2^53 and no longer exact`);
  return n;
}

/** Money entries only: a change entry names no money (D36). */
const MONEY = `kind IN ('revenue', 'cost')`;

function identityOf(row: LedgerRow): Identity {
  return {
    asset: row.asset,
    period: row.period,
    kind: row.kind,
    family: row.family,
    currency: row.currency,
  };
}

function bookedOf(row: LedgerRow): Booked {
  return {
    ...identityOf(row),
    bookingState: row.booking_state,
    amountMinor: row.amount_minor,
    coverage: coverageOf(row),
    supersedes: row.supersedes_external_id ?? null,
  };
}

function money(minor: number, currency: string): string {
  const digits = currencyMinorDigits(currency);
  return digits === null ? `${minor} minor units (${currency})`
    : `${minorToMajorUnits(minor, currency).toFixed(digits)} ${currency}`;
}

function describe(identity: Identity): string {
  return IDENTITY_FIELDS.map((field) => identity[field]).join(' / ');
}

/** Why `upload` is not a replay of the row stored under the same stable id, or
 * null when it is one. */
function replayConflict(stableId: string, upload: Booked, stored: StoredRow): string | null {
  const reasons: string[] = [];
  if (
    upload.kind !== stored.kind ||
    upload.asset !== stored.asset ||
    upload.period !== stored.period ||
    upload.family !== stored.family ||
    upload.bookingState !== stored.booking_state ||
    upload.amountMinor !== stored.amount_minor
  ) {
    reasons.push(
      `'${stableId}' is already stored as ${money(stored.amount_minor, stored.currency)} ` +
        `(${stored.booking_state}); this upload says ${money(upload.amountMinor, upload.currency)} ` +
        `(${upload.bookingState}). A restated figure is a reconciliation — post it ` +
        `as a reconciled row with supersedes_external_id='${stableId}'.`,
    );
  }
  if (upload.currency !== stored.currency) {
    reasons.push(
      `'${stableId}' is stored in ${stored.currency}; this upload is ${upload.currency}.`,
    );
  }
  // The replacement link is part of the entry: the same key re-posted with a
  // different target (or with the link added or removed) describes a different
  // booking, and accepting it as a no-op would report a link that is not there.
  const sameLink =
    stored.supersedes_number === null
      ? upload.supersedes === null
      : upload.supersedes !== null && upload.supersedes === stored.supersedes_external_id;
  if (!sameLink) {
    const storedLink =
      stored.supersedes_number === null
        ? 'replaces nothing'
        : `replaces '${stored.supersedes_external_id ?? `ledger row #${stored.supersedes_number}`}'`;
    const uploadLink =
      upload.supersedes === null ? 'replaces nothing' : `replaces '${upload.supersedes}'`;
    reasons.push(
      `'${stableId}' is stored as a row that ${storedLink}; this upload says it ${uploadLink}. ` +
        'A booked link cannot be changed — post a new reconciled row instead.',
    );
  }
  if (upload.coverage.explicit && (
    upload.coverage.start !== stored.coverage_start || upload.coverage.end !== stored.coverage_end ||
    upload.coverage.complete !== stored.coverage_complete
  )) {
    reasons.push(`'${stableId}' is already stored with different coverage. A booked period cannot be changed — post a new reconciled row with supersedes_external_id='${stableId}'.`);
  }
  return reasons.length === 0 ? null : reasons.join(' ');
}

function sameBooked(a: Booked, b: Booked): boolean {
  return (
    IDENTITY_FIELDS.every((field) => a[field] === b[field]) &&
    a.bookingState === b.bookingState &&
    a.amountMinor === b.amountMinor &&
    a.supersedes === b.supersedes &&
    (!(a.coverage.explicit || b.coverage.explicit) || (
      a.coverage.start === b.coverage.start && a.coverage.end === b.coverage.end && a.coverage.complete === b.coverage.complete
    ))
  );
}

/** The refusal for a correction whose target is a different entry, or null when
 * the identities agree. */
function mismatch(
  index: number,
  targetRef: string,
  target: Identity,
  row: Identity,
): RowResult | null {
  const differs = IDENTITY_FIELDS.filter((field) => target[field] !== row[field]);
  if (differs.length === 0) return null;
  return {
    index,
    ok: false,
    error: 'supersedes_mismatch',
    detail:
      `'${targetRef}' is ${describe(target)}; this row is ${describe(row)} ` +
      `(differs in ${differs.join(', ')}). A correction replaces an entry of the same ` +
      'asset, period, kind, family and currency — book a different figure as its own row.',
  };
}

/** The refusal for a correction whose target has already been replaced, naming
 * the entry that is current now so the operator knows what to supersede. */
async function alreadySuperseded(
  store: IngestEnv['STORE'],
  index: number,
  targetRef: string,
  targetId: bigint,
): Promise<RowResult> {
  // Walk forward from the target to every entry nothing supersedes. UNION (not
  // UNION ALL) de-duplicates, so the walk ends even on a chain the store's
  // one-successor rule never let exist.
  const rows = await store.read((tx) =>
    tx.query<{ number: bigint; external_id: string | null; amount_minor: bigint; currency: string; booking_state: string }>(
      `WITH RECURSIVE chain(entry_id) AS (
         SELECT $1::bigint
         UNION
         SELECT s.entry_id FROM noticeos.ledger_entries s JOIN chain c ON s.supersedes_id = c.entry_id
       )
       SELECT l.entry_number AS number, l.external_id, l.amount_minor, l.currency, l.booking_state
         FROM noticeos.ledger_entries l JOIN chain c ON c.entry_id = l.entry_id
        WHERE NOT EXISTS (SELECT 1 FROM noticeos.ledger_entries n WHERE n.supersedes_id = l.entry_id)
        ORDER BY l.entry_id`,
      [targetId],
    ),
  );
  const heads = rows.map((head) => ({ ...head, number: exact(head.number), amount_minor: exact(head.amount_minor) }));
  const named = heads.map(
    (head) =>
      `${head.external_id === null ? `ledger row #${head.number} (no external_id)` : `'${head.external_id}'`} ` +
      `(${money(head.amount_minor, head.currency)}, ${head.booking_state})`,
  );
  const only = heads.length === 1 ? heads[0] : undefined;
  const advice =
    only?.external_id != null
      ? ` A correction replaces the current entry only — if this figure still stands, ` +
        `post it with supersedes_external_id='${only.external_id}'.`
      : ' A correction replaces the current entry only.';
  return {
    index,
    ok: false,
    error: 'already_superseded',
    detail:
      `'${targetRef}' is no longer current: it was replaced by ` +
      `${named.length > 0 ? named.join(' and ') : 'another row'}.${advice}`,
  };
}

/** One accepted row, carrying the identity work already done for it. */
interface Pending {
  index: number;
  row: LedgerRow;
  stableId: string;
  /** The entry this row replaces: `ref` is its stable id; `storedId` is its
   * identity when it was already in the store, or null when it is another row
   * of this same batch — which cannot be resolved until that row has been
   * written (see the two insert passes). */
  target: { ref: string; storedId: bigint | null } | null;
  coverage: Coverage;
}

export async function handleRevenue(request: Request, env: IngestEnv): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const contentType = request.headers.get('content-type') ?? '';
  let rawRows: unknown[];
  try {
    if (contentType.includes('text/csv')) {
      rawRows = csvToRows(await request.text());
    } else {
      const parsed = await request.json();
      if (!Array.isArray(parsed)) {
        return json({ error: 'bad_request', detail: 'JSON body must be an array of ledger rows' }, 400);
      }
      rawRows = parsed;
    }
  } catch (err) {
    return json({ error: 'bad_request', detail: `could not parse body: ${String(err)}` }, 400);
  }

  if (rawRows.length === 0) {
    return json({ error: 'bad_request', detail: 'no rows supplied' }, 400);
  }

  try {
    const result = await importLedgerRows(rawRows, env.STORE);
    const status = result.inserted + result.alreadyImported === 0 ? 422 : 200;
    return json(result, status);
  } catch (error) {
    if (error instanceof LedgerImportConflict) return json({ error: 'conflict', detail: error.message }, 409);
    throw error;
  }
}

/** Shared ordinary ledger writer. The caller must first obtain its authorized
 * workspace store; this function authenticates nobody and reads no env token. */
export async function importLedgerRows(rawRows: unknown[], store: WorkspaceStore): Promise<LedgerImportSummary> {
  if (!Array.isArray(rawRows) || rawRows.length === 0) throw new TypeError('No ledger rows supplied.');

  // Known asset ids, so an unknown asset is a clean per-row error rather than a
  // raw FK failure. The site list is on Postgres (bead ro-ujb9.76.4.2).
  const knownAssets = await knownAssetIds(store);

  const results: RowResult[] = new Array(rawRows.length);
  const accepted: { index: number; row: LedgerRow; stableId: string }[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const parsed = LedgerInputRow.safeParse(rawRows[i]);
    if (!parsed.success) {
      results[i] = { index: i, ok: false, error: 'validation', issues: zodIssues(parsed.error) };
      continue;
    }
    if (!knownAssets.has(parsed.data.asset)) {
      results[i] = { index: i, ok: false, error: 'unknown_asset', detail: parsed.data.asset };
      continue;
    }
    accepted.push({ index: i, row: parsed.data, stableId: parsed.data.stable_id });
  }

  // --- what the store already holds under these ids ---------------------------
  // One read for the whole batch, covering both the rows being uploaded and the
  // estimates they claim to supersede — with each row's own link and whether
  // anything replaces it yet.
  const wanted = new Set<string>();
  for (const { row, stableId } of accepted) {
    wanted.add(stableId);
    if (row.supersedes_external_id !== undefined) wanted.add(row.supersedes_external_id);
  }
  const stored = new Map<string, StoredRow>();
  if (wanted.size > 0) {
    const rows = await store.read((tx) =>
      tx.query<Omit<StoredRow, 'number' | 'amount_minor' | 'supersedes_number'> & {
        number: bigint;
        amount_minor: bigint;
        supersedes_number: bigint | null;
      }>(
        `SELECT l.entry_id, l.entry_number AS number, l.external_id, l.kind, l.asset_id AS asset,
                to_char(l.period_month, 'YYYY-MM') AS period, l.family, l.currency,
                l.booking_state, l.amount_minor, t.entry_number AS supersedes_number,
                to_char(l.coverage_start, 'YYYY-MM-DD') AS coverage_start,
                to_char(l.coverage_end, 'YYYY-MM-DD') AS coverage_end, l.coverage_complete,
                t.external_id AS supersedes_external_id,
                EXISTS (SELECT 1 FROM noticeos.ledger_entries s
                         WHERE s.workspace_id = l.workspace_id AND s.supersedes_id = l.entry_id) AS superseded
           FROM noticeos.ledger_entries l
           LEFT JOIN noticeos.ledger_entries t ON t.workspace_id = l.workspace_id AND t.entry_id = l.supersedes_id
          WHERE l.external_id = ANY($1::text[]) AND l.${MONEY}`,
        [[...wanted]],
      ),
    );
    for (const r of rows) {
      stored.set(r.external_id, {
        ...r,
        number: exact(r.number),
        amount_minor: exact(r.amount_minor),
        supersedes_number: r.supersedes_number === null ? null : exact(r.supersedes_number),
      });
    }
  }

  // --- resolve each accepted row against the store and against its own batch ---
  const pending: Pending[] = [];
  // stable id -> the batch position that claimed it first.
  const claimed = new Map<string, { index: number; booked: Booked }>();
  // Later copies of a claimed row: their result follows the first copy's.
  const copies: { index: number; of: number }[] = [];

  for (const { index, row, stableId } of accepted) {
    const booked = bookedOf(row);

    // Already in the store under this id?
    const existing = stored.get(stableId);
    if (existing) {
      const conflict = replayConflict(stableId, booked, existing);
      results[index] =
        conflict === null
          ? { index, ok: true, imported: false, id: existing.number }
          : { index, ok: false, error: 'conflicting_replay', detail: conflict };
      continue;
    }

    // Claimed earlier in THIS batch? Same handling, so a doubled row inside one
    // file is caught before it reaches the unique index.
    const earlier = claimed.get(stableId);
    if (earlier) {
      if (sameBooked(booked, earlier.booked)) {
        copies.push({ index, of: earlier.index });
      } else {
        results[index] = {
          index,
          ok: false,
          error: 'conflicting_replay',
          detail: `'${stableId}' appears twice in this upload with different content (rows ${earlier.index} and ${index})`,
        };
      }
      continue;
    }

    // The entry this row replaces, by stable id: same identity, and current.
    let target: Pending['target'] = null;
    const ref = row.supersedes_external_id;
    if (ref !== undefined) {
      if (ref === stableId) {
        results[index] = {
          index,
          ok: false,
          error: 'supersedes_self',
          detail: `'${stableId}' names itself in supersedes_external_id; a correction replaces an earlier entry`,
        };
        continue;
      }
      const storedTarget = stored.get(ref);
      const batchTarget = storedTarget ? undefined : accepted.find((a) => a.stableId === ref);
      if (storedTarget) {
        const refused = mismatch(index, ref, storedTarget, identityOf(row));
        if (refused) {
          results[index] = refused;
          continue;
        }
        if (storedTarget.superseded) {
          results[index] = await alreadySuperseded(store, index, ref, storedTarget.entry_id);
          continue;
        }
        target = { ref, storedId: storedTarget.entry_id };
      } else if (batchTarget) {
        const refused = mismatch(index, ref, identityOf(batchTarget.row), identityOf(row));
        if (refused) {
          results[index] = refused;
          continue;
        }
        target = { ref, storedId: null };
      } else {
        results[index] = {
          index,
          ok: false,
          error: 'unknown_supersedes',
          detail: `no ledger row has external_id '${ref}'`,
        };
        continue;
      }
    }

    claimed.set(stableId, { index, booked });
    pending.push({ index, row, stableId, target, coverage: booked.coverage });
  }

  // --- one replacement per entry ---------------------------------------------
  // Two rows of one upload replacing the same entry would both be current. The
  // file is ambiguous about which figure stands, so neither is booked.
  const byTarget = new Map<string, Pending[]>();
  for (const p of pending) {
    if (p.target === null) continue;
    const group = byTarget.get(p.target.ref) ?? [];
    group.push(p);
    byTarget.set(p.target.ref, group);
  }
  const branching = new Set<Pending>();
  for (const [ref, group] of byTarget) {
    if (group.length < 2) continue;
    const rows = group.map((p) => p.index).join(', ');
    for (const p of group) {
      branching.add(p);
      results[p.index] = {
        index: p.index,
        ok: false,
        error: 'duplicate_supersedes',
        detail:
          `rows ${rows} of this upload all supersede '${ref}'. An entry has one replacement: ` +
          'keep one of these rows, then post any later restatement against its external_id.',
      };
    }
  }
  const writable = pending.filter((p) => !branching.has(p));

  // --- write ------------------------------------------------------------------
  // Two passes so an export may carry an estimate and the row reconciling it:
  // everything independent goes first, then the rows whose target was written by
  // that first pass. A chain deeper than one link is refused rather than guessed.
  const firstPass = writable.filter((p) => p.target === null || p.target.storedId !== null);
  const secondPass = writable.filter((p) => p.target !== null && p.target.storedId === null);
  const idByStableId = new Map<string, bigint>();
  // Corrections the guarded insert declined: explained after the writes.
  const declined: { p: Pending; targetId: bigint }[] = [];

  // `amount_minor` is the only money column since db/0020 (bead ro-k5s). The
  // dollars figure the upload states is still parsed and validated — it is what
  // an operator's export carries — but it is converted once, on the way in, and
  // never stored a second time as a REAL.
  //
  // A row with no target ($12 IS NULL) is always inserted. A correction is
  // inserted only if, at the moment of the write, its target still has the
  // same identity and nothing supersedes it yet — checked by this statement
  // itself — and it gives way to a correction another upload booked on the
  // one-successor index, so a concurrent upload that booked a correction
  // between our read and our write turns this one into 0 rows instead of a
  // second head. Every value is a parameter, and each is cast, since a SELECT
  // list gives Postgres no column to infer its type from.
  const insert = async (tx: Transaction, p: Pending, supersedesId: bigint | null) => {
    const [row] = await tx.query<{ entry_id: bigint; number: bigint }>(
      `INSERT INTO noticeos.ledger_entries
         (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, external_id,
          source, ref, booking_state, supersedes_id, note, coverage_start, coverage_end, coverage_complete)
       SELECT $1::uuid, $2::text, $3::text, $4::date, $5::text, $6::bigint, $7::char(3), $8::text,
              $9::text, $10::text, $11::text, $12::bigint, $13::text, $14::date, $15::date, $16::boolean
        WHERE $12::bigint IS NULL
           OR (EXISTS (SELECT 1 FROM noticeos.ledger_entries t
                        WHERE t.entry_id = $12::bigint AND t.kind = $2::text AND t.asset_id = $3::text
                          AND t.period_month = $4::date AND t.family = $5::text AND t.currency = $7::char(3))
               AND NOT EXISTS (SELECT 1 FROM noticeos.ledger_entries s WHERE s.supersedes_id = $12::bigint))
       ON CONFLICT (workspace_id, supersedes_id) WHERE supersedes_id IS NOT NULL DO NOTHING
       RETURNING entry_id, entry_number AS number`,
      [
        tx.workspaceId,
        p.row.kind,
        p.row.asset,
        `${p.row.period}-01`,
        p.row.family,
        p.row.amount_minor,
        p.row.currency,
        p.stableId,
        p.row.source ?? null,
        p.row.ref ?? null,
        p.row.booking_state,
        supersedesId,
        p.row.note ?? null,
        p.coverage.start,
        p.coverage.end,
        p.coverage.complete,
      ],
    );
    return row;
  };

  const record = (p: Pending, supersedesId: bigint | null, written: { entry_id: bigint; number: bigint } | undefined) => {
    if (written !== undefined) {
      idByStableId.set(p.stableId, written.entry_id);
      results[p.index] = { index: p.index, ok: true, imported: true, id: exact(written.number) };
    } else if (supersedesId !== null) {
      declined.push({ p, targetId: supersedesId });
    } else {
      results[p.index] = {
        index: p.index,
        ok: false,
        error: 'conflict',
        detail: 'the store reported no row written',
      };
    }
  };

  // Each pass is one transaction, its inserts in upload order: the batch D1 ran.
  const writePass = (rows: { p: Pending; supersedesId: bigint | null }[]) =>
    store.write(async (tx) => {
      const written: ({ entry_id: bigint; number: bigint } | undefined)[] = [];
      for (const { p, supersedesId } of rows) written.push(await insert(tx, p, supersedesId));
      return written;
    });

  try {
    if (firstPass.length > 0) {
      const written = await writePass(firstPass.map((p) => ({ p, supersedesId: p.target?.storedId ?? null })));
      for (let j = 0; j < firstPass.length; j++) {
        const p = firstPass[j]!;
        record(p, p.target?.storedId ?? null, written[j]);
      }
    }
    if (secondPass.length > 0) {
      const resolvable: { p: Pending; targetId: bigint }[] = [];
      for (const p of secondPass) {
        const id = idByStableId.get(p.target!.ref);
        if (id === undefined) {
          results[p.index] = {
            index: p.index,
            ok: false,
            error: 'unknown_supersedes',
            detail: `'${p.target!.ref}' is itself unwritten in this upload; post the estimate first`,
          };
          continue;
        }
        resolvable.push({ p, targetId: id });
      }
      if (resolvable.length > 0) {
        const written = await writePass(resolvable.map(({ p, targetId }) => ({ p, supersedesId: targetId })));
        for (let j = 0; j < resolvable.length; j++) {
          const { p, targetId } = resolvable[j]!;
          record(p, targetId, written[j]);
        }
      }
    }
  } catch (err) {
    // The unique index is the real guard; this is the concurrent-upload case the
    // read above cannot see. Answering 409 keeps a double-post from ever looking
    // like a successful second booking.
    throw new LedgerImportConflict(`ledger write rejected: ${String(err)}`);
  }

  // A declined correction lost a race (or its target changed under it): say
  // which rule it would have broken, from a fresh read.
  for (const { p, targetId } of declined) {
    const ref = p.target!.ref;
    const [now] = await store.read((tx) =>
      tx.query<Identity & { superseded: boolean }>(
        `SELECT kind, asset_id AS asset, to_char(period_month, 'YYYY-MM') AS period, family, currency,
                EXISTS (SELECT 1 FROM noticeos.ledger_entries s
                         WHERE s.workspace_id = t.workspace_id AND s.supersedes_id = t.entry_id) AS superseded
           FROM noticeos.ledger_entries t WHERE t.entry_id = $1::bigint`,
        [targetId],
      ),
    );
    if (now === undefined) {
      results[p.index] = {
        index: p.index,
        ok: false,
        error: 'unknown_supersedes',
        detail: `no ledger row has external_id '${ref}'`,
      };
      continue;
    }
    results[p.index] =
      mismatch(p.index, ref, now, identityOf(p.row)) ??
      (now.superseded
        ? await alreadySuperseded(store, p.index, ref, targetId)
        : {
            index: p.index,
            ok: false,
            error: 'conflict',
            detail: `the store declined to supersede '${ref}'; retry the upload`,
          });
  }

  // A doubled row inside one upload reports what happened to its first copy.
  for (const { index, of } of copies) {
    const first = results[of];
    results[index] =
      first !== undefined && first.ok
        ? { index, ok: true, imported: false, id: first.id }
        : {
            index,
            ok: false,
            error: first?.ok === false ? first.error : 'conflict',
            detail: `same row as ${of} in this upload, which was not booked`,
          };
  }

  let reviewRequired = 0;
  for (const { index, row } of accepted) {
    const result = results[index];
    if (result?.ok && coverageOf(row).review) {
      result.review = {
        code: 'coverage_note_unreadable',
        message: result.imported
          ? 'Row booked with unknown coverage. Review the partial-month dates and upload explicit coverage fields in a reconciliation.'
          : 'Already booked; stored coverage was retained. Review the unreadable partial-month dates before any reconciliation.',
      };
      reviewRequired += 1;
    }
  }

  let inserted = 0;
  let alreadyImported = 0;
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    else if (r.imported) inserted += 1;
    else alreadyImported += 1;
  }

  return { inserted, alreadyImported, failed, reviewRequired, results };
}
