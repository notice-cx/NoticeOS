// The credential store: every provider secret, encrypted under one bootstrap
// key, and the resolver every provider client goes through.
//
// Plaintext exists inside this Worker, at call time, and nowhere else: no RPC,
// route or log line returns a stored value. AES-GCM with a fresh IV on every
// write (a change re-seals the whole fields object; there is no patch path) and
// a `key_version` per row so a rotation can re-seal rows one at a time.
// Store-first, env-fallback, all or nothing: a provider with a stored row is
// served entirely from the store, and the two sources are never mixed.
//
// Nothing provider-specific is imported here: the collectors import this
// module, so a provider client imported back would be an import cycle. The
// probes live in credential-probes.ts.
import { type Transaction, type WorkspaceStore, javascriptInstant } from '@noticeos/postgres';
import { timingSafeEqual } from 'node:crypto';
import {
  CREDENTIAL_BLOCKER_LEADS,
  CREDENTIALS_KEY_COMMAND,
  type CredentialBalance,
  type ExactUsd,
  type CredentialExpirySource,
  type ValidationIssue,
  type CredentialMetadata,
  type CredentialSource,
  type CredentialStoreState,
  type CredentialSummary,
  type DeleteCredentialResult,
  type IntegrationField,
  type IntegrationProvider,
  type IntegrationProviderId,
  type PutCredentialInput,
  type PutCredentialResult,
  type SetCredentialExpiryInput,
  type SetCredentialExpiryResult,
  INTEGRATION_PROVIDERS,
  credentialAuthState,
  exactUsd,
  integrationProvider,
  readEnvCredential,
} from '@noticeos/contract';
import { getConfigDocument } from './config-store.js';
import { workspaceProfile } from '../../../scripts/product-env.mjs';
import { CLOUDFLARE_D1_TARGETS, cloudflareAccountId, d1Selection, storedD1Selection, type D1Selection } from '@noticeos/contract/cloudflare-d1';

/** Only the server's standalone profile may resolve legacy provider bindings. */
export function usesLegacyCredentialBindings(env: IngestEnv): boolean {
  return workspaceProfile(env) === 'standalone';
}

/**
 * The generation a row is stamped with when nothing has ever been rotated. The
 * version is a fact about the table, not this deploy: `currentKeyVersion()`
 * reads the table's own high-water mark and falls back to this.
 */
export const CREDENTIAL_KEY_VERSION = 1;

/** The key rows were sealed with before a rotation, for the window in which
 * both have to be readable. */
export const PREVIOUS_KEY_BINDING = 'CREDENTIALS_KEY_PREVIOUS';

/** AES-GCM's specified nonce length; anything else costs a GHASH pass and buys nothing. */
const IV_BYTES = 12;

/** The raw key length AES-256 needs. */
const KEY_BYTES = 32;

/** A pasted service-account map is a few kilobytes; past this is a mistake, not a credential. */
const MAX_FIELD_BYTES = 64 * 1024;

/**
 * A key problem as one line: the state, the binding, what is wrong with it,
 * and the command that makes a new key. The banner draws the same state and
 * command from the blocker code, so both say one thing. `command: false` for a
 * key that is well-formed but does not open a stored row: a new key would not
 * open it either.
 */
export function credentialKeyLine(
  blocker: 'key-missing' | 'key-invalid',
  binding: string,
  detail: string | null = null,
  { command = true }: { command?: boolean } = {},
): string {
  return [CREDENTIAL_BLOCKER_LEADS[blocker], binding, detail, command ? CREDENTIALS_KEY_COMMAND : null]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

const KEY_MISSING_MESSAGE = credentialKeyLine('key-missing', 'CREDENTIALS_KEY');

/** The bootstrap key is missing or malformed. Carries the operator's line,
 * never anything derived from the key itself. */
export class CredentialKeyError extends Error {
  constructor(readonly code: 'key_missing' | 'key_invalid', message: string) {
    super(message);
    this.name = 'CredentialKeyError';
  }
}

/**
 * One provider's stored credential. Everything but `ciphertext` is public on
 * purpose: `deleteCredential` and `listCredentialSummaries` answer without the
 * bootstrap key, so anything the card renders has to live outside the
 * ciphertext or it disappears exactly when a rotated key makes it most needed.
 */
interface CredentialRow {
  provider: string;
  scope: string;
  connection_id: string;
  /** Which secret of this connection this is; a new one replaces it whole. */
  secret_version: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  key_version: number;
  /** The NAMES of the fields the ciphertext carries, never a value. */
  field_names: string[];
  /** For a `per-asset` provider: the site ids its key map holds a key for. Ids only. */
  asset_ids: string[];
  /** The non-secret facts about the connection; null when none were recorded. */
  metadata: CredentialMetadata | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
}

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

function decodeKey(raw: string, binding: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(raw.trim().replace(/\s+/g, ''));
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch {
    throw new CredentialKeyError('key_invalid', credentialKeyLine('key-invalid', binding, 'not base64'));
  }
  if (bytes.length !== KEY_BYTES) {
    throw new CredentialKeyError(
      'key_invalid',
      credentialKeyLine('key-invalid', binding, `${bytes.length} bytes, not ${KEY_BYTES}`),
    );
  }
  return bytes;
}

function keyBytes(env: IngestEnv): Uint8Array<ArrayBuffer> {
  const raw = (env as { CREDENTIALS_KEY?: string }).CREDENTIALS_KEY;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new CredentialKeyError('key_missing', KEY_MISSING_MESSAGE);
  }
  return decodeKey(raw, 'CREDENTIALS_KEY');
}

/**
 * The key the rows were sealed with before a rotation. Optional by
 * construction: an install that has never rotated has no such binding. A
 * second binding rather than a versioned map, because two keys readable at
 * once is the only state the sweep needs.
 */
function previousKeyBytes(env: IngestEnv): Uint8Array<ArrayBuffer> | null {
  const raw = (env as unknown as Record<string, unknown>)[PREVIOUS_KEY_BINDING];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return decodeKey(raw, PREVIOUS_KEY_BINDING);
}

/** Whether the key is usable, and — when it is not — the sentence to show
 * instead of a form. Never throws: this is what a page renders WITH. */
export function credentialKeyState(env: IngestEnv): {
  present: boolean;
  reason: string | null;
  /** The same answer as a code the Tower draws. */
  blocker: 'key-missing' | 'key-invalid' | null;
} {
  try {
    keyBytes(env);
    return { present: true, reason: null, blocker: null };
  } catch (error) {
    return {
      present: false,
      reason: error instanceof Error ? error.message : KEY_MISSING_MESSAGE,
      blocker: error instanceof CredentialKeyError && error.code === 'key_invalid' ? 'key-invalid' : 'key-missing',
    };
  }
}

