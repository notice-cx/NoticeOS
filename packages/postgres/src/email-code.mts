// Fixed identity/control-plane actions only. This entry grants no workspace
// capabilities and never exposes the maintained engine's general handler.
import { sql, type Transaction } from 'kysely';
import { isValidIP, normalizeIP, createRateLimitKey } from '@better-auth/core/utils/ip';
import { createBrowserRequestPolicy, WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import { EMAIL_CODE_PATHS, type EmailEnrollment } from '../../../scripts/identity-protocol.mjs';
import { identityEngine, openIdentityDatabase, validateIdentityOptions, UUID,
  IdentityRefused, type IdentityOptions, type IdentityDatabase, type EmailCodeMessage } from './identity-engine.mjs';

export { EMAIL_CODE_PATHS, type EmailEnrollment } from '../../../scripts/identity-protocol.mjs';
export interface EmailCodeOptions extends IdentityOptions {
  /** Supplied by a trusted outer server adapter, never a browser/RPC IP claim. */
  readonly peerAddress: string;
  /** Called only after database commit. No real sender is selected here. */
  readonly deliver: (message: EmailCodeMessage) => Promise<void>;
}
export interface EmailCodeLogin {
  requestCode(request: Request, enrollment?: EmailEnrollment): Promise<Response>;
  verifyCode(request: Request, enrollment?: EmailEnrollment): Promise<Response>;
  logout(request: Request): Promise<Response>;
  close(): Promise<void>;
}
type Action = keyof typeof EMAIL_CODE_PATHS;
const EXPECTED = {
  request: new Set(['INVALID_ORIGIN', 'MISSING_OR_NULL_ORIGIN', 'CROSS_SITE_NAVIGATION_LOGIN_BLOCKED']),
  verify: new Set(['INVALID_OTP', 'OTP_EXPIRED', 'TOO_MANY_ATTEMPTS', 'ENROLLMENT_UNAVAILABLE',
    'INVALID_ORIGIN', 'MISSING_OR_NULL_ORIGIN', 'CROSS_SITE_NAVIGATION_LOGIN_BLOCKED']),
  logout: new Set(['INVALID_ORIGIN', 'MISSING_OR_NULL_ORIGIN', 'CROSS_SITE_NAVIGATION_LOGIN_BLOCKED']),
};
interface Eligibility { readonly allowed: boolean; readonly platformId?: string; }

function reply(status: number, ok: boolean, cookies: readonly string[] = [], retryAfter?: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (retryAfter && /^\d+$/u.test(retryAfter)) headers.set('retry-after', retryAfter);
  return new Response(JSON.stringify({ ok }), { status, headers });
}

async function input(request: Request): Promise<{ email: string; otp?: string }> {
  const reader = request.body?.getReader();
  if (!reader) throw new IdentityRefused('Identity input refused');
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new IdentityRefused('Identity input refused')), 5000); });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2048) throw new IdentityRefused('Identity input refused');
      chunks.push(chunk.value);
    }
  } finally {
    clearTimeout(timeout);
    // A tee's cancellation can wait for its other branch. Observe it without
    // retaining this action or its close lifecycle indefinitely.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: { email?: unknown; otp?: unknown };
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new IdentityRefused('Identity input refused'); }
  if (!value || typeof value.email !== 'string' || value.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.email)) {
    throw new IdentityRefused('Identity input refused');
  }
  if (value.otp !== undefined && (typeof value.otp !== 'string' || !/^\d{6}$/u.test(value.otp))) throw new IdentityRefused('Identity input refused');
  return { email: value.email.toLowerCase(), ...(typeof value.otp === 'string' ? { otp: value.otp } : {}) };
}

