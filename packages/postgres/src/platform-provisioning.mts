/** Private platform setup, not a customer route or membership administrator.
 * Existing installations require operator-approved schema/role maintenance.
 * Preparation grants no membership; activation requires real task verification.
 */
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { openIdentity } from './identity.mjs';
import { identityEngine, validateIdentityOptions, UUID, type IdentityDatabase } from './identity-engine.mjs';
import type { TaskProjectMapping } from './task-directory.mjs';
import { releasedDefaultDocuments } from '../../../scripts/released-defaults.mjs';

export interface PlatformProvisioningOptions {
  readonly platformConnectionString: string;
  readonly identityConnectionString: string;
  readonly trustedOrigin: string;
  readonly sessionSecret: string;
  /** Fixed trusted server composition. It verifies the real physical target,
   * checks factory custody in its own realm, and awaits cleanup on cancellation.
   * No readiness boolean or claimed branded result is accepted from a caller.
   */
  readonly verifyProject: (mapping: TaskProjectMapping, budget: {
    readonly signal: AbortSignal; readonly deadline: number;
  }) => Promise<void>;
}
export interface PreparedWorkspace {
  readonly workspaceId: string;
  readonly enrollmentId: string;
}
export interface PlatformProvisioning {
  prepare(input: unknown): Promise<PreparedWorkspace>;
  activate(input: unknown): Promise<PreparedWorkspace>;
  close(): Promise<void>;
}
export class PlatformProvisioningRefused extends Error {
  override name = 'PlatformProvisioningRefused';
  constructor() { super('Platform provisioning refused'); }
}
function refuse(): never { throw new PlatformProvisioningRefused(); }
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) refuse();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !field || !('value' in field)) refuse();
    result[key] = field.value as unknown;
  }
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) refuse();
  return result;
}
function uuid(input: unknown): string {
  if (typeof input !== 'string' || !UUID.test(input)) refuse();
  return input;
}
function boundedConnection(input: string): string {
  let connection: URL;
  try { connection = new URL(input); } catch { refuse(); }
  if (!['postgres:', 'postgresql:'].includes(connection.protocol) || !connection.hostname
    || !connection.username || connection.pathname.length < 2 || connection.hash) refuse();
  for (const key of ['options', 'statement_timeout', 'lock_timeout', 'query_timeout', 'connectionTimeoutMillis', 'connect_timeout']) {
    connection.searchParams.delete(key);
  }
  connection.searchParams.set('statement_timeout', '5000');
  connection.searchParams.set('lock_timeout', '5000');
  connection.searchParams.set('query_timeout', '6000');
  return connection.href;
}
function preparation(input: unknown) {
  const row = record(input, ['workspaceId', 'slug', 'displayName', 'intendedEmail', 'expiresAt']);
  const workspaceId = uuid(row.workspaceId);
  if (typeof row.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(row.slug)
    || typeof row.displayName !== 'string' || row.displayName.length < 1 || row.displayName.length > 80
    || row.displayName.trim() !== row.displayName || /[\u0000-\u001f\u007f]/u.test(row.displayName)
    || typeof row.intendedEmail !== 'string' || row.intendedEmail.length > 320
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(row.intendedEmail)
    || typeof row.expiresAt !== 'string') refuse();
  const expires = Date.parse(row.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expires) || expires <= now || expires > now + 7 * 86400000) refuse();
  return Object.freeze({ workspaceId, slug: row.slug, displayName: row.displayName,
    intendedEmail: row.intendedEmail.toLowerCase(), expiresAt: new Date(expires).toISOString() });
}
const ROLE_SQL = `SELECT session_user::text AS session_role,current_user::text AS acting_role,
  r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication AS elevated,
  EXISTS(SELECT 1 FROM pg_catalog.pg_roles other WHERE other.rolname<>current_user
    AND pg_catalog.pg_has_role(current_user,other.oid,'MEMBER')) AS another_role,
  pg_catalog.has_schema_privilege(current_user,'noticeos','USAGE') OR
  pg_catalog.has_schema_privilege(current_user,'noticeos_platform','CREATE') OR
  pg_catalog.has_schema_privilege(current_user,'noticeos_identity','CREATE') OR
  EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='noticeos' AND c.relkind='r'
      AND (pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) OR
  pg_catalog.has_table_privilege(current_user,'noticeos_identity.auth_user','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
  pg_catalog.has_any_column_privilege(current_user,'noticeos_identity.auth_user','INSERT,UPDATE,REFERENCES') OR
  pg_catalog.has_table_privilege(current_user,'noticeos_identity.auth_organization','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
  pg_catalog.has_any_column_privilege(current_user,'noticeos_identity.auth_organization','INSERT,UPDATE,REFERENCES') OR
  pg_catalog.has_table_privilege(current_user,'noticeos_identity.auth_member','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
  pg_catalog.has_any_column_privilege(current_user,'noticeos_identity.auth_member','UPDATE,REFERENCES') OR
  EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='noticeos_identity' AND c.relname NOT IN ('auth_user','auth_organization','auth_member')
      AND c.relkind='r' AND (pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS broad_access,
  pg_catalog.has_table_privilege(current_user,'noticeos_identity.auth_user','SELECT') AND
  pg_catalog.has_table_privilege(current_user,'noticeos_identity.auth_organization','SELECT') AND
  pg_catalog.has_table_privilege(current_user,'noticeos_identity.auth_member','SELECT') AND
  pg_catalog.has_table_privilege(current_user,'noticeos_identity.auth_member','INSERT') AND
  pg_catalog.has_function_privilege(current_user,'noticeos_platform.prepare_workspace(uuid,text,text,text,timestamptz,jsonb)','EXECUTE') AND
  pg_catalog.has_function_privilege(current_user,'noticeos_platform.lock_workspace_activation(uuid,uuid,uuid,jsonb)','EXECUTE') AND
  pg_catalog.has_function_privilege(current_user,'noticeos_platform.complete_workspace_activation(uuid,uuid,uuid,jsonb)','EXECUTE') AS required_access
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;

/** Lazy server composition. All command fields/defaults are captured before I/O.
 * Caller transport and platform-operator authorization are separate entry work.
 */
export function openPlatformProvisioning(input: PlatformProvisioningOptions): PlatformProvisioning {
  const options = Object.freeze({ platformConnectionString: boundedConnection(input.platformConnectionString),
    identityConnectionString: boundedConnection(input.identityConnectionString), trustedOrigin: input.trustedOrigin,
    sessionSecret: input.sessionSecret, verifyProject: input.verifyProject });
  validateIdentityOptions({ connectionString: options.identityConnectionString,
    trustedOrigin: options.trustedOrigin, sessionSecret: options.sessionSecret });
  if (typeof options.verifyProject !== 'function') refuse();
  const documents = JSON.stringify(releasedDefaultDocuments());
  let database: Kysely<IdentityDatabase> | undefined;
  let opening: Promise<Kysely<IdentityDatabase>> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<PreparedWorkspace>>();
  async function connected(): Promise<Kysely<IdentityDatabase>> {
    if (opening) return opening;
    opening = (async () => {
      // Full supported identity preflight uses its existing low-privilege role;
      // platform role never gains protocol-table SELECT merely for introspection.
      const identity = await openIdentity({ connectionString: options.identityConnectionString,
        trustedOrigin: options.trustedOrigin, sessionSecret: options.sessionSecret });
      await identity.close();
      const pool = new Pool({ connectionString: options.platformConnectionString, max: 2,
        connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, statement_timeout: 5000,
        lock_timeout: 5000, query_timeout: 6000 });
      pool.on('error', () => undefined);
      try {
        const role = (await pool.query(ROLE_SQL)).rows[0] as Record<string, unknown> | undefined;
        if (role?.session_role !== 'noticeos_platform' || role.acting_role !== 'noticeos_platform'
          || role.elevated !== false || role.another_role !== false || role.broad_access !== false
          || role.required_access !== true) refuse();
        database = new Kysely<IdentityDatabase>({ dialect: new PostgresDialect({ pool }) });
        return database;
      } catch {
        await pool.end();
        refuse();
      }
    })();
    return opening;
  }
  async function transaction(work: (db: Kysely<IdentityDatabase>, signal: AbortSignal, deadline: number) => Promise<PreparedWorkspace>) {
    const controller = new AbortController();
    const deadline = Date.now() + 60000;
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const db = await connected();
      if (controller.signal.aborted) refuse();
      return await work(db, controller.signal, deadline);
    } catch { refuse(); }
    finally { clearTimeout(timer); }
  }
  function track(work: Promise<PreparedWorkspace>) {
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }
  return Object.freeze({
    prepare(input: unknown) {
      if (closed) return Promise.reject(new PlatformProvisioningRefused());
      let command: ReturnType<typeof preparation>;
      try { command = preparation(input); } catch { return Promise.reject(new PlatformProvisioningRefused()); }
      return track(transaction(async (db, signal) => db.transaction().execute(async trx => {
        if (signal.aborted) refuse();
        const result = await sql<{ enrollment_id: string }>`SELECT noticeos_platform.prepare_workspace(
          ${command.workspaceId}::uuid,${command.slug},${command.displayName},${command.intendedEmail},
          ${command.expiresAt}::timestamptz,${documents}::jsonb) AS enrollment_id`.execute(trx);
        const enrollmentId = result.rows[0]?.enrollment_id;
        if (!enrollmentId || !UUID.test(enrollmentId) || signal.aborted) refuse();
        return Object.freeze({ workspaceId: command.workspaceId, enrollmentId });
      })));
    },
    activate(input: unknown) {
      if (closed) return Promise.reject(new PlatformProvisioningRefused());
      let command: Readonly<{ workspaceId: string; enrollmentId: string; projectId: string }>;
      try {
        const row = record(input, ['workspaceId', 'enrollmentId', 'projectId']);
        command = Object.freeze({ workspaceId: uuid(row.workspaceId), enrollmentId: uuid(row.enrollmentId), projectId: uuid(row.projectId) });
      } catch { return Promise.reject(new PlatformProvisioningRefused()); }
      return track(transaction(async (db, signal, deadline) => db.transaction().execute(async trx => {
        if (signal.aborted) refuse();
        const result = await sql<{ person_id: string; project_id: string; executor_ref: string; credential_ref: string; database_key: string }>`
          SELECT * FROM noticeos_platform.lock_workspace_activation(${command.workspaceId}::uuid,
            ${command.enrollmentId}::uuid,${command.projectId}::uuid,${documents}::jsonb)`.execute(trx);
        const row = result.rows[0];
        if (!row || result.rows.length !== 1 || !UUID.test(row.person_id)
          || row.project_id !== command.projectId || !UUID.test(row.executor_ref) || !UUID.test(row.credential_ref)
          || !/^n_[0-9a-f]{32}$/u.test(row.database_key) || signal.aborted) refuse();
        const mapping = Object.freeze({ workspaceId: command.workspaceId, projectId: row.project_id,
          executorRef: row.executor_ref, credentialRef: row.credential_ref, databaseKey: row.database_key });
        // Never race away from this promise: locks remain held until the real
        // verifier settles after its exact process/profile cleanup.
        await options.verifyProject(mapping, Object.freeze({ signal, deadline: Math.min(deadline, Date.now() + 30000) }));
        if (signal.aborted) refuse();
        await identityEngine(trx, { connectionString: options.platformConnectionString,
          trustedOrigin: options.trustedOrigin, sessionSecret: options.sessionSecret },
          { transaction: false, validateSchema: false }).api.addMember({ body: {
            organizationId: command.workspaceId, userId: row.person_id, role: 'owner',
          } });
        if (signal.aborted) refuse();
        await sql`SELECT noticeos_platform.complete_workspace_activation(${command.workspaceId}::uuid,
          ${command.enrollmentId}::uuid,${command.projectId}::uuid,${documents}::jsonb)`.execute(trx);
        if (signal.aborted) refuse();
        return Object.freeze({ workspaceId: command.workspaceId, enrollmentId: command.enrollmentId });
      })));
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => { await Promise.allSettled([...pending]); await database?.destroy(); })();
      return closing;
    },
  });
}
