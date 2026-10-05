import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../../../../scripts/browser-request-policy.mjs';
import { QueryClient } from '@tanstack/react-query';
import { createApi, type ApiTransport, type TowerApi } from './api';
import { createAnswerQueue, type AnswerQueue } from './answer-queue';
import { captureBrowserOwner, browserOwnerKey } from './browser-owner';
import { createOwnerStorage } from './browser-storage';
import { createHostedTaskTransport } from './hosted-task-transport';
import { createAppRelease, AppReleaseError } from './app-release';

export class BrowserRetiredError extends Error {
  constructor() { super('This browser context is no longer active.'); this.name = 'BrowserRetiredError'; }
}

interface BrowserRuntimeOptions<Answer> {
  /** Fixed entry origin and transport; neither is selected from a request. */
  origin: string;
  fetch: ApiTransport;
  appRelease?: ReturnType<typeof createAppRelease>;
  /** Replay entry may capture one visit prefix; never consult a later URL. */
  apiBase?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  page?: Window;
  sendAnswer: (api: TowerApi, answer: Answer, keepalive: boolean) => Promise<void>;
}

// Replacing the page runtime relinquishes reads, caches and drafts together,
// even before the new workspace issues a request or schedules an answer.
const pageOwners = new WeakMap<Window, () => void>();

/** A browser lifetime, not permission. The receiver freshly checks the selected
 * UUID, session and action on every request. Entry wiring must create a new
 * runtime on session/role refresh and remount its owner subtree. */
export function createBrowserRuntime<Answer>(identity: unknown, options: BrowserRuntimeOptions<Answer>) {
  const owner = captureBrowserOwner(identity);
  const origin = new URL(options.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== options.origin) throw new Error('Browser origin is invalid.');
  const apiBase = options.apiBase ?? '/api/';
  if (apiBase !== '/api/' && (owner.mode !== 'demo' || !/^\/visit\/[a-f0-9]{32}\/api\/$/u.test(apiBase))) throw new Error('Browser API base is invalid.');
  const appRelease = options.appRelease ?? createAppRelease(options.fetch);
  const transport = appRelease.fetch;
  const sendAnswer = options.sendAnswer;
  const page = options.page;
  if (typeof transport !== 'function' || typeof sendAnswer !== 'function') throw new Error('Browser transport is required.');
  const abort = new AbortController();
  let active = true;
  let retired = false;
  const assertActive = () => { if (!active) throw new BrowserRetiredError(); };
  const assertReadable = () => { if (retired) throw new BrowserRetiredError(); };
  const queries = new QueryClient({ defaultOptions: { queries: {
    retry: (count, error) => !(error instanceof AppReleaseError) && count < 1,
    refetchOnWindowFocus: false,
  } } });

  const fetch: ApiTransport = async (input, init) => {
    assertActive();
    // Named API methods supply product-local paths. There is no raw Response
    // interface: their decoding must finish before the lifetime check returns.
    if (typeof input !== 'string' || !input.startsWith('/api/')) throw new Error('Browser request target is invalid.');
    const url = new URL(input, origin);
    if (url.origin !== origin.origin || url.username || url.password || url.hash || !url.pathname.startsWith('/api/')) throw new Error('Browser request target is invalid.');
    const headers = new Headers(init?.headers);
    const selected = headers.get(WORKSPACE_SELECTION_HEADER);
    if (owner.mode === 'standalone') {
      if (selected !== null) throw new Error('Standalone requests cannot select a workspace.');
    } else {
      if (selected !== null && selected !== owner.workspaceId) throw new Error('Browser workspace selection is invalid.');
      headers.set(WORKSPACE_SELECTION_HEADER, owner.workspaceId);
    }
    const expectedSession = headers.get(WORKSPACE_SESSION_HEADER);
    if (owner.mode === 'hosted') {
      if (expectedSession !== null && expectedSession !== owner.sessionId) throw new Error('Browser session binding is invalid.');
      headers.set(WORKSPACE_SESSION_HEADER, owner.sessionId);
    } else if (expectedSession !== null) throw new Error('This browser mode cannot select a session.');
    url.pathname = `${apiBase}${url.pathname.slice('/api/'.length)}`;
    const signals = [abort.signal, ...(init?.signal ? [init.signal] : [])];
    try {
      const response = await transport(url, { ...init, headers,
        credentials: 'same-origin', mode: 'same-origin', signal: AbortSignal.any(signals) });
      if (!active) {
        void response.body?.cancel().catch(() => {});
        assertActive();
      }
      return response;
    } catch (error) {
      assertActive();
      throw error;
    }
  };
  const api = createApi(owner.mode === 'standalone' ? fetch : createHostedTaskTransport(fetch), () => {
    assertActive(); appRelease.assertCurrent();
  }, origin.origin);
  const preferences = createOwnerStorage(owner, options.storage, assertActive, assertReadable);
  let answers: AnswerQueue<Answer> | undefined;
  // Irreversible: keep the mounted view and its cached data while session
  // verification is pending, without allowing any old work to complete.
  function freeze() {
    if (!active) return;
    active = false;
    abort.abort();
    answers?.retire();
    void queries.cancelQueries();
  }
  function retire() {
    if (retired) return;
    freeze();
    retired = true;
    queries.clear();
    if (page) {
      page.removeEventListener('pagehide', retire);
      if (pageOwners.get(page) === retire) pageOwners.delete(page);
    }
  }
  if (page) {
    const previous = pageOwners.get(page);
    pageOwners.set(page, retire);
    previous?.();
    if (active && pageOwners.get(page) === retire) page.addEventListener('pagehide', retire);
    else retire();
  }
  // Register retirement before the queue's exit hook, so pagehide cancels
  // unissued answers. Sharing its page ownership also retires a legacy queue.
  answers = createAnswerQueue<Answer>(owner, (answer, keepalive) => sendAnswer(api, answer, keepalive), page);
  if (!active) answers.retire();
  return Object.freeze({ owner, ownerKey: browserOwnerKey(owner), api, queries, answers, preferences,
    /** Wrap UI completion/error/optimistic rollback callbacks in this lifetime. */
    guard<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
      return (...args: Args): Result | undefined => active ? callback(...args) : undefined;
    },
    assertReadable, freeze, retire,
  });
}
