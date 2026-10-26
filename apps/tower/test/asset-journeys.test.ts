// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { journeyDefinitionId, type JourneyDefinition, type JourneySnapshot } from '@noticeos/contract/journeys';
import { assetJourneys } from '../worker/asset-journeys';

const definition: JourneyDefinition = {
  id: 'accounts', label: 'Account growth', kind: 'funnel', status: 'active',
  goal: 'Create an account', version: 1,
  steps: [
    { id: 'start', label: 'Start', alternatives: [{ eventName: 'form_start' }] },
    { id: 'account', label: 'Create account', alternatives: [{ eventName: 'sign_up' }] },
  ],
};

const binding = { asset: 'example.com', propertyId: '123456', timeZone: 'UTC' };
function model(payload: string | null, definitions: unknown) { return assetJourneys(payload, definitions, binding); }
function snapshot(): JourneySnapshot {
  return {
    source: 'ga4', countingUnit: 'activeUsers', generatedAt: '2026-10-25T12:00:00.000Z',
    definitions: [definition],
    funnels: [{
      journeyId: definition.id, definitionId: journeyDefinitionId(definition),
      propertyId: '123456', timeZone: 'UTC', identity: 'ga4-active-users',
      collectedAt: '2026-10-25T12:00:00.000Z',
      current7: {
        kind: 'current7', startDate: '2026-10-17', endDate: '2026-10-23', complete: true,
        quality: 'complete', steps: [{ id: 'start', users: 100 }, { id: 'account', users: 22 }],
      },
      prior7: null, current28: null, prior28: null, weekly: [],
    }],
    exploration: { state: 'unsupported', reason: 'Session paths are unavailable.' },
  };
}

describe('asset journey read model', () => {
  it('makes saved definitions available before the first result without inventing counts', () => {
    expect(model(null, [definition])).toMatchObject({ definitions: [definition], funnels: [], generatedAt: null });
    expect(model(null, undefined).definitions).toEqual([]);
  });

  it('keeps ordered stored results and uses current display labels', () => {
    const renamed = { ...definition, label: 'New account goal' };
    const result = model(JSON.stringify({ asset: 'example.com', journeys: snapshot() }), [renamed]);
    expect(result.definitions[0]?.label).toBe('New account goal');
    expect(result.funnels[0]?.current7?.steps.map((s) => s.users)).toEqual([100, 22]);
  });

  it('removes old results after a measurement edit, removal or planned status', () => {
    const raw = JSON.stringify({ asset: 'example.com', journeys: snapshot() });
    expect(model(raw, [{ ...definition, version: 2 }]).funnels).toEqual([]);
    expect(model(raw, []).funnels).toEqual([]);
    expect(model(raw, [{ ...definition, status: 'planned' }]).funnels).toEqual([]);
  });

  it('keeps definitions editable when the published result is invalid', () => {
    expect(model('{broken', [definition]).definitions).toEqual([definition]);
    const invalid = snapshot();
    invalid.funnels[0]!.current7!.steps[1]!.users = 200;
    expect(model(JSON.stringify({ asset: 'example.com', journeys: invalid }), [definition]).funnels).toEqual([]);
  });

  it('retains results after a timezone change but withholds different properties or assets', () => {
    const raw = JSON.stringify({ asset: 'example.com', journeys: snapshot() });
    expect(assetJourneys(raw, [definition], { ...binding, propertyId: '654321' }).funnels).toEqual([]);
    expect(assetJourneys(raw, [definition], { ...binding, timeZone: 'Etc/GMT+1' }).funnels).toHaveLength(1);
    expect(assetJourneys(raw, [definition], { ...binding, propertyId: null }).funnels).toEqual([]);
    expect(assetJourneys(raw, [definition], { ...binding, asset: 'another.example' }).funnels).toEqual([]);
  });
});
