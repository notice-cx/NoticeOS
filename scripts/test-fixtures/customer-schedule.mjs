import assert from 'node:assert/strict';

export function prepareCustomerSchedule({ db, app }) {
  // Two real tenants, one owing a check. A domain-less asset makes this an
  // entirely database-backed job with no provider traffic or uptime requests.
  for (const [index, workspace] of app.workspaces.entries()) {
    db.cluster.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status,list_position)
      SELECT :'workspace_id'::uuid,'fixture-app','Fixture app','live',COALESCE(MAX(list_position),0)+1
      FROM noticeos.assets WHERE workspace_id=:'workspace_id'::uuid;
      UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{schedules}',
        jsonb_build_object('freshness',jsonb_build_object('enabled',:'enabled'::boolean,'cron','* * * * *')))::json
      WHERE workspace_id=:'workspace_id'::uuid AND document_key='constants';`,
    { vars: { workspace_id: workspace.workspaceId, enabled: String(index === 0) } });
  }
}

export function assertCustomerSchedule({ db, app }) {
  const rows = db.cluster.sql(`SELECT workspace_id,lane,state FROM noticeos.hosted_job_occurrences WHERE lane='freshness' ORDER BY workspace_id`);
  assert.deepEqual(rows, [{ workspace_id: app.workspaces[0].workspaceId, lane: 'freshness', state: 'succeeded' }]);
}
