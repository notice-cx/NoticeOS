// The signal contract — Zod schemas + inferred types (docs/02-signal-contract).
//
// Two casing worlds meet here, deliberately (db/README choice #5): pulse
// envelopes arrive from assets in the docs/02 *camelCase* shape and are stored
// verbatim, so the in-transit schemas are camelCase; the persisted store rows
// (FlagRow, the ledger input) are *snake_case* to match the store's columns the
// worker writes and the Tower reads.

import { z } from 'zod';
import { isSupportedCurrency, majorToMinorUnits } from './money.js';

// ISO-8601 datetime, accepting a trailing Z or a numeric offset.
const isoDateTime = z.iso.datetime({ offset: true });

// --- separate severity / kind enums (docs/02 §glossary) ------------------
// v1 mixed "celebrate" into severity and could no longer threshold it; the
// contract keeps them orthogonal. milestone-kind is always info-severity, an
// invariant enforced on every flag shape below.
export const FlagSeverity = z.enum(['info', 'warn', 'error']);
export type FlagSeverity = z.infer<typeof FlagSeverity>;

export const FlagKind = z.enum(['anomaly', 'opportunity', 'milestone']);
export type FlagKind = z.infer<typeof FlagKind>;

const milestoneIsInfo = <T extends { kind: FlagKind; severity: FlagSeverity }>(
  f: T,
): boolean => f.kind !== 'milestone' || f.severity === 'info';
const milestoneIsInfoIssue = {
  message: 'milestone-kind flags must be info-severity (docs/02)',
  path: ['severity'] as PropertyKey[],
};

// --- the pulse (docs/02 §"The pulse") ------------------------------------

