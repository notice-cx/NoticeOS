// Shared test tokens. Imported by both vitest.config.ts (to inject them as
// worker bindings) and the test files (to present them as bearer tokens), so
// the two never drift.

// One token per asset, both directions: the pulse lane checks an inbound push
// against the entry for the asset id in the body, and the nightly pull/counters
// crons present that same entry when they fetch the asset's self-report
// endpoint. An asset absent here (acorn.example) has no token in either lane.
export const ASSET_TOKENS: Record<string, string> = {
  'meadow.example': 'meadow-secret-token',
  'northwind.example': 'nw-secret-token',
  'root-os': 'os-secret-token',
};

export const OPERATOR_TOKEN = 'operator-secret-token';

// A throwaway 32-byte key, base64, so the credential-store suite can seal and
// open real AES-GCM rows. Made nowhere near an installation's own key.
export const CREDENTIALS_KEY = btoa('reindex-os-test-credentials-key!');
