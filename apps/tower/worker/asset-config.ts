// The shapes of the per-asset config documents the Tower reads. Types only:
// `config-source.ts` resolves each per request and consumers take them as
// injected deps.

/** One config/pull.json entry (the shape the ingest lane reads). `metrics` rides
 * with the `prometheus` format only — an `envelope` endpoint already returns the
 * signal contract, so it carries no metric→counter map to mirror. */
export interface PullConfigEntry {
  asset: string;
  url: string;
  enabled: boolean;
  format: string;
  metrics?: Record<string, { counter: string }>;
}

/** The one thing the Tower needs from config/serp-panel.json. */
export interface SerpPanelConfig {
  assets: Record<string, unknown>;
}

/** The per-asset roster and the optional `/refresh` block whose two knobs
 * (`windowDays`, `freshnessMaxAgeDays`) `/settings` edits. Without the block
 * the page renders no rows rather than two zeros nobody configured. */
export interface SignalPanelsConfig {
  assets: Record<string, unknown>;
  refresh?: Record<string, unknown>;
}

/** config/value-events.json, as the Tower reads it. */
export interface ValueEventsConfig {
  assets: Record<string, { valueEvents?: unknown; productUseStages?: unknown } | undefined>;
}

/** config/ga4-custom-dimensions.json, as the Tower reads it. */
export interface Ga4EventParamsConfig {
  assets: Record<string, { eventParams?: unknown } | undefined>;
}
