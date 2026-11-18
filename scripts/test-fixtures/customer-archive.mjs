import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import { openWorkspaceStore } from '../../packages/postgres/src/store.mjs';

const asset = 'archive-app';
const scope = 'https://www.googleapis.com/auth/webmasters.readonly';
const site = 'sc-domain:example.test';

export function customerArchiveFixture(app, { useServiceAccount = false } = {}) {
  const [east, west] = app.workspaces;
  const refresh = randomBytes(24).toString('base64url');
  const access = randomBytes(24).toString('base64url');
  const client = randomBytes(24).toString('base64url');
  const secret = randomBytes(24).toString('base64url');
  const requests = [];
  const email = 'collector@example.test';
  const accountKey = useServiceAccount ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : null;
  let mints = 0;
  let refused = false;

  return {
    async configure(db, credentialsKey) {
      const aes = await crypto.subtle.importKey('raw', Buffer.from(credentialsKey, 'base64'), 'AES-GCM', false, ['encrypt']);
      const fieldsByProvider = accountKey ? [
        ['google', { GOOGLE_SIGNAL_ACCOUNTS: JSON.stringify({ archive: {
          service_account_b64: Buffer.from(JSON.stringify({ client_email: email,
            private_key: accountKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) })).toString('base64'),
          properties: { [asset]: { gsc_site_url: site } },
        } }) }],
      ] : [
        ['google', { GOOGLE_OAUTH_REFRESH_TOKEN: refresh }],
        ['google-oauth-app', { GOOGLE_OAUTH_CLIENT_ID: client, GOOGLE_OAUTH_CLIENT_SECRET: secret }],
      ];
      for (const [provider, fields] of fieldsByProvider) {
        const iv = randomBytes(12);
        const ciphertext = Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes,
          new TextEncoder().encode(JSON.stringify(fields))));
        db.cluster.run(`INSERT INTO noticeos.integration_connections
          (workspace_id,connection_id,provider,scope,account,scopes,created_at,updated_at)
          VALUES(:'workspace'::uuid,:'connection'::uuid,:'provider','shared','fixture@example.test',:'scopes'::jsonb,now(),now());
          INSERT INTO noticeos.connection_secrets
          (workspace_id,connection_id,secret_version,ciphertext,iv,key_version,field_names,created_at)
          VALUES(:'workspace'::uuid,:'connection'::uuid,1,decode(:'ciphertext','hex'),decode(:'iv','hex'),1,:'fields'::jsonb,now());`,
        { vars: { workspace: east.workspaceId, connection: randomUUID(), provider, scopes: JSON.stringify([scope]),
          ciphertext: ciphertext.toString('hex'), iv: iv.toString('hex'), fields: JSON.stringify(Object.keys(fields)) } });
      }
      for (const workspace of [east, west]) {
        db.cluster.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status,list_position)
          SELECT :'workspace'::uuid,:'asset','Archive app','live',COALESCE(MAX(list_position),0)+1
          FROM noticeos.assets WHERE workspace_id=:'workspace'::uuid;
          UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{assets}',COALESCE(body::jsonb->'assets','{}'::jsonb)
          || jsonb_build_object(:'asset',jsonb_build_object('gsc',jsonb_build_object('status','live','siteUrl',:'site'))))::json
          WHERE workspace_id=:'workspace'::uuid AND document_key='integrations';
          UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{schedules}',COALESCE(body::jsonb->'schedules','{}'::jsonb)
          || jsonb_build_object('signal-dumps',jsonb_build_object('enabled',true,'cron','* * * * *'),
            'counters',jsonb_build_object('enabled',false,'cron','0 * * * *')))::json
          WHERE workspace_id=:'workspace'::uuid AND document_key='constants';`,
        { vars: { workspace: workspace.workspaceId, asset, site } });
      }
    },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.href === 'https://oauth2.googleapis.com/token') {
        const params = new URLSearchParams(await request.text());
        if (accountKey) {
          assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
          const [header, claims, signature, extra] = (params.get('assertion') ?? '').split('.');
          assert.ok(header && claims && signature && extra === undefined);
          assert.ok(verifySignature('RSA-SHA256', Buffer.from(`${header}.${claims}`), accountKey.publicKey, Buffer.from(signature, 'base64url')));
          const token = JSON.parse(Buffer.from(claims, 'base64url').toString());
          assert.equal(token.iss, email);
          assert.equal(token.aud, url.href);
          assert.equal(token.scope, scope);
          assert.equal(token.exp - token.iat, 3600);
        } else if (params.get('refresh_token') !== refresh || params.get('client_id') !== client || params.get('client_secret') !== secret) {
          return new Response(null, { status: 401 });
        }
        mints++;
        return Response.json({ access_token: access, expires_in: 3600 });
      }
      if (url.href !== `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`
        || request.headers.get('authorization') !== `Bearer ${access}`) {
        throw new Error('Unexpected upstream in the customer archive fixture.');
      }
      const report = await request.json();
      assert.equal(report.dataState, 'final');
      assert.equal(report.startDate, report.endDate);
      assert.equal(report.startRow, 0);
      const family = report.dimensions.join('/');
      requests.push(family);
      if (family === 'page/query' && !refused) {
        refused = true;
        return Response.json({ error: { message: 'Synthetic report unavailable' } }, { status: 503 });
      }
      const byDimension = { query: 'vegetable soup', page: 'https://example.test/recipes/soup' };
      const keys = report.dimensions.map(name => byDimension[name]);
      assert.ok(keys.every(Boolean));
      return Response.json({ rows: [{ keys, impressions: 400, clicks: 41, ctr: .1025, position: 3.7 }] });
    },
    async verify({ db, options, t }) {
      assert.deepEqual([...new Set(requests)].sort(), ['page', 'page/query', 'query']);
      assert.equal(mints, 3);
      const rows = db.cluster.sql(`SELECT r.workspace_id,r.status,r.report,r.provider_rows,o.object_key
        FROM noticeos.archive_runs r JOIN noticeos.archive_objects o USING (workspace_id, object_seq)
        WHERE r.asset_id='${asset}' AND r.integration='gsc' ORDER BY r.run_seq`);
      assert.equal(rows.length, requests.length - 1);
      for (const row of rows) {
        assert.equal(row.workspace_id, east.workspaceId);
        assert.equal(row.status, 'success');
        assert.equal(Number(row.provider_rows), 1);
        assert.ok(row.object_key.startsWith(`workspaces/${east.workspaceId}/raw/google/gsc/${asset}/`));
        assert.ok(await options.bucket.head(row.object_key));
      }
      const occurrences = db.cluster.sql(`SELECT workspace_id,state,steps->'collect'->>'state' AS step
        FROM noticeos.hosted_job_occurrences WHERE lane='signal-dumps' ORDER BY state`);
      assert.deepEqual(occurrences, [{ workspace_id: east.workspaceId, state: 'exhausted', step: 'failed' },
        ...Array(2).fill({ workspace_id: east.workspaceId, state: 'succeeded', step: 'succeeded' })]);
      const misses = db.cluster.sql(`SELECT workspace_id,report FROM noticeos.archive_runs
        WHERE asset_id='${asset}' AND status='error'`);
      assert.deepEqual(misses, [{ workspace_id: east.workspaceId, report: 'page-query' }]);
      db.cluster.run(`UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{assets}',(body::jsonb->'assets')
        || jsonb_build_object(:'asset',jsonb_build_object('enabled',true)))::json
        WHERE workspace_id=:'workspace'::uuid AND document_key='signal-panels';`, { vars: { workspace: east.workspaceId, asset } });
      const store = openWorkspaceStore(options.connectionString, { workspaceId: east.workspaceId });
      try {
        const report = await options.reports.run({ store, workspaceId: east.workspaceId, asset, scheduledAt: new Date().toISOString() });
        assert.equal(report.archivesFetched, rows.length);
        assert.equal(report.publication.created, true);
      } finally { await store.close(); }
      t.diagnostic(`Scheduled Search Console: ${mints} ${accountKey ? 'signed service-account ' : ''}token exchanges, ${requests.length} free report reads, ${rows.length} namespaced archives, 1 terminal partial failure, 0 requests from the second tenant.`);
      return { asset, archives: rows.length };
    },
  };
}
