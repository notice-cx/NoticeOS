// ingest-door.mjs — how a script on this machine reaches the central store.
//
// Operational data lives in Postgres (D25). Scripts using this transport call
// the running ingest's routes through the loopback-only door, with the
// operator bearer those routes require. They reuse the application's write
// boundary instead of opening a database connection or starting another Worker.
//
// `scripts/no-second-runtime.test.mjs` is what keeps that true as scripts are
// added (apps/tower/vite/runner-door.ts, bead ro-mad).
//
// The one exception is a script that may only run when NOTHING holds the store —
// a migration, a fixture load. Those ask `doorIsHeld()` first and refuse while
// the door answers, which is the same interlock `scripts/os-up.mjs` applies to
// itself before it starts anything.

import http from 'node:http';
import net from 'node:net';

/** The managed service's door. Same address `pnpm os:cron` fires at — the
 * loopback-only door on the Tower's dev server (apps/tower/vite/runner-door.ts),
 * pinned in scripts/runner/config.mjs CONFIG.ingestPort. */
export const MANAGED_DOOR = 'http://127.0.0.1:8791';

/**
 * The door THIS process belongs to. A dev server is told where to bind its door
 * through `OS_UP_INGEST_DOOR_HOST` / `OS_UP_INGEST_DOOR_PORT`
 * (apps/tower/vite/runner-door.ts), and the lanes inside it reach the store
 * through that same door — so they read the same two variables. Unset (every
 * CLI run by hand, the managed service's own process) it is the managed door.
 * `pnpm start` sets them, which is what keeps its Tower's Saves on its own
 * store (bead ro-ujb9.126).
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

/** Maximum response body from a loopback operator call. Long-running lanes wait
 * a long time for HEADERS; their eventual JSON answer is still tiny. */
export const LOCAL_DOOR_RESPONSE_LIMIT = 1024 * 1024;

/**
 * Fetch-compatible transport for a LONG request to the local ingest door.
 *
 * Node's built-in fetch (Undici) fails if response headers take roughly five
 * minutes. A 56-call DataForSEO panel legitimately exceeds that, so fetch can
 * sever the request after the provider has already billed calls and before the
 * family manifest is written. `node:http` has no response-header deadline unless
 * one is explicitly installed; this function deliberately installs none.
 *
 * It is not a general-purpose timeout bypass. Only literal loopback HTTP is
 * accepted, redirects are not followed, and the response remains byte-bounded.
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

/** Build one door URL. `params` values that are null or undefined are dropped,
 * so a caller can pass its whole option bag without spelling out which filters
 * the operator happened to type. */
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
 * `ran` for any other 2xx, `failed` for a non-2xx or no answer — named by the
 * door's error code when it gave one, e.g. `unknown_cron` for an expression no
 * scheduled job runs on (bead ro-ujb9.217). Never throws.
 * Over the long-request transport: a weekly collection answers after minutes.
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
 * Is a runtime holding the door — and with it the local store?
 *
 * A TCP connect, not an HTTP request, because the question is about the SOCKET.
 * Anything bound there is the workerd runtime that owns the sqlite file (or a
 * vite orphaned by one), and that is true whether it answers `/healthz`, 404s,
 * or is still booting. `scripts/os-up.mjs` asks the same question of the same
 * port before it starts anything, for the same reason (runnerArmDecision).
 *
 * `connect` is injectable so the refusal is testable without binding a port.
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

/** The operator bearer the ingest routes require. Same source `scripts/os-up.mjs`
 * reads: the gitignored dev-secrets file of this installation's home
 * (scripts/dev-secrets.mjs). */
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
 * One door request, with the failure an operator can act on.
 *
 * A door that answers nothing at all is the common case and reads as a network
 * error, so it is caught and translated: nine times in ten the OS is simply not
 * running, and "start os:up" is the whole fix. Anything non-2xx carries the
 * body, because the ingest's 400/401/422 bodies name the actual problem.
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
