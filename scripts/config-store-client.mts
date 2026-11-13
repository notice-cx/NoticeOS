// How a terminal reaches the config store: the running ingest's config
// routes, through its loopback-only door with the operator bearer, so their
// validation, version guards and audit trail hold. This client neither opens
// the database nor starts another Worker
// (`scripts/no-second-runtime.test.mjs`).

import { DEFAULT_DOOR as defaultDoor, doorFetch, doorUrl, operatorToken } from './ingest-door.mjs';

export const DEFAULT_DOOR: string = defaultDoor;

export interface ConfigStoreRequestOptions {
  door?: string;
  /** The operator bearer. Read from the dev-secrets file when omitted. */
  token?: string;
  method?: string;
  body?: unknown;
  params?: Record<string, string | null | undefined>;
  fetchImpl?: typeof fetch;
}

export interface StoredConfigSnapshotRow {
  file: string;
  version: number;
  body: object;
}

/** The routes the ingest answers for the config store (db/0029). */
export const CONFIG_DOCUMENTS_PATH = 'api/config-documents';
export const CONFIG_SEED_PATH = 'api/config-documents/seed';
export const CONFIG_APPLY_PATH = 'api/config-documents/apply';

/**
 * One request to the door, through `doorFetch`. Every answer comes back with
 * its body, because the store's own 409/422/503 bodies name the actual problem.
 */
export async function configStoreRequest(
  route: string,
  { door = DEFAULT_DOOR, token, method = 'GET', body = null, params = {}, fetchImpl = fetch }: ConfigStoreRequestOptions = {},
): Promise<{ status: number; body: unknown }> {
  const url = doorUrl(door, route, params);
  const bearer = token ?? (await operatorToken());
  const response = await doorFetch(fetchImpl, url, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: 'application/json',
      ...(body === null ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401) {
    throw new Error(
      'the ingest refused the operator token — check OPERATOR_TOKEN matches the running Worker.',
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${route} answered HTTP ${response.status} with no JSON body.`);
  }
  return { status: response.status, body: payload };
}

/** An acknowledged database snapshot for local consumers. Missing documents
 * are explicit; a failed or malformed response never authorizes a stale export. */
export async function readConfigSnapshot(options: Pick<ConfigStoreRequestOptions, 'door' | 'token' | 'fetchImpl'> = {}): Promise<Map<string, StoredConfigSnapshotRow>> {
  const { status, body } = await configStoreRequest(CONFIG_DOCUMENTS_PATH, {
    ...options, params: { bodies: '1' },
  }) as { status: number; body: { ready?: unknown; reason?: unknown; documents?: unknown } | null };
  if (status < 200 || status >= 300 || body?.ready !== true) {
    throw new Error(`Configuration database unavailable (HTTP ${status}). ${
      typeof body?.reason === 'string' ? body.reason : 'No settings were acknowledged.'}`);
  }
  if (!Array.isArray(body.documents)) throw new Error('Configuration database returned an invalid document list.');
  const documents = new Map<string, StoredConfigSnapshotRow>();
  for (const row of body.documents) {
    if (typeof row?.file !== 'string' || documents.has(row.file)
      || !Number.isSafeInteger(row.version) || row.version < 1
      || row.body === null || typeof row.body !== 'object') {
      throw new Error('Configuration database returned an invalid document.');
    }
    documents.set(row.file, row);
  }
  return documents;
}
