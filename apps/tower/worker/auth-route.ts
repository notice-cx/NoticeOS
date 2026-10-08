import { isIP } from 'node:net';
import { openEmailCodeLogin, type EmailCodeLogin, type EmailCodeOptions } from '@noticeos/postgres/email-code';
import { EMAIL_CODE_PATHS, EMAIL_ENROLLMENT_HEADERS, type EmailEnrollment } from '../../../scripts/identity-protocol.mjs';
import { PRODUCT_ENV } from '../../../scripts/product-env.mjs';
import { createBrowserRequestPolicy, WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import { workspaceEntryOrigin, workspaceProfile, type WorkspaceEntryBindings } from '../../../scripts/workspace-entry.mjs';
import { captureIdentityMail, type IdentityMailBindings } from './identity-mail';

export interface AuthEntryBindings extends WorkspaceEntryBindings, IdentityMailBindings {
  NOTICEOS_IDENTITY_EDGE?: string;
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const HEADERS = { 'cache-control': 'no-store', vary: 'Cookie' };
function refuse(): never { throw new Error('Identity entry unavailable'); }

/** Cloudflare replaces the edge peer header. Worker subrequests have different
 * peer semantics and are refused; arbitrary forwarded-IP headers are ignored.
 * This adapter is only for a server-declared Cloudflare deployment, never a
 * native proxy trusting similarly named browser headers.
 * https://developers.cloudflare.com/fundamentals/reference/http-headers/ */
export function edgePeer(request: Request, env: AuthEntryBindings): string {
  if (env[PRODUCT_ENV.identityEdge.name] !== 'cloudflare') refuse();
  const metadata = (request as Request & { readonly cf?: unknown }).cf;
  if (!metadata || typeof metadata !== 'object' || request.headers.has('cf-worker')) refuse();
  const peer = request.headers.get('cf-connecting-ip');
  if (!peer || isIP(peer) === 0 || peer === '2a06:98c0:3600::103') refuse();
  return peer;
}
function enrollment(request: Request): EmailEnrollment | undefined {
  const kind = request.headers.get(EMAIL_ENROLLMENT_HEADERS.kind);
  const id = request.headers.get(EMAIL_ENROLLMENT_HEADERS.id);
  if (kind === null && id === null) return undefined;
  if ((kind !== 'platform' && kind !== 'invitation') || id === null || !UUID.test(id)) refuse();
  return Object.freeze({ kind, id });
}
function codeSender(env: AuthEntryBindings): EmailCodeOptions['deliver'] {
  const send = captureIdentityMail(env);
  return async message => {
    if (!/^\d{6}$/u.test(message.code)) refuse();
    await send({ to: message.email, subject: 'Your NoticeOS sign-in code',
      text: `Your NoticeOS sign-in code is ${message.code}.`,
      html: `<p>Your NoticeOS sign-in code</p><p><strong>${message.code}</strong></p>` });
  };
}

/** Only these three protocol operations reach the maintained domain module.
 * `open` belongs to server composition/testing, never HTTP or RPC input. */
export async function handleAuthRequest(request: Request, env: AuthEntryBindings,
  open: (options: EmailCodeOptions) => EmailCodeLogin = openEmailCodeLogin): Promise<Response> {
  let login: EmailCodeLogin | undefined;
  try {
    if (workspaceProfile(env) !== 'hosted' || !(request instanceof Request) || request.url.length > 4096) refuse();
    const url = new URL(request.url);
    const action = (Object.keys(EMAIL_CODE_PATHS) as (keyof typeof EMAIL_CODE_PATHS)[])
      .find(key => EMAIL_CODE_PATHS[key] === url.pathname);
    if (!action || request.method !== 'POST' || url.search || url.hash || url.username || url.password) refuse();
    const origin = workspaceEntryOrigin(env);
    createBrowserRequestPolicy(origin).assertEffect(request);
    const peerAddress = edgePeer(request, env);
    const selected = enrollment(request);
    if (action === 'logout') {
      const expected = request.headers.get(WORKSPACE_SESSION_HEADER);
      if (selected || !expected || !UUID.test(expected)) refuse();
    } else if (request.headers.has(WORKSPACE_SESSION_HEADER) || request.headers.has(WORKSPACE_SELECTION_HEADER)) refuse();
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') refuse();
    const connectionString = env[PRODUCT_ENV.identityDatabase.name];
    const sessionSecret = env[PRODUCT_ENV.identitySecret.name];
    if (typeof connectionString !== 'string' || typeof sessionSecret !== 'string') refuse();
    // Verification and logout keep working if delivery is unavailable.
    const deliver = action === 'request' ? codeSender(env) : async () => refuse();
    login = open({ connectionString, sessionSecret, trustedOrigin: origin, peerAddress,
      deliver,
    });
    const result = action === 'request' ? await login.requestCode(request, selected)
      : action === 'verify' ? await login.verifyCode(request, selected) : await login.logout(request);
    await login.close(); login = undefined;
    return result;
  } catch {
    return Response.json({ ok: false }, { status: 403, headers: HEADERS });
  } finally {
    // Close failures cannot override a redacted refusal. The domain module
    // awaits all admitted actions before closing its request-owned pool.
    if (login) { try { await login.close(); } catch { /* already refused */ } }
  }
}
