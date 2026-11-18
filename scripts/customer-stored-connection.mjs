import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { unsealCredential } from './sealed-credential.mjs';

export async function readCustomerConnection({ address, workspaceId }, provider) {
  const store = openWorkspaceStore(address, { workspaceId, maxConnections: 1 });
  try {
    const rows = await store.read(tx => tx.query(`SELECT c.connection_id, s.secret_version,
        CASE WHEN octet_length(s.ciphertext) <= 65552 THEN s.ciphertext END AS ciphertext, s.iv
      FROM noticeos.integration_connections c LEFT JOIN LATERAL (
        SELECT secret_version, ciphertext, iv FROM noticeos.connection_secrets
        WHERE workspace_id=c.workspace_id AND connection_id=c.connection_id
        ORDER BY secret_version DESC LIMIT 1
      ) s ON true WHERE c.workspace_id=$1::uuid AND c.provider=$2`, [workspaceId, provider]));
    if (rows.length > 1) throw new Error('Ambiguous connection.');
    return rows[0] ?? null;
  } finally { await store.close(); }
}

export async function customerCredentialFields(row, credentialsKey) {
  const key = Uint8Array.from(Buffer.from(credentialsKey, 'base64'));
  if (key.length !== 32 || row?.iv?.length !== 12 || !row.ciphertext || !Number.isInteger(row.secret_version)) throw new Error('Unreadable connection.');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await unsealCredential(key, row.iv, row.ciphertext)));
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(field => typeof field !== 'string')) {
    throw new Error('Unreadable connection.');
  }
  return value;
}
