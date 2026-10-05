/** Bounded invitation/member mutations. The original browser evidence and the
 * central server-owned action decision precede every maintained API effect.
 * No workspace provisioning or raw organization handler escapes this module. */
import { sql, type Transaction } from 'kysely';
import { createBrowserRequestPolicy, WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import { identityEngine, identityMembership, openIdentityDatabase, validateIdentityOptions,
  UUID, IdentityRefused, type IdentityDatabase, type IdentityOptions,
  type IdentityMembershipFacts, type InvitationMessage } from './identity-engine.mjs';

export type MembershipRole = 'owner' | 'operator' | 'viewer';
export interface MembershipAuthority extends IdentityMembershipFacts {
  readonly workspaceStatus: 'active' | 'provisioning' | 'suspended';
}
export type MembershipCommand =
  | { readonly kind: 'list'; readonly collection: 'members' | 'invitations'; readonly after?: string }
  | { readonly kind: 'invite'; readonly email: string; readonly role: MembershipRole }
  | { readonly kind: 'resend'; readonly invitationId: string }
  | { readonly kind: 'cancel'; readonly invitationId: string }
  | { readonly kind: 'accept'; readonly invitationId: string }
  | { readonly kind: 'change-role'; readonly memberId: string; readonly role: MembershipRole }
  | { readonly kind: 'remove'; readonly memberId: string };
export interface MembershipOptions extends IdentityOptions {
  /** Server-owned central memberships.manage decision. Called exactly once
   * with one immutable, transaction-fresh fact snapshot; returned values are
   * ignored. This callback must only decide permission, not run capabilities. */
  readonly authorize: (request: Request, facts: MembershipAuthority) => void | Promise<void>;
  /** Capture during the library call, deliver only after commit. No sender is
   * selected here. Retry uses the same maintained pending invitation ID. */
  readonly deliver: (message: InvitationMessage) => Promise<void>;
}
export interface MembershipLifecycle {
  execute(request: Request, workspaceId: string, command: MembershipCommand): Promise<Response>;
  /** The stored invitation selects its workspace; the verified recipient and
   * captured session are checked again under the same canonical locks. */
  accept(request: Request, invitationId: string): Promise<Response>;
  close(): Promise<void>;
}
export class InvitationDeliveryFailed extends IdentityRefused {
  readonly invitationId: string;
  constructor(invitationId: string) {
    super('Invitation saved; delivery failed.'); this.invitationId = invitationId;
  }
}
function refuse(): never { throw new IdentityRefused('Membership action refused'); }
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) refuse(); return value; }
function role(value: unknown): MembershipRole {
  if (value !== 'owner' && value !== 'operator' && value !== 'viewer') refuse(); return value;
}
function command(input: MembershipCommand): MembershipCommand {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) refuse();
  const row = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !field || !('value' in field)) refuse();
    row[key] = field.value as unknown;
  }
  if (row.kind === 'list') {
    if (Object.keys(row).some(key => !['kind', 'collection', 'after'].includes(key))
      || (row.collection !== 'members' && row.collection !== 'invitations')) refuse();
    return Object.freeze({ kind: 'list', collection: row.collection,
      ...(row.after === undefined ? {} : { after: uuid(row.after) }) });
  }
  const fields = row.kind === 'invite' ? ['kind', 'email', 'role'] : row.kind === 'change-role' ? ['kind', 'memberId', 'role']
    : row.kind === 'remove' ? ['kind', 'memberId'] : ['kind', 'invitationId'];
  if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) refuse();
  if (row.kind === 'invite') {
    if (typeof row.email !== 'string' || row.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(row.email)) refuse();
    return Object.freeze({ kind: 'invite', email: row.email.toLowerCase(), role: role(row.role) });
  }
  if (row.kind === 'change-role') return Object.freeze({ kind: row.kind, memberId: uuid(row.memberId), role: role(row.role) });
  if (row.kind === 'remove') return Object.freeze({ kind: row.kind, memberId: uuid(row.memberId) });
  if (row.kind !== 'resend' && row.kind !== 'cancel' && row.kind !== 'accept') refuse();
  const invitationId = uuid(row.invitationId);
  if (row.kind === 'resend') return Object.freeze({ kind: 'resend', invitationId });
  if (row.kind === 'cancel') return Object.freeze({ kind: 'cancel', invitationId });
  return Object.freeze({ kind: 'accept', invitationId });
}
function proof(original: Request, origin: string): Request {
  if (!(original instanceof Request) || original.method !== 'POST' || original.url.length > 12288) refuse();
  // The explicit command is validated separately. Snapshot truthful request
  // metadata without retaining an unused tee of its incoming body stream.
  const request = new Request(original.url, { method: original.method, headers: new Headers(original.headers) });
  createBrowserRequestPolicy(origin).assertEffect(request);
  uuid(request.headers.get(WORKSPACE_SESSION_HEADER));
  return request;
}
function libraryRequest(original: Request, origin: string, path: string, body: object): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const key of ['cookie', 'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) {
    const value = original.headers.get(key); if (value !== null) headers.set(key, value);
  }
  return new Request(`${origin}/api/auth/organization/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function value(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader(); if (!reader) refuse();
  const bytes: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > 16384) refuse(); bytes.push(chunk.value);
    }
  } finally {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new IdentityRefused('Membership action refused')), 1000);
      });
      await Promise.race([reader.cancel(), deadline]);
    } finally { clearTimeout(timer); reader.releaseLock(); }
  }
  const joined = new Uint8Array(size); let offset = 0;
  for (const chunk of bytes) { joined.set(chunk, offset); offset += chunk.byteLength; }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); } catch { refuse(); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) refuse();
  return data as Record<string, unknown>;
}
async function lockWorkspace(trx: Transaction<IdentityDatabase>, workspaceId: string): Promise<void> {
  const org = await sql`SELECT id FROM noticeos_identity.auth_organization WHERE id=${workspaceId}::uuid FOR UPDATE`.execute(trx);
  if (org.rows.length !== 1) refuse();
  const canonical = await sql<{ status: string }>`SELECT status FROM noticeos_identity.lock_login_workspace(${workspaceId}::uuid)`.execute(trx);
  if (canonical.rows[0]?.status !== 'active') refuse();
}
function reply(invitationId?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  return new Response(JSON.stringify({ ok: true, ...(invitationId ? { invitationId } : {}) }), { status: 200, headers });
}
async function roster(trx: Transaction<IdentityDatabase>, workspaceId: string,
  query: Extract<MembershipCommand, { kind: 'list' }>): Promise<Response> {
  const after = query.after ?? null;
  const rows = query.collection === 'members'
    ? (await sql<{ id: string; name: string; email: string; role: string }>`
        SELECT m.id,u.name,u.email,m.role FROM noticeos_identity.auth_member m
        JOIN noticeos_identity.auth_user u ON u.id=m.user_id
        WHERE m.organization_id=${workspaceId}::uuid AND (${after}::uuid IS NULL OR m.id>${after}::uuid)
        ORDER BY m.id LIMIT 101`.execute(trx)).rows
    : (await sql<{ id: string; email: string; role: string; expires_at: Date }>`
        SELECT id,email,role,expires_at FROM noticeos_identity.auth_invitation
        WHERE organization_id=${workspaceId}::uuid AND status='pending' AND (${after}::uuid IS NULL OR id>${after}::uuid)
        ORDER BY id LIMIT 101`.execute(trx)).rows;
  const items = rows.slice(0, 100).map(row => ({ id: uuid(row.id), email: row.email, role: role(row.role),
    ...('name' in row ? { name: row.name } : { expiresAt: row.expires_at.toISOString() }) }));
  return Response.json({ ok: true, collection: query.collection, items,
    nextCursor: rows.length > 100 ? items.at(-1)!.id : null }, { headers: { 'cache-control': 'no-store' } });
}
/** Open lazily per request and await close. Unknown commands, foreign evidence
 * and malformed selectors never connect. No active-organization fallback. */
export function openMembershipLifecycle(input: MembershipOptions): MembershipLifecycle {
  const options = Object.freeze({ connectionString: input.connectionString, trustedOrigin: input.trustedOrigin,
    sessionSecret: input.sessionSecret, authorize: input.authorize, deliver: input.deliver });
  const origin = validateIdentityOptions(options);
  if (typeof options.authorize !== 'function' || typeof options.deliver !== 'function') refuse();
  let resources: ReturnType<typeof openIdentityDatabase> | undefined, validated: Promise<void> | undefined, closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  async function database() {
    resources ??= openIdentityDatabase(options);
    const opened = await resources;
    validated ??= (async () => {
      const response = await identityEngine(opened.database, options, { transaction: true, validateSchema: true })
        .handler(new Request(`${origin}/api/auth/get-session`));
      if (response.status !== 200 || await response.json() !== null) refuse();
    })();
    await validated; return opened.database;
  }
  async function execute(request: Request, workspaceId: string | undefined, inputCommand: MembershipCommand): Promise<Response> {
    const original = proof(request, origin), requested = workspaceId === undefined ? undefined : uuid(workspaceId), action = command(inputCommand);
    if (requested === undefined && action.kind !== 'accept') refuse();
    const expectedSession = original.headers.get(WORKSPACE_SESSION_HEADER);
    const db = await database();
    const captured: InvitationMessage[] = [];
    const result = await db.transaction().execute(async trx => {
      await sql`SELECT set_config('statement_timeout','5000',true), set_config('lock_timeout','5000',true)`.execute(trx);
      const auth = identityEngine(trx, options, { transaction: false, validateSchema: false, readOnlySession: true,
        invitation: message => captured.push(message) });
      let selected = requested;
      if (selected === undefined && action.kind === 'accept') {
        const session = await auth.api.getSession({ headers: original.headers, query: { disableCookieCache: true, disableRefresh: true } });
        if (!session || session.session.id !== expectedSession) refuse();
        const target = await sql<{ organization_id: string }>`SELECT organization_id FROM noticeos_identity.auth_invitation
          WHERE id=${action.invitationId}::uuid`.execute(trx);
        selected = uuid(target.rows[0]?.organization_id);
      }
      if (selected === undefined) refuse();
      // Never take login's preceding rate/mailbox locks from here. All member,
      // invitation and lifecycle mutations serialize through this organization
      // then canonical row before current session/member/invitation locks.
      await lockWorkspace(trx, selected);
      let path: string, body: object, invitationId: string | undefined;
      if (action.kind === 'accept') {
        const verified = await auth.api.getSession({ headers: original.headers, query: { disableCookieCache: true, disableRefresh: true } });
        if (!verified || verified.session.id !== expectedSession) refuse();
        const person = await sql<{ email: string }>`SELECT u.email FROM noticeos_identity.auth_session s
          JOIN noticeos_identity.auth_user u ON u.id=s.user_id
          WHERE s.id=${verified.session.id}::uuid AND s.user_id=${verified.user.id}::uuid
            AND s.expires_at>clock_timestamp() AND u.email_verified=true FOR SHARE OF s,u`.execute(trx);
        const invite = await sql<{ email: string; role: string; valid: boolean }>`SELECT email,role,
          status='pending' AND expires_at>clock_timestamp() AS valid FROM noticeos_identity.auth_invitation
          WHERE id=${action.invitationId}::uuid AND organization_id=${selected}::uuid FOR UPDATE`.execute(trx);
        const row = invite.rows[0];
        if (!person.rows[0] || !row?.valid || row.email.toLowerCase() !== person.rows[0].email.toLowerCase()) refuse();
        role(row.role); invitationId = action.invitationId;
        path = 'accept-invitation'; body = { invitationId };
      } else {
        const facts = await identityMembership(trx, auth, original.headers, selected, true, true);
        if (!facts?.workspaceStatus || facts.sessionId !== expectedSession) refuse();
        const person = await sql`SELECT id FROM noticeos_identity.auth_user
          WHERE id=${facts.principalId}::uuid AND email_verified=true FOR SHARE`.execute(trx);
        if (person.rows.length !== 1) refuse();
        // Exactly one call, inside the held transaction. Alternate returned
        // objects grant nothing; only a successful central decision continues.
        await options.authorize(original, Object.freeze({ ...facts, workspaceStatus: facts.workspaceStatus }));
        if (action.kind === 'list') return roster(trx, selected, action);
        if (action.kind === 'invite') {
          path = 'invite-member'; body = { organizationId: selected, email: action.email, role: action.role };
        } else if (action.kind === 'cancel' || action.kind === 'resend') {
          const invite = await sql<{ email: string; role: string; pending: boolean }>`SELECT email,role,
            status='pending' AS pending FROM noticeos_identity.auth_invitation
            WHERE id=${action.invitationId}::uuid AND organization_id=${selected}::uuid FOR UPDATE`.execute(trx);
          const row = invite.rows[0]; if (!row?.pending) refuse(); role(row.role);
          invitationId = action.invitationId;
          if (action.kind === 'resend') {
            const same = await sql<{ id: string }>`SELECT id FROM noticeos_identity.auth_invitation
              WHERE organization_id=${selected}::uuid AND lower(email)=${row.email.toLowerCase()} AND status='pending' FOR UPDATE`.execute(trx);
            if (same.rows.length !== 1 || same.rows[0]!.id !== invitationId) refuse();
            path = 'invite-member'; body = { organizationId: selected, email: row.email, role: row.role, resend: true };
          } else { path = 'cancel-invitation'; body = { invitationId }; }
        } else {
          const target = await sql<{ role: string }>`SELECT role FROM noticeos_identity.auth_member
            WHERE id=${action.memberId}::uuid AND organization_id=${selected}::uuid FOR UPDATE`.execute(trx);
          if (target.rows.length !== 1) refuse();
          const targetRole = role(target.rows[0]!.role);
          if (targetRole === 'owner' && (action.kind === 'remove' || action.role !== 'owner')) {
            const owners = await sql<{ n: number }>`SELECT count(*)::int AS n FROM noticeos_identity.auth_member
              WHERE organization_id=${selected}::uuid AND role='owner'`.execute(trx);
            if (owners.rows[0]!.n <= 1) refuse();
          }
          if (action.kind === 'remove') { path = 'remove-member'; body = { organizationId: selected, memberIdOrEmail: action.memberId }; }
          else { path = 'update-member-role'; body = { organizationId: selected, memberId: action.memberId, role: action.role }; }
        }
      }
      const response = await auth.handler(libraryRequest(original, origin, path, body));
      const data = await value(response);
      if (!response.ok) refuse();
      if (action.kind === 'invite' || action.kind === 'resend') {
        const created = uuid(data.id);
        if (invitationId && created !== invitationId) refuse();
        invitationId = created;
        if (captured.length !== 1 || captured[0]!.invitationId !== created || captured[0]!.workspaceId !== selected) refuse();
      } else if (captured.length !== 0) refuse();
      return { invitationId };
    });
    // A failure here cannot pretend the invitation transaction rolled back.
    // A caller retries the declared existing invitation, never a new write.
    for (const message of captured) {
      try { await options.deliver(message); } catch { throw new InvitationDeliveryFailed(message.invitationId); }
    }
    // Membership responses never replace a browser session cookie. A delayed
    // administration response must not overwrite another tab's newer login.
    return result instanceof Response ? result : reply(result.invitationId);
  }
  function run(request: Request, workspaceId: string | undefined, command: MembershipCommand): Promise<Response> {
    if (closing) return Promise.reject(new IdentityRefused('Membership is closed'));
    const operation = execute(request, workspaceId, command).catch(error => {
      if (error instanceof InvitationDeliveryFailed) throw error;
      refuse();
    });
    pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
  }
  return Object.freeze({
    execute(request: Request, workspaceId: string, command: MembershipCommand): Promise<Response> {
      return run(request, workspaceId, command);
    },
    accept(request: Request, invitationId: string): Promise<Response> {
      return run(request, undefined, { kind: 'accept', invitationId });
    },
    close(): Promise<void> {
      closing ??= (async () => { await Promise.allSettled([...pending]);
        if (resources) { const { database: db } = await resources.catch(() => ({ database: undefined })); await db?.destroy(); }
      })(); return closing;
    },
  });
}
