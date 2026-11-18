import { METERED_DATA_PROVIDER, RESEARCH_COLLECTOR_ACTOR } from '../packages/contract/src/metered-spend.ts';
import { ASSET_ID_MAX, ASSET_ID_RE } from '../packages/contract/src/configuration.mjs';
import { isCalendarDate } from './config-registers.mjs';

// These source tables supply amounts and dates only. No source row is exported.
export const SHADOW_SPEND_SOURCES = Object.freeze({
  archive_runs: 'workspace_id run_seq run_id asset_id integration report credential_ref property_ref report_date requested_at finished_at status data_state schema_version provider_rows request_count provider_truncated object_seq error_code error_message cost_usd cost_state dataforseo_cost_accounted_usd',
  dataforseo_request_charges: 'workspace_id asset_id attempt_id request_key reserved_at reserve_usd provider_cost_usd provider_completed',
  research_log: 'workspace_id research_id research_number asset_id provider endpoint params_sha256 question cost_usd cost_state object_key actor bought_at',
});
const MAX_DAILY_TOTALS = 100_000;
const DAY = /^\d{4}-\d\d-\d\d$/u;
export const invalidShadowSpend = () => new Error('The backup contains invalid metered spending evidence.');

function micros(value) {
  const decimal = typeof value === 'string' && /^(\d{1,8})(?:\.(\d{1,6}))?$/u.exec(value);
  if (!decimal) throw invalidShadowSpend();
  return BigInt(decimal[1]) * 1_000_000n + BigInt((decimal[2] ?? '').padEnd(6, '0'));
}

function dayOf(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::\d\d)?)$/u.test(value)) throw invalidShadowSpend();
  const parsed = new Date(value.replace(' ', 'T').replace(/([+-]\d\d)$/u, '$1:00'));
  if (!Number.isFinite(parsed.getTime())) throw invalidShadowSpend();
  return parsed.toISOString().slice(0, 10);
}

/** Apply the same accounting rules as loadMeteredDataSpend to the dump stream. */
export function recordShadowSpend(daily, name, row) {
  let at, spent, unknown = 0;
  if (name === 'dataforseo_request_charges') {
    if (row.provider_cost_usd === null) return;
    at = row.reserved_at;
    spent = micros(row.provider_cost_usd);
  } else {
    if ((name === 'archive_runs' ? row.integration : row.provider) !== METERED_DATA_PROVIDER
      || (name === 'research_log' && row.actor === RESEARCH_COLLECTOR_ACTOR)) return;
    at = name === 'archive_runs' ? row.requested_at : row.bought_at;
    if (row.cost_state === 'unknown' && row.cost_usd === null) { spent = 0n; unknown = 1; }
    else if (row.cost_state === 'reported' || row.cost_state === 'estimated') spent = micros(row.cost_usd);
    else throw invalidShadowSpend();
    if (name === 'archive_runs' && row.dataforseo_cost_accounted_usd !== undefined) spent -= micros(row.dataforseo_cost_accounted_usd);
  }
  if (spent < 0n) throw invalidShadowSpend();
  if (spent === 0n && unknown === 0) return;
  const day = dayOf(at), asset = row.asset_id;
  if ((asset === null && name !== 'research_log') || (asset !== null && (typeof asset !== 'string' || asset.length > ASSET_ID_MAX || !ASSET_ID_RE.test(asset)))) throw invalidShadowSpend();
  const key = JSON.stringify([day, asset]);
  const total = daily.get(key) ?? { day, asset, micros: 0n, unknown: 0 };
  total.micros += spent;
  total.unknown += unknown;
  daily.set(key, total);
  if (daily.size > MAX_DAILY_TOTALS) throw invalidShadowSpend();
}

export function shadowSpendRows(daily) {
  return [...daily.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, { day, asset, micros, unknown }]) => {
      const usd = `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
      return { day, asset, usd, unknown };
    });
}

export function checkShadowSpendRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_DAILY_TOTALS) throw invalidShadowSpend();
  const keys = new Set();
  for (const row of rows) {
    if (!row || Object.keys(row).length !== 4 || typeof row.day !== 'string' || !DAY.test(row.day) || !isCalendarDate(row.day)
      || (row.asset !== null && (typeof row.asset !== 'string' || row.asset.length > ASSET_ID_MAX || !ASSET_ID_RE.test(row.asset)))
      || typeof row.usd !== 'string' || !/^\d{1,20}\.\d{6}$/u.test(row.usd)
      || !Number.isSafeInteger(row.unknown) || row.unknown < 0 || row.unknown >= 2 ** 31) throw invalidShadowSpend();
    const key = JSON.stringify([row.day, row.asset]);
    if (keys.has(key)) throw invalidShadowSpend();
    keys.add(key);
  }
  return rows;
}
