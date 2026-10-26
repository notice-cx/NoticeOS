import assert from 'node:assert/strict';
import test from 'node:test';
import { createJourneyManagement } from './journey-management.mjs';
import { applyDocumentOps, resolveOps, validateSchemaAndSafety } from './config-documents.mjs';

const FILE = 'config/value-events.json';
const ASSET = 'example.com';
const journey = (id = 'calculate') => ({ id, label: 'Complete calculation', kind: 'funnel', status: 'active',
  goal: 'Measure whether people complete the calculator.', steps: [
    { id: 'start', label: 'Start', alternatives: [{ eventName: 'calculator_start', pagePath: '/calculator' }] },
    { id: 'complete', label: 'Complete', alternatives: [{ eventName: 'calculator_complete', pagePath: '/calculator' }], withinSeconds: 1800 },
  ] });
const saved = (id = 'calculate') => ({ ...journey(id), version: 1 });
function fixture(body = { assets: {} }) {
  const state = { body: structuredClone(body), version: 7, reads: 0, applies: [], known: true,
    beforeApply: null, rejectApply: null };
  const management = createJourneyManagement({
    async read() { state.reads++; return { known: state.known, document: { version: state.version, body: structuredClone(state.body) } }; },
    async apply(input) {
      state.applies.push(structuredClone(input));
      await state.beforeApply?.();
      if (state.rejectApply) return state.rejectApply;
      if (input.expectVersions[FILE] !== state.version) return { status: 409, body: { error: 'version_mismatch' } };
      const changeset = { version: 1, slug: input.slug, createdAt: '2026-10-25T00:00:00Z', ops: input.ops };
      validateSchemaAndSafety(changeset);
      const resolved = await resolveOps(changeset, null, { readDocument: async () => structuredClone(state.body) });
      if (resolved.mismatches.length) return { status: 409, body: { error: 'expect_mismatch' } };
      applyDocumentOps(resolved.resolved, resolved.documents);
      state.body = resolved.documents.get(FILE);
      state.version++;
      return { status: 200, body: { applied: input.ops.length, archive: null, commit: null } };
    },
  });
  return { state, management };
}
const input = (definition = journey(), edit_token = null, extra = {}) => ({ journey: definition, edit_token, ...extra });
const entry = reply => reply.body.journeys[0];

test('create seeds an absent holder or list through the real config operation contract', async () => {
  for (const body of [{ assets: { 'neighbor.example': { valueEvents: ['purchase'] } } },
    { assets: { [ASSET]: { valueEvents: ['purchase'] }, 'neighbor.example': { valueEvents: ['purchase'] } } }]) {
    const { state, management } = fixture(body);
    const result = await management.save(ASSET, input());
    assert.equal(result.status, 200);
    assert.equal(result.body.created, true);
    assert.equal(result.body.definition.version, 1);
    assert.deepEqual(state.body.assets[ASSET].journeys, [saved()]);
    assert.deepEqual(state.body.assets['neighbor.example'], body.assets['neighbor.example']);
    if (body.assets[ASSET]) assert.deepEqual(state.body.assets[ASSET].valueEvents, ['purchase']);
    assert.equal(state.applies[0].ops[0].kind, 'file-json-insert');
    assert.equal(state.applies[0].ops[0].pointer, body.assets[ASSET] ? `/assets/${ASSET}/journeys` : `/assets/${ASSET}`);
    assert.deepEqual(state.applies[0].expectVersions, { [FILE]: 7 });
  }
});

test('get names saved events and collection timing without collecting anything', async () => {
  const { state, management } = fixture({ assets: { [ASSET]: { valueEvents: ['purchase'], journeys: [saved()] } } });
  const result = await management.get(ASSET);
  assert.equal(result.status, 200);
  assert.equal(result.body.documentVersion, 7);
  assert.match(entry(result).edit_token, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.body.eventNames, ['calculator_complete', 'calculator_start', 'purchase']);
  assert.equal(result.body.eventNamesSource, 'saved-configuration');
  assert.equal(result.body.collection.schedule, 'daily');
  assert.equal(result.body.collection.immediateFetch, false);
  assert.equal(state.applies.length, 0);
  entry(result).definition.label = 'Mutated response';
  assert.equal(entry(await management.get(ASSET)).definition.label, saved().label);
});

