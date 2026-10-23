import assert from 'node:assert/strict';
import test from 'node:test';
import { plannedWalks } from '../apps/tower/e2e/flow-gate.mjs';
import { FLOWS } from '../apps/tower/e2e/ux-flows.mjs';
import { VIEWPORTS } from '../apps/tower/e2e/ux-walk.mjs';

const ids = Object.keys(FLOWS);
const viewports = Object.keys(VIEWPORTS);
const key = (walk) => `${walk.id} ${walk.viewport}`;

// CI walks the flows on several runners, each passing --shard i/n.
test("the flow walker's shards make every walk once between them", () => {
  const all = plannedWalks(ids, viewports);
  assert.equal(new Set(all.map(key)).size, ids.length * viewports.length, 'one walk per flow and viewport');
  for (const count of [2, 3]) {
    const shards = Array.from({ length: count }, (_, index) => plannedWalks(ids, viewports, { index: index + 1, count }));
    assert.deepEqual(shards.flat().map(key).sort(), all.map(key).sort(), `${count} shards make every walk exactly once`);
  }
});

test("the survey, the longest walk, starts first and its viewports go to different shards", () => {
  const survey = ids.find((id) => FLOWS[id].kind === 'survey');
  assert.ok(survey, 'a survey flow is declared');
  assert.equal(plannedWalks(ids, viewports)[0].id, survey);
  const holders = [1, 2].map((index) => plannedWalks(ids, viewports, { index, count: 2 }).filter((walk) => walk.id === survey).length);
  assert.deepEqual(holders, [1, 1]);
});
