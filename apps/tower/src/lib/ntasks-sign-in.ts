import type { TaskChoiceKey } from "@noticeos/contract/task-choices";
import type { TaskResolution } from "@noticeos/contract/task-resolution";
import { ApiError } from "@/lib/api";

// A person's own sign-in to the installation's Ntasks, held in their browser.
// The Tower is a connected app of that Ntasks (Ntasks docs/sign-in.md,
// "Connected apps"): this page runs the authorization code flow with PKCE as
// a public client, keeps the person's tokens in this browser's storage and
// sends their decisions to Ntasks itself. The Tower's server never sees these
// tokens and never vouches for a person; it keeps the installation's service
// credential for the machine reads and writes (vite/task-service-lane.ts).

/** The first Ntasks HTTP API version whose connected-app tokens act as the person. */
export const NTASKS_API_VERSION = 2;
/** Where Ntasks sends the browser back after sign-in; registered in Ntasks as the app's redirect address. */
export const SIGNED_IN_PATH = "/tasks/signed-in";
const SCOPE = "tasks:read tasks:write tasks:decide offline_access";
/** The sign-in in progress, in this tab only: its PKCE verifier never outlives the tab. */
const PENDING_KEY = "noticeos:ntasks-sign-in";
/** An access token this close to its end is refreshed before it is sent. */
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_LIFETIME_S = 3600;

export interface NtasksApp {
  readonly origin: string;
  readonly clientId: string;
}

/** The person's tokens for one app, as this browser keeps them. */
export interface PersonTokens {
  readonly access: string;
  readonly refresh: string | null;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  /** The person's name in Ntasks, as `GET /api/access/me` answers it. */
  readonly name: string | null;
}

/** The Tower's per-browser storage (`useOwnerPreferences`). */
export interface TokenStorage {
  read(name: string): string | null;
  write(name: string, value: string): void;
  forget(name: string): void;
}

type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface PersonState {
  readonly signedIn: boolean;
  readonly name: string | null;
}

/** A person's call refused because they are not signed in, or Ntasks no longer takes their sign-in. */
export class NtasksSignedOut extends ApiError {
  constructor() {
    super("Sign in to Ntasks again; nothing was sent.", 401, "signed_out");
    this.name = "NtasksSignedOut";
  }
}

/** The address Ntasks returns the browser to, for a Tower served at `towerOrigin`. */
export function returnAddress(towerOrigin: string): string {
  return `${towerOrigin}${SIGNED_IN_PATH}`;
}

const tokensName = (app: NtasksApp) => `ntasks-person:${app.origin}:${app.clientId}`;
/** The token audience Ntasks issues for: its MCP endpoint, as docs/sign-in.md names it. */
const resourceOf = (app: NtasksApp) => `${app.origin}/api/mcp`;

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function randomText(crypto: Crypto, length = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(length)));
}

/** A UUID where `randomUUID` is missing (a page on plain HTTP). */
function idempotencyKey(crypto: Crypto): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  try { return record(await response.json()) ?? {}; } catch { return {}; }
}

function readTokens(value: string | null): PersonTokens | null {
  if (value === null) return null;
  try {
    const parsed = record(JSON.parse(value));
    if (typeof parsed?.access !== "string" || typeof parsed.expiresAt !== "number") return null;
    return { access: parsed.access, refresh: typeof parsed.refresh === "string" ? parsed.refresh : null,
      expiresAt: parsed.expiresAt, name: typeof parsed.name === "string" ? parsed.name : null };
  } catch {
    return null;
  }
}

/** A token endpoint answer as tokens, or null when it is not one. */
function grantedTokens(answer: Record<string, unknown>, nowMs: number, previous: PersonTokens | null): PersonTokens | null {
  if (typeof answer.access_token !== "string" || answer.access_token === "") return null;
  const lifetime = typeof answer.expires_in === "number" && answer.expires_in > 0 ? answer.expires_in : DEFAULT_LIFETIME_S;
  return { access: answer.access_token, expiresAt: nowMs + lifetime * 1000,
    refresh: typeof answer.refresh_token === "string" ? answer.refresh_token : previous?.refresh ?? null, name: previous?.name ?? null };
}

/** What the browser keeps between sending the person to Ntasks and their return. */
interface PendingSignIn {
  origin: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
  state: string;
  returnTo: string;
}

function readPending(session: SessionStore): PendingSignIn | null {
  try {
    const parsed = record(JSON.parse(session.getItem(PENDING_KEY) ?? "null"));
    const keys = ["origin", "clientId", "redirectUri", "verifier", "state", "returnTo"] as const;
    return parsed && keys.every((key) => typeof parsed[key] === "string") ? parsed as unknown as PendingSignIn : null;
  } catch {
    return null;
  }
}

