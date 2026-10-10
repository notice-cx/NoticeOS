// Hosted identity facts only. No HTTP handler, provisioning or workspace
// capabilities escape this module. Standalone callers need not open it.
import { identityEngine, identityMembership, openIdentityDatabase, UUID, validateIdentityOptions } from './identity-engine.mjs';
import { IdentityRefused, type IdentityOptions } from './identity-engine.mjs';
import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from 'jose';
import { AGENT_SCOPES, agentIssuer, agentResourceUri, bearerToken } from '../../../scripts/agent-access.mjs';
export { AGENT_NAMES, IDENTITY_NAMES, IDENTITY_ROLE, IDENTITY_SCHEMA, IdentityRefused, agentPlugins, type IdentityOptions } from './identity-engine.mjs';

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
/** A verified agent access token: the person it acts for,
 * the client, its scopes still consented, and when it expires. */
export interface AgentToken {
  readonly principalId: string;
  readonly clientId: string;
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}
/** The token with its person's fresh membership and lifecycle in one named
 * workspace. A fact, never a grant: admission maps the scopes to actions and
 * bounds them by the role. */
export interface AgentAuthorityFacts extends AgentToken {
  readonly workspaceId: string;
  readonly role: MembershipRole;
  readonly workspaceStatus: WorkspaceStatus;
}
export interface AgentWorkspace {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly role: MembershipRole;
  readonly status: WorkspaceStatus;
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
  /** The request's agent access token, or null: signed by this deployment's
   * key, issued here for its MCP endpoint, unexpired, and still backed by a
   * live consent and an enabled client. */
  agentToken(request: Request): Promise<AgentToken | null>;
  /** The token plus its person's current membership in this workspace and
   * the workspace's lifecycle, in one observation; null when either lapsed. */
  agentAuthority(request: Request, workspaceId: string): Promise<AgentAuthorityFacts | null>;
  /** The token's person's workspaces, as an agent lists them (at most 100). */
  agentWorkspaces(request: Request): Promise<readonly AgentWorkspace[] | null>;
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
    /** Signature, issuer, this deployment's MCP endpoint as audience and
     * expiry, then a live consent and an enabled client in one observation:
     * revoking either cuts the agent off at once. */
    async function agentToken(request: Request): Promise<AgentToken | null> {
      const token = request instanceof Request ? bearerToken(request.headers) : null;
      if (typeof token !== 'string') return null;
      let payload: JWTPayload;
      try {
        const header = decodeProtectedHeader(token);
        if (typeof header.kid !== 'string' || !UUID.test(header.kid)) return null;
        const { rows: [key] } = await pool.query<{ public_key: string; alg: string | null }>(`
          SELECT public_key, alg FROM noticeos_identity.auth_jwks
          WHERE id=$1::uuid AND (expires_at IS NULL OR expires_at>clock_timestamp())`, [header.kid]);
        if (!key) return null;
        const algorithm = key.alg ?? 'EdDSA';
        ({ payload } = await jwtVerify(token, await importJWK(JSON.parse(key.public_key) as Record<string, unknown>, algorithm), {
          issuer: agentIssuer(input.trustedOrigin), audience: agentResourceUri(input.trustedOrigin),
          algorithms: [algorithm], requiredClaims: ['exp', 'iat', 'sub'] }));
      } catch { return null; }
      const clientId = payload.azp ?? payload.client_id, scope = payload.scope;
      if (typeof payload.sub !== 'string' || !UUID.test(payload.sub) || typeof clientId !== 'string' || clientId.length === 0
        || clientId.length > 512 || typeof scope !== 'string' || typeof payload.exp !== 'number') return null;
      const { rows: [row] } = await pool.query<{ scopes: unknown }>(`
        SELECT c.scopes FROM noticeos_identity.auth_oauth_consent c
        JOIN noticeos_identity.auth_oauth_client o ON o.client_id=c.client_id AND o.disabled IS NOT TRUE
        WHERE c.user_id=$1::uuid AND c.client_id=$2 ORDER BY c.updated_at DESC LIMIT 1`, [payload.sub, clientId]);
      if (!row || !Array.isArray(row.scopes)) return null;
      const consented = row.scopes as unknown[];
      return Object.freeze({ principalId: payload.sub, clientId, expiresAt: new Date(payload.exp * 1000).toISOString(),
        scopes: Object.freeze(scope.split(' ').filter(value => Object.hasOwn(AGENT_SCOPES, value) && consented.includes(value))) });
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
      agentToken: (request) => run(() => agentToken(request)),
      agentAuthority: (request, workspaceId) => run(async () => {
        if (!UUID.test(workspaceId)) return null;
        const token = await agentToken(request);
        if (!token) return null;
        const { rows: [row] } = await pool.query<{ role: MembershipRole; status: WorkspaceStatus }>(`
          SELECT m.role, w.status FROM noticeos_identity.auth_member m
          JOIN LATERAL noticeos_identity.workspace_summary(m.organization_id) w ON w.workspace_id=m.organization_id
          WHERE m.user_id=$1::uuid AND m.organization_id=$2::uuid`, [token.principalId, workspaceId]);
        if (!row || !['owner', 'operator', 'viewer'].includes(row.role)
          || !['active', 'provisioning', 'suspended'].includes(row.status)) return null;
        return Object.freeze({ ...token, workspaceId, role: row.role, workspaceStatus: row.status });
      }),
      agentWorkspaces: (request) => run(async () => {
        const token = await agentToken(request);
        if (!token) return null;
        const { rows } = await pool.query<{ workspace_id: string; display_name: string; role: MembershipRole; status: WorkspaceStatus }>(`
          SELECT w.workspace_id, w.display_name, m.role, w.status FROM noticeos_identity.auth_member m
          JOIN LATERAL noticeos_identity.workspace_summary(m.organization_id) w ON w.workspace_id=m.organization_id
          WHERE m.user_id=$1::uuid AND m.role IN ('owner','operator','viewer')
          ORDER BY w.display_name, w.workspace_id LIMIT 100`, [token.principalId]);
        return Object.freeze(rows.map(row => Object.freeze({ workspaceId: row.workspace_id, displayName: row.display_name,
          role: row.role, status: row.status })));
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
