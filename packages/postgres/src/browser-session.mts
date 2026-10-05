/** Browser choices are fresh identity facts, never workspace capabilities.
 * This one read owns and closes its connection; there is no active-organization
 * fallback and no public arbitrary workspace-summary lookup. */
import { sql } from 'kysely';
import { identityEngine, openIdentityDatabase, validateIdentityOptions, UUID,
  IdentityRefused, type IdentityOptions } from './identity-engine.mjs';
import type { MembershipRole, SessionFacts, WorkspaceStatus } from './identity.mjs';

export const WORKSPACE_CHOICES_PAGE_SIZE = 100;
export interface BrowserWorkspaceChoice {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly status: WorkspaceStatus;
  readonly role: MembershipRole;
}
export interface BrowserSessionSnapshot {
  readonly session: SessionFacts;
  readonly workspaces: readonly BrowserWorkspaceChoice[];
  readonly nextCursor: string | null;
  readonly selectedWorkspace: BrowserWorkspaceChoice | null;
}
function refuse(): never { throw new IdentityRefused('Browser session unavailable'); }
function selector(value: string | null): string | null {
  if (value !== null && (typeof value !== 'string' || !UUID.test(value))) refuse();
  return value;
}
function choice(value: unknown): BrowserWorkspaceChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  const row = value as Record<string, unknown>;
  if (typeof row.workspace_id !== 'string' || !UUID.test(row.workspace_id)
    || typeof row.display_name !== 'string'
    || !['active', 'provisioning', 'suspended'].includes(String(row.status))
    || !['owner', 'operator', 'viewer'].includes(String(row.role))) refuse();
  return Object.freeze({ workspaceId: row.workspace_id, displayName: row.display_name,
    status: row.status as WorkspaceStatus, role: row.role as MembershipRole });
}

/** Keyset pages keep responses bounded by membership count. A page cursor is
 * only an ordering marker, not authority. Selection is read in the same SQL
 * snapshot even when it is on another page; it must be active to be selected.
 * A verified person without memberships has an empty list and no selection. */
export async function readBrowserSession(input: IdentityOptions, headers: Headers,
  requestedWorkspaceId: string | null = null, afterWorkspaceId: string | null = null): Promise<BrowserSessionSnapshot | null> {
  const options = Object.freeze({ connectionString: input.connectionString,
    trustedOrigin: input.trustedOrigin, sessionSecret: input.sessionSecret });
  validateIdentityOptions(options);
  const selected = selector(requestedWorkspaceId), after = selector(afterWorkspaceId);
  const proof = new Headers(headers);
  const { database } = await openIdentityDatabase(options);
  try {
    const auth = identityEngine(database, options, { transaction: true, validateSchema: true, readOnlySession: true });
    const context = await auth.$context;
    await context.checkSchema?.();
    const verified = await auth.api.getSession({ headers: proof,
      query: { disableCookieCache: true, disableRefresh: true } });
    if (!verified) return null;
    const result = await database.transaction().execute(async trx => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      await sql`SELECT set_config('statement_timeout','5000',true), set_config('lock_timeout','5000',true)`.execute(trx);
      return sql<{ user_id: string; session_id: string; expires_at: Date;
        choices: unknown; selected: unknown }>`
        WITH current_person AS (
          SELECT s.user_id, s.id AS session_id, s.expires_at
          FROM noticeos_identity.auth_session s
          JOIN noticeos_identity.auth_user u ON u.id=s.user_id
          WHERE s.id=${verified.session.id}::uuid AND s.user_id=${verified.user.id}::uuid
            AND s.expires_at>clock_timestamp() AND u.email_verified=true
        ), choices AS (
          SELECT w.workspace_id, w.display_name, w.status, m.role
          FROM current_person p
          JOIN noticeos_identity.auth_member m ON m.user_id=p.user_id
          JOIN LATERAL noticeos_identity.workspace_summary(m.organization_id) w ON true
          WHERE (${after}::uuid IS NULL OR m.organization_id>${after}::uuid)
          ORDER BY m.organization_id LIMIT ${WORKSPACE_CHOICES_PAGE_SIZE + 1}
        )
        SELECT p.user_id, p.session_id, p.expires_at,
          COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.workspace_id) FROM choices c),'[]'::jsonb) AS choices,
          (SELECT jsonb_build_object('workspace_id',w.workspace_id,'display_name',w.display_name,
              'status',w.status,'role',m.role)
            FROM noticeos_identity.auth_member m
            JOIN LATERAL noticeos_identity.workspace_summary(m.organization_id) w ON true
            WHERE m.user_id=p.user_id AND m.organization_id=${selected}::uuid
              AND w.status='active') AS selected
        FROM current_person p`.execute(trx);
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) refuse();
    const row = result.rows[0]!;
    if (!Array.isArray(row.choices) || row.choices.length > WORKSPACE_CHOICES_PAGE_SIZE + 1) refuse();
    const workspaces = row.choices.slice(0, WORKSPACE_CHOICES_PAGE_SIZE).map(choice);
    const selectedWorkspace = row.selected === null ? null : choice(row.selected);
    if (selected !== null && selectedWorkspace?.workspaceId !== selected) refuse();
    return Object.freeze({
      session: Object.freeze({ principalId: row.user_id, sessionId: row.session_id, expiresAt: row.expires_at.toISOString() }),
      workspaces: Object.freeze(workspaces),
      nextCursor: row.choices.length > WORKSPACE_CHOICES_PAGE_SIZE ? workspaces.at(-1)!.workspaceId : null,
      selectedWorkspace,
    });
  } catch { return refuse(); }
  finally { await database.destroy(); }
}
