import type { Transaction } from './store.mjs';

/** Evidence only. The receiver authorizes first and supplies fresh person
 * facts; this recorder grants no capability and opens no transaction. */
export interface MutationActor {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
}
export type MutationEvent =
  | { readonly event: 'asset.create'; readonly assetId: string; readonly subject: Record<string, never> }
  | { readonly event: 'asset.column'; readonly assetId: string; readonly subject: { readonly column: 'status' | 'sense_only' | 'display_name' } }
  | { readonly event: 'asset.move'; readonly assetId: string; readonly subject: { readonly to: string; readonly changedCount: number } }
  | { readonly event: 'decision.set'; readonly assetId: string; readonly subject: { readonly kind: 'query' | 'finding'; readonly key: string; readonly status: 'marked' | 'dismissed' } }
  | { readonly event: 'decision.clear'; readonly assetId: string; readonly subject: { readonly kind: 'query' | 'finding'; readonly key: string } }
  | { readonly event: 'annotation.create'; readonly assetId: string; readonly subject: { readonly annotationNumber: string; readonly kind: string } }
  | { readonly event: 'flag.acknowledge' | 'flag.resolve' | 'flag.snooze' | 'flag.unsnooze' | 'flag.tune'; readonly assetId: string; readonly subject: { readonly flagNumber: number; readonly changedCount: number } };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
function refused(): never { throw new Error('Mutation audit facts are invalid'); }
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) refused();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== names.length
    || names.some(name => !Object.hasOwn(descriptors, name)
      || !Object.hasOwn(descriptors[name]!, 'value'))) refused();
  const row: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) row[name] = descriptors[name]!.value as unknown;
  return row;
}
function text(value: unknown, maximum = Number.POSITIVE_INFINITY): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.includes('\u0000')) refused();
  return value;
}
function oneOf(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) refused();
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) refused();
  return value;
}
function subject(event: string, input: unknown): Record<string, unknown> {
  switch (event) {
    case 'asset.create': return fields(input, []);
    case 'asset.column': {
      const row = fields(input, ['column']);
      return { column: oneOf(row.column, ['status', 'sense_only', 'display_name']) };
    }
    case 'asset.move': {
      const row = fields(input, ['to', 'changedCount']);
      return { to: text(row.to, 128), changedCount: count(row.changedCount) };
    }
    case 'decision.set':
    case 'decision.clear': {
      const row = fields(input, event === 'decision.set' ? ['kind', 'key', 'status'] : ['kind', 'key']);
      return { kind: oneOf(row.kind, ['query', 'finding']), key: text(row.key, 512),
        ...(event === 'decision.set' ? { status: oneOf(row.status, ['marked', 'dismissed']) } : {}) };
    }
    case 'annotation.create': {
      const row = fields(input, ['annotationNumber', 'kind']);
      if (typeof row.annotationNumber !== 'string' || !/^[1-9]\d{0,18}$/u.test(row.annotationNumber)
        || BigInt(row.annotationNumber) > 9223372036854775807n) refused();
      return { annotationNumber: row.annotationNumber,
        kind: oneOf(row.kind, ['deploy', 'model-change', 'config', 'incident', 'autonomy-change', 'external']) };
    }
    case 'flag.acknowledge':
    case 'flag.resolve':
    case 'flag.snooze':
    case 'flag.unsnooze':
    case 'flag.tune': {
      const row = fields(input, ['flagNumber', 'changedCount']);
      return { flagNumber: count(row.flagNumber), changedCount: count(row.changedCount) };
    }
    default: return refused();
  }
}

/** The event and actor are snapshotted before I/O. Unknown standalone authors
 * stay explicitly unknown; free-form values/notes and request bodies never
 * enter the event-specific metadata envelope. Failure rolls back its caller's
 * effect because both use the same transaction. */
export async function recordMutation(tx: Transaction, actor: MutationActor | null, input: MutationEvent): Promise<void> {
  const row = fields(input, ['event', 'assetId', 'subject']);
  const event = text(row.event, 32), assetId = text(row.assetId);
  const body = JSON.stringify(subject(event, row.subject));
  let person: string | null = null, session: string | null = null;
  if (actor !== null) {
    const selected = fields(actor, ['workspaceId', 'principalId', 'sessionId']);
    if (selected.workspaceId !== tx.workspaceId
      || typeof selected.principalId !== 'string' || !UUID.test(selected.principalId)
      || typeof selected.sessionId !== 'string' || !UUID.test(selected.sessionId)) refused();
    person = selected.principalId; session = selected.sessionId;
  }
  await tx.execute(`INSERT INTO noticeos.workspace_mutation_audit
    (workspace_id,actor_kind,actor_person_id,actor_session_id,event,asset_id,subject)
    VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7::jsonb)`,
  [tx.workspaceId, person === null ? 'unknown' : 'person', person, session, event, assetId, body]);
}
