import { integrationProvider } from '@noticeos/contract/integrations';
import type { IntegrationHealthItem, IntegrationHealthPayload } from '@noticeos/contract/integration-health';
import { currentHealth, siteStatuses, type SiteStatus } from './connection-status';

export const integrationProviderName = (id: string) => integrationProvider(id)?.label.split(' (')[0] ?? id;

/** One provider's sites, as the connection model reads them. */
export interface ProviderSites { provider: string; sites: SiteStatus[] }

/**
 * The monitoring read as the shell's summaries count it (System health's status
 * cell, the Wall's warning), in the connection model's units (bead
 * `ro-ujb9.96.7.3`): a site failing or late now needs the operator; a report
 * date missing from an old outage is a fact on its site, not an incident.
 */
export interface IntegrationStatus {
  current: boolean;
  available: boolean;
  /** The monitoring items as this screen may use them (`currentHealth`). */
  items: IntegrationHealthItem[];
  providers: ProviderSites[];
  /** Sites failing or overdue now. */
  attention: number;
  failing: number;
  /** Sites still waiting for a first result, or whose result is unknown. */
  unconfirmed: number;
  working: number;
  /** Sites whose collection is switched off. */
  idle: number;
  affectedAssets: string[];
}

export function integrationStatus(data: IntegrationHealthPayload | undefined, isError: boolean, nowMs: number): IntegrationStatus {
  const { current, available, items } = currentHealth(data, isError, nowMs);
  const ids = [...new Set(items.map((item) => item.provider))];
  const providers = ids.map((provider) => ({
    provider,
    sites: siteStatuses(items.filter((item) => item.provider === provider && item.state !== 'disconnected')),
  }));
  const sites = providers.flatMap((entry) => entry.sites);
  const count = (...kinds: SiteStatus['kind'][]) => sites.filter((site) => kinds.includes(site.kind)).length;
  const affected = sites.filter((site) => site.kind === 'failing' || site.kind === 'overdue').flatMap((site) => (site.asset ? [site.asset] : []));
  return {
    current, available: available && items.length > 0, items, providers,
    attention: count('failing', 'overdue'), failing: count('failing'), unconfirmed: count('unknown', 'collecting'),
    working: count('working'), idle: count('not-using'), affectedAssets: [...new Set(affected)],
  };
}