async function eligibility(trx: Transaction<IdentityDatabase>, email: string, enrollment?: EmailEnrollment): Promise<Eligibility> {
  if (!enrollment) {
    const result = await sql<{ id: string }>`SELECT id FROM noticeos_identity.auth_user WHERE email=${email}`.execute(trx);
    return { allowed: result.rows.length === 1 };
  }
  const target = enrollment.kind === 'platform'
    ? await sql<{ workspace_id: string }>`SELECT workspace_id FROM noticeos_identity.platform_enrollment WHERE id=${enrollment.id}::uuid`.execute(trx)
    : await sql<{ workspace_id: string }>`SELECT organization_id AS workspace_id FROM noticeos_identity.auth_invitation WHERE id=${enrollment.id}::uuid`.execute(trx);
  const workspaceId = target.rows[0]?.workspace_id;
  if (!workspaceId) return { allowed: false };
  // All later invitation/provisioning lifecycle operations must use this same
  // order: organization, canonical workspace, then invitation/enrollment. Login
  // first holds its maintained rate bucket and normalized mailbox locks.
  await sql`SELECT id FROM noticeos_identity.auth_organization WHERE id=${workspaceId}::uuid FOR UPDATE`.execute(trx);
  const workspace = await sql<{ status: string }>`SELECT status FROM noticeos_identity.lock_login_workspace(${workspaceId}::uuid)`.execute(trx);
  if (enrollment.kind === 'platform') {
    const result = await sql<{ allowed: boolean }>`SELECT email=${email} AND workspace_id=${workspaceId}::uuid
      AND revoked_at IS NULL AND verified_at IS NULL AND expires_at>clock_timestamp() AS allowed
      FROM noticeos_identity.platform_enrollment WHERE id=${enrollment.id}::uuid FOR UPDATE`.execute(trx);
    const allowed = workspace.rows[0]?.status === 'provisioning' && result.rows[0]?.allowed === true;
    return { allowed, ...(allowed ? { platformId: enrollment.id } : {}) };
  }
  const result = await sql<{ allowed: boolean }>`SELECT lower(email)=${email} AND organization_id=${workspaceId}::uuid
    AND status='pending' AND role IN ('owner','operator','viewer') AND expires_at>clock_timestamp() AS allowed
    FROM noticeos_identity.auth_invitation WHERE id=${enrollment.id}::uuid FOR UPDATE`.execute(trx);
  return { allowed: workspace.rows[0]?.status === 'active' && result.rows[0]?.allowed === true };
}

/** Lazy, request-owned lifecycle: original evidence is checked before any
 * connection/query. The trusted peer and fixed action are server facts; caller
 * headers never choose a rate bucket. Close in finally after the last action. */