test('updates preserve neighbors; display edits change tokens while measurement edits increment version', async () => {
  const { state, management } = fixture({ assets: { [ASSET]: { valueEvents: ['purchase'], journeys: [saved(), saved('other')] } } });
  const initial = entry(await management.get(ASSET));
  const renamed = { ...journey(), label: 'Finish calculation' };
  const nameResult = await management.save(ASSET, input(renamed, initial.edit_token));
  assert.equal(nameResult.status, 200);
  assert.equal(nameResult.body.definition.version, 1);
  assert.notEqual(nameResult.body.edit_token, initial.edit_token);
  assert.deepEqual(state.body.assets[ASSET].journeys[1], saved('other'));
  assert.deepEqual(state.body.assets[ASSET].valueEvents, ['purchase']);
  assert.deepEqual(state.applies[0].ops[0].expect, [saved(), saved('other')]);
  const changed = structuredClone(renamed);
  changed.steps[1].alternatives[0].eventName = 'result_saved';
  const changedResult = await management.save(ASSET, input(changed, nameResult.body.edit_token));
  assert.equal(changedResult.status, 200);
  assert.equal(changedResult.body.definition.version, 2);
  assert.deepEqual(changedResult.body.eventNames, ['calculator_complete', 'calculator_start', 'purchase', 'result_saved']);
  const single = fixture({ assets: { [ASSET]: { journeys: [saved()] } } });
  const token = entry(await single.management.get(ASSET)).edit_token;
  await single.management.save(ASSET, input(changed, token));
  assert.deepEqual((await single.management.get(ASSET)).body.eventNames, ['calculator_start', 'result_saved']);
});

test('lost response retries are unchanged for creates and updates, without repeating a write', async () => {
  const { state, management } = fixture();
  const create = input();
  const first = await management.save(ASSET, create);
  const repeated = await management.save(ASSET, create);
  assert.equal(repeated.body.unchanged, true);
  assert.equal(state.applies.length, 1);
  const changed = { ...journey(), goal: 'Measure calculator completion.' };
  const update = input(changed, first.body.edit_token);
  const updated = await management.save(ASSET, update);
  const retried = await management.save(ASSET, update);
  assert.equal(retried.body.unchanged, true);
  assert.equal(retried.body.edit_token, updated.body.edit_token);
  assert.equal(state.applies.length, 2);
});

test('stale tokens, duplicate creates, and concurrent neighboring saves refuse without retry', async () => {
  const { state, management } = fixture({ assets: { [ASSET]: { journeys: [saved()] } } });
  const initial = entry(await management.get(ASSET));
  const changed = { ...journey(), label: 'Changed display name' };
  await management.save(ASSET, input(changed, initial.edit_token));
  assert.equal((await management.save(ASSET, input(journey(), initial.edit_token))).status, 409);
  assert.equal((await management.save(ASSET, input(journey()))).status, 409);
  assert.equal((await management.save(ASSET, input(journey('missing'), initial.edit_token))).status, 409);
  const now = entry(await management.get(ASSET));
  state.beforeApply = () => { state.body.assets[ASSET].journeys.push(saved('concurrent')); state.version++; };
  const race = await management.save(ASSET, input({ ...changed, goal: 'Updated goal.' }, now.edit_token));
  assert.equal(race.status, 409);
  assert.equal(race.body.error, 'version_mismatch');
  assert.equal(state.applies.length, 2);
  assert.deepEqual(state.body.assets[ASSET].journeys.map(definition => definition.id), ['calculate', 'concurrent']);
  assert.equal(state.body.assets[ASSET].journeys[0].goal, changed.goal);
});

test('dry runs validate and show guarded changes without writing or fabricating a persisted version', async () => {
  const { state, management } = fixture();
  const result = await management.save(ASSET, input(journey(), null, { dry_run: true }));
  assert.equal(result.status, 200);
  assert.equal(result.body.dry_run, true);
  assert.equal(result.body.documentVersion, 7);
  assert.equal(result.body.ops.length, 1);
  assert.deepEqual(result.body.expectVersions, { [FILE]: 7 });
  assert.equal(state.applies.length, 0);
  assert.deepEqual(state.body, { assets: {} });
});