async function importAesKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function importCredentialKey(env: IngestEnv): Promise<CryptoKey> {
  return importAesKey(keyBytes(env));
}

async function seal(
  env: IngestEnv,
  fields: Record<string, string>,
): Promise<{ iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> }> {
  const key = await importCredentialKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(fields)),
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/** Which generation of the bootstrap secret opened a row. */
type OpeningKey = 'current' | 'previous';

/**
 * Open one row with the current key, then the previous one. `key_version` is
 * not consulted: a failed GCM decrypt is cheap, and trusting the column would
 * make a row whose version was written wrong a row nobody can open. The version
 * is what the rotation reads to know what is left to do.
 */
async function openWith(
  env: IngestEnv,
  row: Pick<CredentialRow, 'provider' | 'ciphertext' | 'iv'>,
): Promise<{ fields: Record<string, string>; key: OpeningKey }> {
  const attempts: { key: OpeningKey; bytes: Uint8Array<ArrayBuffer> }[] = [
    { key: 'current', bytes: keyBytes(env) },
  ];
  const previous = previousKeyBytes(env);
  if (previous !== null) attempts.push({ key: 'previous', bytes: previous });

  for (const attempt of attempts) {
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toBytes(row.iv) },
        await importAesKey(attempt.bytes),
        toBytes(row.ciphertext),
      );
    } catch {
      continue;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    const fields: Record<string, string> = {};
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') fields[name] = value;
      }
    }
    return { fields, key: attempt.key };
  }

  // Wrong key or tampered row: the same instruction to an operator, and neither
  // may leak which.
  throw new CredentialKeyError(
    'key_invalid',
    credentialKeyLine('key-invalid', 'CREDENTIALS_KEY', `does not open ${row.provider}`, { command: false }),
  );
}

async function open(env: IngestEnv, row: CredentialRow): Promise<Record<string, string>> {
  return (await openWith(env, row)).fields;
}

/** WebCrypto is given a copy over a buffer of its own, not the driver's. */
function toBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value.slice().buffer) as Uint8Array<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// The store: a connection and its current secret
// ---------------------------------------------------------------------------
//
// A read or write that cannot reach the store throws; nothing falls back to
// "nothing stored". One secret per connection at rest: a new secret is the
// next `secret_version`, written in the transaction that removes the one
// before, and a version is never rewritten, so "the version I read is still
// current" is how a write knows nothing replaced the secret meanwhile.

/** One connection with its newest secret version, as the store answers it. */
type StoredCredential = {
  provider: string;
  scope: string;
  connection_id: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  account: string | null;
  scopes: string;
  connected_at: string | null;
  expires_at: string | null;
  expiry_source: string | null;
  /** numeric(14,6) as the store prints it, its scale's padding zeros trimmed. */
  balance_usd: string | null;
  balance_seen_at: string | null;
  secret_version: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  key_version: number;
  field_names: string;
  asset_ids: string;
};

/** A jsonb list of names, as the strings it holds. */
function jsonNames(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
}

function instantOrNull(value: string | null): string | null {
  return value === null ? null : javascriptInstant(value);
}

function credentialRow(stored: StoredCredential): CredentialRow {
  return {
    provider: stored.provider,
    scope: stored.scope,
    connection_id: stored.connection_id,
    secret_version: stored.secret_version,
    ciphertext: stored.ciphertext,
    iv: stored.iv,
    key_version: stored.key_version,
    field_names: jsonNames(stored.field_names),
    asset_ids: jsonNames(stored.asset_ids),
    metadata: readMetadata({
      account: stored.account,
      scopes: jsonNames(stored.scopes),
      connectedAt: instantOrNull(stored.connected_at),
      expiresAt: instantOrNull(stored.expires_at),
      expirySource: stored.expiry_source,
      balance:
        stored.balance_usd === null || stored.balance_seen_at === null
          ? null
          : { usd: stored.balance_usd, seenAt: javascriptInstant(stored.balance_seen_at) },
    }),
    created_at: javascriptInstant(stored.created_at),
    updated_at: javascriptInstant(stored.updated_at),
    last_used_at: instantOrNull(stored.last_used_at),
    last_ok_at: instantOrNull(stored.last_ok_at),
    last_error: stored.last_error,
  };
}

/** Every stored credential, or one provider's (`provider` null: all). */
async function selectCredentials(tx: Transaction, provider: string | null): Promise<CredentialRow[]> {
  const rows = await tx.query<StoredCredential>(
    `SELECT c.provider, c.scope, c.connection_id, c.created_at, c.updated_at,
            c.last_used_at, c.last_ok_at, c.last_error,
            c.account, c.scopes, c.connected_at, c.expires_at, c.expiry_source,
            trim_scale(c.balance_usd) AS balance_usd, c.balance_seen_at,
            s.secret_version, s.ciphertext, s.iv, s.key_version, s.field_names, s.asset_ids
       FROM noticeos.integration_connections c
       JOIN LATERAL (
              SELECT secret_version, ciphertext, iv, key_version, field_names, asset_ids
                FROM noticeos.connection_secrets
               WHERE workspace_id = c.workspace_id AND connection_id = c.connection_id
               ORDER BY secret_version DESC
               LIMIT 1
            ) s ON true
      WHERE $1::text IS NULL OR c.provider = $1`,
    [provider],
  );
  return rows.map(credentialRow);
}

// A hand-built test env with no store has no stored credential by definition.
// Every call into this Worker has one (src/call-store.ts).
async function readRows(store: WorkspaceStore | undefined): Promise<CredentialRow[]> {
  if (!store) return [];
  return store.read((tx) => selectCredentials(tx, null));
}

async function readRow(store: WorkspaceStore | undefined, provider: string): Promise<CredentialRow | null> {
  if (!store) return null;
  return (await store.read((tx) => selectCredentials(tx, provider)))[0] ?? null;
}

/**
 * The generation a new write should be stamped with: the store's own high-water
 * mark. After a rotation has re-sealed every secret at 2, stamping the constant
 * 1 would put the store straight back into the split state. An empty store
 * answers the base version.
 */
async function currentKeyVersion(tx: Transaction): Promise<number> {
  const [row] = await tx.query<{ version: number | null }>(
    'SELECT max(key_version) AS version FROM noticeos.connection_secrets',
  );
  const version = row?.version;
  return typeof version === 'number' && version >= CREDENTIAL_KEY_VERSION
    ? version
    : CREDENTIAL_KEY_VERSION;
}

/**
 * Replace a connection's secret as the version after `replaces` (or after
 * whatever is newest when null), inside the caller's transaction. With
 * `replaces`, nothing is written unless that version is still current. The
 * connection row is locked first, as a Save's upsert locks it, so two writers
 * of one connection take turns.
 */
