// The credential store: every provider secret the product holds, encrypted
// under ONE bootstrap key, and the resolver every provider client goes through
// (epic `ro-vu8d`, bead `ro-vu8d.1`). On Postgres (the port pattern,
// docs/briefs/2026-09-29-postgres-port-pattern.md; bead ro-ujb9.76.4.4, under
// the operator's approval on ro-ujb9.76.31): a provider's connection is a row
// of noticeos.integration_connections, its sealed secret the current version
// in noticeos.connection_secrets, both through this call's store, `env.STORE`.
//
// THE ONE RULE. Plaintext exists inside THIS Worker, at call time, and nowhere
// else. `listCredentialSummaries()` returns field NAMES and metadata; no RPC,
// no route and no log line in this system returns a stored value to a caller.
// The Tower never holds a credential: it asks for a probe verdict or summary
// through the server's authorized workspace context instead of for the secret.
//
// THE ONE ENV SECRET. `CREDENTIALS_KEY`, 32 bytes base64. Without it the store
// cannot be written or read, and this module says so in one line — the state,
// the binding and `openssl rand -base64 32` (`credentialKeyLine`) — rather than
// throwing something an operator has to search for. Explicit standalone
// installations retain legacy env fallback. Hosted and demo profiles use only
// the selected workspace's stored connections and never read provider bindings.
//
// AES-GCM, FRESH IV PER WRITE, VERSIONED KEY. The IV is 12 random bytes on
// every write — reusing one under the same key is the one way to break GCM
// outright, so there is no "patch one field" path: a change re-seals the whole
// fields object. `key_version` rides every row so a rotation can re-seal rows
// one at a time later without a migration.
//
// STORE-FIRST, ENV-FALLBACK, ALL-OR-NOTHING. A provider with a stored row is
// served ENTIRELY from the store; standalone fallback uses only env fields. The
// two are never mixed. A stored DataForSEO login paired with an env password
// would produce a 401 nobody could explain, and the write path already refuses
// an incomplete credential, so a stored row is complete by construction.