test('strict input and shared contract limits reject changes before apply', async () => {
  const { state, management } = fixture();
  const invalid = [null, {}, { journey: journey() }, { ...input(), unexpected: true },
    input({ ...journey(), version: 7 }), input(journey(), 'bad-token'), input(journey(), null, { dry_run: 'yes' }),
    input({ ...journey(), steps: [journey().steps[0]] }),
    input({ ...journey(), steps: [{ ...journey().steps[0], withinSeconds: 1 }, journey().steps[1]] }),
    input({ ...journey(), steps: [{ ...journey().steps[0], alternatives: [{ eventName: 'bad name' }] }, journey().steps[1]] }),
    input({ ...journey(), steps: [{ ...journey().steps[0], alternatives: Array(9).fill({ eventName: 'start' }) }, journey().steps[1]] })];
  for (const body of invalid) assert.equal((await management.save(ASSET, body)).status, 422);
  assert.equal(state.applies.length, 0);
  const full = fixture({ assets: { [ASSET]: { journeys: Array.from({ length: 8 }, (_, index) => saved(`journey${index}`)) } } });
  assert.equal((await full.management.save(ASSET, input())).status, 422);
  assert.equal(full.state.applies.length, 0);
  const upperCaseId = fixture();
  assert.equal((await upperCaseId.management.save(ASSET, input(journey('Calculate_v1_')))).status, 200);
  assert.equal(upperCaseId.state.applies[0].slug, 'journey-calculate-v1');
});

test('unknown, missing, invalid, and unavailable stored configuration never becomes an empty writable list', async () => {
  const unknown = fixture();
  unknown.state.known = false;
  assert.equal((await unknown.management.get('unknown.example')).status, 404);
  for (const body of [{}, { assets: null }, { assets: { [ASSET]: null } },
    { assets: { [ASSET]: { journeys: null } } }, { assets: { [ASSET]: { journeys: [saved(), saved()] } } },
    { assets: { [ASSET]: { journeys: [{ ...saved(), version: 0 }] } } }]) {
    const { state, management } = fixture(body);
    assert.equal((await management.get(ASSET)).body.error, 'invalid_stored_config');
    assert.equal((await management.save(ASSET, input())).status, 503);
    assert.equal(state.applies.length, 0);
  }
  let applies = 0;
  for (const read of [async () => ({ known: true, document: null }), async () => { throw new Error('credential-must-not-escape'); }]) {
    const management = createJourneyManagement({ read, async apply() { applies++; throw new Error('must not run'); } });
    const result = await management.get(ASSET);
    assert.equal(result.status, 503);
    assert.doesNotMatch(JSON.stringify(result), /credential-must-not-escape/);
    assert.equal((await management.save(ASSET, input())).status, 503);
  }
  assert.equal(applies, 0);
});

test('store refusals pass through and transport uncertainty does not claim a rollback', async () => {
  const refused = fixture();
  refused.state.rejectApply = { status: 409, body: { error: 'expect_mismatch', mismatches: ['changed'] } };
  assert.deepEqual(await refused.management.save(ASSET, input()), refused.state.rejectApply);
  assert.equal(refused.state.applies.length, 1);
  const uncertain = createJourneyManagement({ async read() { return { known: true, document: { version: 1, body: { assets: {} } } }; },
    async apply() { throw new Error('operator-secret'); } });
  const result = await uncertain.save(ASSET, input());
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'save_unconfirmed');
  assert.doesNotMatch(JSON.stringify(result), /operator-secret/);
});


test('first-party exploration creates without GA4 conditions and source changes version', async () => {
  const exploration = { id: 'section-exploration', label: 'Section exploration', goal: 'First-party session paths between site sections', kind: 'exploration', source: 'first-party', reportingLagDays: 2, status: 'planned', steps: [] };
  const { state, management } = fixture();
  const created = await management.save(ASSET, input(exploration));
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.definition, { ...exploration, version: 1 });
  assert.deepEqual(created.body.eventNames, []);
  assert.deepEqual(state.body.assets[ASSET].journeys, [{ ...exploration, version: 1 }]);
  const renamed = await management.save(ASSET, input({ ...exploration, label: 'Site section paths' }, created.body.edit_token));
  assert.equal(renamed.body.definition.version, 1);
  const legacy = { ...journey('section-exploration'), kind: 'exploration' };
  const changed = await management.save(ASSET, input(legacy, renamed.body.edit_token));
  assert.equal(changed.status, 200);
  assert.equal(changed.body.definition.version, 2);
  const restored = await management.save(ASSET, input(exploration, changed.body.edit_token));
  assert.equal(restored.body.definition.version, 3);
  const delayed = await management.save(ASSET, input({ ...exploration, reportingLagDays: 3 }, restored.body.edit_token));
  assert.equal(delayed.body.definition.version, 4);
});
