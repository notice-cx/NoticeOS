const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One fetched document is retained as JSON; block reports retain their source scalar columns. */
export function productDataRows(archive) {
  const rows = [];
  for (const page of archive.pages ?? []) {
    const body = page?.response;
    if (!record(body) || typeof body.generatedAt !== 'string') throw new Error('Malformed product data archive');
    if (archive.report === 'metrics') {
      if (!record(body.document)) throw new Error('Missing product data document');
      rows.push({ generated_at: body.generatedAt, document_json: JSON.stringify(body.document) });
      continue;
    }
    if (!/^metrics-[a-z][a-z0-9-]*$/.test(archive.report) || !Array.isArray(body.rows)) throw new Error('Malformed product data block');
    for (const row of body.rows) {
      if (!record(row) || Object.values(row).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) throw new Error('Malformed product data row');
      rows.push({ ...row, generated_at: body.generatedAt });
    }
  }
  return rows;
}

const BLOCK_COLUMNS = {
  headline: ['signups', 'activated', 'activationPct', 'activationInstrumentedFrom', 'activationFirstWeek', 'instrumentedSignups', 'instrumentedActivated', 'maturedWeek2', 'retainedWeek2', 'week2RetentionPct', 'maturedDay30', 'retainedDay30', 'day30RetentionPct'],
  cohorts: ['signup_week', 'signups', 'activated_7d', 'activation_pct', 'activated_matured_for_week_2', 'retained_week_2', 'activated_matured_for_day_30', 'retained_day_30_window', 'activation_instrumented'],
  adoption: ['accounts', 'plan_savers', 'food_loggers', 'planners', 'recipe_savers', 'companion_weighers', 'companion_dose_loggers', 'push_users'],
  weeklyActive: ['week', 'weekly_active_users', 'users_active_2plus_days'],
  firstLogWeeks: ['week', 'signups', 'first_loggers', 'first_loggers_per_100_signups', 'is_current_week'],
  trackerDaily: ['day', 'event', 'mobile', 'desktop', 'server', 'total'],
  emailContactSync: ['failed_adds_7d', 'failed_adds_90d', 'last_failure_day'],
  firstResults: ['week', 'matured', 'any_result', 'plan', 'recipe', 'log'],
  firstResultsByIntent: ['intent', 'matured', 'any_result', 'plan', 'recipe', 'log'],
  newAccountsDaily: ['day', 'intent', 'section', 'accounts'],
  availability: ['block', 'state', 'row_count'],
  collection: ['state', 'code', 'attempted_at', 'source_generated_at', 'availability_json'],
};

export function productDataColumns(report) {
  const columns = report === 'metrics' ? ['document_json'] : BLOCK_COLUMNS[Object.keys(BLOCK_COLUMNS).find(block => report === `metrics-${block.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`)];
  return columns ? ['asset', 'report_date', 'collected_at', 'data_state', 'provider_truncated', 'generated_at', ...columns] : null;
}

/** The latest successful attempt carries only its bounded block summary, never source-document contents. */
export function productCollectionAvailability(attempt) {
  if (attempt?.state !== 'healthy' || (attempt.availability_json === undefined && attempt.source_generated_at === undefined)) return null;
  if (typeof attempt.availability_json !== 'string' || attempt.availability_json.length > 8192 ||
    typeof attempt.source_generated_at !== 'string' || !Number.isFinite(Date.parse(attempt.source_generated_at)) ||
    typeof attempt.attempted_at !== 'string' || !Number.isFinite(Date.parse(attempt.attempted_at))) throw new Error('Malformed product collection availability');
  const rows = JSON.parse(attempt.availability_json);
  if (!Array.isArray(rows) || rows.length > 10) throw new Error('Malformed product collection availability');
  const seen = new Set();
  for (const row of rows) {
    if (!record(row) || !Object.hasOwn(BLOCK_COLUMNS, row.block) || ['availability', 'collection'].includes(row.block) || seen.has(row.block) ||
      !['available', 'null', 'missing'].includes(row.state) || Object.keys(row).some(key => !['block', 'state', 'row_count'].includes(key)) ||
      (row.state === 'available' ? !Number.isSafeInteger(row.row_count) || row.row_count < 0 || row.row_count > 20_000 : row.row_count !== null)) throw new Error('Malformed product collection availability');
    seen.add(row.block);
  }
  return rows.map(row => ({ ...row, generated_at: attempt.source_generated_at, collected_at: attempt.attempted_at }));
}

