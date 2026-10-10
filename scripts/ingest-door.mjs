// How a script on this machine reaches the central store: the running
// ingest's routes through the loopback-only door, with the operator bearer
// those routes require, instead of opening a database connection or starting
// another Worker (`scripts/no-second-runtime.test.mjs` keeps that true). A
// script that may only run when nothing holds the store asks `doorIsHeld()`
// first.

import http from 'node:http';
import net from 'node:net';

/** The managed service's door: the loopback-only door on the Tower's dev
 * server (apps/tower/vite/runner-door.ts), pinned in scripts/runner/config.mjs
 * CONFIG.ingestPort. */
export const MANAGED_DOOR = 'http://127.0.0.1:8791';

/**
 * The door this process belongs to: `OS_UP_INGEST_DOOR_HOST` /
 * `OS_UP_INGEST_DOOR_PORT`, the same two variables a dev server is told to
 * bind its door with (apps/tower/vite/runner-door.ts). Unset, it is the
 * managed door; `pnpm start` sets them so its Tower's Saves stay on its own
 * store.
 */
export function doorFromEnv(env = process.env) {
  const host = env.OS_UP_INGEST_DOOR_HOST?.trim();
  const port = env.OS_UP_INGEST_DOOR_PORT?.trim();
  if (!host && !port) return MANAGED_DOOR;
  const managed = new URL(MANAGED_DOOR);
  return `http://${host || managed.hostname}:${port || managed.port}`;
}

/** Where the ingest answers for this process. */
export const DEFAULT_DOOR = doorFromEnv();

/** Maximum response body from a loopback operator call. */
export const LOCAL_DOOR_RESPONSE_LIMIT = 1024 * 1024;

/**
 * Fetch-compatible transport for a long request to the local ingest door.
 * Node's built-in fetch fails if response headers take roughly five minutes,
 * which a weekly provider collection legitimately exceeds; `node:http` has no
 * response-header deadline unless one is installed, and this installs none.
 * Only literal loopback HTTP is accepted, redirects are not followed, and the
 * response remains byte-bounded.
 */
export function localDoorFetch(input, init = {}) {
  const url = new URL(input);
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !loopback) {
    return Promise.reject(
      new Error(`long-running door transport accepts loopback HTTP only, not ${url.origin}`),
    );
  }

  return new Promise((resolve, reject) => {
    const signal = init.signal;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const request = http.request(
      url,
      {
        method: init.method ?? 'GET',
        headers: init.headers,
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > LOCAL_DOOR_RESPONSE_LIMIT) {
            request.destroy(
              new Error(`local ingest response exceeded ${LOCAL_DOOR_RESPONSE_LIMIT} bytes`),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const item of value) headers.append(name, item);
            else if (value !== undefined) headers.set(name, value);
          }
          finish(
            resolve,
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              statusText: response.statusMessage,
              headers,
            }),
          );
        });
      },
    );
    const onAbort = () => {
      request.destroy(
        signal?.reason instanceof Error ? signal.reason : new Error('local ingest request aborted'),
      );
    };
    request.on('error', (error) => finish(reject, error));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (init.body !== undefined && init.body !== null) request.write(init.body);
    request.end();
  });
}

/** Build one door URL. `params` values that are null or undefined are
 * dropped. */
export function doorUrl(door, route, params = {}) {
  const url = new URL(route, door.endsWith('/') ? door : `${door}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Where a door fires one of the ingest's crons. The door answers
 * `/cdn-cgi/handler/scheduled` on loopback and hands it to the ingest Worker's
 * cron dispatch (apps/tower/vite/runner-door.ts, apps/tower/shared/runner-lane.ts).
 */
export function scheduledTriggerUrl(door, expr) {
  return `${new URL(door).origin}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(expr)}`;
}

/** The error code a door's JSON answer names (`{"error":"unknown_cron",…}`),
 * or null when the body names none. */
export function doorErrorCode(body) {
  try {
    const code = JSON.parse(body)?.error;
    return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * Fire one cron at a door and say what it amounted to: the dispatch's own
 * `ran` / `skipped` / `failed` (with its workflow steps) when it names one,
 * `ran` for any other 2xx, `failed` for a non-2xx or no answer, named by the
 * door's error code when it gave one. Never throws. Over the long-request
 * transport, since a weekly collection answers after minutes.
 */
export async function fireScheduledTrigger(door, expr, { fetchImpl = localDoorFetch, emit = () => {} } = {}) {
  try {
    const res = await fetchImpl(scheduledTriggerUrl(door, expr), { method: 'GET' });
    if (res.ok) {
      emit('INFO', `cron "${expr}" fired → HTTP ${res.status}`);
      const result = await res.json().catch(() => null);
      if (result && ['ran', 'skipped', 'failed'].includes(result.outcome)) {
        return { outcome: result.outcome, detail: result.detail ?? `HTTP ${res.status}`, steps: result.steps };
      }
      return { outcome: 'ran', detail: `HTTP ${res.status}` };
    }
    const code = doorErrorCode(await res.text().catch(() => ''));
    const detail = code ? `HTTP ${res.status} · ${code}` : `HTTP ${res.status}`;
    emit('ERROR', `cron "${expr}" fired → ${detail} (non-200)`);
    return { outcome: 'failed', detail };
  } catch (err) {
    emit('ERROR', `cron "${expr}" fire failed: ${err.message}`);
    return { outcome: 'failed', detail: err.message };
  }
}

/**
 * Is a runtime holding the door, and with it the local store? A TCP connect,
 * not an HTTP request, because the question is about the socket: anything
 * bound there owns the store whether it answers `/healthz`, 404s, or is
 * still booting.
 */
export function doorIsHeld(door = DEFAULT_DOOR, { timeoutMs = 1000, connect = net.connect } = {}) {
  const { hostname, port } = new URL(door);
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) });
    let settled = false;
    const finish = (held) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(held);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** The operator bearer the ingest routes require, from the gitignored
 * dev-secrets file of this installation's home (scripts/dev-secrets.mjs). */
export async function operatorToken() {
  const { readDevSecretBindings } = await import('./dev-secrets.mjs');
  const { bindings } = await readDevSecretBindings();
  const token = bindings?.OPERATOR_TOKEN;
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error(
      'OPERATOR_TOKEN is not in workers/ingest/.dev.secrets.json — local signal ' +
        'lanes reach the store through the ingest’s operator-authed routes.',
    );
  }
  return token.trim();
}

/**
 * One door request, with the failure an operator can act on: a door that
 * answers nothing usually means the OS is not running, and a non-2xx carries
 * the body, because the ingest's 400/401/422 bodies name the actual problem.
 */
export async function doorRequest(get, url, { token, ...init } = {}) {
  let response;
  try {
    response = await get(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  } catch (error) {
    throw new Error(
      `the ingest door did not answer at ${new URL(url).origin} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        'Is `pnpm os:up` running?',
    );
  }
  if (!response.ok) {
    const detail =
      typeof response.text === 'function' ? await response.text().catch(() => '') : '';
    throw new Error(
      `${new URL(url).pathname} answered HTTP ${response.status}` +
        (detail ? ` — ${detail.slice(0, 400)}` : ''),
    );
  }
  return response;
}
