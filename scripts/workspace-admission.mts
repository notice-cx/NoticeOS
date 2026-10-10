import { createBrowserRequestPolicy, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { googleOAuthRequest } from './workspace-operations.mjs';
import { agentActions, bearerToken } from './agent-access.mjs';

/** Shared workspace admission.
 * Server composition selects this entry and its fresh authority readers.
 * Request selectors, UUIDs, profile handles and identity facts are not authority.
 * Route mapping, identity protocols and operational capabilities live elsewhere.
 */
export type WorkspaceStatus = 'active' | 'provisioning' | 'suspended';
export type WorkspaceRole = 'owner' | 'operator' | 'viewer';
type Category = 'stored-read' | 'provider-read' | 'write' | 'human-decision' | 'membership' | 'protected';
const rule = (category: Category, demo = false) => Object.freeze({ category, demo });
const ACTIONS = Object.freeze({
  'evidence.read': rule('stored-read', true),
  'tasks.read': rule('stored-read', true),
  'settings.read': rule('stored-read', true),
  'workflows.read': rule('stored-read', true),
  'integrations.summary.read': rule('stored-read', true),
  'provider.read': rule('provider-read'),
  'assets.write': rule('write'),
  'findings.write': rule('write'),
  'annotations.write': rule('write'),
  'tasks.write': rule('write'),
  'tasks.decide': rule('human-decision'),
  'settings.write': rule('write'),
  'integrations.write': rule('write'),
  'workflows.run': rule('write'),
  'memberships.manage': rule('membership'),
  'measurement.write': rule('protected'),
  'identity.manage': rule('protected'),
  'credentials.rotate-key': rule('protected'),
  'platform.maintain': rule('protected'),
});
export type WorkspaceAction = keyof typeof ACTIONS;

export interface WorkspaceMembership {
  readonly principalId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  /** Canonical lifecycle read with the current membership/session observation. */
  readonly workspaceStatus: WorkspaceStatus;
}
export interface GoogleOAuthAdmissionAdapter {
  /** Server-owned transaction adapters. Call authorize exactly once with fresh
   * immutable facts; resolve only after issuance/consumption COMMIT. */
  issue(request: Request, workspaceId: string, authorize: (facts: WorkspaceMembership) => void): Promise<string>;
  claim(request: Request, authorize: (facts: WorkspaceMembership) => void): Promise<void>;
}
/** A verified agent token's fresh facts in the workspace a call names
 * (identity agentAuthority): the person it acts for, the
 * client, the person's current role there and the scopes still consented. */
export interface AgentAuthority {
  readonly principalId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  readonly workspaceStatus: WorkspaceStatus;
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}
export interface StandaloneAuthority {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly workspaceStatus: WorkspaceStatus;
}
export interface ServiceAuthority extends StandaloneAuthority {
  readonly expiresAt: string;
  readonly actions: readonly string[];
}
interface EntryBase {
  /** Opaque server-owned profile identity, not paths, credentials or a request key. */
  readonly profile: symbol;
  /** Test clock; server-owned, never supplied by the request. */
  readonly now?: () => number;
}
export type WorkspaceEntry = EntryBase & (
  | { readonly kind: 'hosted'; readonly trustedOrigin: string;
      readonly membership: (headers: Headers, workspaceId: string) => Promise<WorkspaceMembership | null>;
      readonly googleOAuth?: GoogleOAuthAdmissionAdapter;
      /** Verifies a bearer request's agent token and reads its person's
       * membership in the requested workspace. Without it, a bearer request
       * is refused. */
      readonly agent?: (request: Request, workspaceId: string) => Promise<AgentAuthority | null> }
  | { readonly kind: 'standalone';
      /** Authenticate the existing door and resolve the sole workspace; ambiguity denies. */
      readonly authority: (request: Request) => Promise<StandaloneAuthority | null> }
  | { readonly kind: 'demo'; readonly workspaceId: string;
      readonly workspaceStatus: (workspaceId: string) => Promise<WorkspaceStatus | null> }
  | { readonly kind: 'service';
      /** Authenticate original service proof and reload its scoped grant on every call. */
      readonly authority: (request: Request) => Promise<ServiceAuthority | null> }
);
export interface WorkspaceSelection {
  readonly requestedWorkspaceId?: string;
  readonly correlationId: string;
}
export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly principalKind: 'person' | 'agent' | 'standalone-operator' | 'demo-reader' | 'workspace-service';
  /** Only person contexts carry this from the same fresh membership facts. */
  readonly sessionId?: string;
  /** Only agent contexts carry this: the OAuth client acting for the person. */
  readonly agentClientId?: string;
  readonly entryProfile: WorkspaceEntry['kind'];
  readonly profile: symbol;
  readonly action: WorkspaceAction;
  readonly correlationId: string;
  /** Fresh permission summary for this operation's UI only. A later request
   * still needs new admission; serialized/copied contexts grant nothing. */
  readonly allowedActions: readonly WorkspaceAction[];
}
export interface WorkspaceAdmission {
  /** Await all operation work here. Queued/resumed work requires fresh admission.
   * Same-operation helpers may read required settings without upgrading action. */
  withAdmission<T>(action: WorkspaceAction, selection: WorkspaceSelection, proof: Request,
    work: (context: WorkspaceContext) => Promise<T>): Promise<T>;
  /** Accept only this factory's live context for the same semantic operation. */
  assertContext(context: unknown, action: WorkspaceAction): asserts context is WorkspaceContext;
  /** Fixed hosted Google entries only. They are not general protocol bypasses. */
  withGoogleStart<T>(correlationId: string, proof: Request,
    work: (context: WorkspaceContext, state: string) => Promise<T>): Promise<T>;
  withGoogleCallback<T>(correlationId: string, proof: Request,
    work: (context: WorkspaceContext) => Promise<T>): Promise<T>;
}
export class AdmissionRefused extends Error {
  override name = 'AdmissionRefused';
  constructor() { super('Workspace action is not authorized.'); }
}
function refuse(): never { throw new AdmissionRefused(); }
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse();
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) refuse();
  const row: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !field || !('value' in field)) refuse();
    row[key] = field.value as unknown;
  }
  return row;
}
function keys(row: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(row, key))
    || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) refuse();
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)) refuse();
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)) refuse();
  return value;
}
function actionCategory(action: unknown): Category {
  if (typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) refuse();
  return ACTIONS[action as WorkspaceAction].category;
}
function expiry(value: unknown, now: number): void {
  if (!Number.isFinite(now) || typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= now) refuse();
}
async function fresh<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch { refuse(); }
}
function active(value: unknown): void { if (value !== 'active') refuse(); }
function permissionActions(kind: WorkspaceEntry['kind'], role?: WorkspaceRole, grant?: readonly WorkspaceAction[]): readonly WorkspaceAction[] {
  return Object.freeze((Object.keys(ACTIONS) as WorkspaceAction[]).filter(action => {
    const { category, demo } = ACTIONS[action];
    if (category === 'protected') return false;
    if (kind === 'demo') return demo;
    if (kind === 'service') return category !== 'membership' && category !== 'human-decision' && grant!.includes(action);
    if (kind === 'hosted') return role === 'viewer' ? category === 'stored-read'
      : category !== 'membership' || role === 'owner';
    return true;
  }));
}

