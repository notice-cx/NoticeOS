import { openMembershipLifecycle, InvitationDeliveryFailed, type MembershipCommand, type MembershipOptions,
  type MembershipLifecycle } from '@noticeos/postgres/membership';
import { MEMBERSHIP_PATH, ACCEPT_INVITATION_PATH, emailEnrollmentUrl } from '../../../scripts/identity-protocol.mjs';
import { createBrowserRequestPolicy, WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import { createWorkspaceAdmission } from '../../../scripts/workspace-admission.mjs';
import { workspaceEntryOrigin, workspaceProfile, type WorkspaceEntryBindings } from '../../../scripts/workspace-entry.mjs';
import { PRODUCT_ENV } from '../../../scripts/product-env.mjs';
import { captureIdentityMail, type IdentityMailBindings } from './identity-mail';

type Bindings = WorkspaceEntryBindings & IdentityMailBindings;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const HEADERS = { 'cache-control': 'no-store', vary: 'Cookie' };
function refuse(): never { throw new Error('Membership entry refused'); }
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') refuse();
  const reader = request.body?.getReader(); if (!reader) refuse();
  const chunks: Uint8Array[] = []; let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Membership input refused')), 5000); });
  try {
    for (;;) {
      const item = await Promise.race([reader.read(), deadline]); if (item.done) break;
      size += item.value.byteLength; if (size > 4096) refuse(); chunks.push(item.value);
    }
  } finally { clearTimeout(timer); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}
const html = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Identity-only entry. No operational store, provider capability, serialized
 * authority or general auth handler is available to a membership command. */
export async function handleMembershipRequest(request: Request, env: Bindings,
  open: (options: MembershipOptions) => MembershipLifecycle = openMembershipLifecycle): Promise<Response> {
  let client: MembershipLifecycle | undefined;
  try {
    if (!(request instanceof Request) || workspaceProfile(env) !== 'hosted' || request.url.length > 4096) refuse();
    const url = new URL(request.url), accept = url.pathname === ACCEPT_INVITATION_PATH;
    if ((!accept && url.pathname !== MEMBERSHIP_PATH) || request.method !== 'POST' || url.search || url.hash) refuse();
    const origin = workspaceEntryOrigin(env); createBrowserRequestPolicy(origin).assertEffect(request);
    const session = request.headers.get(WORKSPACE_SESSION_HEADER), workspace = request.headers.get(WORKSPACE_SELECTION_HEADER);
    if (!session || !UUID.test(session) || (accept ? workspace !== null : !workspace || !UUID.test(workspace))) refuse();
    // Capture truthful metadata separately. Reading the capped original body
    // does not leave a tee whose cancellation could keep a request alive.
    const proof = new Request(request.url, { method: request.method, headers: new Headers(request.headers) });
    const input = await body(request);
    if (accept) {
      if (Object.keys(input).length !== 1 || typeof input.invitationId !== 'string' || !UUID.test(input.invitationId)) refuse();
    } else if (input.kind === 'accept') refuse();
    const send = !accept && (input.kind === 'invite' || input.kind === 'resend') ? captureIdentityMail(env) : null;
    const connectionString = env[PRODUCT_ENV.identityDatabase.name], sessionSecret = env[PRODUCT_ENV.identitySecret.name];
    if (typeof connectionString !== 'string' || typeof sessionSecret !== 'string') refuse();
    client = open({ connectionString, sessionSecret, trustedOrigin: origin,
      authorize: async (original, facts) => {
        const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol('membership-entry'), trustedOrigin: origin,
          membership: async () => facts });
        await admission.withAdmission('memberships.manage', { requestedWorkspaceId: facts.workspaceId, correlationId: crypto.randomUUID() }, original, async () => undefined);
      },
      deliver: async message => {
        if (!send) refuse();
        const link = emailEnrollmentUrl(origin, { kind: 'invitation', id: message.invitationId });
        await send({ to: message.email, subject: 'Join your NoticeOS workspace', text: `Join your workspace: ${link}`,
          html: `<p><a href="${html(link)}">Join your NoticeOS workspace</a></p>` });
      },
    });
    const response = accept ? await client.accept(proof, input.invitationId as string)
      : await client.execute(proof, workspace!, input as unknown as MembershipCommand);
    await client.close(); client = undefined;
    return response;
  } catch (error) {
    if (error instanceof InvitationDeliveryFailed) return Response.json({ ok: false, code: 'delivery_failed', invitationId: error.invitationId }, { status: 503, headers: HEADERS });
    return Response.json({ ok: false }, { status: 403, headers: HEADERS });
  } finally { if (client) { try { await client.close(); } catch { /* fixed refusal already returned */ } } }
}