// NOTHING PROVIDER-SPECIFIC IS IMPORTED HERE, on purpose: the collectors import
// this module, so a provider client imported back would be an import cycle. The
// probes live next door in credential-probes.ts, which is allowed to know about
// both.
import { type Transaction, type WorkspaceStore, javascriptInstant } from '@noticeos/postgres';
import {
  CREDENTIAL_BLOCKER_LEADS,
  CREDENTIALS_KEY_COMMAND,
  type CredentialBalance,
  type ExactUsd,
  type CredentialExpirySource,
  type CredentialIssue,
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

/** Only the server's standalone profile may resolve legacy provider bindings. */
export function usesLegacyCredentialBindings(env: IngestEnv): boolean {
  return workspaceProfile(env) === 'standalone';
}

/**
 * The generation a row is stamped with when nothing has ever been rotated.
 *
 * NOT a build constant any more (bead `ro-vu8d.11`). The version is a fact
 * about the TABLE, not about this deploy: once a rotation has re-sealed every
 * row at 2, a later `putCredential` has to stamp 2 as well or the table would
 * split every time somebody pressed Save. `currentKeyVersion()` reads the
 * table's own high-water mark and falls back to this.
 */
export const CREDENTIAL_KEY_VERSION = 1;

/** Where the key rows were sealed with BEFORE a rotation lives, for the window
 * in which both have to be readable (bead `ro-vu8d.11`). */
export const PREVIOUS_KEY_BINDING = 'CREDENTIALS_KEY_PREVIOUS';

/** AES-GCM's nonce length in bytes. 96 bits is the size the construction is
 * specified for; anything else costs a GHASH pass and buys nothing. */
const IV_BYTES = 12;

/** The raw key length AES-256 needs. */
const KEY_BYTES = 32;

/** Ceiling on one field's stored value. A pasted service-account map is a few
 * kilobytes; anything past this is a mistake, not a credential. */
const MAX_FIELD_BYTES = 64 * 1024;

/**
 * A key problem as ONE line: the state, the binding, what is wrong with it,
 * and the command that makes a new key — `No encryption key · CREDENTIALS_KEY ·
 * openssl rand -base64 32` (bead `ro-ujb9.96.6.25`).
 *
 * The same state and command the Integrations banner draws from the blocker
 * code (`CREDENTIAL_BLOCKER_LEADS`, `CREDENTIALS_KEY_COMMAND`), so the command
 * line, "Import from this machine" and the banner say one thing. Where the key
 * is set — `.dev.secrets.json` locally, a Worker secret when deployed — is doc
 * 06's (bootstrap secrets vs integration credentials), linked from the README
 * and never restated in a message.
 *
 * `command: false` for a key that is well-formed but does not open a stored
 * row: a NEW key would not open it either, so the command would be the wrong
 * press (the right one is the key it was sealed with, or reconnecting that
 * provider on its card).
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
 * One provider's stored credential: its connection and that connection's
 * current secret version, instants as JavaScript writes them.
 *
 * THE PUBLIC HALF IS EVERYTHING BUT `ciphertext`. Field names, the site ids a
 * key map covers and the metadata live in the clear, and on purpose:
 * `deleteCredential` and `listCredentialSummaries` both answer WITHOUT the
 * bootstrap key — a rotated key must still leave a card an operator can read
 * and disconnect — so anything the card renders has to live outside the
 * ciphertext or it disappears exactly when it is most needed. None of it is a
 * credential: an email address identifies the grant, the scopes are what
 * Google itself lists on the account's permissions page, and a site id is in
 * `config/integrations.json` and in every site URL.
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
  /** For a `per-asset` provider: the site ids its key map holds a key for
   * (bead `ro-vu8d.9`). Ids only, never a key. */
  asset_ids: string[];
  /** The non-secret facts about the connection (bead `ro-vu8d.3`); null when
   * none were recorded. */
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
 * The key the rows were sealed with BEFORE a rotation, when the operator has
 * both configured (bead `ro-vu8d.11`).
 *
 * Optional by construction: an install that has never rotated has no such
 * binding, and every read below works exactly as it always did. Setting it is
 * the whole of the two-key window — generate a new key, put the old one here,
 * run the rotation, then remove this binding — and it is deliberately a SECOND
 * BINDING rather than a versioned map, because two keys readable at once is the
 * only state the sweep needs and a map would be a config format to get wrong.
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
  /** The same answer as a code the Tower draws (bead `ro-ujb9.96.6.19`). */
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
 * Open one row, trying the CURRENT key and then the PREVIOUS one (bead
 * `ro-vu8d.11`).
 *
 * TWO KEYS, NO BOOKKEEPING. The row records `key_version`, but correctness here
 * does not depend on it: a failed GCM decrypt costs one cheap operation, and
 * trusting a column to decide which key to reach for would mean a row whose
 * version was written wrong is a row nobody can open. So the version is what
 * the ROTATION reads to know what is left to do, and this just tries both —
 * which is also what keeps every collector running throughout the sweep,
 * whichever half of the table it lands on.
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

  // GCM authentication failed under every key we hold: the wrong key, or a
  // tampered row. Both are the same instruction to an operator and neither may
  // leak which.
  throw new CredentialKeyError(
    'key_invalid',
    credentialKeyLine('key-invalid', 'CREDENTIALS_KEY', `does not open ${row.provider}`, { command: false }),
  );
}

async function open(env: IngestEnv, row: CredentialRow): Promise<Record<string, string>> {
  return (await openWith(env, row)).fields;
}

/** The store hands a bytea back as a Uint8Array over whatever buffer the
 * driver read it into; WebCrypto is given a copy over a buffer of its own. */
function toBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value.slice().buffer) as Uint8Array<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// The store: a connection and its current secret
// ---------------------------------------------------------------------------
//
// ALWAYS THERE. The Postgres store is built whole by its baseline
// (db/postgres/migrations), so D1's "the table is not applied yet" cannot
// happen: a read or a write that cannot reach the store throws, and nothing
// falls back to "nothing stored".
//
// ONE SECRET PER CONNECTION AT REST. A new secret — a Save, a key rotation, a
// renewed Mediavine session — is the next `secret_version`, written in the
// same transaction that removes the one before. A version is never rewritten,
// so "the version I read is still the current one" is how a write knows that
// nothing replaced the secret meanwhile.

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

// A hand-built test env with no store has no stored credential by definition —
// the calendar suite constructs exactly that. Every call into this Worker has
// one (src/call-store.ts), so this never fires in anger.
async function readRows(store: WorkspaceStore | undefined): Promise<CredentialRow[]> {
  if (!store) return [];
  return store.read((tx) => selectCredentials(tx, null));
}

