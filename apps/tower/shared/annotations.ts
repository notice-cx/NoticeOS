// Annotation vocabulary: the timeline events (deploys, model changes, config
// edits) both wall.ts and asset-detail.ts carry, kept here so neither contract
// imports the other.

/** The `annotations.kind` CHECK: the closed set of timeline event kinds. */
export type AnnotationKind =
  | "deploy"
  | "model-change"
  | "config"
  | "incident"
  | "autonomy-change"
  | "external";

/** The same closed set as a value, for a select control and for validation. */
export const ANNOTATION_KINDS: AnnotationKind[] = [
  "deploy",
  "model-change",
  "config",
  "incident",
  "autonomy-change",
  "external",
];

/** Field caps, identical to the ingest worker's operator API (its README is the
 * published contract), so the form cannot accept what the store would reject. */
export const ANNOTATION_REF_MAX = 256;
export const ANNOTATION_NOTE_MAX = 1000;

/** One annotations row, verbatim (docs/02 §Annotations shape). */
export interface AnnotationItem {
  id: number;
  at: string;
  kind: AnnotationKind;
  ref: string | null;
  note: string | null;
}

/**
 * An asset's timeline as the detail payload ships it: the rows the page draws
 * plus how many older ones the read did not carry, so the cap is never silent.
 */
export interface AnnotationTimeline {
  /** Newest first, and CONTIGUOUS: whatever is missing is the older tail, so a
   * single "N older" line at the end accounts for all of it. */
  items: AnnotationItem[];
  /** Rows this asset holds that `items` does not. 0 when it holds them all. */
  olderCount: number;
}
