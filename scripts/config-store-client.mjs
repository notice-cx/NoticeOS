// config-store-client.mjs — how a terminal reaches the config store.
//
// Operational data lives in Postgres (D25). These commands use the running
// ingest's config routes, preserving their validation, version guards and
// audit trail. They reach its loopback-only door with the required operator
// bearer; this client neither opens the database nor starts another Worker.
// `scripts/no-second-runtime.test.mjs` enforces that transport boundary.
//
// The two commands share this file rather than each carrying a copy: the door
// address, the bearer, and the sentence a caller hears when the OS is down are
// one fact each.

import { DEFAULT_DOOR, doorUrl, operatorToken } from './ingest-door.mjs';

export { DEFAULT_DOOR };

/** The routes the ingest answers for the config store (db/0029). */
export const CONFIG_DOCUMENTS_PATH = 'api/config-documents';
export const CONFIG_SEED_PATH = 'api/config-documents/seed';
export const CONFIG_APPLY_PATH = 'api/config-documents/apply';

/**
 * One request to the door, with the failure an operator can act on.
 *
 * A door that answers nothing at all is the common case and arrives as a
 * transport error: nine times in ten the OS is simply not running, and "start
 * os:up" is the whole fix. Every other answer comes back WITH ITS BODY, because
 * the store's own 409/422/503 bodies name the actual problem and this script has
 * nothing to add to them.
 */
export async function configStoreRequest(
  route,
  { door = DEFAULT_DOOR, token, method = 'GET', body = null, params = {}, fetchImpl = fetch } = {},
) {
  const url = doorUrl(door, route, params);
  const bearer = token ?? (await operatorToken());
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: 'application/json',
        ...(body === null ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new Error(
      `the ingest door did not answer at ${new URL(url).origin} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        'Is `pnpm os:up` running?',
    );
  }
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
export async function readConfigSnapshot(options = {}) {
  const { status, body } = await configStoreRequest(CONFIG_DOCUMENTS_PATH, {
    ...options, params: { bodies: '1' },
  });
  if (status < 200 || status >= 300 || body?.ready !== true) {
    throw new Error(`Configuration database unavailable (HTTP ${status}). ${
      typeof body?.reason === 'string' ? body.reason : 'No settings were acknowledged.'}`);
  }
  if (!Array.isArray(body.documents)) throw new Error('Configuration database returned an invalid document list.');
  const documents = new Map();
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