async function readRow(store: WorkspaceStore | undefined, provider: string): Promise<CredentialRow | null> {
  if (!store) return null;
  return (await store.read((tx) => selectCredentials(tx, provider)))[0] ?? null;
}

/**
 * The generation a NEW write should be stamped with (bead `ro-vu8d.11`).
 *
 * The store's own high-water mark, not a build constant. After a rotation has
 * re-sealed every secret at 2, a `putCredential` stamping the constant 1 would
 * put the store straight back into the split state the rotation just resolved —
 * and the next rotation would then have to guess which half was current. Read
 * inside the write that stamps it; one MAX() over one secret per provider.
 *
 * An empty store answers the base version, which is what its first write needs.
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
 * Replace a connection's secret with `secret`, as the version after `replaces`
 * (or after whatever is newest, when `replaces` is null), inside the caller's
 * transaction. With `replaces`, nothing is written unless that version is
 * still the current one — the guard a write that read the secret first needs —
 * and the answer says whether it was.
 *
 * The connection row is locked first, as a Save's upsert locks it, so two
 * writers of one connection take turns instead of each waiting on the other's
 * secret row.
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

/** The connection's metadata, or null when nothing was recorded: THE ONE RULE
 * for what counts as recorded, whether the facts came from the store's columns
 * or from a caller. Read defensively rather than cast, so a value of the wrong
 * shape degrades to "nothing recorded" instead of putting `undefined` on a
 * card. */
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
    // 'operator' }` is the operator saying THIS DOES NOT EXPIRE, and dropping
    // it as "nothing recorded" would let the next sign-in put a countdown back
    // on a card they already corrected.
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
    // Written only for a provider that HAS a prepaid account, so the key stays
    // absent on the other six rather than becoming a null every row carries.
    ...(balance === null ? {} : { balance }),
  };
}

/** A prepaid sighting, or nothing. BOTH HALVES OR NEITHER (bead `ro-qpas`): a
 * figure whose stored instant is missing or unreadable is an undated balance,
 * and an undated balance is the one shape the card must never be handed — it
 * would render as though it were current. */
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

/** A connection's metadata as the columns it is stored in: every fact in the
 * clear, beside the secret rather than inside it. */
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
 * The asset ids a `per-asset` credential's map holds a key for — keys only,
 * never a value (bead `ro-vu8d.9`).
 *
 * Shared by the store write and the env-fallback summary, so a card reads the
 * same list whichever half of the move an install is on. A map that does not
 * parse answers with nothing rather than throwing: the caller has either
 * validated it already, or is describing a binding somebody typed by hand and a
 * broken one covers no assets.
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

/** The asset ids held by whichever of this provider's fields is the asset map.
 * Empty for every `shared` provider — there is no per-asset dimension. */
function assetsHeldBy(
  provider: IntegrationProvider,
  fields: Record<string, string>,
): string[] {
  if (provider.scope !== 'per-asset') return [];
  const map = provider.fields.find((field) => field.kind === 'asset-map');
  return map === undefined ? [] : credentialAssetKeys(fields[map.name]);
}

/**
 * What this provider can read out of the legacy env bindings — values and the
 * slot each one came from.
 *
 * ONE READ, in `packages/contract` (`readEnvCredential`), because a provider can
 * hold a field under more than one binding name: Clarity's asset map absorbs the
 * older single-project `CLARITY_PROJECT_API_TOKEN` as that asset's key (bead
 * `ro-vu8d.24`). Reading only the declared names is what put *Not connected* on
 * a card whose collector was collecting.
 */
function envCredential(env: IngestEnv, provider: IntegrationProvider, register: unknown) {
  if (!usesLegacyCredentialBindings(env)) return { fields: {}, legacySlots: {} };
  return readEnvCredential(provider, env as unknown as Record<string, unknown>, register);
}

