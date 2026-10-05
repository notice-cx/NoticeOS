import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { jobRunName, SCHEDULED_JOBS } from '../scheduled-jobs.mjs';

/** Uses the same actual Worker/store as a completed synthetic collect POST. */
export async function proveHostedManualHistory({ admin, towerFetch, demoFetch, origin, headers, workspaces }) {
  const get = async (workspace, run) => {
    const response = await towerFetch.fetch(origin + '/api/workflows' + (run ? '?run=' + encodeURIComponent(run) : ''), { headers: headers(workspace) });
    assert.equal(response.status, 200); return response.json();
  };
  const first = [];
  for (const workspace of workspaces) {
    const payload = await get(workspace);
    assert.equal(payload.runtime, null); assert.equal(payload.runtimeFresh, false); assert.equal(payload.observationsFresh, false);
    const history = payload.workflows.find(row => row.id === 'pull');
    assert.equal(history.runs.length, 1); assert.equal(history.latest.state, 'succeeded');
    assert.deepEqual(history.latest.trigger, { kind: 'manual' }); assert.equal(history.latest.steps, null);
    assert.match(history.latest.id, /^pull@manual\/\d+$/u);
    const selected = (await get(workspace, history.latest.id)).selectedRun;
    assert.equal(selected.id, history.latest.id); assert.equal(selected.steps, null);
    first.push(selected);
  }
  assert.notEqual(first[0].id, first[1].id);
  assert.equal((await get(workspaces[1], first[0].id)).selectedRun, null);
  const demoResponse = await demoFetch.fetch(origin + '/api/workflows');
  assert.equal(demoResponse.status, 200); assert.deepEqual((await demoResponse.json()).workflows, []);

  // More records than the detail page retains still count in hourly totals.
  // Two distinct PG microseconds collapse to one JS millisecond; IDs must not.
  const base = new Date(Date.now() - 120_000).toISOString().replace(/\.\d{3}Z$/u, '.000Z');
  const ids = [];
  for (const [index, workspace] of workspaces.entries()) {
    const outcome = index === 0 ? 'failed' : 'skipped';
    const rows = await admin.query(`INSERT INTO noticeos.job_runs
      (workspace_id,job_run_number,job,started_at,finished_at,outcome,detail,recorded_at)
      SELECT $1,1000+n,$4,$2::timestamptz+n*interval '1 microsecond',
        $2::timestamptz+interval '1 second',$3,'trigger:manual',clock_timestamp()
      FROM generate_series(1,36) n RETURNING job_run_id::text`, [workspace, base, outcome,
      jobRunName(SCHEDULED_JOBS.find(job => job.id === 'pull'))]);
    const ownIds = rows.rows.map(row => `pull@manual/${row.job_run_id}`); ids.push(ownIds);
    const history = (await get(workspace)).workflows.find(row => row.id === 'pull');
    assert.equal(history.runs.length, 30);
    assert.equal(new Set(history.runs.map(row => row.id)).size, 30);
    assert.equal(history.history.reduce((sum, bucket) => sum + bucket.succeeded + bucket.failed + bucket.skipped, 0), 37);
    assert.equal(history.history.reduce((sum, bucket) => sum + bucket[outcome], 0), 36);
    assert.equal((await get(workspace, ownIds[0])).selectedRun, null, 'old detail is outside the retained page');
    for (const id of ownIds.slice(-2)) {
      const selected = (await get(workspace, id)).selectedRun;
      assert.equal(selected.id, id); assert.equal(selected.state, outcome); assert.equal(selected.steps, null);
      assert.equal(new Date(selected.startedAt).toISOString(), base);
    }
  }
  assert.equal((await get(workspaces[1], ids[0].at(-1))).selectedRun, null);
  // A status row for a different lane must not hide manual-only collection.
  await admin.query(`INSERT INTO noticeos.hosted_scheduler_status(workspace_id,service_id,session_id,running,payload)
    VALUES($1,$2,$3,false,$4)`, [workspaces[0], randomUUID(), randomUUID(), JSON.stringify({
    onlyListedJobs: true, registeredJobs: ['counters'], jobs: [], updatedAt: new Date().toISOString(), error: null,
  })]);
  const inactive = await get(workspaces[0]);
  assert.equal(inactive.runtimeFresh, false); assert.equal(inactive.observationsFresh, false);
  assert.deepEqual(inactive.runtime.registeredJobs, ['counters']);
  assert.ok(inactive.workflows.some(row => row.id === 'pull'));
}
