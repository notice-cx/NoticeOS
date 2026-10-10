/** Report family names the collectors own, portable so plain-Node scripts read the generated `.mjs` sibling instead of a copy. */

// ── DataForSEO (the family contract itself is dataforseo.ts) ────────────────

export const DATAFORSEO_BASE_REPORTS = [
  'ranked-keywords',
  'backlinks-summary',
  'backlinks-new-lost',
  'backlinks-referring-domains',
  'backlinks-anchors',
  'llm-mentions-google',
  'llm-mentions-chatgpt',
] as const;

export const DATAFORSEO_PANEL_REPORT = 'serp-panel' as const;

/**
 * Families on a slower-than-weekly cadence, collected by the same sweep but
 * not part of the weekly collection identity above: a 28-day family is
 * legitimately absent from three `report_date`s out of four, so grading
 * against it would call three weeks in four incomplete.
 */
export const DATAFORSEO_PERIODIC_REPORTS = [
  'keyword-ideas',
  'serp-competitors',
] as const;

// ── Bing AI Performance ─────────────────────────────────────────────────────

/** These rows are Bing Webmaster Tools (same account, same verified site), so
 * they share the integration and are told apart by report family. */
export const BING_AI_INTEGRATION = 'bing-webmaster';

/** The three exports of Bing's AI Performance report: no cron produces them,
 * an operator drops each file by hand. */
export const BING_AI_REPORTS = ['ai-overview', 'ai-queries', 'ai-pages'] as const;
export type BingAiReport = (typeof BING_AI_REPORTS)[number];