/**
 * The data-source register the legacy-binding rule reads — store first, the
 * compiled copy when absent (bead `ro-ujb9.118`) — so WHICH asset an older
 * single-asset binding serves is the installation's answer, never a site
 * written into the catalog. Read only when this environment actually holds
 * such a binding; every other install pays nothing for it.
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
      // A partial env credential is `none`, not `env`: the client would refuse
      // it anyway, and calling it configured would put a green light on a lane
      // that cannot run.
      source: state.complete ? 'env' : 'none',
      fields: [],
      // A per-asset credential still in its legacy binding covers the assets
      // its map names, and the card has to be able to say so — otherwise the
      // one provider whose coverage is partial by design would read as covering
      // nothing until it moved into the store.
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
 * Every provider's connection state, in catalog order.
 *
 * ALWAYS all of them: a provider with nothing stored is a card that says "not
 * connected", not a row missing from a list. And never a value — this is the
 * function the Tower calls, so its return type is the security boundary.
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

/** One provider's summary, without assembling the other four. Same answer as
 * `listCredentialSummaries()`, and the same guarantee: names and metadata. */
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
 * An HMAC-SHA256 key for signing something short-lived that has to survive a
 * round trip through a browser — today only the OAuth state nonce
 * (`google-oauth.ts`, bead `ro-vu8d.3`).
 *
 * DERIVED, NOT REUSED. It is HKDF'd out of `CREDENTIALS_KEY` with its own info
 * string rather than being the encryption key wearing a second hat: one key
 * doing two jobs is how a signing oracle turns into a decryption oracle, and
 * the derivation costs nothing. A future second signed thing gets its own info
 * string, not this one.
 *
 * It throws `CredentialKeyError` exactly as the encryption path does — an
 * install with no bootstrap key cannot store what a sign-in would return, so
 * refusing to START one is the honest order.
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

function issue(path: string, code: string, message: string): CredentialIssue {
  return { path, code, message };
}

/** Validate a submitted fields object against the provider's declared schema.
 * Messages name the FIELD and never the value — this text reaches a browser. */
