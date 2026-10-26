import { archiveCollectedDump, archiveDumpFailure, type SignalDumpOutcome } from './signal-dumps.js';
import { boundedResponseJson, SignalError } from './signal-store.js';
import { isRecord } from './shared.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 20_000;
const TIMEOUT_MS = 30_000;
const BLOCKS = ['headline', 'cohorts', 'adoption', 'weeklyActive', 'firstLogWeeks', 'trackerDaily',
  'emailContactSync', 'firstResults', 'firstResultsByIntent', 'newAccountsDaily'] as const;

type Scalar = string | number | boolean | null;
export interface ProductDataReport {
  report: string;
  response: Record<string, unknown>;
  rows: number;
}

function flatRow(value: unknown): Record<string, Scalar> {
  if (!isRecord(value) || Object.keys(value).length > 64) throw new Error('product data row must be a bounded object');
  const row: Record<string, Scalar> = {};
  for (const [key, cell] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || ['asset', 'report_date', 'collected_at', 'data_state', 'provider_truncated', 'generated_at'].includes(key)) {
      throw new Error('product data row has an unsupported column');
    }
    if (cell !== null && typeof cell !== 'string' && typeof cell !== 'boolean' && typeof cell !== 'number') throw new Error('product data rows must contain scalar values');
    if (typeof cell === 'number' && (!Number.isFinite(cell) || cell < 0)) throw new Error('product data numbers must be finite and nonnegative');
    if (typeof cell === 'string' && cell.length > 4096) throw new Error('product data cell exceeds its limit');
    row[key] = cell;
  }
  return row;
}

/** Archive the source document and named aggregate blocks without deriving rates or filling missing counts. */
export function productDataReports(value: unknown, nowMs: number): { generatedAt: string; reports: ProductDataReport[] } {
  if (!isRecord(value) || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error('product data needs generatedAt');
  const generatedMs = Date.parse(value.generatedAt);
  if (generatedMs > nowMs + 5 * 60_000) throw new Error('product data generatedAt is in the future');
  const generatedAt = new Date(generatedMs).toISOString();
  const reports: ProductDataReport[] = [{ report: 'metrics', response: { generatedAt, document: value }, rows: 1 }];
  const availability: Record<string, Scalar>[] = [];
  let totalRows = 0;
  for (const block of BLOCKS) {
    const present = Object.hasOwn(value, block);
    const source = value[block];
    const available = present && source !== null;
    const rows = available ? (Array.isArray(source) ? source : [source]).map(flatRow) : [];
    totalRows += rows.length;
    if (totalRows > MAX_ROWS) throw new Error('product data exceeds its row limit');
    availability.push({ block, state: available ? 'available' : present ? 'null' : 'missing', row_count: available ? rows.length : null });
    reports.push({ report: `metrics-${block.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, response: { generatedAt, rows }, rows: rows.length });
  }
  reports.push({ report: 'metrics-availability', response: { generatedAt, rows: availability }, rows: availability.length });
  return { generatedAt, reports };
}

export async function collectProductData(
  env: IngestEnv, asset: string, url: string, token: string,
  fetchImpl: typeof fetch = fetch, nowMs: number = Date.now(),
): Promise<SignalDumpOutcome[]> {
  const requestedAt = new Date(nowMs).toISOString();
  const target = { asset, integration: 'product-data' as const, credentialRef: `asset:${asset}`, propertyRef: url };
  let metadataAttempted = false;
  let acquired = false;
  let sourceGeneratedAt: string | null = null;
  let availabilityJson: string | null = null;
  const collectionReport = async (state: 'healthy' | 'failing', code: string | null) => {
    metadataAttempted = true;
    const outcome = await archiveCollectedDump(env, {
      provider: 'asset', target, report: 'metrics-collection', reportDate: requestedAt.slice(0, 10), requestedAt, dataState: 'provider-snapshot',
      collected: { pages: [{ request: { url }, response: { generatedAt: requestedAt, rows: [{ state, code, attempted_at: requestedAt, source_generated_at: state === 'healthy' ? sourceGeneratedAt : null, availability_json: state === 'healthy' ? availabilityJson : null }] } }], providerRows: 1, providerTruncated: false },
    });
    if (outcome.status === 'error') throw new Error('Product data collection metadata failed.');
    return outcome;
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let payload: unknown;
    try {
      const response = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'error', signal: controller.signal });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`product data endpoint returned ${response.status}`);
      }
      payload = await boundedResponseJson(response, 'Product data', MAX_BYTES);
    } finally {
      clearTimeout(timeout);
    }
    const { generatedAt, reports } = productDataReports(payload, nowMs);
    acquired = true;
    sourceGeneratedAt = generatedAt;
    availabilityJson = JSON.stringify(reports.find(report => report.report === 'metrics-availability')!.response.rows);
    const outcomes: SignalDumpOutcome[] = [];
    for (const report of reports) {
      const outcome = await archiveCollectedDump(env, {
        provider: 'asset', target,
        report: report.report, reportDate: generatedAt.slice(0, 10), requestedAt, dataState: 'provider-snapshot',
        collected: { pages: [{ request: { url }, response: report.response }], providerRows: report.rows, providerTruncated: false },
      });
      if (outcome.status === 'error') throw new Error('Product data archive failed.');
      outcomes.push(outcome);
    }
    outcomes.push(await collectionReport('healthy', null));
    return outcomes;
  } catch (error) {
    const failure = error instanceof SignalError ? error : new SignalError(acquired ? 'product_data_archive_failed' : 'product_data_failed',
      error instanceof Error && error.message.startsWith('product data') ? error.message : 'Product data collection failed.');
    // A store failure can also prevent its failure record; preserve the original error in that case.
    try {
      await archiveDumpFailure(env.STORE, { target, report: 'metrics', reportDate: requestedAt.slice(0, 10), requestedAt,
        dataState: 'provider-snapshot', error: failure, knownZeroCost: true });
    } catch { /* The original failure remains authoritative. */ }
    if (!metadataAttempted) {
      try { await collectionReport('failing', failure.code); }
      catch { /* Metadata cannot be retried recursively when its store is unavailable. */ }
    }
    throw failure;
  }
}