export function openEmailCodeLogin(options: EmailCodeOptions): EmailCodeLogin {
  options = Object.freeze({ connectionString: options.connectionString, trustedOrigin: options.trustedOrigin,
    sessionSecret: options.sessionSecret, peerAddress: options.peerAddress, deliver: options.deliver });
  const trustedOrigin = validateIdentityOptions(options);
  if (typeof options.peerAddress !== 'string' || !isValidIP(options.peerAddress) || typeof options.deliver !== 'function') {
    throw new IdentityRefused('Identity requires a trusted peer and delivery adapter');
  }
  const peer = normalizeIP(options.peerAddress);
  const policy = createBrowserRequestPolicy(trustedOrigin);
  let resources: ReturnType<typeof openIdentityDatabase> | undefined;
  let validated: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  async function operation(action: Action, request: Request, enrollment?: EmailEnrollment): Promise<Response> {
    if (!(request instanceof Request)) throw new IdentityRefused('Identity request refused');
    request = request.clone();
    if (enrollment) enrollment = Object.freeze({ kind: enrollment.kind, id: enrollment.id });
    policy.assertEffect(request);
    if (request.method !== 'POST' || new URL(request.url).pathname !== EMAIL_CODE_PATHS[action] || new URL(request.url).search) {
      throw new IdentityRefused('Identity action refused');
    }
    if (enrollment && (!['platform', 'invitation'].includes(enrollment.kind) || !UUID.test(enrollment.id))) throw new IdentityRefused('Identity enrollment refused');
    const expectedSession = action === 'logout' ? request.headers.get(WORKSPACE_SESSION_HEADER) : null;
    if (action === 'logout' && (!expectedSession || !UUID.test(expectedSession))) throw new IdentityRefused('Identity session refused');
    const body = action === 'logout' ? undefined : await input(request);
    if (action === 'verify' && !body?.otp) throw new IdentityRefused('Identity input refused');
    resources ??= openIdentityDatabase(options);
    const { database } = await resources;
    validated ??= (async () => {
      const response = await identityEngine(database, options, { transaction: true, emailCode: true, validateSchema: true }).handler(new Request(`${trustedOrigin}/api/auth/get-session`));
      if (response.status !== 200 || await response.json() !== null) throw new IdentityRefused('Identity schema refused');
    })();
    await validated;
    const mail: EmailCodeMessage[] = [];
    const result = await database.transaction().execute(async (trx) => {
      const path = EMAIL_CODE_PATHS[action].slice('/api/auth'.length);
      const bucket = createRateLimitKey(peer, path);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${bucket}, 7350))`.execute(trx);
      if (body) await sql`SELECT pg_advisory_xact_lock(hashtextextended(${body.email}, 7349))`.execute(trx);
      const eligible = body ? await eligibility(trx, body.email, enrollment) : { allowed: true };
      const engine = identityEngine(trx, options, { transaction: false, emailCode: true, validateSchema: false,
        ...(action === 'logout' ? { readOnlySession: true as const } : {}),
        peer, eligible: eligible.allowed, deliver: (message) => { mail.push(message); } });
      if (action === 'logout') {
        const session = await engine.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } });
        if (session && session.session.id !== expectedSession) throw new IdentityRefused('Identity session refused');
      }
      const headers = new Headers();
      for (const name of ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'cookie', 'user-agent']) {
        const value = request.headers.get(name); if (value !== null) headers.set(name, value);
      }
      headers.set('content-type', 'application/json'); headers.set('x-noticeos-trusted-peer', peer);
      const response = await engine.handler(new Request(`${trustedOrigin}${EMAIL_CODE_PATHS[action]}`, {
        method: 'POST', headers, body: JSON.stringify(action === 'request' ? { email: body?.email, type: 'sign-in' } : action === 'verify' ? { email: body?.email, otp: body?.otp } : {}),
      }));
      const data: unknown = await response.json();
      const code = data && typeof data === 'object' && 'code' in data ? data.code : undefined;
      if (response.status === 429) return { status: 429, ok: false, cookies: [], retryAfter: response.headers.get('x-retry-after') };
      if (response.status === 202 && action === 'request') return { status: 202, ok: true, cookies: [] };
      if (response.status !== 200) {
        if (typeof code !== 'string' || !EXPECTED[action].has(code)) throw new IdentityRefused('Identity operation failed');
        return { status: response.status, ok: false, cookies: [] };
      }
      if (action === 'verify' && eligible.platformId) {
        const user = data && typeof data === 'object' && 'user' in data ? data.user : undefined;
        const personId = user && typeof user === 'object' && 'id' in user ? user.id : undefined;
        if (typeof personId !== 'string' || !UUID.test(personId)) throw new IdentityRefused('Identity operation failed');
        await sql`UPDATE noticeos_identity.platform_enrollment SET verified_person_id=${personId}::uuid,
          verified_at=clock_timestamp() WHERE id=${eligible.platformId}::uuid`.execute(trx);
      }
      // Sign-out revokes the captured server session. Do not expire the shared
      // browser cookie: its response could arrive after another tab signs in
      // and would then erase that newer session's cookie. The revoked cookie
      // grants nothing; a later successful sign-in replaces it.
      return { status: action === 'request' ? 202 : 200, ok: true, cookies: action === 'verify' ? response.headers.getSetCookie() : [] };
    });
    // Database state is now committed. A delivery refusal must not claim that
    // the code/counters rolled back, nor expose a code in a response or log.
    try { for (const message of mail) await options.deliver(message); }
    catch { return reply(503, false); }
    return reply(result.status, result.ok, result.cookies, result.retryAfter);
  }
  function run(action: Action, request: Request, enrollment?: EmailEnrollment): Promise<Response> {
    if (closing) return Promise.reject(new IdentityRefused('Identity is closed'));
    const work = operation(action, request, enrollment).catch(() => { throw new IdentityRefused('Identity operation refused'); });
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }
  return Object.freeze({
    requestCode: (request: Request, enrollment?: EmailEnrollment) => run('request', request, enrollment),
    verifyCode: (request: Request, enrollment?: EmailEnrollment) => run('verify', request, enrollment),
    logout: (request: Request) => run('logout', request),
    close: () => {
      closing ??= (async () => { await Promise.allSettled([...pending]); if (resources) { const { database } = await resources.catch(() => ({ database: undefined })); await database?.destroy(); } })();
      return closing;
    },
  });
}
