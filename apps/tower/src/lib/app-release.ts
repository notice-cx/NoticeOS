import { APP_RELEASE_HEADER, APP_RELEASE_PATH, compiledAppRelease, validAppRelease } from '@shared/app-release';
import type { ApiTransport } from './api';

export type AppReleaseState = 'current' | 'changed' | 'unavailable';
export class AppReleaseError extends Error {
  constructor() { super('Open the updated app to continue.'); this.name = 'AppReleaseError'; }
}

/** One document lifetime, outside workspace/session state. A version change
 * never remounts editors, stores drafts, grants access or retries an action. */
export function createAppRelease(fetch: ApiTransport, release = compiledAppRelease()) {
  if (release !== null && !validAppRelease(release)) throw new Error('App release identity is invalid.');
  let state: AppReleaseState = 'current';
  const listeners = new Set<() => void>();
  const assertCurrent = () => { if (state !== 'current') throw new AppReleaseError(); };
  const transport: ApiTransport = async (input, init) => {
    assertCurrent();
    const headers = new Headers(init?.headers);
    if (release !== null) headers.set(APP_RELEASE_HEADER, release);
    const response = await fetch(input, { ...init, headers });
    const server = response.headers.get(APP_RELEASE_HEADER);
    if (state !== 'current' || release !== null && server !== release) {
      if (state === 'current') {
        state = validAppRelease(server) ? 'changed' : 'unavailable';
        for (const listener of listeners) listener();
      }
      // Refusal is immediate even if a streaming body's cleanup stalls.
      void response.body?.cancel().catch(() => {});
      throw new AppReleaseError();
    }
    return response;
  };
  return Object.freeze({ fetch: transport, assertCurrent, enabled: release !== null,
    async check(signal?: AbortSignal) {
      assertCurrent();
      if (release === null) return;
      const response = await transport(APP_RELEASE_PATH, { headers: { accept: 'application/json' }, cache: 'no-store', signal });
      void response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error('App version could not be checked.');
    },
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
}
