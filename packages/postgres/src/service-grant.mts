// Fresh facts for a deployment-owned service, never a bearer protocol or
// admission policy. Construction binds both IDs before any asynchronous work;
// the trusted job composition must run central admission again before effects.
import { Pool } from 'pg';

export interface WorkspaceServiceFacts {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly workspaceStatus: 'active' | 'provisioning' | 'suspended';
  readonly expiresAt: string;
  /** Untrusted stored names. Central admission validates its released catalog. */
  readonly actions: readonly string[];
}
export interface WorkspaceServiceGrant {
  facts(): Promise<WorkspaceServiceFacts | null>;
  close(): Promise<void>;
}
export class ServiceGrantRefused extends Error {
  override name = 'ServiceGrantRefused';
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const ROLE = 'noticeos_service_grant';
const ROLE_SQL = `SELECT session_user::text AS session_role,current_user::text AS acting_role,
  r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication AS elevated,
  EXISTS(SELECT 1 FROM pg_catalog.pg_roles other WHERE other.rolname<>current_user
    AND pg_catalog.pg_has_role(current_user,other.oid,'MEMBER')) AS another_role,
  pg_catalog.has_schema_privilege(current_user,'noticeos','USAGE,CREATE') OR
  pg_catalog.has_schema_privilege(current_user,'noticeos_identity','USAGE,CREATE') OR
  pg_catalog.has_schema_privilege(current_user,'noticeos_platform','CREATE') OR
  EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='noticeos_platform'
      AND p.oid<>'noticeos_platform.resolve_workspace_service(uuid,uuid)'::regprocedure
      AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')) OR
  EXISTS(SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('noticeos','noticeos_identity','noticeos_platform')
      AND c.relkind IN ('r','p','v','m','f') AND (
        pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
        pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS broad_access,
  pg_catalog.has_function_privilege(current_user,
    'noticeos_platform.resolve_workspace_service(uuid,uuid)','EXECUTE') AS resolver
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;

function connection(input: unknown): string {
  if (typeof input !== 'string') throw new ServiceGrantRefused('Service grant requires an explicit PostgreSQL connection');
  let value: URL;
  try { value = new URL(input); } catch { throw new ServiceGrantRefused('Service grant requires an explicit PostgreSQL connection'); }
  if (!['postgres:', 'postgresql:'].includes(value.protocol) || !value.hostname
    || !value.username || value.pathname.length < 2 || value.hash) {
    throw new ServiceGrantRefused('Service grant requires an explicit PostgreSQL connection');
  }
  for (const key of ['statement_timeout', 'lock_timeout', 'query_timeout', 'connectionTimeoutMillis', 'connect_timeout', 'options']) {
    value.searchParams.delete(key);
  }
  return value.href;
}

export function openWorkspaceServiceGrant(options: {
  readonly connectionString: string;
  readonly principalId: string;
  readonly workspaceId: string;
}): WorkspaceServiceGrant {
  const { principalId, workspaceId } = options;
  if (typeof principalId !== 'string' || !UUID.test(principalId)
    || typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
    throw new ServiceGrantRefused('Service grant requires fixed principal and workspace UUIDs');
  }
  const connectionString = connection(options.connectionString);
  let pool: Pool | undefined;
  let opening: Promise<Pool> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const pending = new Set<Promise<WorkspaceServiceFacts | null>>();

  function connected(): Promise<Pool> {
    if (opening) return opening;
    opening = (async () => {
      const candidate = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 1000, statement_timeout: 5000, lock_timeout: 5000, query_timeout: 6000 });
      candidate.on('error', () => undefined);
      try {
        const row = (await candidate.query(ROLE_SQL)).rows[0] as Record<string, unknown> | undefined;
        if (row?.session_role !== ROLE || row.acting_role !== ROLE || row.elevated !== false
          || row.another_role !== false || row.broad_access !== false || row.resolver !== true) {
          throw new ServiceGrantRefused('Service grant requires its separate read-only runtime role');
        }
        pool = candidate;
        return candidate;
      } catch {
        await candidate.end();
        throw new ServiceGrantRefused('Service grant connection refused');
      }
    })();
    return opening;
  }
  async function read(): Promise<WorkspaceServiceFacts | null> {
    try {
      const client = await connected();
      const rows = (await client.query({
        text: 'SELECT * FROM noticeos_platform.resolve_workspace_service($1::uuid,$2::uuid)',
        values: [workspaceId, principalId],
      })).rows as Record<string, unknown>[];
      if (rows.length === 0) return null;
      const row = rows[0];
      if (rows.length !== 1 || !row || row.service_id !== principalId || row.workspace_id !== workspaceId
        || !['active', 'provisioning', 'suspended'].includes(String(row.status))
        || !(row.expires_at instanceof Date) || !Number.isFinite(row.expires_at.getTime())
        || !Array.isArray(row.actions) || row.actions.length === 0 || row.actions.length > 32
        || row.actions.some(action => typeof action !== 'string' || !/^[a-z][a-z.-]{0,63}$/u.test(action))
        || new Set(row.actions).size !== row.actions.length) {
        throw new ServiceGrantRefused('Service grant facts refused');
      }
      return Object.freeze({ principalId, workspaceId,
        workspaceStatus: row.status as WorkspaceServiceFacts['workspaceStatus'],
        expiresAt: row.expires_at.toISOString(), actions: Object.freeze([...row.actions] as string[]) });
    } catch (error) {
      if (error instanceof ServiceGrantRefused) throw error;
      throw new ServiceGrantRefused('Service grant read refused');
    }
  }
  return Object.freeze({
    facts() {
      if (closed) return Promise.reject(new ServiceGrantRefused('Service grant is closed'));
      const work = read();
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([...pending]);
        await pool?.end();
      })();
      return closing;
    },
  });
}