export function createWorkspaceAdmission(input: WorkspaceEntry): WorkspaceAdmission {
  const entry = record(input);
  const kind = entry.kind;
  if (typeof kind !== 'string' || !['hosted', 'standalone', 'demo', 'service'].includes(kind) || typeof entry.profile !== 'symbol') refuse();
  const specific = kind === 'hosted' ? ['trustedOrigin', 'membership'] : kind === 'demo' ? ['workspaceId', 'workspaceStatus'] : ['authority'];
  keys(entry, ['kind', 'profile', ...specific], ['now', ...(kind === 'hosted' ? ['googleOAuth', 'agent'] : [])]);
  if (entry.now !== undefined && typeof entry.now !== 'function') refuse();
  const clock = (entry.now ?? Date.now) as () => number;
  function checkedClock(): number {
    let now: number;
    try { now = clock(); } catch { refuse(); }
    if (!Number.isFinite(now)) refuse();
    return now;
  }
  const profile = entry.profile;
  let browserPolicy: ReturnType<typeof createBrowserRequestPolicy> | null = null;
  if (kind === 'hosted') {
    try { browserPolicy = createBrowserRequestPolicy(entry.trustedOrigin as string); } catch { refuse(); }
  }
  const trustedOrigin = browserPolicy?.origin ?? null;
  const demoWorkspace = kind === 'demo' ? uuid(entry.workspaceId) : null;
  const reader = kind === 'hosted' ? entry.membership : kind === 'demo' ? entry.workspaceStatus : entry.authority;
  if (typeof reader !== 'function') refuse();
  if (entry.agent !== undefined && typeof entry.agent !== 'function') refuse();
  const agentReader = entry.agent as Extract<WorkspaceEntry, { kind: 'hosted' }>['agent'];
  let google: GoogleOAuthAdmissionAdapter | undefined;
  if (entry.googleOAuth !== undefined) {
    const adapter = record(entry.googleOAuth); keys(adapter, ['issue', 'claim']);
    if (typeof adapter.issue !== 'function' || typeof adapter.claim !== 'function') refuse();
    google = Object.freeze({ issue: adapter.issue, claim: adapter.claim }) as unknown as GoogleOAuthAdmissionAdapter;
  }
  const live = new WeakSet<object>();
  function personFacts(input: unknown, requested: string | null) {
    const row = record(input);
    keys(row, ['principalId', 'sessionId', 'expiresAt', 'workspaceId', 'role', 'workspaceStatus']);
    const workspaceId = uuid(row.workspaceId), principalId = uuid(row.principalId), sessionId = identifier(row.sessionId);
    if (requested !== null && workspaceId !== requested) refuse();
    expiry(row.expiresAt, checkedClock()); active(row.workspaceStatus);
    if (typeof row.role !== 'string' || !['owner', 'operator', 'viewer'].includes(row.role)) refuse();
    return Object.freeze({ workspaceId, principalId, sessionId, expiresAt: row.expiresAt as string,
      allowedActions: permissionActions('hosted', row.role as WorkspaceRole) });
  }
  function agentFacts(input: unknown, requested: string | null) {
    const row = record(input);
    keys(row, ['principalId', 'clientId', 'workspaceId', 'role', 'workspaceStatus', 'expiresAt', 'scopes']);
    const workspaceId = uuid(row.workspaceId), principalId = uuid(row.principalId);
    if (typeof row.clientId !== 'string' || !/^[A-Za-z0-9._~:-]{1,512}$/u.test(row.clientId)) refuse();
    if (requested !== null && workspaceId !== requested) refuse();
    expiry(row.expiresAt, checkedClock()); active(row.workspaceStatus);
    if (typeof row.role !== 'string' || !['owner', 'operator', 'viewer'].includes(row.role)) refuse();
    if (!Array.isArray(row.scopes) || row.scopes.length > 16 || row.scopes.some(scope => typeof scope !== 'string')) refuse();
    // The person's current role bounds what any scope can grant.
    const granted = agentActions(row.scopes as string[]);
    const allowedActions = Object.freeze(permissionActions('hosted', row.role as WorkspaceRole).filter(action => granted.includes(action)));
    return Object.freeze({ workspaceId, principalId, clientId: row.clientId, allowedActions });
  }
  // Capture the tab's expected session before asynchronous identity reads.
  // This is a binding constraint, never client-supplied permission.
  function browserSessionCheck(proof: Request): (person: { readonly sessionId: string }) => void {
    const expected = uuid(proof.headers.get(WORKSPACE_SESSION_HEADER));
    return person => { if (person.sessionId !== expected) refuse(); };
  }
  async function googleOperation<T>(phase: 'start' | 'callback', correlation: string, request: Request,
    work: (context: WorkspaceContext, state?: string) => Promise<T>): Promise<T> {
    if (kind !== 'hosted' || !google || !(request instanceof Request) || typeof work !== 'function') refuse();
    const correlationId = identifier(correlation);
    let proof: Request;
    try { proof = request.clone(); } catch { refuse(); }
    let requested: string | null = null;
    try {
      if (phase === 'start') { requested = (await googleOAuthRequest(proof, trustedOrigin!, 'start')).workspaceId; browserPolicy!.assertEffect(proof); }
      else googleOAuthRequest(proof, trustedOrigin!, 'callback');
    } catch { refuse(); }
    const checkSession = phase === 'start' ? browserSessionCheck(proof) : null;
    checkedClock();
    let snapshot: ReturnType<typeof personFacts> | undefined, calls = 0;
    const authorize = (facts: WorkspaceMembership): void => {
      if (++calls !== 1) refuse();
      const authorized = personFacts(facts, requested);
      checkSession?.(authorized);
      if (!authorized.allowedActions.includes('integrations.write')) refuse();
      snapshot = authorized;
    };
    let state: string | undefined;
    if (phase === 'start') state = await fresh(() => google!.issue(proof, requested!, authorize));
    else await fresh(() => google!.claim(proof, authorize));
    if (calls !== 1 || !snapshot || (phase === 'start' && (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(state)))) refuse();
    // Adapter resolution means the identity transaction committed. A late
    // expiry or invalid clock cannot release provider/store capability.
    expiry(snapshot.expiresAt, checkedClock());
    const context = Object.freeze({ workspaceId: snapshot.workspaceId, principalId: snapshot.principalId,
      sessionId: snapshot.sessionId, principalKind: 'person' as const, entryProfile: 'hosted' as const,
      profile, action: 'integrations.write' as const, correlationId, allowedActions: snapshot.allowedActions });
    live.add(context);
    try { return await work(context, state); } finally { live.delete(context); }
  }
  return Object.freeze({
    async withAdmission<T>(action: WorkspaceAction, inputSelection: WorkspaceSelection, request: Request, work: (context: WorkspaceContext) => Promise<T>): Promise<T> {
      const category = actionCategory(action);
      if (category === 'protected' || typeof work !== 'function' || !(request instanceof Request)) refuse();
      const selection = record(inputSelection);
      keys(selection, ['correlationId'], ['requestedWorkspaceId']);
      const correlationId = identifier(selection.correlationId);
      const requested = selection.requestedWorkspaceId === undefined ? null : uuid(selection.requestedWorkspaceId);
      // Snapshot untrusted request proof before any asynchronous authority read.
      let proof: Request;
      try { proof = request.clone(); } catch { refuse(); }
      checkedClock();
      let workspaceId: string, principalId: string, principalKind: WorkspaceContext['principalKind'], sessionId: string | undefined;
      let agentClientId: string | undefined;
      let allowedActions: readonly WorkspaceAction[];
      const bearer = bearerToken(proof.headers);
      if (bearer === false || (bearer !== null && (kind !== 'hosted' || !agentReader))) refuse();
      if (bearer !== null) {
        // An agent's token carries no ambient browser credential, so the
        // browser effect and tab-session checks do not apply. It covers its
        // person's workspaces; each call names one, read fresh here.
        if (!requested || new URL(proof.url).origin !== trustedOrigin) refuse();
        const facts = await fresh(() => agentReader!(proof, requested));
        if (!facts) refuse();
        const agent = agentFacts(facts, requested);
        ({ workspaceId, principalId, allowedActions } = agent);
        agentClientId = agent.clientId;
        principalKind = 'agent';
      } else if (kind === 'hosted') {
        if (!requested || new URL(proof.url).origin !== trustedOrigin) refuse();
        if (category !== 'stored-read') {
          try { browserPolicy!.assertEffect(proof); } catch { refuse(); }
        }
        const checkSession = browserSessionCheck(proof);
        const facts = await fresh(() => (reader as Extract<WorkspaceEntry, { kind: 'hosted' }>['membership'])(proof.headers, requested));
        if (!facts) refuse();
        const person = personFacts(facts, requested);
        checkSession(person);
        ({ workspaceId, principalId, sessionId, allowedActions } = person);
        principalKind = 'person';
      } else if (kind === 'demo') {
        if (!ACTIONS[action].demo || (requested !== null && requested !== demoWorkspace)) refuse();
        workspaceId = demoWorkspace!; principalId = 'demo-reader'; principalKind = 'demo-reader';
        active(await fresh(() => (reader as Extract<WorkspaceEntry, { kind: 'demo' }>['workspaceStatus'])(workspaceId)));
        allowedActions = permissionActions('demo');
      } else {
        const facts = await fresh(() => (reader as Extract<WorkspaceEntry, { kind: 'standalone' | 'service' }>['authority'])(proof));
        if (!facts) refuse();
        const row = record(facts);
        keys(row, ['principalId', 'workspaceId', 'workspaceStatus', ...(kind === 'service' ? ['expiresAt', 'actions'] : [])]);
        workspaceId = uuid(row.workspaceId); principalId = identifier(row.principalId); active(row.workspaceStatus);
        if (requested !== null && requested !== workspaceId) refuse();
        if (kind === 'service') {
          expiry(row.expiresAt, checkedClock());
          if (!Array.isArray(row.actions) || row.actions.length > Object.keys(ACTIONS).length || row.actions.some(value => {
              const category = actionCategory(value);
              return category === 'protected' || category === 'membership' || category === 'human-decision';
            })) refuse();
          allowedActions = permissionActions('service', undefined, row.actions as WorkspaceAction[]);
        } else {
          allowedActions = permissionActions('standalone');
        }
        principalKind = kind === 'service' ? 'workspace-service' : 'standalone-operator';
      }
      checkedClock();
      if (!allowedActions.includes(action)) refuse();
      const context = Object.freeze({ workspaceId, principalId, principalKind, ...(sessionId ? { sessionId } : {}),
        ...(agentClientId ? { agentClientId } : {}),
        entryProfile: kind as WorkspaceEntry['kind'], profile, action, correlationId, allowedActions });
      live.add(context);
      try { return await work(context); } finally { live.delete(context); }
    },
    assertContext(context: unknown, action: WorkspaceAction): asserts context is WorkspaceContext {
      actionCategory(action);
      if (!context || typeof context !== 'object' || !live.has(context)
        || (context as WorkspaceContext).action !== action || (context as WorkspaceContext).profile !== profile) refuse();
    },
    async withGoogleStart<T>(correlationId: string, request: Request,
      work: (context: WorkspaceContext, state: string) => Promise<T>): Promise<T> {
      if (typeof work !== 'function') refuse();
      return googleOperation('start', correlationId, request, (context, state) => work(context, state!));
    },
    withGoogleCallback<T>(correlationId: string, request: Request,
      work: (context: WorkspaceContext) => Promise<T>): Promise<T> {
      return googleOperation('callback', correlationId, request, work);
    },
  });
}
