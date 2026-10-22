import { APP_RELEASE_HEADER, APP_RELEASE_PATH, compiledAppRelease, validAppRelease } from '@shared/app-release';
import type { ApiTransport } from './api';

export type AppReleaseState = 'current' | 'changed' | 'unavailable' | 'read-only';
export class AppReleaseError extends Error {
  constructor() { super('Open the updated app to continue.'); this.name = 'AppReleaseError'; }
}

/** One document lifetime, outside workspace/session state. A version change
 * never remounts editors, stores drafts, grants access or retries an action. */
export function createAppRelease(fetch: ApiTransport, release = compiledAppRelease()) {
  if (release !== null && !validAppRelease(release)) throw new Error('App release identity is invalid.');
  let state: AppReleaseState = 'current';
  const listeners = new Set<() => void>();
  let revision = 0;
  let differentReleaseObserved = false;
  const update = (next: AppReleaseState) => { state = next; ++revision; for (const listener of listeners) listener(); };
  const assertCurrent = () => { if (state !== 'current') throw new AppReleaseError(); };
  const transport: ApiTransport = async (input, init) => {
    const read = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() === 'GET';
    if (state !== 'read-only' || !read) assertCurrent();
    const issued = revision;
    const headers = new Headers(init?.headers);
    if (release !== null) headers.set(APP_RELEASE_HEADER, release);
    const response = await fetch(input, { ...init, headers });
    const server = response.headers.get(APP_RELEASE_HEADER);
    if (validAppRelease(server) && server !== release) differentReleaseObserved = true;
    if (issued !== revision || release !== null && server !== release) {
      if (issued === revision && (state === 'current' || state === 'read-only')) update(validAppRelease(server) ? 'changed' : 'unavailable');
      // Refusal is immediate even if a streaming body's cleanup stalls.
      void response.body?.cancel().catch(() => {});
      throw new AppReleaseError();
    }
    return response;
  };
  return Object.freeze({ fetch: transport, assertCurrent,
    captureReadable() {
      if (state !== 'current' && state !== 'read-only') throw new AppReleaseError();
      const issued = revision;
      return () => { if (revision !== issued) throw new AppReleaseError(); };
    }, enabled: release !== null,
    async check(signal?: AbortSignal) {
      assertCurrent();
      if (release === null) return;
      const response = await transport(APP_RELEASE_PATH, { headers: { accept: 'application/json' }, cache: 'no-store', signal });
      void response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error('App version could not be checked.');
    },
    async displayRecovery(signal?: AbortSignal): Promise<'resume' | 'reload' | null> {
      if (release === null || state === 'current' || state === 'read-only') return null;
      const issued = revision;
      // Confirm the current release lane and session Worker agree. A deployment
      // may have advanced again since this document first observed a mismatch.
      const response = await fetch(APP_RELEASE_PATH, { headers: { accept: 'application/json' }, cache: 'no-store', signal });
      const server = response.headers.get(APP_RELEASE_HEADER);
      if (validAppRelease(server) && server !== release) differentReleaseObserved = true;
      const candidate = response.ok && validAppRelease(server)
        && (state === 'unavailable' && !differentReleaseObserved || server !== release);
      void response.body?.cancel().catch(() => {});
      if (!candidate || signal?.aborted) return null;
      const session = await fetch('/api/session', {
        headers: { accept: 'application/json', [APP_RELEASE_HEADER]: server },
        cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', signal,
      });
      const sessionRelease = session.headers.get(APP_RELEASE_HEADER);
      if (validAppRelease(sessionRelease) && sessionRelease !== release) differentReleaseObserved = true;
      const ready = session.ok && session.headers.get(APP_RELEASE_HEADER) === server;
      void session.body?.cancel().catch(() => {});
      if (!ready || signal?.aborted || revision !== issued) return null;
      if (state === 'unavailable' && !differentReleaseObserved && server === release) { update('read-only'); return 'resume'; }
      return server !== release ? 'reload' : null;
    },
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
}