export function validateCredentialFields(
  provider: IntegrationProvider,
  fields: Record<string, unknown>,
): CredentialIssue[] {
  const issues: CredentialIssue[] = [];
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

function validateFieldShape(field: IntegrationField, value: string): CredentialIssue[] {
  if (field.kind === 'text' || field.kind === 'password') {
    return value.trim() === ''
      ? [issue(field.name, 'blank', `${field.label} is blank.`)]
      : [];
  }

  // ONE url that is itself the credential (a Discord webhook). Checked to the
  // same standard as one entry of a `url-list` — it parses, and it is http(s) —
  // and refused by FIELD NAME, never by echoing the address back.
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

  // asset-map: `asset id -> that asset's own key` (bead `ro-vu8d.9`). A
  // rejection names the ASSET, never the token — the same rule the calendar
  // map keeps for its labels, and for the same reason: this text reaches a
  // browser.
  if (field.kind === 'asset-map') {
    const issues: CredentialIssue[] = [];
    for (const [asset, token] of entries) {
      if (typeof token !== 'string' || token.trim() === '') {
        issues.push(
          issue(field.name, 'blank', `${field.label}: "${asset}" has no key.`),
        );
      }
    }
    return issues;
  }

  // url-list: `label -> url` or `label -> { url, … }`, http(s) only. The URL is
  // the credential, so a rejection names the LABEL and never the value.
  const issues: CredentialIssue[] = [];
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

/** Store one provider's credential, replacing whatever was there.
 *
 * A REPLACE and not a merge: the IV must be fresh, so the whole fields object is
 * re-sealed. That also makes "reconnect" mean what an operator expects — what
 * they just typed is what is stored, with nothing surviving from before.
 *
 * ONE EXCEPTION, and it is narrow: a `managed` field (contract — today only the
 * Google refresh token) SURVIVES an input that does not name it. No form can
 * send one, because no operator can type one, so an input that omits it is not
 * a statement that it should go. Without this, pasting a service-account map on
 * a card that is already signed in would silently throw away a live grant —
 * leaving a token valid at Google that this OS can no longer revoke. Disconnect
 * is how a grant is removed, and it revokes at Google first.
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
  Object.assign(fields, await carriedManagedFields(env, provider, previous, fields));

  // WHETHER THE RESULT WORKS AT ALL, judged on what will actually be stored.
  // `required` cannot express Google's *either a sign-in or a service account*,
  // so the rule is the contract's — the same one the card reads a summary with
  // and the importer skips an incomplete provider with.
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

  // The metadata the caller asserted, or whatever the row already recorded. A
  // form save must not erase whose account is connected merely by not
  // mentioning it — only the OAuth callback ever sets this.
  //
  // THE BALANCE IS THE EXCEPTION, and for the same reason the verdict columns
  // are cleared below (bead `ro-qpas`): what was pasted may name a DIFFERENT
  // prepaid account, and a credit figure carried across a rotation would then
  // be attributed to an account nobody read it from. The card says nothing has
  // been seen yet until the next answer carries one, which the Test press
  // beside the form usually is.
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
    await replaceSecret(
      tx,
      connection!.connection_id,
      null,
      {
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        // The store's generation, not the build's — see `currentKeyVersion`.
        keyVersion: await currentKeyVersion(tx),
        fieldNames: Object.keys(fields),
        assetIds: assetsHeldBy(provider, fields),
      },
      now,
    );
  });

  const row = await readRow(env.STORE, provider.id);
  return { ok: true, summary: summarize(provider, row, env, await legacyRegister(env)) };
}

/**
 * The `managed` values the previous row held that this write did not name.
 *
 * Reading them costs a decrypt, so it only happens when there is something to
 * carry: no managed field in the schema, or every one of them named by the
 * input, and this returns without touching the key. A key that cannot open the
 * old row carries NOTHING rather than failing the save — an operator who has
 * rotated `CREDENTIALS_KEY` is reconnecting precisely because the old row is
 * unreadable, and refusing them would be the store defending a secret nobody
 * can use.
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
    if (error instanceof CredentialKeyError) return {};
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
 * Record — or clear — when one provider's credential stops working (bead
 * `ro-vu8d.8`).
 *
 * A METADATA-ONLY WRITE, and that is the whole design. The expiry is a
 * non-secret fact in a column of the connection beside the secret, so this
 * touches neither the ciphertext nor the IV: it needs no bootstrap key (a card whose key was
 * rotated must still be able to record that its credential dies on Friday), it
 * cannot fail a GCM round trip, and it leaves `last_ok_at` alone — unlike a
 * `putCredential`, which clears the verdict because a NEW secret has to prove
 * itself. A date is not a new secret.
 *
 * `expiresAt: null` is an ANSWER, not an erasure: it stamps `operator` so a
 * later sign-in cannot put the flow's assumption back (`carriedExpiry` below).
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

  // The date and who gave it, and nothing else: whose account it is and the
  // last balance sighting (with its own instant) ride through untouched.
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
 * Stamp what a provider's PREPAID ACCOUNT held, with the instant it said so
 * (bead `ro-qpas`).
 *
 * THE ONE WRITER. Everything that can see the figure — the Test connection
 * probe, and the weekly sweep when a response carries one — comes through here,
 * so there is one shape on disk and one rule about what counts as a sighting.
 *
 * A METADATA-ONLY WRITE, for exactly the reasons `setCredentialExpiry` above is
 * one: the balance is a NON-SECRET fact, so this touches neither the ciphertext
 * nor the IV, needs no `CREDENTIALS_KEY`, and leaves `last_ok_at` and
 * `last_error` standing — a number the vendor volunteered is not a verdict.
 *
 * SILENT WHERE THERE IS NOTHING TO STAMP, because both callers are doing
 * something else and neither should fail over this: a provider still on a
 * legacy env binding has no row (nothing is stored to hang the fact on), and a
 * figure that is not a number's own digits or carries no readable instant is not a
 * sighting at all. The card can only ever say "seen 2h ago" about something
 * that was actually seen.
 */
export async function setCredentialBalance(
  env: IngestEnv,
  providerId: IntegrationProviderId,
  balance: CredentialBalance,
): Promise<void> {
  const usd = exactUsd(balance.usd);
  if (usd === null || !Number.isFinite(Date.parse(balance.seenAt))) return;
  // No connection is no row to stamp: the update touches nothing. The digits
  // cross as text and are cast in SQL: six decimals kept, a seventh rounded
  // half away from zero, and a figure of $100,000,000 or more refused by the
  // type (the card keeps the sighting it had).
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
 * The expiry a NEW connection should carry, given what the row already held.
 *
 * THE OPERATOR'S ANSWER WINS, ALWAYS. A flow can only ever assume — Google
 * publishes no API that says whether a consent screen is still in Testing — so
 * an operator who has told this card "published, no expiry" (or named a real
 * date) must not have that overwritten by the next sign-in. Anything else and
 * the correction has to be re-made after every reconnect, which is how an
 * honest warning becomes one people learn to dismiss.
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
 * Forget one provider's credential.
 *
 * Works WITHOUT `CREDENTIALS_KEY`, on purpose: removing a secret you can no
 * longer read is exactly the operation a lost key calls for, and requiring the
 * key to delete would strand the ciphertext forever. The provider falls back to
 * `env` or to `none`, which the returned summary states.
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
  // Nothing to delete is the same outcome as deleting it: a disconnect is
  // idempotent.
  await env.STORE.write((tx) =>
    tx.execute('DELETE FROM noticeos.integration_connections WHERE provider = $1', [provider.id]),
  );
  return { ok: true, summary: summarize(provider, null, env, await legacyRegister(env)) };
}

// ---------------------------------------------------------------------------
// Rotating the bootstrap key (bead `ro-vu8d.11`)
// ---------------------------------------------------------------------------

/** What one rotation pass did. COUNTS AND PROVIDER IDS ONLY — a provider id is
 * in the shipped catalog, and nothing here has ever seen a plaintext it could
 * report. */
export interface CredentialRotationResult {
  ok: boolean;
  /** Why the pass did not run, as a code: `previous-key-missing` is the
   * rotation's own precondition; the other two are the key blockers. Null
   * when it ran. `pnpm creds:rotate-key` prints the runbook for the first. */
  refusal: 'previous-key-missing' | 'key-missing' | 'key-invalid' | null;
  /** The same refusal as one short line. Null when it ran. */
  reason: string | null;
  /** The generation every readable row is now sealed at. Null on an empty or
   * absent table. */
  keyVersion: number | null;
  rows: number;
  /** Re-sealed under the current key by THIS pass. */
  rotated: number;
  /** Already sealed under the current key at the target version — the resumable
   * skip, and what a second run of a finished rotation reports for everything. */
  alreadyCurrent: number;
  /** Provider ids neither key could open. NAMED, never dropped: the row is left
   * exactly as it was, and the operator reconnects that one provider by hand. */
  unreadable: string[];
  /** Provider ids whose row was written by something else mid-pass (a Save on
   * the Integrations page while this ran). Left alone and named; running the
   * command again picks them up. */
  contended: string[];
}

/** The refusal without the previous key, as its state. The steps that open the
 * two-key window are the runbook `pnpm creds:rotate-key` prints for this code
 * (and workers/ingest/README.md § Rotating CREDENTIALS_KEY): the command that
 * performs the procedure is where its steps are read (bead `ro-ujb9.96.6.25`). */
export const ROTATE_NEEDS_PREVIOUS_KEY = `Nothing to rotate from · ${PREVIOUS_KEY_BINDING} not set`;

/**
 * Re-seal every stored credential under the current `CREDENTIALS_KEY`.
 *
 * WHY THIS EXISTS. `db/0028` shipped a `key_version` column and nothing could
 * move a row between generations, so rotating the bootstrap secret meant every
 * stored credential became undecryptable and the operator reconnected each
 * provider by hand from the source systems. The column was the cheap half; this
 * is the other one.
 *
 * THE PLAINTEXT NEVER LEAVES THIS WORKER, which is the whole reason rotation is
 * an RPC and a loopback route rather than a Node script over the same store. A script would have to decrypt in Node, which is a second place a
 * credential exists — and this store's one rule is that there is no second
 * place. One row's plaintext is held at a time, between a decrypt and the
 * `seal()` on the next line.
 *
 * ATOMIC PER ROW, AND RESUMABLE. Each row is one transaction that writes the
 * next secret version and removes the one it read, guarded on that version
 * still being the current one, so a Save on the Integrations page mid-sweep
 * loses no work and is simply named in `contended`.
 * A pass that dies halfway leaves a SPLIT table, which is a state the reader
 * above handles natively (it tries both keys) and which this function
 * recognises: a split table finishes at the version already reached rather than
 * bumping again, so running the command twice is finishing rather than
 * restarting.
 *
 * IT REFUSES WITHOUT THE PREVIOUS KEY, deliberately. Rotation is only meaningful
 * inside the two-key window; without `CREDENTIALS_KEY_PREVIOUS` there is no old
 * generation to move rows off, and a pass that "succeeded" by re-sealing
 * everything under the key it was already using would be a command that reports
 * work it did not do.
 *
 * A ROW NEITHER KEY OPENS IS NAMED, NEVER DROPPED. Deleting it would destroy the
 * only record that the provider was connected, and rewriting it is impossible —
 * so it keeps its bytes, keeps its version, and the operator gets its provider
 * id and reconnects that one card.
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

  // PASS ONE — which key opens each row. It decrypts and DISCARDS: holding
  // every plaintext at once so the write pass could reuse it would put the whole
  // store in one variable, and a portfolio has one row per provider.
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

  // NOTHING SEALED UNDER THE OLD KEY = NOTHING TO ROTATE. A second run inside
  // the same two-key window says so and bumps no version, rather than re-sealing
  // five working rows at a generation nobody asked for.
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
    // Opened by the current key but stamped at another version — a row a Save
    // wrote while the pass was running. It is re-sealed like any other, so the
    // count of rows that needed nothing has to lose it.
    if (key === 'current') alreadyCurrent -= 1;

    let fields: Record<string, string>;
    try {
      fields = (await openWith(env, row)).fields;
    } catch (error) {
      if (!(error instanceof CredentialKeyError)) throw error;
      // It opened a moment ago and does not now: the row was rewritten under a
      // key we do not hold. Name it rather than guessing.
      unreadable.push(row.provider);
      continue;
    }
    const sealed = await seal(env, fields);
    // The connection is not written: `updated_at` deliberately does NOT move —
    // a rotation is not something the operator did to this credential, and a
    // card reading "Stored 2 minutes ago" for a secret nobody touched would be
    // a lie the whole page exists to prevent. The verdict columns stay too —
    // what the credential proved is still true; only the lock on the box
    // changed.
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
   * Asset id → the env binding NAME that supplied that asset's key, where a
   * legacy single-asset binding answered for it (bead `ro-vu8d.24`). Always
   * empty for a store-held credential, which has exactly one slot.
   *
   * It exists so a run records the slot that ACTUALLY answered: folding
   * `CLARITY_PROJECT_API_TOKEN` into the asset map is what makes the card
   * honest, and naming the map on the manifest row afterwards would make the
   * manifest dishonest in exchange.
   */
  legacySlots: Record<string, string>;
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
 *
 * Store-first, env-fallback, ALL OR NOTHING (see the module header). Never
 * throws for a missing key: an install without one keeps running on env, which
 * is the whole point of the fallback.
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
      // working env binding sits beside it. It is loud (once per resolve) and
      // then the fallback carries the run.
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
 * Is this provider connected at all — false exactly when Integrations draws it
 * as not connected: no stored row (readable or not) and no complete env binding
 * (beads `ro-ujb9.172`, `ro-ujb9.176`). A row this Worker cannot open is still a
 * connection, one that broke, so a lane given `resolved` with no fields asks the
 * row's presence the way the Integrations card asks it.
 *
 * A scheduled lane whose provider is not connected has no work: it asks nothing,
 * records nothing and its step reads skipped, like every source nobody set up.
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

/** One field of one provider's credential, plus where the credential came from.
 * The shape every single-secret client (Bing, the calendar map, the Google
 * account map) actually wants. */
export async function resolveCredentialField(
  env: IngestEnv,
  providerId: IntegrationProviderId,
  field: string,
): Promise<{ value: string | undefined; source: CredentialSource }> {
  const resolved = await resolveCredential(env, providerId);
  return { value: resolved.fields[field], source: resolved.source };
}

/**
 * What `signal_runs.credential_ref` records, so "which credential ran this" is
 * readable months later.
 *
 * A store-held credential is prefixed rather than renamed: the existing refs
 * (an account alias, a binding name) keep meaning what they meant, and the
 * prefix adds the one fact that was missing — the value came from the product,
 * not from `.dev.vars`.
 */
export function sourcedCredentialRef(ref: string, source: CredentialSource): string {
  return source === 'store' ? `store:${ref}` : ref;
}

/**
 * Stamp the outcome of a REAL call onto a stored credential.
 *
 * Only for store-held credentials (there is no row to stamp otherwise) and only
 * from the scheduled collectors and the connection test. The polled display
 * reads — GA4 realtime every 30s, the calendar every 60s — deliberately do not
 * call this: a status column is not worth two writes a minute.
 *
 * Never throws. A collection must not fail over its own bookkeeping.
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
    // Deliberately silent: a store that cannot answer, or a provider with no
    // stored connection, both mean "nothing to stamp".
  }
}
