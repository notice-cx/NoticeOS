/** Cross-Worker contract for the annotation write.
 *
 * The ingest Worker owns the `annotations` table and the operator bearer that
 * guards its HTTP lane. The Control Tower is served unauthenticated on the
 * trusted LAN, so it must never hold that bearer — it reaches this one write
 * through the private INGEST Service Binding instead, where the binding itself
 * is the capability. Same posture as the GA4 realtime read: plain data crosses,
 * never a credential.
 *
 * Every field of the input is re-validated inside ingest. These types describe
 * the shape a caller intends, not a shape ingest is willing to trust.
 */
import type { AnnotationKind } from './schema.js';

export interface CreateAnnotationInput {
  asset: string;
  kind: AnnotationKind;
  /**
   * ISO-8601. Absent means "now" by ingest's clock. Backdating is expected —
   * an event is annotated at the time it happened — and a future instant is
   * rejected.
   */
  at?: string | null;
  /** commit sha / config version / model+version / update-calendar id. */
  ref?: string | null;
  note?: string | null;
}

/** One `annotations` row as the store holds it (snake_case, like `FlagRow`). */
export interface AnnotationRow {
  id: number;
  asset: string;
  at: string;
  kind: AnnotationKind;
  ref: string | null;
  note: string | null;
  created_at: string;
}

/** One rejected field, in the same `{path, code, message}` shape the operator
 * HTTP routes report — one validation vocabulary, whichever lane called. */
export interface AnnotationIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * The outcome of one write attempt.
 *
 * A rejected field and an unknown asset are RESULTS, not thrown errors: both
 * are ordinary answers a caller renders. Only an infrastructure failure (a D1
 * error) throws across the binding. `created: false` is the idempotent case —
 * identity is `(asset, at, kind, ref)`, so a re-post returns the row already
 * there rather than a second one.
 */
export type CreateAnnotationResult =
  | { ok: true; created: boolean; annotation: AnnotationRow }
  | { ok: false; error: 'validation'; issues: AnnotationIssue[] }
  | { ok: false; error: 'unknown_asset'; asset: string };
