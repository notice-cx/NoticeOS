// Types for config-store-client.mjs — hand-written, because the client is plain
// Node ESM (house style of scripts/) and the Tower's write lane is TypeScript.
// Keep in lockstep with the .mjs.

export const DEFAULT_DOOR: string;
export const CONFIG_DOCUMENTS_PATH: string;
export const CONFIG_SEED_PATH: string;
export const CONFIG_APPLY_PATH: string;

export interface ConfigStoreRequestOptions {
  door?: string;
  /** The operator bearer. Read from the dev-secrets file when omitted. */
  token?: string;
  method?: string;
  body?: unknown;
  params?: Record<string, string | null | undefined>;
  fetchImpl?: typeof fetch;
}

/** One request to the loopback ingest door. Throws with the sentence an
 * operator can act on when the door does not answer or refuses the bearer;
 * every other status comes back with its body. */
export function configStoreRequest(
  route: string,
  options?: ConfigStoreRequestOptions,
): Promise<{ status: number; body: unknown }>;

export interface StoredConfigSnapshotRow {
  file: string;
  version: number;
  body: object;
}

/** Read acknowledged stored documents; unavailable or malformed responses throw. */
export function readConfigSnapshot(
  options?: Pick<ConfigStoreRequestOptions, 'door' | 'token' | 'fetchImpl'>,
): Promise<Map<string, StoredConfigSnapshotRow>>;
