import { WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../packages/postgres/src/email-code.mjs';
import { GOOGLE_INTEGRATION_START, GOOGLE_INTEGRATION_CALLBACK } from './workspace-operations.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { bundleWorkerFixture as bundle, Miniflare } from './worker-entry-test-fixture.mjs';

const identityRequire = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = identityRequire('pg');
const fixtureDir = path.join(REPO_ROOT, 'workers/ingest/test/fixture-config');
const fixture = name => JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8'));

test('hosted OAuth original HTTP/RPC proof commits custody before scoped provider/store effects in workerd', { timeout: 120000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'noticeos-oauth-entry-'));
  let owner, admin, runtime;
  try {
    const ingest = await bundle(root, 'ingest', path.join(REPO_ROOT, 'workers/ingest/src/index.ts'));
    const tower = await bundle(root, 'tower', path.join(REPO_ROOT, 'apps/tower/worker/index.ts'));
    const driverEntry = path.join(root, 'driver.ts');
    writeFileSync(driverEntry, `import { withHostedWorkspaceStore } from ${JSON.stringify(path.join(REPO_ROOT,'packages/postgres/src/store.mjs'))};
      import { openIdentity } from ${JSON.stringify(path.join(REPO_ROOT,'packages/postgres/src/identity.mjs'))};
      import { putCredential } from ${JSON.stringify(path.join(REPO_ROOT,'workers/ingest/src/credentials.ts'))};
      export default {async fetch(request, env, ctx) {
        const asked = await request.json();
        if(asked.identity){const identity=await openIdentity({connectionString:env.NOTICEOS_IDENTITY_DATABASE_URL,trustedOrigin:env.NOTICEOS_WORKSPACE_ORIGIN,sessionSecret:env.NOTICEOS_IDENTITY_SESSION_SECRET});
          try {return Response.json(asked.identity==='close'?{ok:true}:await identity.workspaceSummary(asked.workspace));}finally{await identity.close();}}
        if (asked.seed) return withHostedWorkspaceStore({transport:{kind:'direct',connectionString:env.NOTICEOS_WORKSPACE_DATABASE_URL},workspace:{workspaceId:asked.seed}},ctx,
          async STORE=>Response.json(await putCredential({...env,STORE},{provider:'google-oauth-app',fields:{GOOGLE_OAUTH_CLIENT_ID:asked.seed,GOOGLE_OAUTH_CLIENT_SECRET:crypto.randomUUID()}})));
        if (asked.target) {const response=await env[asked.target].fetch(new Request(asked.url,asked.init));
          return Response.json({httpStatus:response.status,headers:[...response.headers],body:response.status===302?null:await response.text()});}
        try { const proof=asked.proof?new Request(asked.proof.url,asked.proof.init):undefined;
          return Response.json({ok:true,result:await env.INGEST[asked.method](...(asked.args??[]),...(proof?[proof]:[]))});
        } catch {return Response.json({ok:false},{status:403});}
      }};`);
    const driver = await bundle(root, 'driver', driverEntry);
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return; applyMigrations(owner);
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 2 });
    const password = randomBytes(32).toString('base64url');
    await admin.query('ALTER ROLE noticeos_identity LOGIN');
    await admin.query(`ALTER ROLE noticeos_identity PASSWORD '${password}'`);
    appendFileSync(path.join(owner.root, LOOPBACK_HBA), 'host all noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
    const appUrl = owner.applicationLogin().url(), identityUrl = new URL(appUrl);
    identityUrl.username = 'noticeos_identity'; identityUrl.password = password;
    const origin = 'https://fixture.example.test', secret = randomBytes(48).toString('base64url');
    const [a,b,person] = [randomUUID(),randomUUID(),randomUUID()];
    for (const id of [a,b]) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')",[id,`fixture-${id}`]);
      await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())',[id,`fixture-${id}`]);
    }
    await admin.query('INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified) VALUES($1,$2,$3,true)',[person,'Generated person','person@example.test']);
    for (const id of [a,b]) await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",[randomUUID(),id,person]);
    let message;
    const login = openEmailCodeLogin({connectionString:identityUrl.href,trustedOrigin:origin,sessionSecret:secret,
      peerAddress:'192.0.2.1',deliver:async value=>{message=value;}});
    let cookie;
    try {
      const request=(action,body)=>new Request(origin+EMAIL_CODE_PATHS[action],{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
      assert.equal((await login.requestCode(request('request',{email:'person@example.test'}))).status,202);
      const response=await login.verifyCode(request('verify',{email:'person@example.test',otp:message.code}));
      assert.equal(response.status,200); await response.arrayBuffer(); cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    } finally {await login.close();}
    const common={NOTICEOS_WORKSPACE_PROFILE:'hosted',NOTICEOS_WORKSPACE_ORIGIN:origin,NOTICEOS_WORKSPACE_DATABASE_URL:appUrl,
      NOTICEOS_IDENTITY_DATABASE_URL:identityUrl.href,NOTICEOS_IDENTITY_SESSION_SECRET:secret,CREDENTIALS_KEY:randomBytes(32).toString('base64')};
    let outside=0, provider=0, revoke=false, providerFails=false; const clients=[];
    const outbound=async request=>{
      if (request.url!=='https://oauth2.googleapis.com/token') {outside++;throw new Error('No outside request in owned OAuth fixture');}
      provider++;const body=new URLSearchParams(await request.text());clients.push(body.get('client_id'));
      if(providerFails)return Response.json({error:'invalid_grant'},{status:400});
      return Response.json({refresh_token:randomUUID(),scope:'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly'});
    };
    const relay=`import {WorkerEntrypoint} from 'cloudflare:workers';export default class extends WorkerEntrypoint {
      async beginGoogleOAuth(input,proof){await this.env.CONTROL.fetch('https://fixture-control/');return this.env.INGEST.beginGoogleOAuth(input,proof);}
      async completeGoogleOAuth(input,proof){return this.env.INGEST.completeGoogleOAuth(input,proof);}
    }`;
    const worker=(name,options,bindings,serviceBindings)=>({name,...options,bindings,serviceBindings,outboundService:outbound});
    runtime=new Miniflare({workers:[
      worker('driver',driver,common,{TOWER:'tower',DEMO:'demo',INGEST:'ingest'}),
      worker('tower',tower,common,{INGEST:'relay'}),worker('ingest',ingest,common,{}),
      worker('demo-ingest',ingest,{NOTICEOS_WORKSPACE_PROFILE:'demo'},{}),
      worker('standalone-ingest',ingest,{NOTICEOS_WORKSPACE_PROFILE:'standalone'},{}),
      worker('wrong-role-ingest',ingest,{...common,NOTICEOS_IDENTITY_DATABASE_URL:appUrl},{}),
      worker('demo',tower,{...common,NOTICEOS_WORKSPACE_PROFILE:'demo',NOTICEOS_DEMO_WORKSPACE_ID:b},{INGEST:'ingest'}),
      worker('relay',{modules:true,script:relay,compatibilityDate:'2026-07-06'}, {},{INGEST:'ingest',CONTROL:async()=>{
        if(revoke){await admin.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2',[a,person]);revoke=false;}
        return new Response(null,{status:204});
      }}),
    ]});
    // A hang guard for one call, not a speed check: a cold call on a loaded CI runner took over 10 s.
    const dispatch=asked=>runtime.dispatchFetch('https://fixture-driver/',{method:'POST',body:JSON.stringify(asked),signal:AbortSignal.timeout(30000)});
    const expectedSession=(await admin.query('SELECT id FROM noticeos_identity.auth_session WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',[person])).rows[0].id;
    const headers=id=>({origin,cookie,'x-noticeos-workspace-id':id,[WORKSPACE_SESSION_HEADER]:expectedSession});
    const http=async(pathname,init={},target='TOWER')=>{
      const bridge=await dispatch({target,url:origin+pathname,init});const held=await bridge.json();
      return new Response(held.body||null,{status:held.httpStatus,headers:held.headers});
    };
    const start=async id=>{
      const response=await http(GOOGLE_INTEGRATION_START,{method:'POST',headers:headers(id)});
      assert.equal(response.status,200,await response.clone().text());const body=await response.json();assert.equal(body.ok,true);
      const url=new URL(body.authorizeUrl);assert.equal(url.searchParams.get('client_id'),id);return url.searchParams.get('state');
    };
    const callback=(state,tail='&code=generated-code')=>http(`${GOOGLE_INTEGRATION_CALLBACK}?state=${state}${tail}`,{redirect:'manual',headers:{cookie,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}});
    for(const id of [a,b])assert.equal((await (await dispatch({seed:id})).json()).ok,true);
    await t.test('Google start requires matching session at Tower and independently at its receiver before custody or providers',async()=>{
      const before=(await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_verification WHERE identifier LIKE 'noticeos:integration-google:v1:%'")).rows[0].n;
      for(const expected of [undefined,'malformed',randomUUID(),`${expectedSession}, ${expectedSession}`]){
        const evidence={...headers(a)};
        if(expected===undefined)delete evidence[WORKSPACE_SESSION_HEADER];else evidence[WORKSPACE_SESSION_HEADER]=expected;
        const init={method:'POST',headers:evidence};
        assert.equal((await http(GOOGLE_INTEGRATION_START,init)).status,403);
        const answer=await dispatch({method:'beginGoogleOAuth',args:[{origin}],proof:{url:origin+GOOGLE_INTEGRATION_START,init}});
        assert.equal(answer.status,403);
      }
      assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_verification WHERE identifier LIKE 'noticeos:integration-google:v1:%'")).rows[0].n,before);
      assert.equal(provider,0);assert.equal(outside,0);
    });
    await t.test('only a hosted real scheduled event can retire expired Google custody',async()=>{
      const id=randomUUID();
      await admin.query(`INSERT INTO noticeos_identity.auth_verification(id,identifier,value,expires_at)
        VALUES($1,'noticeos:integration-google:v1:scheduled','generated-fixture',clock_timestamp()-interval '1 hour')`,[id]);
      const count=async()=> (await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_verification WHERE id=$1',[id])).rows[0].n;
      assert.equal((await dispatch({method:'scheduled',args:[{cron:'7 * * * *'}]})).status,403,'instance handler is not RPC-visible');
      assert.equal((await dispatch({method:'runScheduled',args:['7 * * * *']})).status,403,'ordinary runner RPC cannot run platform lane');
      for(const name of ['demo-ingest','standalone-ingest']){
        const worker=await runtime.getWorker(name);
        assert.equal((await worker.scheduled({cron:'7 * * * *'})).outcome,'ok');
        assert.equal(await count(),1,'non-hosted lane is a no-op with no identity bindings');
      }
      const wrong=await runtime.getWorker('wrong-role-ingest');
      assert.equal((await wrong.scheduled({cron:'7 * * * *'})).outcome,'exception');assert.equal(await count(),1);
      const worker=await runtime.getWorker('ingest');
      assert.equal((await worker.scheduled({cron:'0 * * * *'})).outcome,'exception','unwired hosted tenant lanes remain denied');
      await assert.rejects(worker.fetch(origin+'/api/oauth-maintenance',{method:'POST'}),/Workspace entry is unavailable/u);
      assert.equal(await count(),1);
      assert.equal((await worker.scheduled({cron:'7 * * * *'})).outcome,'ok');assert.equal(await count(),0);
      assert.equal((await worker.scheduled({cron:'7 * * * *'})).outcome,'ok');assert.equal(provider,0);assert.equal(outside,0);
    });
    await t.test('ordinary identity immediate-close and summary await initialized schema in workerd',async()=>{
      assert.deepEqual(await(await dispatch({identity:'close'})).json(),{ok:true});
      for(const id of[a,b])assert.deepEqual(await(await dispatch({identity:'summary',workspace:id})).json(),{workspaceId:id,displayName:`fixture-${id}`,status:'active'});
    });
    await t.test('actual two-workspace POST start and callback store only the bound credential',async()=>{
      for(const id of [a,b]){
        const state=await start(id);assert.match(state,/^[A-Za-z0-9_-]{43}$/u);
        const answer=await callback(state);assert.equal(answer.status,302);assert.ok(answer.headers.get('location').includes('google=connected'));
        assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos.integration_connections WHERE workspace_id=$1 AND provider='google'",[id])).rows[0].n,1);
        assert.ok((await callback(state)).headers.get('location').includes('state_invalid'));
      }
      assert.equal(provider,2);assert.deepEqual(clients,[a,b]);
    });
    await t.test('cancellation claims state, malformed/duplicate callback cannot redirect successfully',async()=>{
      const state=await start(a);const answer=await callback(state,'&error=access_denied');assert.ok(answer.headers.get('location').includes('denied'));
      assert.ok((await callback(state)).headers.get('location').includes('state_invalid'));assert.equal(provider,2);
      const next=await start(a);assert.ok((await callback(next,'&code=one&code=two')).headers.get('location').includes('state_invalid'));
      assert.ok((await callback(next,'&code=one&workspaceId='+b)).headers.get('location').includes('state_invalid'));assert.equal(provider,2);
      await callback(next,'&error=access_denied');
    });
    await t.test('failed provider exchange remains consumed and callback rejects suspended lifecycle',async()=>{
      const state=await start(b);providerFails=true;
      try{assert.ok((await callback(state)).headers.get('location').includes('exchange_failed'));}finally{providerFails=false;}
      assert.equal(provider,3);assert.ok((await callback(state)).headers.get('location').includes('state_invalid'));assert.equal(provider,3);
      const held=await start(b);await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1",[b]);
      assert.ok((await callback(held)).headers.get('location').includes('state_invalid'));assert.equal(provider,3);
      await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1",[b]);
      assert.ok((await callback(held,'&error=access_denied')).headers.get('location').includes('denied'));assert.equal(provider,3);
    });
    await t.test('receiver rejects revoked membership between Tower admission and issuance',async()=>{
      revoke=true;assert.equal((await http(GOOGLE_INTEGRATION_START,{method:'POST',headers:headers(a)})).status,403);
      assert.equal(provider,3);
    });
    await t.test('raw RPC options/omitted proof/demo/legacy GET refuse before effects',async()=>{
      for(const method of ['beginGoogleOAuth','completeGoogleOAuth'])assert.equal((await dispatch({method,args:[{}]})).status,403);
      const proof={url:origin+GOOGLE_INTEGRATION_START,init:{method:'POST',headers:headers(b)}};
      for(const extra of [{actor:person},{workspaceId:a},{nowMs:0},{profile:'standalone'}])assert.equal((await dispatch({method:'beginGoogleOAuth',args:[{origin,...extra}],proof})).status,403);
      assert.equal((await http(GOOGLE_INTEGRATION_START,{method:'POST',headers:headers(b)},'DEMO')).status,403);
      assert.equal((await http(GOOGLE_INTEGRATION_START,{headers:headers(b)})).status,403);
      assert.equal(outside,0);assert.equal(provider,3);
    });
  } finally {
    const cleanup=await Promise.allSettled([...(runtime?[runtime.dispose()]:[]),...(admin?[admin.end()]:[])]);
    owner?.close();assert.equal(existsSync(path.join(root,'pg/data/postmaster.pid')),false);
    for(const result of cleanup)if(result.status==='rejected')throw result.reason;
    rmSync(root,{recursive:true,force:true});assert.equal(existsSync(root),false);
  }
});
