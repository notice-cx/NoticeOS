/** Private platform setup, not a customer route or membership administrator.
 * Existing installations require operator-approved schema/role maintenance.
 * Preparation grants no membership; activation requires real task verification.
 */
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { openIdentity } from './identity.mjs';
import { hasConflictingLegacyMailbox, identityEngine, openIdentityDatabase, validateIdentityOptions, UUID, type IdentityDatabase } from './identity-engine.mjs';
import type { TaskProjectMapping } from './task-directory.mjs';
import { releasedDefaultDocuments } from '../../../scripts/released-defaults.mjs';

export interface PlatformProvisioningOptions {
  readonly platformConnectionString: string;
  readonly identityConnectionString: string;
  readonly trustedOrigin: string;
  readonly localTowerOrigin?: string;
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
  prepare(input: unknown, project?: unknown): Promise<PreparedWorkspace>;
  recoverPreparation(input: unknown, project: unknown): Promise<PreparedWorkspace>;
  activate(input: unknown, scheduler?: { serviceId: string; intendedEmail: string }): Promise<PreparedWorkspace>;
  prepareStandaloneOwner(input: unknown): Promise<PreparedWorkspace>;
  activateStandaloneOwner(input: unknown): Promise<PreparedWorkspace & { readonly serviceId: string }>;
  close(): Promise<void>;
}
export class PlatformProvisioningRefused extends Error {
  override name = 'PlatformProvisioningRefused';
  constructor() { super('Platform provisioning refused'); }
}
export class StandaloneOwnerMigrationRequired extends Error {
  override name = 'StandaloneOwnerMigrationRequired';
  constructor() { super('Apply the standalone owner handoff migration with the operator migration command first.'); }
}
export class PlatformProjectReserved extends Error {
  override name = 'PlatformProjectReserved';
  constructor() { super('That Ntasks project is already reserved for another workspace.'); }
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
    || row.displayName.trim() !== row.displayName || /[\u0000-\u001f\u007f]/u.test(row.displayName)) refuse();
  return Object.freeze({ workspaceId, slug: row.slug, displayName: row.displayName,
    ...intendedOwner(row.intendedEmail, row.expiresAt) });
}
function ownerEmail(input: unknown): string {
  if (typeof input !== 'string' || input.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input)) refuse();
  return input.toLowerCase();
}
function intendedOwner(intendedEmail: unknown, expiresAt: unknown) {
  if (typeof expiresAt !== 'string') refuse();
  const expires = Date.parse(expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expires) || expires <= now || expires > now + 7 * 86400000) refuse();
  return { intendedEmail: ownerEmail(intendedEmail), expiresAt: new Date(expires).toISOString() };
}
function initialProject(input: unknown): Omit<TaskProjectMapping, 'workspaceId'> {
  const row = record(input, ['projectId', 'executorRef', 'credentialRef', 'databaseKey']);
  if (typeof row.databaseKey !== 'string' || !/^n_[0-9a-f]{32}$/u.test(row.databaseKey)) refuse();
  return { projectId: uuid(row.projectId), executorRef: uuid(row.executorRef),
    credentialRef: uuid(row.credentialRef), databaseKey: row.databaseKey };
}
async function lockAvailableProject(trx: Transaction<IdentityDatabase>, workspaceId: string, projectId: string) {
  // The physical project UUID also identifies reservations written by the
  // standalone adopter, whose executor and database references differ.
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('noticeos:initial-task-project:' || ${projectId}::text, 0))`.execute(trx);
  const existing = await sql`SELECT 1 FROM noticeos_platform.task_project_directory
    WHERE project_id=${projectId}::uuid AND workspace_id<>${workspaceId}::uuid LIMIT 1`.execute(trx);
  if (existing.rows.length) throw new PlatformProjectReserved();
}
function standaloneBinding(row: Record<string, unknown>) {
  if (typeof row.ntasksOrigin !== 'string' || row.ntasksOrigin.length > 512) refuse();
  let origin: URL;
  try { origin = new URL(row.ntasksOrigin); } catch { refuse(); }
  if (origin.origin !== row.ntasksOrigin || (origin.protocol !== 'https:'
    && (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'))) refuse();
  return { workspaceId: uuid(row.workspaceId), projectId: uuid(row.projectId),
    ntasksWorkspaceId: uuid(row.ntasksWorkspaceId), ntasksOrigin: origin.origin };
}

async function requireStandaloneSchema(trx: Transaction<IdentityDatabase>): Promise<void> {
  const result = await sql<{ installed: boolean }>`SELECT
    to_regprocedure('noticeos_platform.prepare_standalone_owner(uuid,text,timestamptz,text,uuid,uuid)') IS NOT NULL
    AND to_regprocedure('noticeos_platform.lock_standalone_owner(uuid,uuid,text,text,uuid,uuid)') IS NOT NULL
    AND to_regprocedure('noticeos_platform.complete_standalone_owner(uuid,uuid)') IS NOT NULL
    AND to_regprocedure('noticeos_identity.is_standalone_owner_enrollment(uuid,uuid)') IS NOT NULL AS installed`.execute(trx);
  if (result.rows[0]?.installed !== true) throw new StandaloneOwnerMigrationRequired();
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
    localTowerOrigin: input.localTowerOrigin,
    sessionSecret: input.sessionSecret, verifyProject: input.verifyProject });
  validateIdentityOptions({ connectionString: options.identityConnectionString,
    trustedOrigin: options.trustedOrigin, localTowerOrigin: options.localTowerOrigin, sessionSecret: options.sessionSecret });
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
        trustedOrigin: options.trustedOrigin, localTowerOrigin: options.localTowerOrigin, sessionSecret: options.sessionSecret });
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
  async function transaction<T extends PreparedWorkspace>(work: (db: Kysely<IdentityDatabase>, signal: AbortSignal, deadline: number) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const deadline = Date.now() + 60000;
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const db = await connected();
      if (controller.signal.aborted) refuse();
      return await work(db, controller.signal, deadline);
    } catch (error) {
      if (error instanceof StandaloneOwnerMigrationRequired || error instanceof PlatformProjectReserved) throw error;
      refuse();
    }
    finally { clearTimeout(timer); }
  }
  function track<T extends PreparedWorkspace>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }
  async function addFirstOwner(trx: Transaction<IdentityDatabase>, organizationId: string, userId: string): Promise<void> {
    await identityEngine(trx, { connectionString: options.platformConnectionString,
      trustedOrigin: options.trustedOrigin, localTowerOrigin: options.localTowerOrigin, sessionSecret: options.sessionSecret },
    { transaction: false, validateSchema: false }).api.addMember({ body: { organizationId, userId, role: 'owner' } });
  }
  return Object.freeze({
    prepare(input: unknown, projectInput?: unknown) {
      if (closed) return Promise.reject(new PlatformProvisioningRefused());
      let command: ReturnType<typeof preparation>;
      let project: ReturnType<typeof initialProject> | undefined;
      try {
        command = preparation(input);
        if (projectInput !== undefined) project = initialProject(projectInput);
      } catch { return Promise.reject(new PlatformProvisioningRefused()); }
      return track(transaction(async (db, signal) => db.transaction().setIsolationLevel('read committed').execute(async trx => {
        if (project) {
          if (await hasConflictingLegacyMailbox(trx, command.intendedEmail)) refuse();
          await lockAvailableProject(trx, command.workspaceId, project.projectId);
        }
        if (signal.aborted) refuse();
        const result = await sql<{ enrollment_id: string }>`SELECT noticeos_platform.prepare_workspace(
          ${command.workspaceId}::uuid,${command.slug},${command.displayName},${command.intendedEmail},
          ${command.expiresAt}::timestamptz,${documents}::jsonb) AS enrollment_id`.execute(trx);
        const enrollmentId = result.rows[0]?.enrollment_id;
        if (!enrollmentId || !UUID.test(enrollmentId) || signal.aborted) refuse();
        if (project) {
          await sql`INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key)
            VALUES (${command.workspaceId}::uuid, ${project.projectId}::uuid, ${project.executorRef}::uuid,
              ${project.credentialRef}::uuid, ${project.databaseKey})`.execute(trx);
        }
        if (signal.aborted) refuse();
        return Object.freeze({ workspaceId: command.workspaceId, enrollmentId });
      })));
    },
    recoverPreparation(input: unknown, projectInput: unknown) {
      if (closed) return Promise.reject(new PlatformProvisioningRefused());
      let expected: { workspaceId: string; displayName: string; intendedEmail: string };
      let project: ReturnType<typeof initialProject>;
      try {
        const row = record(input, ['workspaceId', 'displayName', 'intendedEmail']);
        if (typeof row.displayName !== 'string' || row.displayName.length < 1 || row.displayName.length > 80) refuse();
        expected = { workspaceId: uuid(row.workspaceId), displayName: row.displayName, intendedEmail: ownerEmail(row.intendedEmail) };
        project = initialProject(projectInput);
      } catch { return Promise.reject(new PlatformProvisioningRefused()); }
      return track(transaction(async (db, signal) => {
        const reservation = await sql`SELECT 1 FROM noticeos_platform.task_project_directory
          WHERE workspace_id=${expected.workspaceId}::uuid AND project_id=${project.projectId}::uuid
            AND executor_ref=${project.executorRef}::uuid AND credential_ref=${project.credentialRef}::uuid
            AND database_key=${project.databaseKey} AND revoked_at IS NULL`.execute(db);
        if (reservation.rows.length !== 1 || signal.aborted) refuse();
        const identity = await openIdentityDatabase({ connectionString: options.identityConnectionString, trustedOrigin: options.trustedOrigin,
          localTowerOrigin: options.localTowerOrigin, sessionSecret: options.sessionSecret });
        try {
          const result = await sql<{ id: string }>`SELECT e.id FROM noticeos_identity.platform_enrollment e
            JOIN LATERAL noticeos_identity.workspace_summary(e.workspace_id) w ON w.status='provisioning'
            WHERE e.workspace_id=${expected.workspaceId}::uuid AND e.email=${expected.intendedEmail} AND w.display_name=${expected.displayName}
              AND e.activated_at IS NULL AND e.revoked_at IS NULL AND e.expires_at>pg_catalog.clock_timestamp() LIMIT 2`.execute(identity.database);
          const enrollmentId = result.rows[0]?.id;
          if (result.rows.length !== 1 || !enrollmentId || !UUID.test(enrollmentId) || signal.aborted) refuse();
          return Object.freeze({ workspaceId: expected.workspaceId, enrollmentId });
        } finally { await identity.database.destroy(); }
      }));
    },
    activate(input: unknown, schedulerInput?: { serviceId: string; intendedEmail: string }) {
      if (closed) return Promise.reject(new PlatformProvisioningRefused());
      let command: Readonly<{ workspaceId: string; enrollmentId: string; projectId: string }>;
      let scheduler: { serviceId: string; intendedEmail: string } | undefined;
      try {
        const row = record(input, ['workspaceId', 'enrollmentId', 'projectId']);
        command = Object.freeze({ workspaceId: uuid(row.workspaceId), enrollmentId: uuid(row.enrollmentId), projectId: uuid(row.projectId) });
        if (schedulerInput !== undefined) {
          const grant = record(schedulerInput, ['serviceId', 'intendedEmail']);
          scheduler = { serviceId: uuid(grant.serviceId), intendedEmail: ownerEmail(grant.intendedEmail) };
        }
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
        if (scheduler) {
          const person = await sql<{ matches: boolean }>`SELECT lower(email)=${scheduler.intendedEmail} AS matches
            FROM noticeos_identity.auth_user WHERE id=${row.person_id}::uuid`.execute(trx);
          if (person.rows[0]?.matches !== true || signal.aborted) refuse();
        }
        const mapping = Object.freeze({ workspaceId: command.workspaceId, projectId: row.project_id,
          executorRef: row.executor_ref, credentialRef: row.credential_ref, databaseKey: row.database_key });
        // Never race away from this promise: locks remain held until the real
        // verifier settles after its exact process/profile cleanup.
        await options.verifyProject(mapping, Object.freeze({ signal, deadline: Math.min(deadline, Date.now() + 30000) }));
        if (signal.aborted) refuse();
        await addFirstOwner(trx, command.workspaceId, row.person_id);
        if (signal.aborted) refuse();
        await sql`SELECT noticeos_platform.complete_workspace_activation(${command.workspaceId}::uuid,
          ${command.enrollmentId}::uuid,${command.projectId}::uuid,${documents}::jsonb)`.execute(trx);
        if (scheduler) {
          await sql`INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at)
            VALUES (${scheduler.serviceId}::uuid, ${command.workspaceId}::uuid, ARRAY['workflows.run'], clock_timestamp() + interval '1 year')`.execute(trx);
        }
        if (signal.aborted) refuse();
        return Object.freeze({ workspaceId: command.workspaceId, enrollmentId: command.enrollmentId });
      })));
    },
    prepareStandaloneOwner(input: unknown) {
      if (closed) return Promise.reject(new PlatformProvisioningRefused());
      let command: ReturnType<typeof standaloneBinding> & ReturnType<typeof intendedOwner>;
      try {
        const row = record(input, ['workspaceId', 'ntasksWorkspaceId', 'ntasksOrigin', 'projectId', 'intendedEmail', 'expiresAt']);
        command = { ...standaloneBinding(row), ...intendedOwner(row.intendedEmail, row.expiresAt) };
      } catch { return Promise.reject(new PlatformProvisioningRefused()); }
      return track(transaction(async (db, signal) => db.transaction().setIsolationLevel('read committed').execute(async trx => {
        await requireStandaloneSchema(trx);
        await lockAvailableProject(trx, command.workspaceId, command.projectId);
        if (signal.aborted) refuse();
        const result = await sql<{ enrollment_id: string }>`SELECT noticeos_platform.prepare_standalone_owner(
          ${command.workspaceId}::uuid,${command.intendedEmail},${command.expiresAt}::timestamptz,${command.ntasksOrigin},
          ${command.ntasksWorkspaceId}::uuid,${command.projectId}::uuid) AS enrollment_id`.execute(trx);
        const enrollmentId = result.rows[0]?.enrollment_id;
        if (!enrollmentId || !UUID.test(enrollmentId) || signal.aborted) refuse();
        return Object.freeze({ workspaceId: command.workspaceId, enrollmentId });
      })));
    },
    activateStandaloneOwner(input: unknown) {
      if (closed) return Promise.reject(new PlatformProvisioningRefused());
      let command: ReturnType<typeof standaloneBinding> & { enrollmentId: string; intendedEmail: string };
      try {
        const row = record(input, ['workspaceId', 'ntasksWorkspaceId', 'ntasksOrigin', 'projectId', 'enrollmentId', 'intendedEmail']);
        command = { ...standaloneBinding(row), enrollmentId: uuid(row.enrollmentId), intendedEmail: ownerEmail(row.intendedEmail) };
      } catch { return Promise.reject(new PlatformProvisioningRefused()); }
      return track(transaction(async (db, signal, deadline) => db.transaction().execute(async trx => {
        await requireStandaloneSchema(trx);
        if (signal.aborted) refuse();
        const result = await sql<{ person_id: string; project_id: string; executor_ref: string; credential_ref: string;
          database_key: string; service_id: string; completed: boolean }>`SELECT * FROM noticeos_platform.lock_standalone_owner(
          ${command.workspaceId}::uuid,${command.enrollmentId}::uuid,${command.intendedEmail},${command.ntasksOrigin},${command.ntasksWorkspaceId}::uuid,
          ${command.projectId}::uuid)`.execute(trx);
        const row = result.rows[0];
        if (!row || result.rows.length !== 1 || !UUID.test(row.person_id) || !UUID.test(row.service_id)
          || typeof row.completed !== 'boolean' || row.project_id !== command.projectId || !UUID.test(row.executor_ref)
          || !UUID.test(row.credential_ref) || !/^n_[0-9a-f]{32}$/u.test(row.database_key) || signal.aborted) refuse();
        if (!row.completed) {
          const mapping = Object.freeze({ workspaceId: command.workspaceId, projectId: row.project_id,
            executorRef: row.executor_ref, credentialRef: row.credential_ref, databaseKey: row.database_key });
          await options.verifyProject(mapping, Object.freeze({ signal, deadline: Math.min(deadline, Date.now() + 30000) }));
          if (signal.aborted) refuse();
          await addFirstOwner(trx, command.workspaceId, row.person_id);
          const completed = await sql<{ service_id: string }>`SELECT noticeos_platform.complete_standalone_owner(
            ${command.workspaceId}::uuid,${command.enrollmentId}::uuid) AS service_id`.execute(trx);
          if (signal.aborted || completed.rows[0]?.service_id !== row.service_id) refuse();
        }
        return Object.freeze({ workspaceId: command.workspaceId, enrollmentId: command.enrollmentId, serviceId: row.service_id });
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
