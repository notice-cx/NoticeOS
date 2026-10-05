import { NoSingleWorkspace, openStore, type WorkspaceStore } from '@noticeos/postgres';
import { workspaceProfile } from '../../../scripts/product-env.mjs';

type ObjectOwner = Pick<IngestEnv, 'NOTICEOS_WORKSPACE_PROFILE'> & {
  STORE: WorkspaceStore;
  POSTGRES: Pick<IngestEnv['POSTGRES'], 'connectionString'>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A selected store supplies ownership, not authentication. The calling entry
 * must admit the operation before constructing its store or accessing R2. */
export async function signalObjectScope(env: ObjectOwner) {
  const profile = workspaceProfile(env);
  const workspaceId = await env.STORE.workspaceId();
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
    throw new Error('Signal object owner is unavailable.');
  }
  const prefix = `workspaces/${workspaceId}/`;
  const owns = (key: string): boolean => safeKey(key) && key.startsWith(prefix);
  let legacyOwner: Promise<boolean> | undefined;
  const proveLegacyOwner = async (): Promise<boolean> => {
    const store = openStore(env.POSTGRES.connectionString, { maxConnections: 1 });
    try { return await store.onlyWorkspace() === workspaceId; }
    catch (error) {
      if (error instanceof NoSingleWorkspace) return false;
      throw error;
    } finally { await store.close(); }
  };
  return Object.freeze({
    workspaceId,
    key(relative: string): string {
      if (!safeKey(relative) || !safeKey(prefix + relative)
        || !(relative.startsWith('raw/') || relative.startsWith('checkpoints/'))) {
        throw new Error('Signal object key is invalid.');
      }
      return prefix + relative;
    },
    owns,
    /** Old paid checkpoints have no SQL manifest. Only a freshly proven sole
     * standalone owner may adopt one; never use this after an invalid object or
     * failed namespaced read. No rows or old objects are migrated/deleted. */
    async legacyCheckpoint(key: string): Promise<string | null> {
      if (profile !== 'standalone' || !owns(key)) return null;
      const relative = key.slice(prefix.length);
      if (!relative.startsWith('checkpoints/dataforseo/')) return null;
      legacyOwner ??= proveLegacyOwner();
      return await legacyOwner ? relative : null;
    },
    /** Prefix is an additional boundary. Archive reads still need the current
     * store's RLS manifest membership, including standalone legacy objects. */
    canReadArchive(key: string): boolean {
      if (owns(key)) return key.slice(prefix.length).startsWith('raw/');
      return profile === 'standalone' && safeKey(key)
        && (key.startsWith('raw/') || key.startsWith('signals/'));
    },
  });
}

export type SignalObjectScope = Awaited<ReturnType<typeof signalObjectScope>>;

function safeKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || new TextEncoder().encode(key).byteLength > 1024) return false;
  return key.split('/').every((part) => {
    if (!part) return false;
    try {
      const decoded = decodeURIComponent(part);
      return decoded !== '.' && decoded !== '..' && !/[\u0000-\u0020\u007f/\\]/.test(decoded);
    } catch { return false; }
  });
}
