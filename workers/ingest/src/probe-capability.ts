import type { IntegrationProviderId } from '@noticeos/contract';

/**
 * The integration-health capability a provider's connection proof is recorded
 * under. One map for both doors that prove a credential, the Test button
 * (`credential-probes.ts`) and the connect panel (`credential-connect.ts`), so
 * a key accepted in the panel lands on the same health row a later Test updates.
 */
export const PROBE_CAPABILITY: Record<IntegrationProviderId, string> = {
  cloudflare: 'cloudflare-test',
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