async function replaceSecret(
  tx: Transaction,
  connectionId: string,
  replaces: number | null,
  secret: {
    ciphertext: Uint8Array;
    iv: Uint8Array;
    keyVersion: number;
    fieldNames: string[];
    assetIds: string[];
  },
  at: string,
): Promise<boolean> {
  await tx.query(
    `SELECT 1 FROM noticeos.integration_connections
      WHERE workspace_id = $1 AND connection_id = $2
        FOR NO KEY UPDATE`,
    [tx.workspaceId, connectionId],
  );
  const [newest] = await tx.query<{ version: number | null }>(
    `SELECT max(secret_version) AS version FROM noticeos.connection_secrets
      WHERE workspace_id = $1 AND connection_id = $2`,
    [tx.workspaceId, connectionId],
  );
  const current = newest?.version ?? 0;
  if (replaces !== null && current !== replaces) return false;
  await tx.execute(
    `INSERT INTO noticeos.connection_secrets
       (workspace_id, connection_id, secret_version, ciphertext, iv, key_version,
        field_names, asset_ids, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::timestamptz)`,
    [
      tx.workspaceId,
      connectionId,
      current + 1,
      secret.ciphertext,
      secret.iv,
      secret.keyVersion,
      JSON.stringify(secret.fieldNames),
      JSON.stringify(secret.assetIds),
      at,
    ],
  );
  await tx.execute(
    `DELETE FROM noticeos.connection_secrets
      WHERE workspace_id = $1 AND connection_id = $2 AND secret_version <= $3`,
    [tx.workspaceId, connectionId, current],
  );
  return true;
}

// ---------------------------------------------------------------------------
// Summaries — names and metadata, never values
// ---------------------------------------------------------------------------

/** The connection's metadata, or null when nothing was recorded. Read
 * defensively rather than cast, so a value of the wrong shape degrades to
 * "nothing recorded" instead of putting `undefined` on a card. */
function readMetadata(value: unknown): CredentialMetadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const account = typeof record.account === 'string' ? record.account : null;
  const scopes = Array.isArray(record.scopes)
    ? record.scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
  const connectedAt = typeof record.connectedAt === 'string' ? record.connectedAt : null;
  const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : null;
  const expirySource =
    record.expirySource === 'flow' || record.expirySource === 'operator'
      ? record.expirySource
      : null;
  const balance = readBalance(record.balance);
  if (
    account === null &&
    scopes.length === 0 &&
    connectedAt === null &&
    expiresAt === null &&
    balance === null &&
    // `expirySource` alone is meaningful: `{ expiresAt: null, expirySource:
    // 'operator' }` is the operator saying this does not expire.
    expirySource === null
  ) {
    return null;
  }
  return {
    account,
    scopes,
    connectedAt,
    expiresAt,
    expirySource,
    // Absent rather than null on providers without a prepaid account.
    ...(balance === null ? {} : { balance }),
  };
}

/** A prepaid sighting, or nothing: both halves or neither, because an undated
 * balance would render as though it were current. */
function readBalance(value: unknown): CredentialBalance | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const usd = exactUsd(record.usd);
  const seenAt =
    typeof record.seenAt === 'string' && Number.isFinite(Date.parse(record.seenAt))
      ? record.seenAt
      : null;
  return usd === null || seenAt === null ? null : { usd, seenAt };
}

/** A connection's metadata as the columns it is stored in. */
function metadataColumns(metadata: CredentialMetadata | null): {
  account: string | null;
  scopes: string;
  connectedAt: string | null;
  expiresAt: string | null;
  expirySource: CredentialExpirySource | null;
  balanceUsd: ExactUsd | null;
  balanceSeenAt: string | null;
} {
  const facts = readMetadata(metadata);
  const balance = facts?.balance ?? null;
  return {
    account: facts?.account ?? null,
    scopes: JSON.stringify(facts?.scopes ?? []),
    connectedAt: facts?.connectedAt ?? null,
    expiresAt: facts?.expiresAt ?? null,
    expirySource: facts?.expirySource ?? null,
    balanceUsd: balance?.usd ?? null,
    balanceSeenAt: balance?.seenAt ?? null,
  };
}

/**
 * The asset ids a `per-asset` credential's map holds a key for; never a value.
 * Shared by the store write and the env-fallback summary. A map that does not
 * parse answers with nothing rather than throwing: a broken binding covers no
 * assets.
 */
export function credentialAssetKeys(value: string | undefined): string[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>)
    .filter(([, token]) => typeof token === 'string' && token.trim() !== '')
    .map(([asset]) => asset)
    .sort();
}

/** The asset ids held by whichever of this provider's fields is the asset map;
 * empty for every `shared` provider. */
function assetsHeldBy(
  provider: IntegrationProvider,
  fields: Record<string, string>,
): string[] {
  if (provider.id === 'cloudflare') return [...new Set(storedD1Selection(fields)?.targets.map(target => target.asset) ?? [])].sort();
  if (provider.scope !== 'per-asset') return [];
  const map = provider.fields.find((field) => field.kind === 'asset-map');
  return map === undefined ? [] : credentialAssetKeys(fields[map.name]);
}

/**
 * What this provider can read out of the legacy env bindings, and the slot each
 * value came from. One read, in the contract, because a provider can hold a
 * field under more than one binding name (Clarity's asset map absorbs the older
 * single-project token as that asset's key).
 */
function envCredential(env: IngestEnv, provider: IntegrationProvider, register: unknown) {
  if (!usesLegacyCredentialBindings(env)) return { fields: {}, legacySlots: {} };
  return readEnvCredential(provider, env as unknown as Record<string, unknown>, register);
}

/**
 * The data-source register the legacy-binding rule reads, store first, so which
 * asset an older single-asset binding serves is the installation's answer.
 * Read only when this environment holds such a binding.
 */
async function legacyRegister(env: IngestEnv): Promise<unknown> {
  if (!usesLegacyCredentialBindings(env)) return undefined;
  const bindings = env as unknown as Record<string, unknown>;
  const holds = INTEGRATION_PROVIDERS.some((provider) =>
    provider.fields.some((field) => {
      const legacy = field.legacyAssetBinding;
      if (legacy === undefined) return false;
      const raw = bindings[legacy.name];
      return typeof raw === 'string' && raw.trim() !== '';
    }),
  );
  if (!holds) return undefined;
  return (await getConfigDocument(env, 'config/integrations.json')).body;
}