export interface StartOptions {
  /** The Tower's own origin, which Ntasks returns the browser to. */
  towerOrigin: string;
  /** The Tower address to open once signed in. */
  returnTo: string;
  session?: SessionStore;
  fetch?: typeof globalThis.fetch;
  crypto?: Crypto;
}

/**
 * The address to send the person's browser to: Ntasks's authorization
 * endpoint with this sign-in's PKCE challenge and state, kept in this tab
 * until they return. Refused before anything is kept when this Ntasks answers
 * an older API than connected apps need, or does not answer this page at all,
 * which is what it does for a Tower it has no connected app for.
 */
export async function startSignIn(app: NtasksApp, options: StartOptions): Promise<string> {
  const crypto = options.crypto ?? globalThis.crypto;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const session = options.session ?? window.sessionStorage;
  if (!crypto?.subtle) throw new Error("Signing in to Ntasks needs this Tower on https or a localhost address.");
  let version: unknown;
  try {
    const answer = await fetchImpl(`${app.origin}/api/version`, { headers: { accept: "application/json" } });
    version = answer.ok ? (await bodyOf(answer)).version : null;
  } catch {
    throw new Error(`${app.origin} did not answer this Tower. In Ntasks, register it under Settings → Connected apps with the address ${returnAddress(options.towerOrigin)}.`);
  }
  if (typeof version !== "number" || version < NTASKS_API_VERSION) {
    throw new Error(`${app.origin} is older than the Tower needs for signing in. Update Ntasks to API version ${NTASKS_API_VERSION} or later.`);
  }
  const verifier = randomText(crypto, 48);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const pending: PendingSignIn = { origin: app.origin, clientId: app.clientId, redirectUri: returnAddress(options.towerOrigin),
    verifier, state: randomText(crypto), returnTo: options.returnTo };
  session.setItem(PENDING_KEY, JSON.stringify(pending));
  const query = new URLSearchParams({ response_type: "code", client_id: app.clientId, redirect_uri: pending.redirectUri,
    scope: SCOPE, state: pending.state, code_challenge: challenge, code_challenge_method: "S256", resource: resourceOf(app) });
  return `${app.origin}/api/auth/oauth2/authorize?${query}`;
}

export interface FinishOptions {
  session?: SessionStore;
  /** The holder for the app the sign-in began with, which keeps the tokens. */
  sessionFor: (app: NtasksApp) => PersonSession;
}

/**
 * On the return address: exchange Ntasks's code for the person's tokens and
 * hand them to the app's holder. The state must be the one this tab sent,
 * and the sign-in in progress is forgotten whatever the outcome.
 */
export async function finishSignIn(search: string, options: FinishOptions): Promise<{ returnTo: string }> {
  const session = options.session ?? window.sessionStorage;
  const pending = readPending(session);
  session.removeItem(PENDING_KEY);
  const params = new URLSearchParams(search);
  if (pending === null || params.get("state") !== pending.state) throw new Error("This sign-in was not started from this tab. Sign in to Ntasks again.");
  const refused = params.get("error");
  if (refused !== null) throw new Error(refused === "access_denied" ? "Ntasks was not allowed to sign this Tower in." : `Ntasks refused the sign-in (${refused}).`);
  const code = params.get("code");
  if (!code) throw new Error("Ntasks sent no sign-in code. Sign in to Ntasks again.");
  await options.sessionFor({ origin: pending.origin, clientId: pending.clientId }).exchange({ code, verifier: pending.verifier, redirectUri: pending.redirectUri });
  return { returnTo: pending.returnTo };
}

/** One person's sign-in to one app, in this browser. */
export interface PersonSession {
  readonly app: NtasksApp;
  /** The same object until the sign-in changes. */
  snapshot(): PersonState;
  subscribe(listener: () => void): () => void;
  /** Read the kept tokens again, as after another tab changed them. */
  reload(): void;
  exchange(grant: { code: string; verifier: string; redirectUri: string }): Promise<void>;
  /** A current access token: refreshed once when the kept one has expired, null once signed out.
   * Throws, keeping the sign-in, when Ntasks did not answer the refresh. */
  token(): Promise<string | null>;
  /** One API call as the person. A 401 signs them out and throws `NtasksSignedOut`. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** The Ntasks project id holding a task, by the prefix of its id, and the
   * workspace this sign-in reaches, as Ntasks names them for it. */
  projectIdOf(taskId: string): Promise<{ projectId: string; workspaceId: string | null }>;
  /** Forget the tokens in this browser; revoking stays on Ntasks's own Connected apps page. */
  signOut(): void;
}

