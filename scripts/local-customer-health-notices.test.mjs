import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { verifyComposeCustomerFollowups } from '../deploy/compose/customer-entry.mjs';
import { startPlan } from './start.mjs';
import { startLocalCustomer } from './local-customer.mjs';
import { startAttachedCustomer } from './local-customer-attach.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { availableCustomerPort } from './test/customer-ports.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { sealedProviderSql } from './test-fixtures/customer-backup.mjs';

test('approved sites and revenue notifications run once in their own workspace', { timeout: 150000 }, async t => {
  const root = testFixtureRoot('n-customer-health-');
  const plan = startPlan({ dir: path.join(root, 'source'), port: await availableCustomerPort() });
  const other = startPlan({ dir: path.join(root, 'attached'), port: plan.port });
  const asset = 'fixture-shop', domain = 'shop.example.test', origin = 'https://' + domain;
  const webhookId = '123456789012345678', webhook = 'https://discord.com/api/webhooks/' + webhookId + '/' + randomUUID();
  let app, db;
  try {
    db = await skipWithoutPostgres(t, () => openDevelopmentStart(plan, { profile: 'hosted' }));
    if (!db) return;
    app = await startLocalCustomer(plan, db);
    const [east, west] = app.workspaces, { identitySecret, credentialsKey } = JSON.parse(readFileSync(path.join(db.customer, 'settings.json')));
    await app.close(); app = undefined;
    const start = new Date(Date.now() - 60_000); start.setUTCSeconds(0, 0);
    let clock = start.getTime();
    const schedules = Object.fromEntries(['hygiene','freshness','notifications'].map(job => [job, { enabled: true, cron: '* * * * *' }]));
    for (const { workspaceId } of [east, west]) {
      db.cluster.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position)
          VALUES(:'ws'::uuid,:'asset',:'domain','Example shop','live',1);
        UPDATE noticeos.config_documents SET body=(body::jsonb || jsonb_build_object('schedules',:'settings'::jsonb,'discord_mediavine_revenue',true))::json
          WHERE workspace_id=:'ws'::uuid AND document_key='constants';
        UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{assets}',jsonb_build_object(:'asset','{}'::jsonb))::json
          WHERE workspace_id=:'ws'::uuid AND document_key='integrations';
        INSERT INTO noticeos.notification_events(workspace_id,notification_type,source_kind,source_ref,occurrence,payload,occurred_at,next_attempt_at)
          VALUES(:'ws'::uuid,'daily-mediavine-revenue','asset',:'asset','2026-11-16',
          '{"amount_minor":2345,"month_minor":10000,"month_reported_days":13}',now()-interval '1 hour',now()-interval '1 hour'),
          (:'ws'::uuid,'open-error','alert','12','open','{}',now(),now());`,
      { vars: { ws: workspaceId, asset, domain, settings: JSON.stringify(workspaceId === east.workspaceId ? schedules :
        { ...schedules, freshness: { enabled: false, cron: '* * * * *' } }) } });
      db.cluster.run(sealedProviderSql(workspaceId, credentialsKey, 'discord', { DISCORD_WEBHOOK_URL: webhook.replace('discord.com/', 'discord.com:443/') }));
    }
    const file = path.join(root, 'config.json');
    const config = { format: 'noticeos-customer-operating/1', database: { app: db.address, identity: db.identityDatabase, grant: db.grantConnectionString },
      identitySecret, credentialsKey, workspaces: [east, west].map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId })),
      mailRecipients: [east.email, west.email], siteChecks: [{ workspaceId: east.workspaceId, asset, origins: [origin] }],
      revenueNotices: [{ workspaceId: east.workspaceId, webhookId }] };
    const foreign = 'https://west.example.test';
    config.siteChecks.push({ workspaceId: west.workspaceId, asset, origins: [foreign] });
    const preflight = () => verifyComposeCustomerFollowups({ ...config, address: db.address, workspaces: [east] });
    await preflight();
    const probes = [], destinations = [], messages = [];
    const launch = async () => {
      writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
      app = await startAttachedCustomer(other, file, { startSchedules: options => startLocalCustomerSchedules({ ...options, now: () => clock }),
        collectorTransport: async (url, options) => {
          destinations.push(url);
          if (url === webhook) {
            messages.push(JSON.parse(Buffer.from(options.body).toString()));
            return new Response(null, { status: 204 });
          }
          assert.equal(new URL(url).origin, origin);
          assert.equal(new Headers(options.headers).get('authorization'), null);
          probes.push(new URL(url).pathname);
          if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\nSitemap: ' + origin + '/sitemap.xml');
          if (url.endsWith('/sitemap.xml')) return Response.redirect(origin + '/catalog.xml', 302);
          if (url.endsWith('/products')) return Response.redirect(foreign + '/private-path', 302);
          if (url.endsWith('/catalog.xml')) return new Response('<urlset><url><loc>' + origin + '/products</loc></url></urlset>');
          return new Response('<html><head><title>Example shop</title><link rel="icon" href="/favicon.ico"></head><body><h1>Products</h1></body></html>');
        } });
      await app.whenIdle();
    };
    const states = () => db.cluster.sql('SELECT workspace_id,notification_type,state,attempts FROM noticeos.notification_events ORDER BY workspace_id,notification_type');
    const startedAt = Date.now();
    await launch();
    const oldest = db.cluster.sql("SELECT extract(epoch FROM min(observed_at))*1000 AS observed FROM noticeos.hygiene_checks")[0].observed;
    assert.ok(Number(oldest) >= startedAt, 'a delayed occurrence records when the site was checked');
    assert.ok(probes.includes('/robots.txt') && probes.includes('/sitemap.xml'));
    assert.ok(probes.includes('/catalog.xml') && probes.includes('/products'));
    assert.ok(destinations.every(url => new URL(url).origin !== foreign));
    assert.equal(messages.length, 1);
    assert.deepEqual(states().filter(row => row.state === 'sent').map(row => [row.workspace_id,row.notification_type]), [[east.workspaceId,'daily-mediavine-revenue']]);
    assert.ok(states().filter(row => row.state !== 'sent').every(row => row.attempts === '0'));
    for (const table of ['hygiene_checks','asset_icons','connection_daily_counts','connection_status_daily_counts']) {
      const rows = db.cluster.sql('SELECT DISTINCT workspace_id FROM noticeos.' + table);
      assert.deepEqual(rows.map(row => row.workspace_id), [east.workspaceId], table);
    }
    const first = [...probes];
    await app.close(); app = undefined; await launch();
    assert.deepEqual(probes, first); assert.equal(messages.length, 1);
    await app.close(); app = undefined;
    // An approved asset with a newly assigned domain and a different configured webhook cannot receive the earlier workspace's credentials or reports.
    db.cluster.run(`UPDATE noticeos.assets SET domain='moved.example.test' WHERE workspace_id=:'ws'::uuid AND asset_id=:'asset';
      INSERT INTO noticeos.notification_events(workspace_id,notification_type,source_kind,source_ref,occurrence,payload,occurred_at,next_attempt_at)
      SELECT workspace_id,notification_type,source_kind,source_ref,'2026-11-17',payload,now(),now() FROM noticeos.notification_events WHERE state='sent';`,
      { vars: { ws: east.workspaceId, asset } });
    config.revenueNotices[0].webhookId = '987654321012345678';
    await assert.rejects(preflight(), /webhook/u);
    clock += 60000; await launch();
    assert.deepEqual(probes, first); assert.equal(messages.length, 1);
    assert.equal(states().filter(row => row.state === 'sent').length, 1);
    await app.close(); app = undefined;
    config.revenueNotices[0].webhookId = webhookId;
    db.cluster.run(`UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{discord_mediavine_revenue}','false')::json
      WHERE workspace_id=:'ws'::uuid AND document_key='constants'`, { vars: { ws: east.workspaceId } });
    clock += 60000; await launch();
    assert.equal(messages.length, 1);
    await app.close(); app = undefined;
    db.cluster.run(`UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{discord_mediavine_revenue}','true')::json
        WHERE workspace_id=:'ws'::uuid AND document_key='constants';
      UPDATE noticeos.assets SET status='retired' WHERE workspace_id=:'ws'::uuid AND NOT is_os;
      INSERT INTO noticeos.notification_events(workspace_id,notification_type,source_kind,source_ref,occurrence,payload,occurred_at,next_attempt_at)
      SELECT workspace_id,notification_type,source_kind,source_ref,'2026-11-18',payload,now(),now() FROM noticeos.notification_events WHERE state='sent';`, { vars: { ws: east.workspaceId } });
    clock += 60000; await launch();
    assert.equal(messages.length, 2, 'the pending workspace notification is delivered after its last site retires');
    assert.deepEqual(probes, first);
    await app.close(); app = undefined;
    db.cluster.run(`DELETE FROM noticeos.connection_secrets WHERE workspace_id=:'ws'::uuid AND connection_id IN
      (SELECT connection_id FROM noticeos.integration_connections WHERE workspace_id=:'ws'::uuid AND provider='discord');
      UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{discord_mediavine_revenue}','true')::json
      WHERE workspace_id=:'ws'::uuid AND document_key='constants'`, { vars: { ws: east.workspaceId } });
    await assert.rejects(preflight(), /webhook/u);
    clock += 60000; await launch();
    assert.equal(messages.length, 2);
  } finally {
    try { await app?.close(); } finally { db?.close(); }
    if (!existsSync(path.join(plan.home, '.local', 'customer-postgres', 'data', 'postmaster.pid'))) rmSync(root, { recursive: true, force: true });
  }
});
