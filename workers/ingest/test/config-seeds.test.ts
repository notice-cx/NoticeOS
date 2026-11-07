// Check product defaults and explicit synthetic panels, never an
// installation-owned config file.
import { describe, expect, it } from 'vitest';
import {
  MAX_REPORT_COST_USD as REPORT_RESERVE_USD,
  SERP_PANEL_CALL_USD as CALL_USD,
  SERP_PANEL_DEVICES,
  SERP_PANEL_QUERY_LIMIT as PANEL_CEILING,
} from '@noticeos/contract';
import shippedSerpPanel from '../../../config/serp-panel.json';

describe('the committed config files', () => {
  // How often the counter cards are read, and what the Tower ages them
  // against, is the counters job's schedule alone
  // (apps/tower/worker/counters.ts `countersCadenceHours`), so no file here has
  // a cadence to hold to the cron.

  // The DataForSEO gate reserves a fixed amount per family before it calls,
  // and the panel is the one family whose cost is a function of config
  // (dataforseo-dumps.test.ts pins the ceiling to that reserve). Every shipped
  // panel must fit under it, so the operator learns about a narrowed ceiling
  // from a red gate rather than a red Monday.
  it('fits the maximum legal SERP panel inside its reserve and excludes one more query', () => {
    expect(PANEL_CEILING * SERP_PANEL_DEVICES.length * CALL_USD).toBeLessThanOrEqual(REPORT_RESERVE_USD);
    // The product default tracks no query; an installation's panels must fit.
    expect(shippedSerpPanel.assets).toEqual({});
    // One more tracked query cannot fit the actual product reserve. This
    // couples the configured ceiling to the collector's per-device economics.
    expect((PANEL_CEILING + 1) * SERP_PANEL_DEVICES.length * CALL_USD).toBeGreaterThan(REPORT_RESERVE_USD);
  });
});
