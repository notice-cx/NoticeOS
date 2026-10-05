// runner/startup-report.mjs — two notes the runner writes once, after the
// runtime is up, from the OS's own answers: which provider credentials still
// resolve from the environment file, and which settings still read from a file
// rather than the store. Never fatal and never a health check.

import { CONFIG } from './config.mjs';
import { log } from './log.mjs';
import { operatorToken } from './operator-token.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// WHICH PROVIDERS ARE STILL ON THE ENVIRONMENT FILE (bead `ro-vu8d.5`)
//
// Since D21 a provider credential is entered in the product and kept encrypted
// in the store; a binding in `.dev.secrets.json` is the LEGACY fallback for
// installs that have not moved. Both work, so nothing here is a warning — but
// "which half am I on" is invisible until something breaks, and a fresh install
// that still needs six env secrets has not actually got the property the epic
// promises.
//
// So the runner says it once, at startup, from the OS's own answer: the Tower's
// `/api/integrations/providers`, which serves the ingest's credential summaries
// (names and metadata only — no value crosses, here or anywhere).
// ─────────────────────────────────────────────────────────────────────────────

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
    `(${onEnv.join(', ')}) — Import them on /integrations, or run pnpm dev:secrets:import`
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

// ─────────────────────────────────────────────────────────────────────────────
// WHICH CONFIG THIS INSTALL IS READING (epic `ro-syok`, db/0029).
//
// Since 0029 a setting can live in the store, which is what lets a deployed
// Tower save one. The files are the seed and the export; until `pnpm config:seed`
// runs, every read falls back to the copy compiled into the Workers — correct,
// and completely invisible. So the runner says it once, at startup, in the same
// spirit as the credentials line above: a Save that lands in a file rather than
// the store is a different OS from the one the docs describe, and the operator
// should not have to discover which one they have by testing it.
// ─────────────────────────────────────────────────────────────────────────────

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
