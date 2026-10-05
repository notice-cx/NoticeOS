// Released generic defaults. No filesystem, installation resolver or provider I/O.
import type { JsonValue } from './config-documents.mjs';
import constantsJson from '../config/constants.json' with { type: 'json' };
import countersJson from '../config/counters.json' with { type: 'json' };
import domainCostsJson from '../config/domain-costs.json' with { type: 'json' };
import entitiesJson from '../config/entities.json' with { type: 'json' };
import ga4CustomDimensionsJson from '../config/ga4-custom-dimensions.json' with { type: 'json' };
import integrationsJson from '../config/integrations.json' with { type: 'json' };
import pullJson from '../config/pull.json' with { type: 'json' };
import recurringCostsJson from '../config/recurring-costs.json' with { type: 'json' };
import serpPanelJson from '../config/serp-panel.json' with { type: 'json' };
import signalPanelsJson from '../config/signal-panels.json' with { type: 'json' };
import towerJson from '../config/tower.json' with { type: 'json' };
import valueEventsJson from '../config/value-events.json' with { type: 'json' };

const COMPILED: Readonly<Record<string, unknown>> = Object.freeze({
  'config/constants.json': constantsJson,
  'config/counters.json': countersJson,
  'config/domain-costs.json': domainCostsJson,
  'config/entities.json': entitiesJson,
  'config/ga4-custom-dimensions.json': ga4CustomDimensionsJson,
  'config/integrations.json': integrationsJson,
  'config/pull.json': pullJson,
  'config/recurring-costs.json': recurringCostsJson,
  'config/serp-panel.json': serpPanelJson,
  'config/signal-panels.json': signalPanelsJson,
  'config/tower.json': towerJson,
  'config/value-events.json': valueEventsJson,
});

/** Preserve the ordinary Worker's existing coordination-file exclusion. */
export function collectorDefaultDocument(file: string): JsonValue | null {
  if (file === 'config/beads.json') return null;
  const value = COMPILED[file];
  return value === undefined ? null : structuredClone(value) as JsonValue;
}
