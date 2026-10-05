// ONE SITE'S TOKEN, SAVED ON ITS OWN ROW (bead `ro-ujb9.96.7.9`, epic
// `ro-ujb9.96.7`).
//
// Clarity issues one data-export token per project — per site — and offers no
// call cheap enough to prove one (each export spends a tenth of that site's
// day). So the connect panel lists the sites, the operator pastes each token
// on its site's row, and it is saved the moment it is pasted; the proof is the
// export, which the panel runs only on an explicit Run now.
//
// The credential is still ONE encrypted row holding a map of site → token
// (the provider's `asset-map` field). A row's paste is merged into that map
// here, inside the Worker that alone can open it, so a paste never replaces
// the other sites' tokens and the browser never holds any of them. What the
// map held before — from the store, or folded from the legacy environment
// bindings — is carried into the write, so the first paste on an install
// still reading its tokens from the environment moves them all into the store
// rather than dropping them.

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
