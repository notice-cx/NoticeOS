import type { IntegrationProviderId } from '@noticeos/contract';

/**
 * The integration-health capability a provider's connection proof is recorded
 * under (`packages/contract/src/integration-health.ts` declares each one).
 *
 * ONE MAP for both doors that prove a credential — the Test button
 * (`credential-probes.ts`) and the connect panel's save-and-test
 * (`credential-connect.ts`, bead `ro-ujb9.96.7.1`) — so a key accepted in the
 * panel lands on the same health row a later Test would update.
 */
export const PROBE_CAPABILITY: Record<IntegrationProviderId, string> = {
  google: 'google-test',
  'bing-webmaster': 'bing-discovery',
  dataforseo: 'dataforseo-test',
  calendar: 'calendar-test',
  discord: 'discord-test',
  mediavine: 'mediavine-test',
  clarity: 'clarity-setup',
  posthog: 'posthog-test',
  'google-oauth-app': 'google-app-setup',
};
