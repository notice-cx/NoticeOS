// One site's token, saved on its own row. Clarity issues one data-export
// token per project and offers no call cheap enough to prove one, so a token
// is saved the moment it is pasted and the proof is the export, run only on an
// explicit Run now. The credential is still one encrypted row holding a map of
// site → token; a paste is merged into that map here, inside the Worker that
// alone can open it, so it never replaces the other sites' tokens. What the
// map held before, from the store or folded from the legacy environment
// bindings, is carried into the write.

import type { IntegrationProvider, PutSiteTokenInput, PutSiteTokenResult } from '@noticeos/contract';
import { integrationProvider } from '@noticeos/contract';
import { putCredential, resolveCredential } from './credentials.js';

/** The per-site map field a `site-tokens` provider stores its tokens in. */
export function siteTokenField(provider: IntegrationProvider): string | null {
  if (provider.connect?.kind !== 'site-tokens') return null;
  return provider.fields.find((field) => field.kind === 'asset-map' && field.managed !== true)?.name ?? null;
}

/**
 * Save one site's token into its provider's per-site map. The token must be
 * non-empty and the site one of the portfolio's own; everything else about it
 * is the store's own validation, run by `putCredential` on the merged map.
 */
export async function putSiteToken(env: IngestEnv, input: PutSiteTokenInput): Promise<PutSiteTokenResult> {
  const provider = integrationProvider(String(input?.provider));
  if (provider === null) return { ok: false, error: 'unknown_provider', provider: String(input?.provider) };
  const field = siteTokenField(provider);
  if (field === null) return { ok: false, error: 'not_supported', provider: provider.id };
  const asset = typeof input.asset === 'string' ? input.asset.trim() : '';
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (token === '') return { ok: false, error: 'validation', issues: [{ path: 'token', code: 'required', message: 'The token is required.' }] };
  // One of the installation's own sites, never the OS: the site list on Postgres.
  const known = asset !== '' && (await env.STORE.read((tx) =>
    tx.query(`SELECT 1 AS known FROM noticeos.assets WHERE asset_id = $1 AND NOT is_os`, [asset]),
  )).length > 0;
  if (!known) return { ok: false, error: 'validation', issues: [{ path: 'asset', code: 'unknown_asset', message: 'That site is not one of this installation’s.' }] };

  const current = await resolveCredential(env, provider.id);
  let map: Record<string, string> = {};
  const held = current.fields[field];
  if (typeof held === 'string' && held.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(held);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        map = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
      }
    } catch {
      // A map that does not parse holds no token this write could keep.
    }
  }
  map[asset] = token;
  const fields: Record<string, string> = {};
  for (const other of provider.fields) {
    const value = current.fields[other.name];
    if (other.name !== field && typeof value === 'string' && value !== '') fields[other.name] = value;
  }
  fields[field] = JSON.stringify(map);
  return putCredential(env, { provider: provider.id, fields });
}
