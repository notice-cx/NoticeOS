import { createAppRelease, AppReleaseError } from './app-release';
import type { ApiTransport } from './api';
import { createBrowserRuntime } from './browser-runtime';
import { fetchBrowserSession, tabSelectionKey, type BrowserSession, type WorkspaceChoice } from './browser-session';
import { createBrowserAuth } from './browser-auth';
import { parseEmailEnrollmentLanding, type EmailEnrollmentLanding } from '../../../../scripts/identity-protocol.mjs';
import type { AgentAccessLanding } from '../../../../scripts/agent-access.mjs';

/** Capture at document entry, outside React's repeated effect setup. */
export function captureBrowserLanding(page: Window): EmailEnrollmentLanding {
  const landing = parseEmailEnrollmentLanding(page.location.href);
  if (landing.kind === 'enrollment') page.history.replaceState(null, '', landing.cleanUrl);
  if (landing.kind === 'invalid') page.history.replaceState(null, '', '/sign-in');
  return landing;
}

export type BrowserUiRuntime = ReturnType<typeof createBrowserRuntime<(keepalive: boolean) => Promise<void>>>;
export type BrowserEntryState = Readonly<{
  phase: 'checking' | 'ready' | 'choose' | 'agent' | 'signed-out' | 'invitation' | 'unavailable' | 'invalid-link';
  session: BrowserSession | null;
  choices: readonly WorkspaceChoice[];
  runtime: BrowserUiRuntime | null;
  label: string | null;
  loadingMore: boolean;
}>;

/** One tab enters from server facts and replaces its entire owner subtree.
 * Local storage is a selection preference, never a membership decision. */
