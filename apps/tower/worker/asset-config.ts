// The shapes of the per-asset config files the Tower reads — config/pull.json,
// config/serp-panel.json, config/signal-panels.json, config/value-events.json
// and config/ga4-custom-dimensions.json.
//
// Types only. `config-source.ts` resolves each file per request (store first,
// bundle second) and every consumer takes them as injected deps, never from
// disk. They live here, in one place named for what they describe, so a module
// that needs one of these shapes — the integration evidence reader, the router,
// a page builder — never has to import another page's payload module to get it.

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

/** What the Tower needs from config/signal-panels.json: the per-asset roster,
 * and — since bead `ro-x5gu.8` — the `/refresh` block, for the two DECLARED
 * KNOBS inside it (`windowDays`, `freshnessMaxAgeDays`) that `/settings` edits.
 * The block is OPTIONAL: a config without one renders no rows rather than two
 * zeros nobody configured. The cadence itself is still not here — it is the
 * runner's schedule (config/signal-panels.README.md). */
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