function summarize(
  provider: IntegrationProvider,
  row: CredentialRow | null,
  env: IngestEnv,
  register: unknown,
): CredentialSummary {
  if (row === null) {
    const fromEnv = envCredential(env, provider, register);
    const state = credentialAuthState(provider, Object.keys(fromEnv.fields));
    return {
      provider: provider.id,
      // A partial env credential is `none`, not `env`: calling it configured
      // would put a green light on a lane that cannot run.
      source: state.complete ? 'env' : 'none',
      fields: [],
      // A per-asset credential still in its legacy binding covers the assets
      // its map names, and the card has to be able to say so.
      assetsHeld: assetsHeldBy(provider, fromEnv.fields),
      missingFields: state.missing,
      auth: state.auth,
      metadata: null,
      keyVersion: null,
      createdAt: null,
      updatedAt: null,
      lastUsedAt: null,
      lastOkAt: null,
      lastError: null,
    };
  }
  const state = credentialAuthState(provider, row.field_names);
  return {
    provider: provider.id,
    source: 'store',
    fields: row.field_names,
    assetsHeld: row.asset_ids,
    missingFields: state.missing,
    auth: state.auth,
    metadata: row.metadata,
    keyVersion: row.key_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    lastOkAt: row.last_ok_at,
    lastError: row.last_error,
  };
}

/**
 * Every provider's connection state, in catalog order. Always all of them: a
 * provider with nothing stored is a card that says "not connected". Never a
 * value: this is the function the Tower calls, so its return type is the
 * security boundary.
 */
export async function listCredentialSummaries(
  env: IngestEnv,
): Promise<CredentialStoreState> {
  const rows = await readRows(env.STORE);
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  const key = credentialKeyState(env);
  const register = await legacyRegister(env);
  return {
    keyPresent: key.present,
    keyReason: key.reason,
    blockers: key.blocker === null ? [] : [key.blocker],
    summaries: INTEGRATION_PROVIDERS.map((provider) =>
      summarize(provider, byProvider.get(provider.id) ?? null, env, register),
    ),
  };
}

/** One provider's summary; the same guarantee as `listCredentialSummaries()`. */
export async function credentialSummary(
  env: IngestEnv,
  providerId: IntegrationProviderId,
  policy: 'legacy-fallback' | 'store-only' = 'legacy-fallback',
): Promise<CredentialSummary | null> {
  const provider = integrationProvider(providerId);
  if (provider === null) return null;
  const row = await readRow(env.STORE, provider.id);
  if (row === null && policy === 'store-only') return null;
  return summarize(provider, row, env, policy === 'store-only' ? undefined : await legacyRegister(env));
}

/**
 * An HMAC-SHA256 key for signing the OAuth state nonce. HKDF'd out of
 * `CREDENTIALS_KEY` with its own info string rather than reusing the
 * encryption key: one key doing two jobs is how a signing oracle becomes a
 * decryption oracle. A second signed thing gets its own info string. Throws
 * `CredentialKeyError` like the encryption path: an install with no key cannot
 * store what a sign-in would return.
 */
export async function credentialSigningKey(env: IngestEnv): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', keyBytes(env), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('noticeos/oauth-state/v1'),
    },
    base,
    256,
  );
  return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

// ---------------------------------------------------------------------------
// Validation — the same rules whichever door a write arrived at
// ---------------------------------------------------------------------------

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

/** Validate a submitted fields object against the provider's schema. Messages
 * name the field and never the value: this text reaches a browser. */
export function validateCredentialFields(
  provider: IntegrationProvider,
  fields: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (provider.id === 'cloudflare') {
    if (Object.hasOwn(fields, CLOUDFLARE_D1_TARGETS)) issues.push(issue(CLOUDFLARE_D1_TARGETS, 'invalid', 'Choose databases in the Cloudflare panel.'));
    if (!cloudflareAccountId(fields.CLOUDFLARE_ACCOUNT_ID)) issues.push(issue('CLOUDFLARE_ACCOUNT_ID', 'invalid', 'Account ID must contain 32 hexadecimal characters.'));
  }
  const known = new Map(provider.fields.map((field) => [field.name, field]));

  for (const name of Object.keys(fields)) {
    if (!known.has(name)) {
      issues.push(
        issue(
          name,
          'unknown_field',
          `${provider.label} has no field "${name}" — expected ${[...known.keys()].join(', ')}.`,
        ),
      );
    }
  }

  for (const field of provider.fields) {
    const value = fields[field.name];
    if (value === undefined || value === null || value === '') {
      if (field.required) {
        issues.push(issue(field.name, 'required', `${field.label} is required.`));
      }
      continue;
    }
    if (typeof value !== 'string') {
      issues.push(
        issue(field.name, 'not_a_string', `${field.label} must be sent as a string.`),
      );
      continue;
    }
    if (new TextEncoder().encode(value).byteLength > MAX_FIELD_BYTES) {
      issues.push(
        issue(
          field.name,
          'too_large',
          `${field.label} is larger than ${MAX_FIELD_BYTES / 1024} KB.`,
        ),
      );
      continue;
    }
    issues.push(...validateFieldShape(field, value));
  }
  return issues;
}

function validateFieldShape(field: IntegrationField, value: string): ValidationIssue[] {
  if (field.kind === 'text' || field.kind === 'password') {
    return value.trim() === ''
      ? [issue(field.name, 'blank', `${field.label} is blank.`)]
      : [];
  }

  // A url that is itself the credential (a Discord webhook): checked like one
  // entry of a `url-list`, refused by field name, never echoed.
  if (field.kind === 'url') {
    const trimmed = value.trim();
    if (trimmed === '') return [issue(field.name, 'blank', `${field.label} is blank.`)];
    let scheme: string;
    try {
      scheme = new URL(trimmed).protocol;
    } catch {
      return [issue(field.name, 'invalid_url', `${field.label} is not a url.`)];
    }
    return scheme === 'https:' || scheme === 'http:'
      ? []
      : [issue(field.name, 'invalid_url', `${field.label} must be an http or https url.`)];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [issue(field.name, 'invalid_json', `${field.label} is not valid JSON.`)];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [issue(field.name, 'invalid_json', `${field.label} must be a JSON object.`)];
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    return [issue(field.name, 'empty', `${field.label} is an empty object.`)];
  }
  if (field.kind === 'json') return [];

  // asset-map: `asset id -> that asset's own key`. A rejection names the asset,
  // never the token.
  if (field.kind === 'asset-map') {
    const issues: ValidationIssue[] = [];
    for (const [asset, token] of entries) {
      if (typeof token !== 'string' || token.trim() === '') {
        issues.push(
          issue(field.name, 'blank', `${field.label}: "${asset}" has no key.`),
        );
      }
    }
    return issues;
  }

  // url-list: `label -> url` or `label -> { url, … }`. The URL is the
  // credential, so a rejection names the label.
  const issues: ValidationIssue[] = [];
  for (const [label, entry] of entries) {
    const url = typeof entry === 'string' ? entry : credentialFeedUrl(entry);
    if (url === null) {
      issues.push(
        issue(field.name, 'missing_url', `${field.label}: "${label}" has no url.`),
      );
      continue;
    }
    let scheme: string;
    try {
      scheme = new URL(url).protocol;
    } catch {
      issues.push(
        issue(field.name, 'invalid_url', `${field.label}: "${label}" is not a url.`),
      );
      continue;
    }
    if (scheme !== 'https:' && scheme !== 'http:') {
      issues.push(
        issue(field.name, 'invalid_url', `${field.label}: "${label}" must be http or https.`),
      );
    }
  }
  return issues;
}