export function createBrowserEntry(options: {
  origin: string;
  fetch: ApiTransport;
  page: Window;
  landing: EmailEnrollmentLanding;
  /** An agent asking to connect (agent-access.mts): the person signs in if
   * needed, then decides on the agent page instead of opening a workspace. */
  agent?: AgentAccessLanding;
  base?: string;
  compiledDemoWorkspace?: string;
  appRelease?: ReturnType<typeof createAppRelease>;
  onRetire?: () => void;
}) {
  const appRelease = options.appRelease ?? createAppRelease(options.fetch);
  const fetch = appRelease.fetch;
  const landing = options.landing;
  let enrollmentCompleted = false;
  let state: BrowserEntryState = Object.freeze({ phase: 'checking', session: null, choices: [], runtime: null, label: null, loadingMore: false });
  let generation = 0;
  let revision = 0;
  let disposed = false;
  let request: AbortController | null = null;
  let releaseProbe: AbortController | null = null;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const storage = (() => { try { return options.page.sessionStorage; } catch { return null; } })();
  const preferences = (() => { try { return options.page.localStorage; } catch { return null; } })();
  const set = (next: BrowserEntryState) => {
    if (disposed) return;
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  function relinquish() {
    clearTimeout(expiry);
    state.runtime?.retire();
    options.onRetire?.();
  }
  function begin(retainView = false) {
    releaseProbe?.abort(); releaseProbe = null;
    const ticket = ++revision;
    request?.abort();
    request = new AbortController();
    if (retainView && state.runtime) {
      clearTimeout(expiry);
      state.runtime.freeze();
    } else {
      relinquish();
      set({ phase: 'checking', session: null, choices: [], runtime: null, label: null, loadingMore: false });
    }
    return { ticket, signal: request.signal };
  }
  const current = (ticket: number) => !disposed && ticket === revision;
  async function readSession(settings: Parameters<typeof fetchBrowserSession>[1]) {
    try { return await fetchBrowserSession(fetch, settings); }
    // Header validation precedes decoding; a different request may observe a
    // release change while this body is still arriving.
    finally { appRelease.assertCurrent(); }
  }
  function remembered(session: { principalId: string; sessionId: string }) {
    try { return storage?.getItem(tabSelectionKey(session)) ?? undefined; } catch { return undefined; }
  }
  function remember(session: { principalId: string; sessionId: string }, selected: string) {
    try { storage?.setItem(tabSelectionKey(session), selected); } catch { /* A tab can work without storage. */ }
  }
  function ready(session: BrowserSession) {
    let owner;
    let label: string | null = null;
    if (landing.kind === 'enrollment' && !enrollmentCompleted && session.mode !== 'hosted') {
      set({ phase: 'invalid-link', session: null, choices: [], runtime: null, label: null, loadingMore: false });
      return;
    }
    if (session.mode === 'hosted') {
      if (landing.kind === 'enrollment' && !enrollmentCompleted) {
        const signedIn = session.session !== null && Date.parse(session.session.expiresAt) > Date.now();
        set({ phase: landing.enrollment.kind === 'invitation' && signedIn ? 'invitation' : 'signed-out', session, choices: [], runtime: null, label: null, loadingMore: false });
        return;
      }
      if (session.session === null) {
        set({ phase: 'signed-out', session, choices: [], runtime: null, label: null, loadingMore: false });
        return;
      }
      if (Date.parse(session.session.expiresAt) <= Date.now()) {
        set({ phase: 'signed-out', session: null, choices: [], runtime: null, label: null, loadingMore: false });
        return;
      }
      if (options.agent?.kind === 'agent') {
        set({ phase: 'agent', session, choices: session.workspaces, runtime: null, label: null, loadingMore: false });
        return;
      }
      if (session.selectedWorkspace === null) {
        set({ phase: 'choose', session, choices: session.workspaces, runtime: null, label: null, loadingMore: false });
        return;
      }
      owner = { mode: 'hosted' as const, principalId: session.session.principalId, sessionId: session.session.sessionId,
        workspaceId: session.selectedWorkspace.workspaceId, clientGeneration: ++generation };
      label = session.selectedWorkspace.displayName;
      remember(session.session, owner.workspaceId);
    } else if (session.mode === 'demo') {
      owner = { mode: 'demo' as const, workspaceId: session.workspace.workspaceId, clientGeneration: ++generation };
      label = session.workspace.displayName;
    } else if (options.compiledDemoWorkspace !== undefined) {
      // The released immutable viewer uses standalone server guards. Its
      // validated build descriptor owns its synthetic lifetime, never a person.
      owner = { mode: 'demo' as const, workspaceId: options.compiledDemoWorkspace, clientGeneration: ++generation };
    } else owner = { mode: 'standalone' as const, clientGeneration: ++generation };
    const runtime = createBrowserRuntime<(keepalive: boolean) => Promise<void>>(owner, { origin: options.origin, fetch, appRelease,
      apiBase: options.base ? `${options.base}/api/` : undefined, storage: preferences, page: options.page,
      sendAnswer: (_api, send, keepalive) => send(keepalive),
    });
    if (options.page.location.pathname === '/sign-in') options.page.history.replaceState(null, '', '/');
    set({ phase: 'ready', session, choices: session.mode === 'hosted' ? session.workspaces : [], runtime, label, loadingMore: false });
    if (session.mode === 'hosted' && session.session) {
      const remaining = Date.parse(session.session.expiresAt) - Date.now();
      expiry = setTimeout(() => void refresh(), Math.min(remaining, 2_147_483_647));
    }
  }
  async function refresh() {
    if (disposed || appRelease.snapshot() !== 'current') return;
    const probe = new AbortController();
    releaseProbe?.abort(); releaseProbe = probe;
    try {
      if (appRelease.enabled) await appRelease.check(AbortSignal.any([probe.signal, AbortSignal.timeout(10_000)]));
    }
    catch (error) {
      if (disposed || releaseProbe !== probe || probe.signal.aborted) return;
      if (!(error instanceof AppReleaseError) && state.runtime === null) set({ ...state, phase: 'unavailable' });
      return;
    }
    if (disposed || releaseProbe !== probe || probe.signal.aborted) return;
    const { ticket, signal } = begin(true);
    if (landing.kind === 'invalid') { set({ phase: 'invalid-link', session: null, choices: [], runtime: null, label: null, loadingMore: false }); return; }
    try {
      // Always identify the current person first. A shared cookie may have
      // changed; an old tab's workspace must not become the next person's default.
      let session = await readSession({ base: options.base, signal });
      if (!current(ticket)) return;
      if (session.mode === 'hosted' && session.session && !(landing.kind === 'enrollment' && !enrollmentCompleted)) {
        const selected = remembered(session.session);
        if (selected !== undefined) {
          let selectedSession;
          try { selectedSession = await readSession({ base: options.base, selected, signal }); }
          catch (error) {
            if (!(error instanceof AppReleaseError)) {
              try { storage?.removeItem(tabSelectionKey(session.session)); } catch { /* No stored selection. */ }
            }
            throw error;
          }
          if (!current(ticket)) return;
          if (!samePerson(session, selectedSession)) { void refresh(); return; }
          session = selectedSession;
        }
      }
      relinquish();
      ready(session);
    } catch (error) {
      if (current(ticket) && !(error instanceof AppReleaseError && state.runtime)) {
        relinquish();
        set({ phase: 'unavailable', session: null, choices: [], runtime: null, label: null, loadingMore: false });
      }
    }
  }
  async function choose(workspaceId: string) {
    if (appRelease.snapshot() !== 'current') return;
    const previous = state.session;
    if (disposed || previous?.mode !== 'hosted' || previous.session === null
      || !state.choices.some(item => item.workspaceId === workspaceId && item.status === 'active')) return;
    const { ticket, signal } = begin();
    try {
      const session = await readSession({ base: options.base, selected: workspaceId, signal });
      if (!current(ticket)) return;
      if (!samePerson(previous, session)) { void refresh(); return; }
      if (session.mode !== 'hosted' || session.selectedWorkspace?.workspaceId !== workspaceId) throw new Error('Workspace selection was not verified.');
      ready(session);
    } catch {
      if (current(ticket)) set({ phase: 'unavailable', session: null, choices: [], runtime: null, label: null, loadingMore: false });
    }
  }
  async function loadMore() {
    if (appRelease.snapshot() !== 'current') return;
    const previous = state;
    const session = previous.session;
    if (disposed || previous.loadingMore || session?.mode !== 'hosted' || !session.session || !session.nextCursor) return;
    const ticket = revision;
    set({ ...state, loadingMore: true });
    try {
      const next = await readSession({ base: options.base, after: session.nextCursor, signal: request?.signal,
        selected: session.selectedWorkspace?.workspaceId });
      if (!current(ticket)) return;
      if (!samePerson(session, next) || next.mode !== 'hosted'
        || JSON.stringify(next.selectedWorkspace) !== JSON.stringify(session.selectedWorkspace)) { void refresh(); return; }
      if (next.nextCursor === session.nextCursor || next.workspaces.some(item => previous.choices.some(old => old.workspaceId === item.workspaceId))) throw new Error('Workspace page is invalid.');
      set({ ...state, session: next, choices: Object.freeze([...previous.choices, ...next.workspaces]), loadingMore: false });
    } catch (error) {
      if (current(ticket)) {
        if (error instanceof AppReleaseError) set({ ...state, loadingMore: false });
        else { relinquish(); set({ phase: 'unavailable', session: null, choices: [], runtime: null, label: null, loadingMore: false }); }
      }
    }
  }
  function switchWorkspace() {
    if (appRelease.snapshot() !== 'current') return;
    const session = state.session;
    if (session?.mode !== 'hosted' || !session.session) return;
    relinquish();
    set({ phase: 'checking', session: null, choices: [], runtime: null, label: null, loadingMore: false });
    try { storage?.removeItem(tabSelectionKey(session.session)); } catch { /* No stored choice. */ }
    void refresh();
  }
  async function logout() {
    const session = state.session;
    if (session?.mode !== 'hosted' || !session.session) return;
    const { ticket, signal } = begin();
    try { await createBrowserAuth(fetch).logout(session.session.sessionId, signal); }
    catch { /* Fresh bootstrap distinguishes an ended session from a replacement. */ }
    if (current(ticket)) await refresh();
  }
  async function completeSignIn(expected?: BrowserSession) {
    const { ticket, signal } = begin();
    let verified: BrowserSession | null = expected ?? null;
    try {
      const fresh = await readSession({ base: options.base, signal });
      if (!current(ticket)) return;
      if (fresh.mode !== 'hosted' || !fresh.session || (expected && !samePerson(expected, fresh))) { await refresh(); return; }
      verified = fresh;
      if (landing.kind === 'enrollment' && !enrollmentCompleted && landing.enrollment.kind === 'invitation') {
        await createBrowserAuth(fetch).acceptInvitation(fresh.session.sessionId, landing.enrollment.id, signal);
        if (!current(ticket)) return;
      }
    } catch {
      if (current(ticket)) {
        const invitation = landing.kind === 'enrollment' && landing.enrollment.kind === 'invitation';
        set({ phase: invitation && verified?.mode === 'hosted' && verified.session ? 'invitation' : 'unavailable', session: verified, choices: [], runtime: null, label: invitation ? 'Invitation could not be accepted.' : null, loadingMore: false });
      }
      return;
    }
    // Signing in or joining does not choose a workspace, even if this session
    // previously remembered a choice in the same tab.
    try {
      const fresh = await readSession({ base: options.base, signal });
      if (!current(ticket)) return;
      if (!verified || !samePerson(verified, fresh)) { await refresh(); return; }
      if (fresh.mode === 'hosted' && fresh.session) storage?.removeItem(tabSelectionKey(fresh.session));
    } catch { if (current(ticket)) await refresh(); return; }
    enrollmentCompleted = true;
    // The agent page keeps its signed query; it leaves for the agent anyway.
    if (options.agent?.kind !== 'agent') options.page.history.replaceState(null, '', '/');
    await refresh();
  }
  async function signedIn() { await completeSignIn(); }
  async function joinInvitation() {
    if (landing.kind !== 'enrollment' || landing.enrollment.kind !== 'invitation' || enrollmentCompleted) return;
    const expected = state.session;
    if (!expected || expected.mode !== 'hosted' || !expected.session) { await refresh(); return; }
    await completeSignIn(expected);
  }
  function hidden() { releaseProbe?.abort(); request?.abort(); ++revision; relinquish(); set({ phase: 'checking', session: null, choices: [], runtime: null, label: null, loadingMore: false }); }
  const shown = () => void refresh();
  const visible = () => { if (options.page.document.visibilityState === 'visible') void refresh(); };
  options.page.addEventListener('pagehide', hidden);
  options.page.addEventListener('pageshow', shown);
  options.page.document.addEventListener('visibilitychange', visible);
  return Object.freeze({
    appRelease,
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh, choose, loadMore, switchWorkspace, logout, signedIn, joinInvitation,
    auth: createBrowserAuth(fetch),
    get enrollment() { return landing.kind === 'enrollment' && !enrollmentCompleted ? landing.enrollment : undefined; },
    /** The agent's signed query, while this tab is an agent page. */
    get agentQuery() { return options.agent?.kind === 'agent' ? options.agent.query : undefined; },
    fetch,
    dispose() {
      if (disposed) return;
      relinquish(); disposed = true; releaseProbe?.abort(); request?.abort(); ++revision; listeners.clear();
      options.page.removeEventListener('pagehide', hidden);
      options.page.removeEventListener('pageshow', shown);
      options.page.document.removeEventListener('visibilitychange', visible);
    },
  });
}

function samePerson(a: BrowserSession, b: BrowserSession) {
  return a.mode === 'hosted' && b.mode === 'hosted' && a.session !== null && b.session !== null
    && a.session.principalId === b.session.principalId && a.session.sessionId === b.session.sessionId;
}
export type BrowserEntry = ReturnType<typeof createBrowserEntry>;
