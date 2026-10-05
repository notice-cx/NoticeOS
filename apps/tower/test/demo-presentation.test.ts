import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTestStore } from './postgres-store';
import { handleDemoPresentationRead } from '../worker/demo-presentation-route';
import { decodeDemoPresentation, DEMO_PRESENTATION_PATH } from '../shared/demo-presentation';
import { DEMO_ACTIVITY_DEFINITION, demoActivityPrefix } from '../../../scripts/demo-activity-definition.mjs';
import { hostedJobDefinitionHash } from '../../../scripts/hosted-job-definition.mjs';
import { createApi } from '@/lib/api';

const scenarioHash = 'a'.repeat(64), serviceId = randomUUID();
const env = { NOTICEOS_DEMO_ACTIVITY_SERVICE_ID: serviceId, NOTICEOS_DEMO_SCENARIO_HASH: scenarioHash };
const request = (suffix = '', method = 'GET') => new Request(`https://fixture.example.test${DEMO_PRESENTATION_PATH}${suffix}`, { method });
describe('completed demo generation evidence', () => {
  it('refuses selectors and invalid server facts before reading a journal', async () => {
    const fixture = await createTestStore();
    const read = vi.spyOn(fixture.call, 'read');
    for (const input of [request('?workspace=foreign'), request('#foreign'), request('', 'POST')]) {
      expect((await handleDemoPresentationRead(input, fixture.call, env))?.status).toBe(400);
    }
    for (const bindings of [{}, { ...env, NOTICEOS_DEMO_ACTIVITY_SERVICE_ID: ` ${serviceId}` },
      { ...env, NOTICEOS_DEMO_SCENARIO_HASH: 'a'.repeat(20) }]) {
      expect(await (await handleDemoPresentationRead(request(), fixture.call, bindings))?.json()).toEqual({ generatedAt: null, through: null });
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('reads only completed current attempts for the exact service, definition and scenario', async () => {
    const fixture = await createTestStore();
    const hash = hostedJobDefinitionHash(DEMO_ACTIVITY_DEFINITION.version, DEMO_ACTIVITY_DEFINITION.steps);
    const prefix = demoActivityPrefix(scenarioHash);
    const put = async (day: string, options: { service?: string; hash?: string; prefix?: string; lane?: string; state?: string; attemptState?: string; attempt?: number; finished?: string } = {}) => {
      const occurrence = (options.prefix ?? prefix) + day, lane = options.lane ?? DEMO_ACTIVITY_DEFINITION.key;
      await fixture.call.write(async tx => {
        await tx.query(`INSERT INTO noticeos.hosted_job_occurrences
          (workspace_id,lane,occurrence,service_id,definition_hash,input_hash,state,attempt,lease_id,lease_expires_at)
          VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,now())`, [tx.workspaceId, lane, occurrence, options.service ?? serviceId,
          options.hash ?? hash, options.state ?? 'succeeded', options.attempt ?? 1, randomUUID()]);
        await tx.query(`INSERT INTO noticeos.hosted_job_attempts
          (workspace_id,lane,occurrence,attempt,lease_id,state,started_at,finished_at)
          VALUES($1,$2,$3,1,$4,$5,'2026-09-01T00:00:00Z',$6)`,
        [tx.workspaceId, lane, occurrence, randomUUID(), options.attemptState ?? 'succeeded', options.finished ?? '2026-09-02T00:00:00.000Z']);
      });
    };
    const read = async () => (await handleDemoPresentationRead(request(), fixture.call, env))!.json();
    expect(await read()).toEqual({ generatedAt: null, through: null });
    await put('2026-09-01');
    const previous = { generatedAt: '2026-09-02T00:00:00.000Z', through: '2026-09-01' };
    expect(await read()).toEqual(previous);
    for (const [day, options] of [
      ['2026-09-02', { service: randomUUID() }], ['2026-09-03', { hash: 'b'.repeat(64) }],
      ['2026-09-04', { prefix: demoActivityPrefix('b'.repeat(64)) }], ['2026-09-05', { lane: 'other' }],
      ['2026-09-06', { state: 'uncertain', attemptState: 'uncertain' }],
      ['2026-09-07', { attempt: 2 }], ['2026-09-08', { attemptState: 'retryable' }],
    ] as const) await put(day, options);
    expect(await read()).toEqual(previous);
    await put('2026-09-09', { finished: '2026-09-10T12:00:00.000Z' });
    const response = (await handleDemoPresentationRead(request(), fixture.call, env))!;
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ generatedAt: '2026-09-10T12:00:00.000Z', through: '2026-09-09' });
  });
  it('the owner API rejects fabricated partial/extra facts and its retired completion', async () => {
    for (const value of [{ generatedAt: null, through: '2026-09-01' }, { generatedAt: 'today', through: '2026-09-01' },
      { generatedAt: '2026-09-02T00:00:00.000Z', through: '2026-02-30' }, { generatedAt: null, through: null, serviceId }]) {
      expect(() => decodeDemoPresentation(value)).toThrow('Demo generation unavailable');
    }
    let active = true;
    const fetch = vi.fn(async () => { active = false; return Response.json({ generatedAt: null, through: null }); });
    const api = createApi(fetch, () => { if (!active) throw new Error('retired'); });
    await expect(api.fetchDemoPresentation()).rejects.toThrow('retired');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(DEMO_PRESENTATION_PATH, { signal: undefined });
  });
});