export function credentialFeedUrl(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() === '' ? null : entry;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const url = (entry as Record<string, unknown>).url;
  return typeof url === 'string' && url.trim() !== '' ? url : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Store one provider's credential, replacing whatever was there: the IV must
 * be fresh, so the whole fields object is re-sealed, and "reconnect" means
 * what was just typed is what is stored.
 *
 * One exception: a `managed` field (the Google refresh token) survives an input
 * that does not name it. No form can send one, so omitting it is not a
 * statement that it should go; dropping it would leave a token valid at Google
 * that this OS can no longer revoke. Disconnect removes a grant, revoking first.
 */
export async function putCredential(
  env: IngestEnv,
  input: PutCredentialInput,
): Promise<PutCredentialResult> {
  const provider = integrationProvider(input.provider);
  if (provider === null) {
    return { ok: false, error: 'unknown_provider', provider: String(input.provider) };
  }
  const raw = input.fields;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: 'validation',
      issues: [issue('fields', 'invalid', 'fields must be an object of name → value.')],
    };
  }
  const issues = validateCredentialFields(provider, raw as Record<string, unknown>);
  if (issues.length > 0) return { ok: false, error: 'validation', issues };

  if (provider.id === 'cloudflare' && !/^[a-f0-9]{32}$/u.test(String(raw.CLOUDFLARE_ACCOUNT_ID))) {
    return { ok: false, error: 'validation', issues: [issue('CLOUDFLARE_ACCOUNT_ID', 'invalid', 'Account ID must contain 32 hexadecimal characters.')] };
  }

  const previous = await readRow(env.STORE, provider.id);
  const fields: Record<string, string> = {};
  for (const field of provider.fields) {
    const value = raw[field.name];
    if (typeof value === 'string' && value !== '') fields[field.name] = value;
  }
  try { Object.assign(fields, await carriedManagedFields(env, provider, previous, fields)); }
  catch (error) {
    if (error instanceof CredentialKeyError) return { ok: false, error: 'key_missing', message: 'Reconnect after restoring the credential key.' };
    throw error;
  }

  // Whether the result works at all, judged on what will be stored: `required`
  // cannot express Google's "either a sign-in or a service account".
  const state = credentialAuthState(provider, Object.keys(fields));
  if (!state.complete) {
    const missing = state.missing
      .map((name) => provider.fields.find((field) => field.name === name)?.label ?? name)
      .join(' and ');
    return {
      ok: false,
      error: 'validation',
      issues: [
        issue(
          state.missing[0] ?? 'fields',
          'incomplete',
          `${provider.label} still needs ${missing || 'a credential'}.`,
        ),
      ],
    };
  }

  // The metadata the caller asserted, or whatever the row already recorded: a
  // form save must not erase whose account is connected by not mentioning it.
  // The balance is the exception: what was pasted may name a different prepaid
  // account, so the figure is dropped until the next answer carries one.
  const carried = previous === null ? null : previous.metadata;
  const metadata =
    input.metadata ?? (carried === null ? null : { ...carried, balance: null });

  let sealed: { iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> };
  try {
    sealed = await seal(env, fields);
  } catch (error) {
    if (error instanceof CredentialKeyError) {
      return { ok: false, error: 'key_missing', message: error.message };
    }
    throw error;
  }

  const now = new Date().toISOString();
  const facts = metadataColumns(metadata);
  // One transaction: the connection, then its new secret in place of the old.
  await env.STORE.write(async (tx) => {
    const [connection] = await tx.query<{ connection_id: string }>(
      `INSERT INTO noticeos.integration_connections
         (workspace_id, provider, scope, created_at, updated_at,
          account, scopes, connected_at, expires_at, expiry_source, balance_usd, balance_seen_at)
       VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz,
               $5, $6::jsonb, $7::timestamptz, $8::timestamptz, $9, $10::numeric(14,6), $11::timestamptz)
       ON CONFLICT (workspace_id, provider) DO UPDATE SET
         scope = excluded.scope,
         updated_at = excluded.updated_at,
         -- A new secret clears the verdict: what a previous one proved says
         -- nothing about what was just pasted, and a stale green check beside
         -- a broken credential is worse than no check at all.
         last_used_at = NULL,
         last_ok_at = NULL,
         last_error = NULL,
         account = excluded.account,
         scopes = excluded.scopes,
         connected_at = excluded.connected_at,
         expires_at = excluded.expires_at,
         expiry_source = excluded.expiry_source,
         balance_usd = excluded.balance_usd,
         balance_seen_at = excluded.balance_seen_at
       RETURNING connection_id`,
      [
        tx.workspaceId,
        provider.id,
        provider.scope,
        now,
        facts.account,
        facts.scopes,
        facts.connectedAt,
        facts.expiresAt,
        facts.expirySource,
        facts.balanceUsd,
        facts.balanceSeenAt,
      ],
    );
    if (provider.id === 'cloudflare' && previous && connection!.connection_id !== previous.connection_id) {
      throw new Error('Cloudflare connection changed. Try again.');
    }
    const replaced = await replaceSecret(
      tx,
      connection!.connection_id,
      provider.id === 'cloudflare' ? previous?.secret_version ?? 0 : null,
      {
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        // The store's generation, not the build's.
        keyVersion: await currentKeyVersion(tx),
        fieldNames: Object.keys(fields),
        assetIds: assetsHeldBy(provider, fields),
      },
      now,
    );
    if (!replaced) throw new Error('Cloudflare connection changed. Try again.');
  });

  const row = await readRow(env.STORE, provider.id);
  return { ok: true, summary: summarize(provider, row, env, await legacyRegister(env)) };
}

/**
 * The `managed` values the previous row held that this write did not name.
 * Read only when there is something to carry, since it costs a decrypt. A key
 * that cannot open the old row carries nothing rather than failing the save: an
 * operator who rotated the key is reconnecting precisely because the old row
 * is unreadable.
 */
async function carriedManagedFields(
  env: IngestEnv,
  provider: IntegrationProvider,
  previous: CredentialRow | null,
  named: Record<string, string>,
): Promise<Record<string, string>> {
  if (previous === null) return {};
  const wanted = provider.fields.filter(
    (field) => field.managed === true && named[field.name] === undefined,
  );
  if (wanted.length === 0) return {};
  if (!previous.field_names.some((name) => wanted.some((f) => f.name === name))) {
    return {};
  }
  let held: Record<string, string>;
  try {
    held = await open(env, previous);
  } catch (error) {
    if (error instanceof CredentialKeyError && provider.id !== 'cloudflare') return {};
    throw error;
  }
  const carried: Record<string, string> = {};
  for (const field of wanted) {
    const value = held[field.name];
    if (typeof value === 'string' && value !== '') carried[field.name] = value;
  }
  return carried;
}

