// runner/startup-report.mjs — two notes the runner writes once, after the
// runtime is up, from the OS's own answers: which provider credentials still
// resolve from the environment file, and which settings still read from a file
// rather than the store. Never fatal and never a health check.

import { CONFIG } from './config.mjs';
import { log } from './log.mjs';
import { operatorToken } from './operator-token.mjs';

// Which providers are still on the environment file. A provider credential is
// entered in the product and kept encrypted in the store; a binding in
// `.dev.secrets.json` is the legacy fallback. Both work, so nothing here is a
// warning, but "which half am I on" is invisible until something breaks, so
// the runner says it once, at startup, from the Tower's
// `/api/integrations/providers` (names and metadata only — no value crosses).

/** Where this machine's Tower serves the credential summaries. */
export function integrationProvidersUrl(config) {
  return `http://127.0.0.1:${config.towerPort}/api/integrations/providers`;
}

/**
 * The one startup line, or null when there is nothing worth saying (no provider
 * is connected at all — a first run, which the Integrations page itself
 * explains far better than a log line could).
 */
export function legacyEnvLine(payload) {
  const providers = payload?.providers ?? [];
  const connected = providers.filter(
    (entry) => entry?.credential?.source === 'env' || entry?.credential?.source === 'store',
  );
  if (connected.length === 0) return null;
  const onEnv = connected
    .filter((entry) => entry.credential.source === 'env')
    .map((entry) => entry.provider?.id ?? entry.provider)
    .filter((id) => typeof id === 'string');
  if (onEnv.length === 0) {
    return `credentials: all ${connected.length} connected provider(s) resolve from the store`;
  }
  return (
    `credentials: ${onEnv.length} of ${connected.length} still resolve from the environment file ` +
    `(${onEnv.join(', ')}) — Import them on /integrations`
  );
}

/** Say it once, after the runtime is up. Never fatal: this is a note about how
 * the install is configured, not a health check. */
export async function reportLegacyEnvCredentials(runtime, deps = {}) {
  const {
    emit = log,
    url = integrationProvidersUrl(CONFIG),
    fetchImpl = fetch,
    ready = () => runtime.running && runtime.ready,
  } = deps;
  if (!ready()) return null;
  let payload;
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    // The Tower not answering yet is its own visible condition elsewhere; one
    // more line about it here would be noise.
    return null;
  }
  const line = legacyEnvLine(payload);
  if (line !== null) emit('INFO', line);
  return line;
}

// Which config this install is reading. A setting lives in the store; the
// files are the seed and the export. Until `pnpm config:seed` runs, every read
// falls back to the copy compiled into the Workers — correct, and invisible —
// so the runner says it once, at startup.

/** Where the ingest answers for the config store. */
export function configDocumentsUrl(config) {
  return `http://${config.ingestHost}:${config.ingestPort}/api/config-documents`;
}

/**
 * The one startup line, or null when there is nothing worth saying.
 *
 * Three states, one sentence each: no table (name the migration), nothing seeded
 * (name the command), partly seeded (name the files still on the file). A fully
 * seeded install says so in one short line rather than nothing at all, because
 * "the store is the source of truth here" is the fact a reader of the log is
 * actually trying to establish.
 */
export function configStoreLine(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  if (payload.ready !== true) {
    return `config: the store has no config_documents table yet — apply migration 0029, then pnpm config:seed`;
  }
  const unseeded = Array.isArray(payload.unseeded) ? payload.unseeded : [];
  const seeded = Array.isArray(payload.documents) ? payload.documents.length : 0;
  if (seeded === 0) {
    return 'config: nothing is seeded — every setting reads from the file compiled into the Workers. Run pnpm config:seed';
  }
  if (unseeded.length === 0) {
    return `config: all ${seeded} document(s) read from the store`;
  }
  return (
    `config: ${seeded} document(s) read from the store; ${unseeded.length} still read from the file ` +
    `(${unseeded.join(', ')}) — run pnpm config:seed`
  );
}

/** Say it once, after the runtime is up. Never fatal: this is a note about how
 * the install is configured, not a health check. */
export async function reportConfigStore(runtime, deps = {}) {
  const {
    emit = log,
    url = configDocumentsUrl(CONFIG),
    fetchImpl = fetch,
    readToken = operatorToken,
    ready = () => runtime.running && runtime.ready,
  } = deps;
  if (!ready()) return null;
  const token = await readToken();
  if (!token) return null;
  let payload;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }
  const line = configStoreLine(payload);
  if (line !== null) emit('INFO', line);
  return line;
}
