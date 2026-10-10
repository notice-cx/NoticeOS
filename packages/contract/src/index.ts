// @noticeos/contract — the shared signal contract (docs/02).
// Schemas + inferred types for the pulse envelope, annotations, flags and the
// ledger ingest row; the volume-aware anomaly rules as pure functions; the
// Poisson primitives they stand on; and the reporting-obligation vocabulary
// both the ingest freshness cron and the Tower's coverage summary count with.
//
// Workers and scripts import this index. The Tower's BROWSER code does not: two
// modules here (`schema`, `posthog`) build zod schemas as they load, so the index
// would put zod on every screen. Browser code imports one module by subpath
// instead (`@noticeos/contract/<module>`, the `./*` entry in package.json);
// apps/tower/test/client-contract-imports.test.ts fails if it stops doing so.
export * from './schema.js';
export * from './rules.js';
export * from './rule-backtest.js';
export * from './poisson.js';
export * from './reporting.js';
export * from './os-time-zone.js';
export * from './time-zone-setting.js';
export * from './ga4-realtime.js';
export * from './calendar-upcoming.js';
export * from './asset-column.js';
export * from './money.js';
export * from './integrations.js';
export * from './integration-health.js';
export * from './mediavine.js';
export * from './notifications.js';
export * from './google-oauth.js';
export * from './create-annotation.js';
export * from './create-watch-window.js';
export * from './job-runs.js';
export * from './workflows.js';
export * from './dataforseo.js';
export * from './metered-spend.js';
export * from './flag-open.js';
export * from './posthog.js';
export * from './site-discovery.js';
export * from './asset-name.js';
export * from './site-order.js';
