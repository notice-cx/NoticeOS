/** Cross-Worker contract for the annotation write. The ingest Worker owns the
 * `annotations` table; the Tower reaches the write through the private ingest
 * Service Binding, and plain data crosses, never a credential. Every field is
 * re-validated inside ingest.
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
 * HTTP routes report. */
export interface AnnotationIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * The outcome of one write attempt. A rejected field and an unknown asset are
 * results, not thrown errors; only an infrastructure failure throws.
 * `created: false` is the idempotent case: identity is `(asset, at, kind,
 * ref)`, so a re-post returns the row already there.
 */
export type CreateAnnotationResult =
  | { ok: true; created: boolean; annotation: AnnotationRow }
  | { ok: false; error: 'validation'; issues: AnnotationIssue[] }
  | { ok: false; error: 'unknown_asset'; asset: string };