/** One named metric series inside a pulse: a day, a 7-day mean, a running total. */
export const Metric = z.object({
  last24h: z.number().int().nonnegative(),
  avg7d: z.number().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type Metric = z.infer<typeof Metric>;

/** A flag carried *in transit* inside a pulse envelope (asset-declared). */
export const InTransitFlag = z
  .object({
    severity: FlagSeverity,
    kind: FlagKind,
    metric: z.string().optional(),
    msg: z.string().optional(),
  })
  .refine(milestoneIsInfo, milestoneIsInfoIssue);
export type InTransitFlag = z.infer<typeof InTransitFlag>;

/** Negative-feedback tally per page (docs/02 example `negativeByPage`). */
export const NegativeByPage = z.object({
  page: z.string(),
  count: z.number().int().nonnegative(),
});
export type NegativeByPage = z.infer<typeof NegativeByPage>;

/**
 * The pulse envelope — the nightly self-report, capability-agnostic (docs/02).
 * `capabilities` lists the metric families the asset can observe; `metrics` is
 * a map keyed by metric name. Stored verbatim; the worker lifts a few columns.
 */
export const PulseEnvelope = z.object({
  asset: z.string().min(1),
  generatedAt: isoDateTime,
  capabilities: z.array(z.string()),
  metrics: z.record(z.string(), Metric),
  negativeByPage: z.array(NegativeByPage).optional(),
  flags: z.array(InTransitFlag).optional(),
});
export type PulseEnvelope = z.infer<typeof PulseEnvelope>;

// --- annotations (docs/02 §Annotations) ----------------------------------
export const AnnotationKind = z.enum([
  'deploy',
  'model-change',
  'config',
  'incident',
  'autonomy-change',
  'external',
]);
export type AnnotationKind = z.infer<typeof AnnotationKind>;

export const Annotation = z.object({
  asset: z.string().min(1),
  at: isoDateTime,
  kind: AnnotationKind,
  ref: z.string().optional(),
  note: z.string().optional(),
});
export type Annotation = z.infer<typeof Annotation>;

// --- the persisted flag row (snake_case, mirrors the store's `flags`) -----
export const FlagDisposition = z.enum([
  'ack',
  'snooze',
  'tune',
  'incident',
  'hypothesis',
]);
export type FlagDisposition = z.infer<typeof FlagDisposition>;

/**
 * A flag as it lives in the store: a queryable row with disposition fields
 * (docs/02 §glossary, docs/14-design.md § Operator flows triage loop). `rule_id` is mandatory — every
 * fired flag records the rule and (in `rule_inputs`, a JSON string) the actual
 * inputs it saw, so false positives are auditable.
 */
export const FlagRow = z
  .object({
    id: z.number().int(),
    asset: z.string(),
    pulse_id: z.number().int().nullable(),
    fired_at: z.string(),
    severity: FlagSeverity,
    kind: FlagKind,
    metric: z.string().nullable(),
    message: z.string().nullable(),
    rule_id: z.string(),
    rule_inputs: z.string().nullable(),
    disposition: FlagDisposition.nullable(),
    disposition_at: z.string().nullable(),
    disposition_note: z.string().nullable(),
    snooze_until: z.string().nullable(),
    ack_expiry: z.string().nullable(),
    hypothesis_ref: z.string().nullable(),
    incident_ref: z.string().nullable(),
    resolved_at: z.string().nullable(),
  })
  .refine(milestoneIsInfo, milestoneIsInfoIssue);
export type FlagRow = z.infer<typeof FlagRow>;

// --- ledger ingest row (docs/00 §ledger; the /api/revenue lane) -----------
export const LedgerKind = z.enum(['revenue', 'cost']);
export type LedgerKind = z.infer<typeof LedgerKind>;

export const BookingState = z.enum(['estimated', 'reconciled']);
export type BookingState = z.infer<typeof BookingState>;

export const RevenueFamily = z.enum(['ads', 'affiliate', 'subs', 'licensing']);
export type RevenueFamily = z.infer<typeof RevenueFamily>;

export const CostFamily = z.enum([
  'inference',
  'api',
  'infra',
  'operator',
  'os-overhead',
]);
export type CostFamily = z.infer<typeof CostFamily>;

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Convert stated major units to exact integer minor units. Legacy uploads
 * without a currency remain USD; precision follows the supported currency. */
export function amountToMinorUnits(amount: number, currency = 'USD'): number {
  return majorToMinorUnits(amount, currency);
}

/**
 * The row's stable identity, namespaced by the source that issued it — the key
 * the store's unique index enforces and the handle a later reconciliation
 * points at.
 *
 * A source that issues its own record id supplies `external_id` and the row is
 * keyed by it. A hand-assembled monthly export usually issues nothing, so the
 * key falls back to the accounting grain the row occupies: one figure per
 * (source, kind, asset, period, family, booking_state). Re-uploading that
 * export therefore lands on the same key instead of appending a second copy of
 * the money.
 *
 * `auto/` marks the derived form so an operator reading the column can tell a
 * provider's id from ours.
 */
export function deriveExternalId(row: {
  kind: string;
  asset: string;
  period: string;
  family: string;
  booking_state: string;
  source?: string | undefined;
  ref?: string | undefined;
  external_id?: string | undefined;
}): string {
  const namespace = row.source ?? row.ref ?? 'operator';
  if (row.external_id !== undefined) return `${namespace}:${row.external_id}`;
  return `${namespace}:auto/${row.kind}/${row.asset}/${row.period}/${row.family}/${row.booking_state}`;
}

/**
 * One ledger row as accepted by /api/revenue (CSV or JSON), validated against
 * the same CHECK constraints the migration enforces *before* insert: `family`
 * is namespaced by `kind`, `period` is `YYYY-MM`, `amount` coerces from CSV
 * strings.
 *
 * Two fields carry the idempotency contract:
 *
 *   - `external_id` — the source's own record id for this row, optional. Absent,
 *     the row is keyed by its accounting grain (see `deriveExternalId`), which
 *     is what makes a re-uploaded export a no-op rather than a second booking.
 *   - `supersedes_external_id` — the stable id of the ESTIMATE this row
 *     reconciles. Reconciliation is still a new superseding row, never an
 *     update; this just names the row it supersedes by id instead of leaving
 *     the link to hand-written SQL.
 *
 * `currency` is a supported uppercase code, defaulting to USD for old exports;
 * the raw numeric `supersedes_id` stays internal — a caller should never need
 * to know the store's autoincrement.
 */
export const LedgerInputRow = z
  .object({
    kind: LedgerKind,
    asset: z.string().min(1),
    period: z.string().regex(PERIOD_RE, 'period must be YYYY-MM'),
    family: z.string().min(1),
    currency: z.string().refine(isSupportedCurrency, 'currency must be a supported uppercase code').default('USD'),
    amount: z.coerce
      .number()
      .refine((n) => Number.isFinite(n), 'amount must be a finite number'),
    source: z.string().optional(),
    ref: z.string().optional(),
    booking_state: BookingState,
    note: z.string().optional(),
    external_id: z.string().min(1).max(200).optional(),
    supersedes_external_id: z.string().min(1).max(200).optional(),
    coverage_start: z.iso.date().nullable().optional(),
    coverage_end: z.iso.date().nullable().optional(),
    // CSV strings must be read literally: Boolean('false') is true.
    coverage_complete: z.union([
      z.boolean(),
      z.enum(['true', 'false']).transform((value) => value === 'true'),
    ]).nullable().optional(),
  })
  .superRefine((row, ctx) => {
    const familyOk =
      row.kind === 'revenue'
        ? RevenueFamily.safeParse(row.family).success
        : CostFamily.safeParse(row.family).success;
    if (!familyOk) {
      ctx.addIssue({
        code: 'custom',
        path: ['family'],
        message: `family '${row.family}' is not valid for kind '${row.kind}'`,
      });
    }
    if (row.coverage_start != null && row.coverage_end != null && row.coverage_start > row.coverage_end) {
      ctx.addIssue({ code: 'custom', path: ['coverage_end'], message: 'coverage_end must be on or after coverage_start' });
    }
    // A figure too large to hold exactly in minor units cannot be stored honestly, so
    // it is rejected at the door rather than rounded into the ledger.
    if (!Number.isSafeInteger(amountToMinorUnits(row.amount, row.currency))) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'amount is too large to represent exactly in minor units',
      });
    }
    // Only a reconciled row may supersede: an estimate that claims to replace
    // another estimate would leave the store with no reconciled figure and a
    // hidden one.
    if (row.supersedes_external_id !== undefined && row.booking_state !== 'reconciled') {
      ctx.addIssue({
        code: 'custom',
        path: ['supersedes_external_id'],
        message: 'only a reconciled row may supersede another row',
      });
    }
  })
  .transform((row) => ({
    ...row,
    /** Exact minor units — the only money the STORE holds since db/0020 dropped the
     * `amount REAL` mirror. `amount` stays on the WIRE because that is what a
     * provider's export prints; it is converted here, once, at the boundary. */
    amount_minor: amountToMinorUnits(row.amount, row.currency),
    /** The stable key the unique index enforces (`deriveExternalId`). */
    stable_id: deriveExternalId(row),
  }));
export type LedgerInputRow = z.infer<typeof LedgerInputRow>;
