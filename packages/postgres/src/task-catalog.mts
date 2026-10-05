/** Private platform setup, never a tenant route or a readiness flag.
 * The operator supplies a fixed real verifier; catalog facts authorize nothing.
 * Existing stores require approved additive migration before using this API.
 */
import { Pool } from 'pg';
import type { TaskProjectMapping } from './task-directory.mjs';

export interface TaskCatalogSetup {
  configure(input: unknown): Promise<void>;
  close(): Promise<void>;
}
export class TaskCatalogRefused extends Error {
  override name = 'TaskCatalogRefused';
  constructor() { super('Task catalog setup refused'); }
}
function refuse(): never { throw new TaskCatalogRefused(); }
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
function command(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) refuse();
  const row: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const fields = ['workspaceId', 'projectId', 'logicalKey', 'displayName', 'prefix'];
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !fields.includes(key) || !property || !('value' in property)) refuse();
    row[key] = property.value as unknown;
  }
  if (Object.keys(row).length !== fields.length
    || typeof row.workspaceId !== 'string' || !UUID.test(row.workspaceId)
    || typeof row.projectId !== 'string' || !UUID.test(row.projectId)
    || typeof row.logicalKey !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(row.logicalKey)
    || typeof row.displayName !== 'string' || row.displayName.length < 1 || row.displayName.length > 80
    || row.displayName.trim() !== row.displayName || /[\u0000-\u001f\u007f]/u.test(row.displayName)
    || typeof row.prefix !== 'string' || !/^[a-z0-9]{1,32}$/u.test(row.prefix)) refuse();
  return Object.freeze({ workspaceId: row.workspaceId, projectId: row.projectId,
    logicalKey: row.logicalKey, displayName: row.displayName, prefix: row.prefix });
}
function connection(value: unknown): string {
  if (typeof value !== 'string') refuse();
  let url: URL;
  try { url = new URL(value); } catch { refuse(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username
    || url.pathname.length < 2 || url.hash) refuse();
  for (const key of ['options', 'statement_timeout', 'lock_timeout', 'query_timeout', 'connectionTimeoutMillis', 'connect_timeout']) {
    url.searchParams.delete(key);
  }
  return url.href;
}
const ROLE_SQL = `SELECT session_user::text AS session_role,current_user::text AS acting_role,
  r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication AS elevated,
  EXISTS(SELECT 1 FROM pg_catalog.pg_roles other WHERE other.rolname<>current_user
    AND pg_catalog.pg_has_role(current_user,other.oid,'MEMBER')) AS another_role,
  pg_catalog.has_schema_privilege(current_user,'noticeos_platform','CREATE') OR
  pg_catalog.has_any_column_privilege(current_user,'noticeos_platform.task_project_directory','UPDATE') AND
    (pg_catalog.has_column_privilege(current_user,'noticeos_platform.task_project_directory','logical_key','UPDATE') OR
     pg_catalog.has_column_privilege(current_user,'noticeos_platform.task_project_directory','display_name','UPDATE') OR
     pg_catalog.has_column_privilege(current_user,'noticeos_platform.task_project_directory','issue_prefix','UPDATE')) OR
  pg_catalog.has_table_privilege(current_user,'noticeos_platform.task_project_catalog_changes','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS broad_access,
  pg_catalog.has_function_privilege(current_user,'noticeos_platform.lock_task_catalog(uuid,uuid)','EXECUTE') AND
  pg_catalog.has_function_privilege(current_user,'noticeos_platform.set_task_catalog(uuid,uuid,uuid,uuid,text,text,text,text)','EXECUTE') AS required_access
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;

export function openTaskCatalogSetup(options: {
  readonly connectionString: string;
  /** Verify and assert factory custody in the same realm. Never return a boolean. */
  readonly verifyProject: (mapping: TaskProjectMapping, budget: {
    readonly signal: AbortSignal; readonly deadline: number; readonly expectedPrefix: string;
  }) => Promise<void>;
}): TaskCatalogSetup {
  const connectionString = connection(options.connectionString), verifyProject = options.verifyProject;
  if (typeof verifyProject !== 'function') refuse();
  let pool: Pool | undefined, opening: Promise<Pool> | undefined, closing: Promise<void> | undefined;
  let closed = false;
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  function connected(): Promise<Pool> {
    opening ??= (async () => {
      const candidate = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 1000, statement_timeout: 5000, lock_timeout: 5000, query_timeout: 6000 });
      candidate.on('error', () => undefined);
      try {
        const row = (await candidate.query(ROLE_SQL)).rows[0] as Record<string, unknown> | undefined;
        if (row?.session_role !== 'noticeos_platform' || row.acting_role !== 'noticeos_platform'
          || row.elevated !== false || row.another_role !== false || row.broad_access !== false || row.required_access !== true) refuse();
        pool = candidate; return candidate;
      } catch { await candidate.end(); refuse(); }
    })();
    return opening;
  }
  async function configure(input: ReturnType<typeof command>, signal: AbortSignal, deadline: number): Promise<void> {
    const checkpoint = () => { if (signal.aborted || Date.now() >= deadline) refuse(); };
    checkpoint();
    const client = await (await connected()).connect();
    let begun = false;
    try {
      checkpoint(); await client.query('BEGIN'); begun = true;
      const rows = (await client.query('SELECT * FROM noticeos_platform.lock_task_catalog($1::uuid,$2::uuid)',
        [input.workspaceId, input.projectId])).rows as Record<string, unknown>[];
      const row = rows[0];
      if (rows.length !== 1 || !row || row.workspace_id !== input.workspaceId || row.project_id !== input.projectId
        || typeof row.executor_ref !== 'string' || !UUID.test(row.executor_ref)
        || typeof row.credential_ref !== 'string' || !UUID.test(row.credential_ref)
        || typeof row.database_key !== 'string' || !/^n_[0-9a-f]{32}$/u.test(row.database_key)) refuse();
      const mapping = Object.freeze({ workspaceId: input.workspaceId, projectId: input.projectId,
        executorRef: row.executor_ref, credentialRef: row.credential_ref, databaseKey: row.database_key });
      checkpoint();
      // Await cancellation/cleanup before releasing SQL locks, even on failure.
      await verifyProject(mapping, Object.freeze({ signal, deadline: Math.min(deadline, Date.now() + 30000), expectedPrefix: input.prefix }));
      checkpoint();
      await client.query('SELECT noticeos_platform.set_task_catalog($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8)',
        [mapping.workspaceId, mapping.projectId, mapping.executorRef, mapping.credentialRef, mapping.databaseKey,
          input.logicalKey, input.displayName, input.prefix]);
      checkpoint(); await client.query('COMMIT'); begun = false;
    } catch { if (begun) await client.query('ROLLBACK'); refuse(); }
    finally { client.release(); }
  }
  return Object.freeze({
    configure(input: unknown) {
      let captured: ReturnType<typeof command>;
      try { if (closed) refuse(); captured = command(input); } catch { return Promise.reject(new TaskCatalogRefused()); }
      const controller = new AbortController(), deadline = Date.now() + 60000;
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 60000);
      const work = configure(captured, controller.signal, deadline).finally(() => {
        clearTimeout(timer); controllers.delete(controller);
      });
      pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const controller of controllers) controller.abort();
      closing = (async () => { await Promise.allSettled([...pending]); await pool?.end(); })();
      return closing;
    },
  });
}
