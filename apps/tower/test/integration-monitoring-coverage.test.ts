// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { INTEGRATION_MONITORS, INTEGRATION_MONITORING_GAPS } from '@noticeos/contract';

it('requires explicit monitoring coverage for every catalog lane and resolvable evidence owners', () => {
  const monitors = Object.values(INTEGRATION_MONITORS).flat();
  const catalog = JSON.parse(readFileSync(new URL('../../../config/integrations.json', import.meta.url), 'utf8')) as { catalog: { id: string }[] };
  const lanes = new Set(monitors.flatMap((item) => item.lanes));
  for (const lane of catalog.catalog) expect(lanes.has(lane.id) || Boolean(INTEGRATION_MONITORING_GAPS[lane.id]), `Uncovered lane: ${lane.id}`).toBe(true);
  for (const item of monitors) expect(existsSync(new URL(`../../../${item.owner}`, import.meta.url)), item.owner).toBe(true);
});
