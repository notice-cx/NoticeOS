// The names a task filed by NoticeOS carries in a project's own tracker
// (config/beads.README.md § Handoff metadata). They are persisted identity in
// other repositories' trackers: every filer's dedupe and the Tower's
// filed-task badge join on them, so every reader also accepts the older
// `reindex_*` names and the `reindex-handoff` label.
//
// Authored TypeScript: `pnpm generate` writes the `.mjs` and `.d.mts`
// beside it.

export interface TaskMetadataField {
  /** The key NoticeOS writes. */
  readonly name: string;
  /** The key a bead filed before the rename carries. */
  readonly legacy: string;
}

export const TASK_METADATA = Object.freeze({
  /** A Tower handoff's source: always the handoff label. */
  source: Object.freeze({ name: "noticeos_source", legacy: "reindex_source" }),
  /** Which site the handoff was raised for. */
  asset: Object.freeze({ name: "noticeos_asset", legacy: "reindex_asset" }),
  /** Which Tower surface raised it: finding, query, page or alert. */
  kind: Object.freeze({ name: "noticeos_kind", legacy: "reindex_kind" }),
  /** The rule behind it. */
  rule: Object.freeze({ name: "noticeos_rule", legacy: "reindex_rule" }),
  /** The byte-exact join back to the row that raised it. */
  key: Object.freeze({ name: "noticeos_key", legacy: "reindex_key" }),
  /** A panel review's site. */
  panelAsset: Object.freeze({ name: "noticeos_panel_asset", legacy: "reindex_panel_asset" }),
  /** A panel review's collection day. */
  panelDate: Object.freeze({ name: "noticeos_panel_date", legacy: "reindex_panel_date" }),
  /** An unpushed-work ask's site. */
  pushAsset: Object.freeze({ name: "noticeos_push_asset", legacy: "reindex_push_asset" }),
  /** A task-map drift report's project. */
  taskMapAsset: Object.freeze({ name: "noticeos_task_map_asset", legacy: "reindex_task_map_asset" }),
  /** The server's identity for the hosted write that created this task, so a
   * retried request can find it. Server-set only; it has no older name. */
  operation: Object.freeze({ name: "noticeos_operation_id", legacy: "noticeos_operation_id" }),
} satisfies Record<string, TaskMetadataField>);

export type TaskMetadataName = keyof typeof TASK_METADATA;

/** The label every Tower handoff bead carries from now on. */
export const HANDOFF_LABEL = "noticeos-handoff";
/** The label handoff beads filed before the rename carry. */
export const LEGACY_HANDOFF_LABEL = "reindex-handoff";
/** Both, for a reader that finds handoffs by label (`bd list --label-any`). */
export const HANDOFF_LABELS: readonly string[] = Object.freeze([HANDOFF_LABEL, LEGACY_HANDOFF_LABEL]);

/**
 * One field of a bead's metadata under either name: the NoticeOS key when the
 * bead carries it, else the pre-rename key. Undefined when the bead carries
 * neither, or its metadata is not an object (`bd list --json` omits it for a
 * bead with none).
 */
export function taskMetadataValue(metadata: unknown, field: TaskMetadataName): unknown {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  const { name, legacy } = TASK_METADATA[field];
  return record[name] !== undefined ? record[name] : record[legacy];
}

/** Whether a label is the handoff label, of either vintage. */
export function isHandoffLabel(label: unknown): boolean {
  return typeof label === "string" && HANDOFF_LABELS.includes(label);
}