/**
 * Record, or clear, when one provider's credential stops working. A
 * metadata-only write: it touches neither ciphertext nor IV, needs no bootstrap
 * key, and leaves `last_ok_at` alone, because a date is not a new secret.
 * `expiresAt: null` is an answer, not an erasure: it stamps `operator` so a
 * later sign-in cannot put the flow's assumption back (`carriedExpiry`).
 */
export async function setCredentialExpiry(
  env: IngestEnv,
  input: SetCredentialExpiryInput,
): Promise<SetCredentialExpiryResult> {
  const provider = integrationProvider(input.provider);
  if (provider === null) {
    return { ok: false, error: 'unknown_provider', provider: String(input.provider) };
  }
  if (provider.expiry.known === 'never') {
    return {
      ok: false,
      error: 'not_expirable',
      message: `${provider.label} has no expiry date to record.`,
    };
  }

  const expiresAt = input.expiresAt;
  if (expiresAt !== null) {
    if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) {
      return {
        ok: false,
        error: 'validation',
        issues: [
          issue('expiresAt', 'invalid_date', 'The expiry has to be a date NoticeOS can read.'),
        ],
      };
    }
  }

  // The date and who gave it, and nothing else.
  const dated = await env.STORE.write((tx) =>
    tx.execute(
      `UPDATE noticeos.integration_connections
          SET expires_at = $1::timestamptz, expiry_source = 'operator'
        WHERE provider = $2`,
      [expiresAt === null ? null : new Date(expiresAt).toISOString(), provider.id],
    ),
  );
  if (dated === 0) {
    return {
      ok: false,
      error: 'not_stored',
      message: `${provider.label} has no stored credential, so there is nothing to date.`,
    };
  }
  return {
    ok: true,
    summary: summarize(provider, await readRow(env.STORE, provider.id), env, await legacyRegister(env)),
  };
}

/**
 * Stamp what a provider's prepaid account held, with the instant it said so.
 * The one writer for every caller that can see the figure. Metadata-only, like
 * `setCredentialExpiry`: a number the vendor volunteered is not a verdict.
 * Silent where there is nothing to stamp (no row, or no readable figure or
 * instant), because both callers are doing something else.
 */
export async function setCredentialBalance(
  env: IngestEnv,
  providerId: IntegrationProviderId,
  balance: CredentialBalance,
): Promise<void> {
  const usd = exactUsd(balance.usd);
  if (usd === null || !Number.isFinite(Date.parse(balance.seenAt))) return;
  // The digits cross as text and are cast in SQL: six decimals kept, a seventh
  // rounded half away from zero, $100,000,000 or more refused by the type.
  await env.STORE.write((tx) =>
    tx.execute(
      `UPDATE noticeos.integration_connections
          SET balance_usd = $1::numeric(14,6), balance_seen_at = $2::timestamptz
        WHERE provider = $3`,
      [usd, new Date(balance.seenAt).toISOString(), providerId],
    ),
  );
}

/**
 * The expiry a new connection should carry. The operator's answer wins: a flow
 * can only assume (Google publishes no API that says whether a consent screen
 * is still in Testing), and a correction that had to be re-made after every
 * reconnect is a warning people learn to dismiss.
 */
export function carriedExpiry(
  previous: CredentialMetadata | null,
  proposed: { expiresAt: string | null; expirySource: CredentialExpirySource },
): Pick<CredentialMetadata, 'expiresAt' | 'expirySource'> {
  if (previous?.expirySource === 'operator') {
    return { expiresAt: previous.expiresAt, expirySource: 'operator' };
  }
  return proposed;
}

/**
 * Forget one provider's credential. Works without `CREDENTIALS_KEY`: removing a
 * secret you can no longer read is exactly what a lost key calls for.
 */
export async function deleteCredential(
  env: IngestEnv,
  providerId: string,
): Promise<DeleteCredentialResult> {
  const provider = integrationProvider(providerId);
  if (provider === null) {
    return { ok: false, error: 'unknown_provider', provider: String(providerId) };
  }
  // The connection and, with it, every secret it held (ON DELETE CASCADE).
  // A disconnect is idempotent.
  await env.STORE.write((tx) =>
    tx.execute('DELETE FROM noticeos.integration_connections WHERE provider = $1', [provider.id]),
  );
  return { ok: true, summary: summarize(provider, null, env, await legacyRegister(env)) };
}

// ---------------------------------------------------------------------------
// Rotating the bootstrap key
// ---------------------------------------------------------------------------

/** What one rotation pass did: counts and provider ids only. */
export interface CredentialRotationResult {
  ok: boolean;
  /** Why the pass did not run: `previous-key-missing` is the rotation's own
   * precondition; the other two are the key blockers. Null when it ran. */
  refusal: 'previous-key-missing' | 'key-missing' | 'key-invalid' | null;
  /** The same refusal as one short line. Null when it ran. */
  reason: string | null;
  /** The generation every readable row is now sealed at. Null on an empty or
   * absent table. */
  keyVersion: number | null;
  rows: number;
  /** Re-sealed under the current key by THIS pass. */
  rotated: number;
  /** Already sealed under the current key at the target version. */
  alreadyCurrent: number;
  /** Provider ids neither key could open. Named, never dropped: the row is left
   * as it was and the operator reconnects that provider. */
  unreadable: string[];
  /** Provider ids whose row was written by something else mid-pass. Left alone;
   * running the command again picks them up. */
  contended: string[];
}

/** The refusal without the previous key. `pnpm creds:rotate-key` prints the
 * runbook for this code. */
export const ROTATE_NEEDS_PREVIOUS_KEY = `Nothing to rotate from · ${PREVIOUS_KEY_BINDING} not set`;

/**
 * Re-seal every stored credential under the current `CREDENTIALS_KEY`.
 *
 * The plaintext never leaves this Worker, which is why rotation is an RPC and a
 * loopback route rather than a Node script: one row's plaintext is held at a
 * time, between a decrypt and the `seal()` on the next line. Atomic per row and
 * resumable: each row is one transaction guarded on its secret version, a Save
 * mid-sweep is named in `contended`, and a split table finishes at the version
 * already reached rather than bumping again. It refuses without the previous
 * key, because a pass that re-sealed everything under the key it was already
 * using would report work it did not do. A row neither key opens is named,
 * never dropped.
 */