/** Per-block availability supersedes the success state of an older block archive. */
export function applyProductDataAvailability(freshness, availability, attempt = null) {
  availability = productCollectionAvailability(attempt) ?? availability;
  const families = new Map(freshness.families.map(family => [family.family, family]));
  for (const row of availability ?? []) {
    if (!Object.hasOwn(BLOCK_COLUMNS, row.block) || row.block === 'availability') continue;
    const family = `product-data-metrics-${row.block.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
    const held = families.get(family) ?? { family, integration: 'product-data', report: `metrics-${row.block.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, newestReportDate: null, archives: 0, role: 'collected' };
    const previous = held.collection;
    held.collection = {
      lastAttemptAt: attempt?.attempted_at ?? row.collected_at ?? null,
      state: row.state === 'available' ? 'healthy' : 'unknown',
      reportDate: row.generated_at?.slice(0, 10) ?? null,
      failure: row.state === 'available' ? null : 'incomplete-report',
      code: row.state === 'available' ? null : 'product_data_unavailable',
      lastSuccessAt: row.state === 'available' ? row.collected_at ?? null : previous?.lastSuccessAt ?? null,
      failing: [],
    };
    if (previous?.state === 'failing' && attempt?.state !== 'healthy') held.collection = previous;
    held.availability = row.state;
    held.newestReportDate = row.generated_at?.slice(0, 10) ?? held.newestReportDate;
    families.set(family, held);
  }
  const generatedAt = availability?.[0]?.generated_at;
  const source = freshness.sources.find(row => row.integration === 'product-data');
  if (source && generatedAt) {
    source.newestReportDate = generatedAt.slice(0, 10);
    source.ageDays = Math.floor((Date.parse(freshness.refreshedAt) - Date.parse(`${source.newestReportDate}T00:00:00.000Z`)) / 86_400_000);
    source.fresh = Number.isFinite(source.ageDays) && source.ageDays >= 0 && source.ageDays <= freshness.maxAgeDays;
    freshness.fresh = freshness.sources.length > 0 && freshness.sources.every(row => row.fresh);
    freshness.stale = freshness.sources.filter(row => !row.fresh).map(row => row.key);
  }
  if (attempt?.state === 'failing') {
    for (const held of families.values()) if (held.integration === 'product-data') held.collection = {
      state: 'failing', reportDate: attempt.attempted_at?.slice(0, 10) ?? null, failure: 'provider', code: attempt.code,
      lastAttemptAt: attempt.attempted_at, lastSuccessAt: held.collection?.lastSuccessAt ?? null,
      failing: [{ reportDate: attempt.attempted_at?.slice(0, 10) ?? null, failure: 'provider', code: attempt.code }],
    };
  }
  freshness.families = [...families.values()].sort((a, b) => a.family.localeCompare(b.family));
  return freshness;
}

export function productDataSchema(report) {
  const text = new Set(['asset', 'report_date', 'collected_at', 'data_state', 'generated_at', 'document_json', 'week', 'signup_week', 'day', 'event', 'intent', 'section', 'block', 'state', 'code', 'attempted_at', 'source_generated_at', 'availability_json', 'last_failure_day', 'activationInstrumentedFrom', 'activationFirstWeek']);
  return Object.fromEntries((productDataColumns(report) ?? []).map(column => [column, column === 'provider_truncated' ? 'BOOLEAN' : text.has(column) ? 'VARCHAR' : 'DOUBLE']));
}
