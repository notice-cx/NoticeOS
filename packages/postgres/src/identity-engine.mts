// Private shared maintained engine. Public modules expose facts or fixed login
// actions; the raw library handler and organization administration stay private.
import { Pool } from 'pg';
import { betterAuth } from 'better-auth/minimal';
import { organization, emailOTP, jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { defaultAc, ownerAc } from 'better-auth/plugins/organization/access';
import { createAuthMiddleware, formCsrfMiddleware } from 'better-auth/api';
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import type { AuthContext, BetterAuthPlugin } from '@better-auth/core';
import { AGENT_ACCESS_PAGE, AGENT_ACCESS_SECONDS, AGENT_REFRESH_SECONDS, AGENT_RESOURCES, AGENT_SCOPES, OFFLINE_ACCESS,
  WORKSPACE_CLAIM, agentResourceUri, type AgentResource } from '../../../scripts/agent-access.mjs';
export const IDENTITY_ROLE = 'noticeos_identity';
export const IDENTITY_SCHEMA = 'noticeos_identity';
export interface IdentityOptions {
  readonly connectionString: string;
  readonly trustedOrigin: string;
  readonly sessionSecret: string;
}
export class IdentityRefused extends Error { override name = 'IdentityRefused'; }
export interface EmailCodeMessage { readonly email: string; readonly code: string; }
export interface InvitationMessage {
  readonly invitationId: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly role: 'owner' | 'operator' | 'viewer';
  readonly expiresAt: string;
}
export type IdentityDatabase = Record<string, Record<string, unknown>>;

/** Static mappings shared by the maintained engine and schema qualification. */
export const IDENTITY_NAMES = {
  user: { modelName: 'auth_user', fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' } },
  session: { modelName: 'auth_session', fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at', ipAddress: 'ip_address', userAgent: 'user_agent', userId: 'user_id' } },
  account: { modelName: 'auth_account', fields: { accountId: 'account_id', providerId: 'provider_id', userId: 'user_id', accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token', accessTokenExpiresAt: 'access_token_expires_at', refreshTokenExpiresAt: 'refresh_token_expires_at', createdAt: 'created_at', updatedAt: 'updated_at' } },
  verification: { modelName: 'auth_verification', fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' } },
  organization: {
    organization: { modelName: 'auth_organization', fields: { createdAt: 'created_at' } },
    member: { modelName: 'auth_member', fields: { organizationId: 'organization_id', userId: 'user_id', createdAt: 'created_at' } },
    invitation: { modelName: 'auth_invitation', fields: { organizationId: 'organization_id', expiresAt: 'expires_at', createdAt: 'created_at', inviterId: 'inviter_id' } },
    session: { fields: { activeOrganizationId: 'active_organization_id' } },
  },
} as const;

/** The library's camelCase field, as the store's snake_case column. */
function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').replace(/([A-Z])([A-Z][a-z])/gu, '$1_$2').toLowerCase();
}
function model<const F extends readonly string[]>(modelName: string, fields: F) {
  return { modelName, fields: Object.fromEntries(fields.map(field => [field, snake(field)])) as Record<F[number], string> };
}
/** Agent sign-in's maintained tables (epic ro-cvl9; migration 0014): signing
 * keys, OAuth clients, the protected resources, tokens and consents. */
export const AGENT_NAMES = {
  jwks: model('auth_jwks', ['publicKey', 'privateKey', 'createdAt', 'expiresAt', 'alg', 'crv']),
  oauth: {
    oauthClient: model('auth_oauth_client', ['clientId', 'clientSecret', 'clientDiscoveryId', 'disabled', 'skipConsent',
      'enableEndSession', 'subjectType', 'scopes', 'clientCredentialsScopes', 'userId', 'createdAt', 'updatedAt', 'name',
      'uri', 'icon', 'contacts', 'tos', 'policy', 'softwareId', 'softwareVersion', 'softwareStatement', 'redirectUris',
      'postLogoutRedirectUris', 'backchannelLogoutUri', 'backchannelLogoutSessionRequired', 'tokenEndpointAuthMethod',
      'applicationType', 'jwks', 'jwksUri', 'grantTypes', 'responseTypes', 'requirePKCE', 'dpopBoundAccessTokens',
      'referenceId', 'metadata']),
    oauthResource: model('auth_oauth_resource', ['identifier', 'name', 'accessTokenTtl', 'refreshTokenTtl',
      'signingAlgorithm', 'signingKeyId', 'allowedScopes', 'customClaims', 'dpopBoundAccessTokensRequired', 'disabled',
      'createdAt', 'updatedAt', 'policyVersion', 'metadata']),
    oauthClientResource: model('auth_oauth_client_resource', ['clientId', 'resourceId', 'metadata', 'createdAt']),
    oauthRefreshToken: model('auth_oauth_refresh_token', ['token', 'clientId', 'sessionId', 'userId', 'referenceId',
      'authorizationCodeId', 'resources', 'requestedUserInfoClaims', 'expiresAt', 'createdAt', 'revoked', 'rotatedAt',
      'rotationReplayResponse', 'rotationReplayExpiresAt', 'authTime', 'confirmation', 'scopes']),
    oauthAccessToken: model('auth_oauth_access_token', ['token', 'clientId', 'sessionId', 'userId', 'referenceId',
      'authorizationCodeId', 'resources', 'requestedUserInfoClaims', 'refreshId', 'expiresAt', 'createdAt', 'revoked',
      'confirmation', 'scopes']),
    oauthConsent: model('auth_oauth_consent', ['clientId', 'userId', 'referenceId', 'resources', 'requestedUserInfoClaims',
      'scopes', 'createdAt', 'updatedAt']),
    oauthClientAssertion: model('auth_oauth_client_assertion', ['expiresAt']),
  },
} as const;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function origin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new IdentityRefused('Identity requires an explicit trusted origin'); }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (parsed.origin !== value || parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))) {
    throw new IdentityRefused('Identity requires an HTTPS origin or a local fixture origin');
  }
  return value;
}

const ROLE_SQL = `SELECT session_user::text AS session_role, current_user::text AS acting_role,
  r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication AS elevated,
  EXISTS (SELECT 1 FROM pg_catalog.pg_roles other WHERE other.rolname<>current_user
    AND pg_has_role(current_user, other.oid, 'MEMBER')) AS another_role,
  has_schema_privilege(current_user, 'noticeos', 'USAGE') OR
  has_schema_privilege(current_user, 'noticeos_identity', 'CREATE') AS broad_schema
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;


export function validateIdentityOptions(input: IdentityOptions): string {
  const baseURL = origin(input.trustedOrigin);
  if (typeof input.connectionString !== 'string' || input.connectionString.length === 0 || typeof input.sessionSecret !== 'string' || input.sessionSecret.length < 32) {
    throw new IdentityRefused('Identity requires an explicit connection and session secret');
  }
  let connection: URL;
  try { connection = new URL(input.connectionString); } catch { throw new IdentityRefused('Identity requires a PostgreSQL connection URL'); }
  if ((connection.protocol !== 'postgresql:' && connection.protocol !== 'postgres:') || !connection.hostname || !connection.username || connection.pathname.length < 2 || connection.hash) {
    throw new IdentityRefused('Identity requires a PostgreSQL connection URL');
  }
  return baseURL;
}

export async function openIdentityDatabase(input: IdentityOptions) {
  validateIdentityOptions(input);
  // Request-owned pool. Workers timers cannot unref(), so no allowExitOnIdle.
  const pool = new Pool({ connectionString: input.connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 });
  pool.on('error', () => undefined);
  try {
    const { rows } = await pool.query(ROLE_SQL);
    const role = rows[0];
    if (role?.session_role !== IDENTITY_ROLE || role.acting_role !== IDENTITY_ROLE || role.elevated !== false || role.another_role !== false || role.broad_schema !== false) {
      throw new IdentityRefused('Identity must use its separate non-owner runtime role');
    }
    const database = new Kysely<IdentityDatabase>({ dialect: new PostgresDialect({ pool }) });
    return { pool, database };
  } catch {
    await pool.end();
    throw new IdentityRefused('Identity connection refused');
  }
}

interface EngineOptions {
  readonly transaction: boolean;
  readonly emailCode?: true;
  readonly validateSchema?: boolean;
  /** Browser bootstrap is a GET fact read, including expired sessions. */
  readonly readOnlySession?: true;
  readonly peer?: string;
  readonly eligible?: boolean;
  readonly deliver?: (message: EmailCodeMessage) => void;
  /** Capture only. The membership module delivers after its outer commit. */
  readonly invitation?: (message: InvitationMessage) => void;
  /** The OAuth authorization server for agents (agent-sign-in.mts). */
  readonly agents?: true;
}
/** The workspace a session chose for the agent it is approving, set only
 * for the length of one approval (agent-sign-in.mts). */
function chosenWorkspace(session: Record<string, unknown>): string | undefined {
  const value = session.activeOrganizationId;
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}
/** Exported for schema qualification (the 0014 parity proof). */
export function agentPlugins(baseURL: string): BetterAuthPlugin[] {
  const scopes = [...Object.keys(AGENT_SCOPES), OFFLINE_ACCESS];
  const resources = (Object.keys(AGENT_RESOURCES) as AgentResource[]).map(key => agentResourceUri(baseURL, key));
  return [jwt({ schema: { jwks: AGENT_NAMES.jwks } }), oauthProvider({
    schema: AGENT_NAMES.oauth,
    // One page signs the person in, takes the workspace and records the
    // decision; the library redirects there for each of those steps.
    loginPage: AGENT_ACCESS_PAGE, consentPage: AGENT_ACCESS_PAGE,
    postLogin: {
      page: AGENT_ACCESS_PAGE,
      shouldRedirect: ({ session }) => chosenWorkspace(session) === undefined,
      consentReferenceId: ({ session }) => {
        const workspace = chosenWorkspace(session);
        if (!workspace) throw new IdentityRefused('Agent workspace unavailable');
        return workspace;
      },
    },
    scopes,
    resources: (Object.keys(AGENT_RESOURCES) as AgentResource[]).map(key => ({ identifier: agentResourceUri(baseURL, key),
      name: AGENT_RESOURCES[key].name, allowedScopes: [...AGENT_RESOURCES[key].scopes, OFFLINE_ACCESS] })),
    grantTypes: ['authorization_code', 'refresh_token'],
    allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultScopes: scopes, clientRegistrationAllowedScopes: scopes,
    clientRegistrationDefaultResources: resources, clientRegistrationAllowedResources: resources,
    clientRegistrationRequirePKCE: true,
    accessTokenExpiresIn: AGENT_ACCESS_SECONDS, refreshTokenExpiresIn: AGENT_REFRESH_SECONDS,
    storeTokens: 'hashed', storeClientSecret: 'hashed',
    customAccessTokenClaims: ({ referenceId }) => (referenceId && UUID.test(referenceId) ? { [WORKSPACE_CLAIM]: referenceId } : {}),
  })];
}
interface IdentityEngine {
  readonly $context: Promise<Pick<AuthContext, 'internalAdapter' | 'options' | 'checkSchema'>>;
  handler(request: Request): Promise<Response>;
  readonly api: {
    /** Supported server-only API; the public raw organization handler stays private. */
    addMember(input: { body: { organizationId: string; userId: string; role: 'owner' } }): Promise<{
      id: string; organizationId: string; userId: string; role: string;
    }>;
    getSession(input: { headers: Headers; query: { disableCookieCache: true; disableRefresh: true } }): Promise<{
      session: { id: string; expiresAt: Date };
      user: { id: string };
    } | null>;
  };
}

export interface IdentityMembershipFacts {
  readonly principalId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly workspaceId: string;
  readonly role: 'owner' | 'operator' | 'viewer';
  readonly workspaceStatus?: 'active' | 'provisioning' | 'suspended';
}
/** Private fresh fact reader shared by ordinary identity and transaction-bound
 * integration custody. It validates facts, never decides action permission.
 * Locking callers first hold organization then canonical workspace. */
export async function identityMembership(database: Kysely<IdentityDatabase> | Transaction<IdentityDatabase>,
  auth: Pick<IdentityEngine, 'api'>, headers: Headers, workspaceId: string,
  admission: boolean, lock = false): Promise<IdentityMembershipFacts | null> {
  if (!UUID.test(workspaceId)) throw new IdentityRefused('Membership requires an explicit workspace UUID');
  const result = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
  if (!result) return null;
  const response = await sql<{ workspace_id: string; role: string; expires_at: Date;
    status?: 'active' | 'provisioning' | 'suspended' }>`
    SELECT m.organization_id AS workspace_id, m.role, s.expires_at${admission ? sql`, w.status` : sql``}
    FROM noticeos_identity.auth_session s
    JOIN noticeos_identity.auth_member m ON m.user_id=s.user_id
    ${admission ? sql`JOIN LATERAL noticeos_identity.workspace_summary(m.organization_id) w ON w.workspace_id=m.organization_id` : sql``}
    WHERE s.id=${result.session.id}::uuid AND s.user_id=${result.user.id}::uuid
      AND s.expires_at>clock_timestamp() AND m.organization_id=${workspaceId}::uuid
    ${lock ? sql`FOR SHARE OF s, m` : sql``}`.execute(database);
  const member = response.rows[0];
  if (!member || (member.role !== 'owner' && member.role !== 'operator' && member.role !== 'viewer')) return null;
  if (admission && (!member.status || !['active', 'provisioning', 'suspended'].includes(member.status))) {
    throw new IdentityRefused('Workspace lifecycle is unavailable');
  }
  return Object.freeze({ principalId: result.user.id, sessionId: result.session.id,
    expiresAt: member.expires_at.toISOString(), workspaceId: member.workspace_id, role: member.role,
    ...(admission ? { workspaceStatus: member.status! } : {}) });
}
/** One configuration for native/Worker facts and transaction-bound login.
 * Schema validation uses the same feature schema, even with limiter execution
 * disabled. No exported product handler exposes the library's other routes. */
export function identityEngine(database: Kysely<IdentityDatabase> | Transaction<IdentityDatabase>, input: IdentityOptions, options: EngineOptions): IdentityEngine {
  const baseURL = validateIdentityOptions(input);
  return betterAuth({
    database: kyselyAdapter(database.withSchema(IDENTITY_SCHEMA), { type: 'postgres', transaction: options.transaction }),
    baseURL, trustedOrigins: [baseURL], secret: input.sessionSecret,
    appName: 'NoticeOS', telemetry: { enabled: false }, logger: { disabled: true },
    advanced: {
      database: { generateId: 'uuid', validateSchema: options.validateSchema },
      ...(options.peer ? { ipAddress: { ipAddressHeaders: ['x-noticeos-trusted-peer'] } } : {}),
    },
    ...(options.emailCode || options.agents ? { rateLimit: { enabled: Boolean(options.peer) && !options.validateSchema, storage: 'database' as const, modelName: 'auth_rate_limit', fields: { key: 'key', count: 'count', lastRequest: 'last_request' } } } : {}),
    user: IDENTITY_NAMES.user, account: IDENTITY_NAMES.account, verification: IDENTITY_NAMES.verification,
    session: { ...IDENTITY_NAMES.session, cookieCache: { enabled: false },
      ...(options.readOnlySession ? { deferSessionRefresh: true } : {}) },
    plugins: [organization({ allowUserToCreateOrganization: false, requireEmailVerificationOnInvitation: true,
      schema: IDENTITY_NAMES.organization,
      // These configure maintained organization behavior, not NoticeOS action
      // permission. The server's central memberships.manage decision still
      // authorizes every administration transaction before the library runs.
      roles: { owner: ownerAc, operator: defaultAc.newRole({}), viewer: defaultAc.newRole({}) },
      ...(options.invitation ? { sendInvitationEmail: async (message) => {
        if (message.role !== 'owner' && message.role !== 'operator' && message.role !== 'viewer') {
          throw new IdentityRefused('Invitation role refused');
        }
        options.invitation!(Object.freeze({ invitationId: message.id,
          workspaceId: message.organization.id, email: message.email,
          role: message.role, expiresAt: message.invitation.expiresAt.toISOString() }));
      } } : {}),
    }),
      ...(options.agents ? agentPlugins(baseURL) : []),
      ...(options.emailCode ? [emailOTP({ storeOTP: 'hashed', allowedAttempts: 3, expiresIn: 300,
        sendVerificationOTP: async (message) => {
          if (message.type !== 'sign-in' || !options.deliver) throw new IdentityRefused('Identity action unavailable');
          options.deliver({ email: message.email, code: message.otp });
        },
      })] : [])],
    hooks: { before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/sign-in/email-otp' || ctx.path === '/email-otp/send-verification-otp') {
        await formCsrfMiddleware(ctx);
        // Maintained onRequest rate accounting runs before this documented hook.
        if (options.eligible === false) return ctx.json({ code: 'ENROLLMENT_UNAVAILABLE' }, { status: ctx.path === '/email-otp/send-verification-otp' ? 202 : 400 });
      }
    }) },
  });
}
