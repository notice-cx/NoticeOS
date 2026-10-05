// os-deploy-forward.mjs — the local runner hands the OS's own deploys to the
// store, so the Wall feed can say "Deployed" (bead ro-trai.8).
//
// The deploy log is a file on this host (`.local/logs/deploys.jsonl`, written
// by `record()` in scripts/os-deploy.mjs), and the Tower reads only the store.
// So the runner reads the log through an `OsDeploySource` adapter and posts
// each recorded move as an annotation through the ingest's existing
// `POST /api/annotations`. The mapping is scripts/os-deploy-events.mts, shared
// with the feed that reads it back.
//
// REPLAY IS SAFE. The annotation writer is idempotent on (asset, at, kind,
// ref), so re-sending a deploy the store already holds files nothing; this
// module also remembers what it sent, so a quiet log costs one small read a
// minute and no request. A post that fails is simply retried next time.

import fs from 'node:fs/promises';
import { NO_DEPLOY_SOURCE, osDeployAnnotation } from './os-deploy-events.mjs';

export { NO_DEPLOY_SOURCE };

/** How far back a forwarder looks. A deploy older than this is history the
 * feed would never show, so a restart does not re-send the whole log. */
export const DEPLOY_FORWARD_WINDOW_DAYS = 7;

/**
 * This host's adapter: the deploy log, one JSON object per line. A missing
 * file is an install that has never deployed; a torn line is skipped, never
 * fatal — the log is evidence, and one bad line must not hide the rest.
 */
export function deployLogSource(file, fsp = fs) {
  return {
    async read() {
      let text;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const records = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          /* torn line: skipped */
        }
      }
      return records;
    },
  };
}

/** The door's annotation route. */
export function annotationsUrl(config) {
  return `http://${config.ingestHost}:${config.ingestPort}/api/annotations`;
}

/** The door's "which asset is the OS" read (beads ro-k9hf, ro-ujb9.118). */
export function osAssetUrl(config) {
  return `http://${config.ingestHost}:${config.ingestPort}/api/os-asset`;
}

/**
 * The OS's own asset id as the STORE names it (`assets.is_os`), never an id
 * written into the runner. Null when there is no token, the store cannot
 * answer, or it holds no OS row — a caller then files nothing about the OS
 * rather than guessing which asset that is. Never throws.
 */
export async function readOsAsset({ url, readToken, get = fetch }) {
  const token = await readToken().catch(() => null);
  if (!token) return null;
  try {
    const res = await get(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.asset === 'string' && body.asset !== '' ? body.asset : null;
  } catch {
    return null;
  }
}

/** What the forwarder has already had accepted, by annotation identity. */
export function createDeployForwardState() {
  return { sent: new Set() };
}

const identity = (annotation) => `${annotation.asset}\u0000${annotation.at}\u0000${annotation.ref}`;

/**
 * Send every recorded deploy inside the window that this state has not had
 * accepted yet. Returns `{ sent, pending }` — how many the store accepted this
 * pass and how many are left for the next one — or null when it could not try
 * (no token, no OS asset). Never throws for a store that is down.
 */
export async function forwardOsDeploys({
  source = NO_DEPLOY_SOURCE,
  osAsset,
  url,
  readToken,
  post = fetch,
  state = createDeployForwardState(),
  nowMs = Date.now(),
}) {
  if (!osAsset) return null;
  const cutoff = nowMs - DEPLOY_FORWARD_WINDOW_DAYS * 86_400_000;
  const due = (await source.read())
    .map((record) => osDeployAnnotation(record, osAsset))
    .filter((annotation) => annotation !== null && Date.parse(annotation.at) >= cutoff)
    .filter((annotation) => !state.sent.has(identity(annotation)));
  if (due.length === 0) return { sent: 0, pending: 0 };
  const token = await readToken().catch(() => null);
  if (!token) return null;
  let sent = 0;
  for (const annotation of due) {
    let res;
    try {
      res = await post(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(annotation),
      });
    } catch {
      break;
    }
    // 200 (already there) and 201 (filed) both mean the store holds it; a 422
    // will never be accepted, so it is not retried every minute either.
    if (res.ok || res.status === 422) {
      state.sent.add(identity(annotation));
      if (res.ok) sent += 1;
    }
  }
  return { sent, pending: due.filter((annotation) => !state.sent.has(identity(annotation))).length };
}

/**
 * What the runner runs once a minute: ask the store which asset is the OS, then
 * forward the log's deploys as that asset's annotations. One `request` carries
 * both calls, so a test drives the whole pass through one fake door. Null when
 * the store names no OS asset (or cannot be asked), exactly as for no token.
 */
export async function forwardOsDeploysToStore({
  source = NO_DEPLOY_SOURCE,
  config,
  readToken,
  request = fetch,
  state = createDeployForwardState(),
  nowMs = Date.now(),
}) {
  const osAsset = await readOsAsset({ url: osAssetUrl(config), readToken, get: request });
  return forwardOsDeploys({
    source,
    osAsset,
    url: annotationsUrl(config),
    readToken,
    post: request,
    state,
    nowMs,
  });
}
