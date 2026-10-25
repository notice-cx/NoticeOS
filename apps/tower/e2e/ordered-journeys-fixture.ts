import { journeyDefinitionId, type JourneyDefinition, type JourneyPeriod, type JourneySnapshot } from '@noticeos/contract/journeys';
import { JOURNEY_NOW } from './fixtures';

export const ORDERED_JOURNEY_DEFINITIONS: JourneyDefinition[] = [{
  id: 'accounts', label: 'Account growth', goal: 'Create an account', kind: 'funnel', status: 'active', version: 1,
  steps: ['Start calculator', 'View result', 'Save plan', 'Start account', 'Create account'].map((label, index) => ({
    id: `step-${index}`, label, alternatives: [{ eventName: ['form_start', 'calculation_complete', 'plan_save_click', 'auth_initiate', 'sign_up'][index]! }],
  })),
}, {
  id: 'paid', label: 'Paid subscriptions', goal: 'Become a subscriber', kind: 'funnel', status: 'planned', version: 1,
  steps: [
    { id: 'checkout', label: 'Start checkout', alternatives: [{ eventName: 'begin_checkout' }] },
    { id: 'paid', label: 'First payment', alternatives: [{ eventName: 'purchase' }] },
  ],
}, {
  id: 'exploration', label: 'Exploration', goal: 'Discover useful pages', kind: 'exploration', status: 'planned', version: 1,
  steps: [
    { id: 'entry', label: 'Entry page', alternatives: [{ eventName: 'page_view' }] },
    { id: 'next', label: 'Next useful page', alternatives: [{ eventName: 'page_view' }] },
  ],
}];

export function orderedJourneyFixture(): JourneySnapshot {
  const definition = ORDERED_JOURNEY_DEFINITIONS[0]!;
  const period = (kind: JourneyPeriod['kind'], startDate: string, endDate: string, counts: number[]): JourneyPeriod => ({
    kind, startDate, endDate, complete: true, quality: 'complete',
    steps: counts.map((users, index) => ({ id: definition.steps[index]!.id, users })),
    visitors: { users: counts[0]! * 2, quality: 'complete' },
  });
  const counts = [
    [2600,1900,650,550,500], [2700,2000,670,560,510], [2800,2100,710,600,550], [2900,2200,820,690,640],
    [2800,2250,860,720,610], [3000,2440,980,840,720], [3000,2230,780,650,600], [3200,2480,980,790,710],
  ];
  return {
    source: 'ga4', countingUnit: 'activeUsers', generatedAt: JOURNEY_NOW,
    definitions: structuredClone(ORDERED_JOURNEY_DEFINITIONS),
    funnels: [{
      journeyId: definition.id, definitionId: journeyDefinitionId(definition), propertyId: '123456',
      timeZone: 'UTC', identity: 'ga4-active-users', collectedAt: JOURNEY_NOW,
      current7: period('current7', '2026-08-29', '2026-09-04', counts[7]!),
      prior7: period('prior7', '2026-08-22', '2026-08-28', counts[6]!),
      current28: period('current28', '2026-08-08', '2026-09-04', [12000,9400,3600,3000,2640]),
      prior28: period('prior28', '2026-07-11', '2026-08-07', [11000,8200,2850,2400,2200]),
      weekly: counts.map((values, index) => {
        const date = new Date('2026-07-06T00:00:00Z');
        date.setUTCDate(date.getUTCDate() + index * 7);
        const start = date.toISOString().slice(0,10);
        date.setUTCDate(date.getUTCDate() + 6);
        return period('week', start, date.toISOString().slice(0,10), values);
      }),
    }],
    exploration: { state: 'unsupported', reason: 'Session paths need an ordered session source.' },
  };
}