export interface SessionOptions {
  storage: TokenStorage;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function createPersonSession(app: NtasksApp, options: SessionOptions): PersonSession {
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let tokens = readTokens(options.storage.read(tokensName(app)));
  let state: PersonState = { signedIn: tokens !== null, name: tokens?.name ?? null };
  let refreshing: Promise<PersonTokens | null> | null = null;
  let projects: Promise<{ byPrefix: ReadonlyMap<string, string>; workspaceId: string | null }> | null = null;

  function keep(next: PersonTokens | null) {
    tokens = next;
    if (next === null) { options.storage.forget(tokensName(app)); projects = null; } else options.storage.write(tokensName(app), JSON.stringify(next));
    const signedIn = next !== null, name = next?.name ?? null;
    if (state.signedIn === signedIn && state.name === name) return;
    state = { signedIn, name };
    for (const listener of [...listeners]) listener();
  }

  /** The token endpoint's answer: its body when it granted, null when it
   * refused, or "unanswered" when it did not answer or answered 429 or 5xx,
   * which says nothing about the grant. */
  async function grant(fields: Record<string, string>): Promise<Record<string, unknown> | null | "unanswered"> {
    let response: Response;
    try {
      response = await fetchImpl(`${app.origin}/api/auth/oauth2/token`, { method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: app.clientId, resource: resourceOf(app), ...fields }).toString() });
    } catch {
      return "unanswered";
    }
    if (response.ok) return bodyOf(response);
    return response.status === 429 || response.status >= 500 ? "unanswered" : null;
  }

  /** Fresh tokens, or null when Ntasks refused the refresh. A refresh Ntasks
   * did not answer keeps the sign-in and throws, so the call can be sent again. */
  async function refreshed(current: PersonTokens): Promise<PersonTokens | null> {
    if (current.refresh === null) return null;
    const answer = await grant({ grant_type: "refresh_token", refresh_token: current.refresh });
    if (answer === "unanswered") throw new ApiError(`${app.origin} did not renew the sign-in; nothing was sent. Try again.`, 0, "task_service_unreachable");
    return answer === null ? null : grantedTokens(answer, now(), current);
  }

  const session: PersonSession = {
    app,
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload() {
      const kept = readTokens(options.storage.read(tokensName(app)));
      if (kept?.access === tokens?.access && kept?.name === tokens?.name) return;
      tokens = kept;
      projects = null;
      const signedIn = kept !== null, name = kept?.name ?? null;
      if (state.signedIn === signedIn && state.name === name) return;
      state = { signedIn, name };
      for (const listener of [...listeners]) listener();
    },
    async exchange({ code, verifier, redirectUri }) {
      const answer = await grant({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
      if (answer === "unanswered") throw new Error(`${app.origin} did not answer the sign-in. Sign in to Ntasks again.`);
      const granted = answer === null ? null : grantedTokens(answer, now(), null);
      if (granted === null) throw new Error("Ntasks did not accept the sign-in code. Sign in to Ntasks again.");
      let name: string | null = null;
      try {
        const me = await fetchImpl(`${app.origin}/api/access/me`, { headers: { accept: "application/json", authorization: `Bearer ${granted.access}` } });
        const said = me.ok ? (await bodyOf(me)).name : null;
        name = typeof said === "string" && said !== "" ? said : null;
      } catch { /* The name only labels the sign-in; the tokens are what sign it. */ }
      keep({ ...granted, name });
    },
    async token() {
      const current = tokens;
      if (current === null) return null;
      if (now() < current.expiresAt - EXPIRY_MARGIN_MS) return current.access;
      refreshing ??= refreshed(current).finally(() => { refreshing = null; });
      const next = await refreshing;
      // Another tab may have signed out, or refreshed first, while this one
      // waited: what is stored then wins over this refresh.
      const stored = readTokens(options.storage.read(tokensName(app)));
      if (tokens === current && stored?.access === current.access) keep(next);
      else session.reload();
      return tokens?.access ?? null;
    },
    async request(path, init = {}) {
      const access = await session.token();
      if (access === null) throw new NtasksSignedOut();
      const response = await fetchImpl(`${app.origin}${path}`, { ...init,
        headers: { accept: "application/json", ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${access}` } });
      if (response.status === 401) {
        if (tokens?.access === access) keep(null);
        throw new NtasksSignedOut();
      }
      return response;
    },
    projectIdOf(taskId) {
      projects ??= (async () => {
        const [listing, me] = await Promise.all([session.request("/api/tasks/projects"), session.request("/api/access/me")]);
        const listed = listing.ok ? (await bodyOf(listing)).projects : null;
        if (!Array.isArray(listed)) throw new ApiError("Ntasks did not list its projects for this sign-in.", listing.status);
        const workspaceId = me.ok ? record((await bodyOf(me)).app)?.workspaceId : null;
        return { workspaceId: typeof workspaceId === "string" ? workspaceId : null, byPrefix: new Map(listed.flatMap((value) => {
          const entry = record(value);
          return typeof entry?.prefix === "string" && typeof entry.projectId === "string" ? [[entry.prefix.toLowerCase(), entry.projectId] as const] : [];
        })) };
      })().catch((error: unknown) => { projects = null; throw error; });
      const prefix = taskId.slice(0, Math.max(0, taskId.indexOf("-"))).toLowerCase();
      return projects.then(({ byPrefix, workspaceId }) => {
        const found = byPrefix.get(prefix);
        if (found === undefined) throw new ApiError(`No Ntasks project this sign-in reaches holds ${taskId}.`, 404, "unknown_project");
        return { projectId: found, workspaceId };
      });
    },
    signOut() { keep(null); },
  };
  return session;
}

/** How a write ends when the person's call was sent. */
export interface PersonWriteOptions {
  keepalive?: boolean;
  /** The Tower's site scope a page passes along; Ntasks finds the project by the task's id. */
  project?: string;
}
export interface PersonCloseOptions extends PersonWriteOptions {
  resolution?: TaskResolution;
  duplicateOf?: string;
}

/** The person's decisions, with the same calls the Tower's own API offers for them. */
export interface PersonDecisions {
  respondToTask(id: string, response: string, options?: PersonWriteOptions): Promise<void>;
  chooseOnTask(id: string, option: TaskChoiceKey, note?: string, options?: PersonWriteOptions): Promise<void>;
  dismissTask(id: string, reason?: string, options?: PersonCloseOptions): Promise<void>;
  resolveGate(id: string, reason?: string, options?: PersonWriteOptions): Promise<void>;
  disputeTask(id: string, options?: PersonWriteOptions): Promise<void>;
}

/** Where the Tower reads a task from, with the installation's service credential. */
export interface TaskSource {
  readonly projectId: string;
  readonly workspaceId: string;
}

/**
 * `readsFrom` names the Ntasks workspace and project the Tower reads a task
 * from. A decision is sent only when the person's sign-in reaches that same
 * workspace and project: a sign-in to an app registered in another workspace
 * would otherwise reach another project with the same prefix, or, after a
 * backup was loaded there, a copy with the same ids.
 */
export function personDecisions(session: PersonSession, readsFrom: (taskId: string) => TaskSource | null,
  crypto: Crypto = globalThis.crypto): PersonDecisions {
  async function decide(path: string, id: string, payload: Record<string, unknown>, options?: PersonWriteOptions): Promise<void> {
    const { projectId, workspaceId } = await session.projectIdOf(id);
    const source = readsFrom(id);
    if (source === null || source.projectId !== projectId || source.workspaceId !== workspaceId) {
      throw new ApiError(`This Ntasks sign-in reaches another workspace than the Tower reads ${id} from; register the Tower in the service credential's workspace. Nothing was sent.`,
        409, "workspace_mismatch");
    }
    let response: Response;
    try {
      response = await session.request(path, { method: "POST", ...(options?.keepalive ? { keepalive: true } : {}),
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey(crypto) },
        body: JSON.stringify({ projectId, ...payload }) });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(`${session.app.origin} did not answer; reload before sending it again.`, 0, "task_service_unreachable");
    }
    if (response.ok) return;
    const body = await bodyOf(response);
    const code = typeof body.error === "string" ? body.error : null;
    const detail = typeof body.detail === "string" && body.detail !== "" ? body.detail : null;
    throw new ApiError(detail ?? code ?? `Ntasks answered HTTP ${response.status}; nothing was sent.`, response.status, code,
      typeof body.field === "string" ? body.field : null);
  }
  const task = (id: string, action: string) => `/api/tasks/${encodeURIComponent(id)}/${action}`;
  return {
    respondToTask: (id, response, options) => decide(task(id, "respond"), id, { response }, options),
    chooseOnTask: (id, option, note, options) =>
      decide(task(id, "choose"), id, { option, ...(note === undefined || note.trim() === "" ? {} : { note }) }, options),
    dismissTask: (id, reason, options) => decide(task(id, "dismiss"), id, {
      ...(reason === undefined ? {} : { reason }),
      ...(options?.resolution === undefined || options.resolution === "wont-do" ? {} : { resolution: options.resolution }),
      ...(options?.duplicateOf === undefined ? {} : { duplicateOf: options.duplicateOf }),
    }, options),
    resolveGate: (id, reason, options) => decide(`/api/gates/${encodeURIComponent(id)}/resolve`, id, reason === undefined ? {} : { reason }, options),
    disputeTask: (id, options) => decide(task(id, "dispute"), id, {}, options),
  };
}
