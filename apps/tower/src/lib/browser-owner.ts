/** Client lifetime identity, supplied by the entry context. These identifiers
 * grant no authority; the server still checks every request independently. */
export type BrowserOwner =
  | Readonly<{ mode: 'hosted'; principalId: string; sessionId: string; workspaceId: string; clientGeneration: number }>
  | Readonly<{ mode: 'demo'; workspaceId: string; clientGeneration: number }>
  | Readonly<{ mode: 'standalone'; clientGeneration: number }>;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Capture plain immutable facts, never a mutable current-workspace pointer.
 * Standalone is the explicit compatibility namespace of the existing desk,
 * whose bootstrap has not exposed a person/session/workspace identifier. */
export function captureBrowserOwner(value: unknown): BrowserOwner {
  const invalid = () => new Error('Browser owner is invalid.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const keys = Reflect.ownKeys(value);
  const source: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    source[key] = descriptor.value;
  }
  const generation = source.clientGeneration;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) throw invalid();
  const mode = source.mode;
  const expected = mode === 'hosted' ? ['mode', 'principalId', 'sessionId', 'workspaceId', 'clientGeneration']
    : mode === 'demo' ? ['mode', 'workspaceId', 'clientGeneration']
    : mode === 'standalone' ? ['mode', 'clientGeneration'] : [];
  if (expected.length === 0 || keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) throw invalid();
  if (mode === 'standalone') return Object.freeze({ mode, clientGeneration: generation });
  if (!uuid(source.workspaceId)) throw invalid();
  const workspaceId = source.workspaceId.toLowerCase();
  if (mode === 'demo') return Object.freeze({ mode, workspaceId, clientGeneration: generation });
  if (mode !== 'hosted' || !uuid(source.principalId) || !uuid(source.sessionId)) throw invalid();
  return Object.freeze({ mode, workspaceId, principalId: source.principalId.toLowerCase(), sessionId: source.sessionId.toLowerCase(), clientGeneration: generation });
}

/** Framing preserves field boundaries even when used beside a resource ID. */
export function browserOwnerKey(owner: BrowserOwner): string {
  return JSON.stringify([owner.mode, owner.mode === 'hosted' ? owner.principalId : null,
    owner.mode === 'hosted' ? owner.sessionId : null,
    owner.mode === 'standalone' ? null : owner.workspaceId, owner.clientGeneration]);
}
