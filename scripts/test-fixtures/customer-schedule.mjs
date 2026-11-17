import assert from 'node:assert/strict';

export function prepareCustomerSchedule({ db, app }) {
  // Matching asset and schedule names belong to two independently bound stores.
  for (const workspace of app.workspaces) {
    db.cluster.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status,list_position)
      SELECT :'workspace_id'::uuid,'fixture-app','Fixture app','live',COALESCE(MAX(list_position),0)+1
      FROM noticeos.assets WHERE workspace_id=:'workspace_id'::uuid;
      UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{schedules}',
        jsonb_build_object('freshness',jsonb_build_object('enabled',true,'cron','* * * * *')))::json
      WHERE workspace_id=:'workspace_id'::uuid AND document_key='constants';`,
    { vars: { workspace_id: workspace.workspaceId } });
  }
}

export function assertCustomerSchedule({ db, app }) {
  const rows = db.cluster.sql(`SELECT workspace_id,lane,state,occurrence,
    (SELECT output->>'value' FROM jsonb_array_elements(steps->'collect'->'output'->'fields') AS output
      WHERE output->>'key'='outcome') AS outcome
    FROM noticeos.hosted_job_occurrences WHERE lane='freshness' ORDER BY workspace_id`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].occurrence, rows[1].occurrence);
  assert.deepEqual(rows.map(({ occurrence, ...record }) => record), app.workspaces.map(({ workspaceId }) => workspaceId).sort()
    .map(workspace_id => ({ workspace_id, lane: 'freshness', state: 'succeeded', outcome: 'ran' })));
}
