import { DEFAULT_WALL_LAYOUT } from '../wall-layout.mjs';

export function prepareShadowDisplay(db, workspace, asset, at) {
  const date = at.slice(0, 10);
  const layout = { ...DEFAULT_WALL_LAYOUT, tileTransparency: 37 };
  const wall = { layout, history: [
    { savedAt: '2026-10-01T22:00:00Z', reason: 'Saved fixture layout', layout: DEFAULT_WALL_LAYOUT },
  ] };
  const costs = [{ id: 'sample-hosting', label: 'Sample hosting', family: 'infra', asset,
    amountUsdPerMonth: 25.5, from: '2026-01' }];
  const domains = [{ domain: 'canopy.example', asset, kind: 'renewal', paidUsd: 120, paidOn: date }];
  db.run(`
    INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at,updated_by)
    VALUES (:'workspace'::uuid,'tower',:'wall'::json,3,:'at'::timestamptz,'fixture'),
           (:'workspace'::uuid,'recurring-costs',:'costs'::json,3,:'at'::timestamptz,'fixture'),
           (:'workspace'::uuid,'domain-costs',:'domains'::json,3,:'at'::timestamptz,'fixture')
    ON CONFLICT (workspace_id,document_key) DO UPDATE SET body=excluded.body,version=excluded.version,
      updated_at=excluded.updated_at,updated_by=excluded.updated_by;
    INSERT INTO noticeos.archive_runs
      (workspace_id,run_id,asset_id,integration,report,credential_ref,property_ref,report_date,requested_at,finished_at,
        status,data_state,schema_version,provider_rows,request_count,provider_truncated,error_code,error_message,
        cost_usd,cost_state,dataforseo_cost_accounted_usd)
    VALUES (:'workspace'::uuid,'fixture-metered-run',:'asset','dataforseo','fixture-provider-key','fixture-provider-key',
      'fixture-provider-key',:'date'::date,:'at'::timestamptz,:'at'::timestamptz,
      'error','provider-final',1,0,1,false,'fixture-provider-key','fixture-provider-key',3.50,'reported',1.25);
    INSERT INTO noticeos.dataforseo_request_charges
      (workspace_id,asset_id,attempt_id,request_key,reserved_at,reserve_usd,provider_cost_usd)
    VALUES (:'workspace'::uuid,:'asset',gen_random_uuid(),repeat('c',64),:'at'::timestamptz,2,1.25),
      (:'workspace'::uuid,:'asset',gen_random_uuid(),repeat('d',64),:'at'::timestamptz,2,NULL);
    INSERT INTO noticeos.research_log
      (workspace_id,research_number,asset_id,provider,endpoint,params_sha256,question,cost_usd,cost_state,object_key,actor,bought_at)
    VALUES
      (:'workspace'::uuid,1,NULL,'dataforseo','fixture-provider-key',repeat('e',64),'fixture-provider-key',
        4.25,'reported','fixture-provider-key','fixture',:'at'::timestamptz),
      (:'workspace'::uuid,2,:'asset','dataforseo','fixture-provider-key',repeat('e',64),'fixture-provider-key',
        NULL,'unknown','fixture-provider-key','fixture',:'at'::timestamptz),
      (:'workspace'::uuid,3,:'asset','dataforseo','fixture-provider-key',repeat('e',64),'fixture-provider-key',
        3.50,'reported','fixture-provider-key','collector',:'at'::timestamptz);`,
  { vars: { workspace, asset, at, date, wall: JSON.stringify({ wall, unlisted: 'fixture-unlisted-setting' }),
    costs: JSON.stringify({ costs: [{ ...costs[0], unlisted: 'fixture-unlisted-setting' }] }),
    domains: JSON.stringify({ domains }) } });
  return { wall, domains, costs, spent: 7.75, unknown: 1 };
}