export async function rotateCredentialKeys(
  env: IngestEnv,
): Promise<CredentialRotationResult> {
  const empty = {
    keyVersion: null,
    rows: 0,
    rotated: 0,
    alreadyCurrent: 0,
    unreadable: [],
    contended: [],
  };

  let previous: Uint8Array<ArrayBuffer> | null;
  try {
    keyBytes(env);
    previous = previousKeyBytes(env);
  } catch (error) {
    if (error instanceof CredentialKeyError) {
      return {
        ok: false,
        refusal: error.code === 'key_invalid' ? 'key-invalid' : 'key-missing',
        reason: error.message,
        ...empty,
      };
    }
    throw error;
  }
  if (previous === null) {
    return { ok: false, refusal: 'previous-key-missing', reason: ROTATE_NEEDS_PREVIOUS_KEY, ...empty };
  }

  const rows = await readRows(env.STORE);
  if (rows.length === 0) {
    return { ok: true, refusal: null, reason: null, ...empty };
  }

  // Pass one: which key opens each row. Decrypts and discards; holding every
  // plaintext at once would put the whole store in one variable.
  const opened = new Map<string, OpeningKey | null>();
  for (const row of rows) {
    try {
      opened.set(row.provider, (await openWith(env, row)).key);
    } catch (error) {
      if (!(error instanceof CredentialKeyError)) throw error;
      opened.set(row.provider, null);
    }
  }

  const versions = rows.map((row) => row.key_version);
  const max = Math.max(...versions);
  const uniform = versions.every((version) => version === max);
  const work = rows.filter((row) => opened.get(row.provider) !== 'current');

  // Nothing sealed under the old key is nothing to rotate: a second run inside
  // the window bumps no version.
  if (work.length === 0) {
    return {
      ok: true,
      refusal: null,
      reason: null,
      keyVersion: max,
      rows: rows.length,
      rotated: 0,
      alreadyCurrent: rows.length,
      unreadable: [],
      contended: [],
    };
  }
  // A uniform table is a rotation starting; a split one is a rotation being
  // finished, so it lands on the version the earlier pass already reached.
  const target = uniform ? max + 1 : max;

  const unreadable: string[] = [];
  const contended: string[] = [];
  let rotated = 0;
  let alreadyCurrent = rows.length - work.length;

  for (const row of rows) {
    const key = opened.get(row.provider);
    if (key === null) {
      unreadable.push(row.provider);
      continue;
    }
    if (key === 'current' && row.key_version === target) continue;
    // Opened by the current key but stamped at another version: a row a Save
    // wrote while the pass was running. Re-sealed like any other.
    if (key === 'current') alreadyCurrent -= 1;

    let fields: Record<string, string>;
    try {
      fields = (await openWith(env, row)).fields;
    } catch (error) {
      if (!(error instanceof CredentialKeyError)) throw error;
      // It opened a moment ago and does not now: rewritten under a key we do
      // not hold. Name it rather than guessing.
      unreadable.push(row.provider);
      continue;
    }
    const sealed = await seal(env, fields);
    // The connection is not written: `updated_at` does not move, because a
    // rotation is not something the operator did to this credential, and the
    // verdict columns stay, because only the lock on the box changed.
    const replaced = await env.STORE.write((tx) =>
      replaceSecret(
        tx,
        row.connection_id,
        row.secret_version,
        {
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          keyVersion: target,
          fieldNames: row.field_names,
          assetIds: row.asset_ids,
        },
        new Date().toISOString(),
      ),
    );
    if (!replaced) {
      contended.push(row.provider);
      continue;
    }
    rotated += 1;
  }

  return {
    ok: true,
    refusal: null,
    reason: null,
    keyVersion: target,
    rows: rows.length,
    rotated,
    alreadyCurrent,
    unreadable,
    contended,
  };
}


// ---------------------------------------------------------------------------
// The resolver every provider client goes through
// ---------------------------------------------------------------------------

export interface ResolvedCredential {
  /** Private ownership facts from the selected store, never provider input.
   * Null workspace is possible only for standalone, store-free legacy readers. */
  readonly workspaceId: string | null;
  readonly connectionId: string | null;
  /** Monitoring metadata captured from the same row as the decrypted fields. */
  revision?: { createdAt: string; updatedAt: string };
  provider: string;
  source: CredentialSource;
  fields: Record<string, string>;
  /**
   * Asset id → the env binding name that supplied that asset's key, where a
   * legacy single-asset binding answered for it. Always empty for a store-held
   * credential. Exists so a run records the slot that actually answered.
   */
  legacySlots: Record<string, string>;
}

/** A provider call's captured connection must still be current before publishing
 * its selection or artifact. Fingerprints are private and timing-safe. */
async function sameCredentialFields(a: Record<string, string>, b: Record<string, string>): Promise<boolean> {
  const digest = (fields: Record<string, string>) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(Object.entries(fields).sort(([x], [y]) => x.localeCompare(y)))));
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}
/** Hold the current connection and export lease while publishing the SQL
 * receipt. Selection, disconnect, resealing and token replacement lock
 * this same connection row; no generation can change between check and publish. */
export async function publishCloudflareBackup(env: IngestEnv, captured: ResolvedCredential, lease: string, owner: string, publish: (tx: Transaction) => Promise<void>): Promise<boolean> {
  await assertCredentialOwner(env, captured, 'cloudflare');
  const row = await readRow(env.STORE, 'cloudflare');
  if (!row || row.connection_id !== captured.connectionId || captured.source !== 'store'
    || !await sameCredentialFields(await open(env, row), captured.fields)) return false;
  return env.STORE.write(async tx => {
    const [connection] = await tx.query<{ connection_id: string }>('SELECT connection_id FROM noticeos.integration_connections WHERE provider = $1 FOR UPDATE', ['cloudflare']);
    if (connection?.connection_id !== row.connection_id) return false;
    const [secret] = await tx.query<{ version: number }>('SELECT max(secret_version) AS version FROM noticeos.connection_secrets WHERE connection_id = $1', [row.connection_id]);
    if (secret?.version !== row.secret_version) return false;
    const [owned] = await tx.query<{ owner: string }>('SELECT owner FROM noticeos.integration_leases WHERE lease_key = $1 AND owner = $2 AND expires_at > $3::timestamptz FOR UPDATE', [lease, owner, new Date()]);
    if (!owned) return false;
    await publish(tx);
    return true;
  });
}
export async function saveCloudflareSelection(env: IngestEnv, captured: ResolvedCredential, selection: D1Selection): Promise<boolean> {
  await assertCredentialOwner(env, captured, 'cloudflare');
  if (!d1Selection(selection) || selection.accountId !== captured.fields.CLOUDFLARE_ACCOUNT_ID) return false;
  const row = await readRow(env.STORE, 'cloudflare');
  if (!row || row.connection_id !== captured.connectionId || captured.source !== 'store') return false;
  const current = await open(env, row);
  if (!await sameCredentialFields(current, captured.fields)) return false;
  const fields = { ...current, [CLOUDFLARE_D1_TARGETS]: JSON.stringify(selection) };
  const sealed = await seal(env, fields); const at = new Date().toISOString();
  return env.STORE.write(async tx => {
    const saved = await replaceSecret(tx, row.connection_id, row.secret_version, {
      ciphertext: sealed.ciphertext, iv: sealed.iv, keyVersion: await currentKeyVersion(tx),
      fieldNames: Object.keys(fields), assetIds: [...new Set(selection.targets.map(target => target.asset))].sort(),
    }, at);
    if (saved) await tx.execute('UPDATE noticeos.integration_connections SET updated_at = $1::timestamptz WHERE connection_id = $2', [at, row.connection_id]);
    return saved;
  });
}

