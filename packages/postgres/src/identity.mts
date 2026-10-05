// Hosted identity facts only. No HTTP handler, provisioning or workspace
// capabilities escape this module. Standalone callers need not open it.
import { identityEngine, identityMembership, openIdentityDatabase, UUID, validateIdentityOptions } from './identity-engine.mjs';
import { IdentityRefused, type IdentityOptions } from './identity-engine.mjs';
export { IDENTITY_NAMES, IDENTITY_ROLE, IDENTITY_SCHEMA, IdentityRefused, type IdentityOptions } from './identity-engine.mjs';

export type MembershipRole = 'owner' | 'operator' | 'viewer';
export interface SessionFacts {
  readonly principalId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}
export interface MembershipFacts extends SessionFacts {
  readonly workspaceId: string;
  readonly role: MembershipRole;
}
export type WorkspaceStatus = 'active' | 'provisioning' | 'suspended';
export interface WorkspaceSummary {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly status: WorkspaceStatus;
}
export interface AdmissionMembershipFacts extends MembershipFacts {
  readonly workspaceStatus: WorkspaceStatus;
}
export interface WorkspaceActor {
  readonly principalId: string;
  readonly displayName: string;
}
export interface Identity {
  /** Fresh verified cookie/session facts, or null. Never a cookie-cache answer. */
  session(headers: Headers): Promise<SessionFacts | null>;
  /** Current membership and unexpired session in one database observation. */
  membership(headers: Headers, workspaceId: string): Promise<MembershipFacts | null>;
  /** Same fresh session/member observation plus canonical lifecycle. Requires
   * the lifecycle migration; neither method grants workspace capabilities. */
  admissionMembership(headers: Headers, workspaceId: string): Promise<AdmissionMembershipFacts | null>;
  /** Internal control-plane fact read. Never expose an arbitrary UUID endpoint;
   * membership choices must first verify session and owned membership. */
  workspaceSummary(workspaceId: string): Promise<WorkspaceSummary | null>;
  /** Private presentation facts, never authority. Call only for an admitted
   * selected workspace; no email/account fields or foreign UUID lookup. The
   * bounded roster refuses over 1,000 members rather than returning a sample. */
  workspaceActors(workspaceId: string): Promise<readonly WorkspaceActor[]>;
  /** Idempotent; awaits operations already started and rejects new operations. */
  close(): Promise<void>;
}
/** Open per request; close in finally (or an awaited Worker waitUntil).
 * No fallback URL, active-organization selection or automatic migration. */
export async function openIdentity(input: IdentityOptions): Promise<Identity> {
  validateIdentityOptions(input);
  const { pool, database } = await openIdentityDatabase(input);
  try {
    const auth = identityEngine(database, input, { transaction: true });
    const context = await auth.$context;
    await context.checkSchema?.();
    let closing: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    function run<T>(work: () => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(new IdentityRefused('Identity is closed'));
      const operation = work();
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    }
    const fresh = (headers: Headers) => auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
    function membership(headers: Headers, workspaceId: string, admission: true): Promise<AdmissionMembershipFacts | null>;
    function membership(headers: Headers, workspaceId: string, admission: false): Promise<MembershipFacts | null>;
    async function membership(headers: Headers, workspaceId: string, admission: boolean): Promise<AdmissionMembershipFacts | MembershipFacts | null> {
      const facts = await identityMembership(database, auth, headers, workspaceId, admission);
      if (!facts) return null;
      if (admission) return { ...facts, workspaceStatus: facts.workspaceStatus! };
      const { workspaceStatus: _status, ...member } = facts;
      return member;
    }
    return {
      session: (headers) => run(async () => {
        const result = await fresh(headers);
        if (!result) return null;
        return { principalId: result.user.id, sessionId: result.session.id, expiresAt: result.session.expiresAt.toISOString() };
      }),
      membership: (headers, workspaceId) => run(() => membership(headers, workspaceId, false)),
      admissionMembership: (headers, workspaceId) => run(() => membership(headers, workspaceId, true)),
      workspaceActors: (workspaceId) => run(async () => {
        if (!UUID.test(workspaceId)) throw new IdentityRefused('Actors require an explicit workspace UUID');
        const { rows } = await pool.query<{ principal_id: string; display_name: string }>(`
          SELECT u.id AS principal_id, u.name AS display_name
          FROM noticeos_identity.auth_member m
          JOIN noticeos_identity.auth_user u ON u.id=m.user_id
          WHERE m.organization_id=$1::uuid AND m.role IN ('owner','operator','viewer')
          ORDER BY u.name, u.id LIMIT 1001`, [workspaceId]);
        if (rows.length > 1000) throw new IdentityRefused('Workspace actors unavailable');
        return Object.freeze(rows.map(row => Object.freeze({ principalId: row.principal_id, displayName: row.display_name })));
      }),
      workspaceSummary: (workspaceId) => run(async () => {
        if (!UUID.test(workspaceId)) throw new IdentityRefused('Summary requires an explicit workspace UUID');
        const { rows } = await pool.query<{ workspace_id: string; display_name: string; status: WorkspaceStatus }>(
          'SELECT workspace_id, display_name, status FROM noticeos_identity.workspace_summary($1::uuid)', [workspaceId]);
        const row = rows[0];
        if (!row) return null;
        if (!['active', 'provisioning', 'suspended'].includes(row.status)) throw new IdentityRefused('Workspace lifecycle is unavailable');
        return { workspaceId: row.workspace_id, displayName: row.display_name, status: row.status };
      }),
      close: () => {
        closing ??= (async () => { await Promise.allSettled([...pending]); await pool.end(); })();
        return closing;
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