/** Internal session persistence. Guarded on the secret version it read, so a
 * disconnected or replaced login is never revived. The field names stay the
 * connection's: the session is the store's own, never a field of the form. */
export async function saveMediavineSession(env: IngestEnv, session: string | null): Promise<void> {
  const row = await readRow(env.STORE, 'mediavine');
  if (!row) throw new Error('Mediavine is disconnected.');
  const fields = await open(env, row);
  if (session === null) delete fields.MEDIAVINE_SESSION;
  else fields.MEDIAVINE_SESSION = session;
  const sealed = await seal(env, fields);
  const saved = await env.STORE.write(async (tx) =>
    replaceSecret(
      tx,
      row.connection_id,
      row.secret_version,
      {
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        keyVersion: await currentKeyVersion(tx),
        fieldNames: row.field_names,
        assetIds: row.asset_ids,
      },
      new Date().toISOString(),
    ),
  );
  if (!saved) throw new Error('Mediavine connection changed. Try again.');
}

/**
 * The credential one provider client should use, and where it came from.
 * Store-first, env-fallback, all or nothing. Never throws for a missing key: an
 * install without one keeps running on env.
 */
export async function resolveCredential(
  env: IngestEnv,
  providerId: IntegrationProviderId,
  policy: 'legacy-fallback' | 'store-only' = 'legacy-fallback',
): Promise<ResolvedCredential> {
  const legacy = usesLegacyCredentialBindings(env);
  const workspaceId = env.STORE ? await env.STORE.workspaceId() : null;
  if (!legacy && workspaceId === null) throw new Error('Credential workspace is unavailable');
  const provider = integrationProvider(providerId);
  if (provider === null) {
    return { workspaceId, connectionId: null, provider: providerId, source: 'none', fields: {}, legacySlots: {} };
  }

  const row = await readRow(env.STORE, provider.id);
  if (row !== null) {
    try {
      return {
        workspaceId, connectionId: row.connection_id,
        provider: provider.id,
        source: 'store',
        revision: { createdAt: row.created_at, updatedAt: row.updated_at },
        fields: await open(env, row),
        legacySlots: {},
      };
    } catch (error) {
      if (!(error instanceof CredentialKeyError)) throw error;
      // An unreadable stored credential must not take the lane down while a
      // working env binding sits beside it: loud once, then the fallback runs.
      console.warn(
        JSON.stringify({
          event: 'credential_unreadable',
          provider: provider.id,
          code: error.code,
        }),
      );
    }
  }

  if (policy === 'store-only' || !legacy) {
    return { workspaceId, connectionId: row?.connection_id ?? null, provider: provider.id, source: 'none', fields: {}, legacySlots: {} };
  }
  const { fields, legacySlots } = envCredential(env, provider, await legacyRegister(env));
  return {
    workspaceId, connectionId: null,
    provider: provider.id,
    source: credentialAuthState(provider, Object.keys(fields)).complete ? 'env' : 'none',
    fields,
    legacySlots,
  };
}

/**
 * Is this provider connected at all: false exactly when Integrations draws it
 * as not connected (no stored row, readable or not, and no complete env
 * binding). A row this Worker cannot open is still a connection, one that
 * broke. A scheduled lane whose provider is not connected has no work.
 */
export async function credentialConnected(
  env: IngestEnv,
  providerId: IntegrationProviderId,
  resolved: ResolvedCredential,
): Promise<boolean> {
  await assertCredentialOwner(env, resolved, providerId);
  if (resolved.source !== 'none') return true;
  return (await credentialSummary(env, providerId))?.source !== 'none';
}

/** A captured credential cannot be reused with another call's store/provider. */
export async function assertCredentialOwner(env: IngestEnv, credential: ResolvedCredential, provider: IntegrationProviderId): Promise<void> {
  const workspaceId = env.STORE ? await env.STORE.workspaceId() : null;
  if (credential.provider !== provider || credential.workspaceId !== workspaceId
    || (!usesLegacyCredentialBindings(env) && (workspaceId === null || credential.source === 'env')))
    throw new Error('Credential ownership does not match this call');
}

/** One field of one provider's credential, plus where the credential came from. */
export async function resolveCredentialField(
  env: IngestEnv,
  providerId: IntegrationProviderId,
  field: string,
): Promise<{ value: string | undefined; source: CredentialSource }> {
  const resolved = await resolveCredential(env, providerId);
  return { value: resolved.fields[field], source: resolved.source };
}

/**
 * What `signal_runs.credential_ref` records. A store-held credential is
 * prefixed rather than renamed, so existing refs keep their meaning and the
 * prefix adds the one missing fact: the value came from the product.
 */
export function sourcedCredentialRef(ref: string, source: CredentialSource): string {
  return source === 'store' ? `store:${ref}` : ref;
}

/**
 * Stamp the outcome of a real call onto a stored credential. Only from the
 * scheduled collectors and the connection test: the polled display reads do
 * not call this, since a status column is not worth two writes a minute.
 * Never throws: a collection must not fail over its own bookkeeping.
 */
export async function recordCredentialOutcome(
  env: IngestEnv,
  providerId: IntegrationProviderId,
  outcome: { ok: boolean; error?: string | null; at?: string },
): Promise<void> {
  const at = outcome.at ?? new Date().toISOString();
  try {
    await env.STORE.write((tx) =>
      tx.execute(
        `UPDATE noticeos.integration_connections
            SET last_used_at = $1::timestamptz,
                last_ok_at = CASE WHEN $3::boolean THEN $1::timestamptz ELSE last_ok_at END,
                last_error = CASE WHEN $3::boolean THEN NULL ELSE $4::text END
          WHERE provider = $2`,
        [at, providerId, outcome.ok, (outcome.error ?? null)?.slice(0, 500) ?? null],
      ),
    );
  } catch {
    // A store that cannot answer, or a provider with no stored connection, both
    // mean "nothing to stamp".
  }
}
