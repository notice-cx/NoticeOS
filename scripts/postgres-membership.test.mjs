import { WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { identityEngine } from '../packages/postgres/src/identity-engine.mjs';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../packages/postgres/src/email-code.mjs';
import { openIdentity } from '../packages/postgres/src/identity.mjs';
import { openMembershipLifecycle, InvitationDeliveryFailed } from '../packages/postgres/src/membership.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './postgres-test-skip.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { stopLocalSecretReads } from './worker-config-folder.mjs';

const require=createRequire(path.join(REPO_ROOT,'packages/postgres/package.json'));
const { Pool }=require('pg');
const { Kysely, PostgresDialect }=require('kysely');
const origin='https://membership.example.test';
function request(pathname, body, cookie='') {
  return new Request(origin+pathname,{method:'POST',headers:{origin,'content-type':'application/json',cookie},body:JSON.stringify(body)});
}
const library=(route,body,cookie)=>request('/api/auth/organization/'+route,body,cookie);

test('maintained roles and native membership transactions preserve fresh authority', {timeout:60000}, async t=>{
  const tools = findPostgres();
  const root=mkdtempSync(path.join(os.tmpdir(),'noticeos-members-'));
  let owner, admin, database;
  const clients=[];
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root,'pg'), tools)); if (!owner) return;
    admin=new Pool({host:owner.socketDir,port:owner.loopbackPort,database:'noticeos_dev',user:'postgres',max:2});
    applyMigrations(owner);
    const password=randomBytes(32).toString('base64url');
    await admin.query('ALTER ROLE noticeos_identity LOGIN');
    await admin.query(`ALTER ROLE noticeos_identity PASSWORD '${password}'`);
    appendFileSync(path.join(owner.root,LOOPBACK_HBA),'host all noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl,['reload','-D',path.join(owner.root,'data')],{stdio:'pipe'});
    const url=new URL(owner.applicationLogin().url()); url.username='noticeos_identity';url.password=password;
    const options={connectionString:url.href,trustedOrigin:origin,sessionSecret:randomBytes(48).toString('base64url')};
    database=new Kysely({dialect:new PostgresDialect({pool:new Pool({connectionString:url.href,max:2})})});
    const captured=[];
    const auth=identityEngine(database,options,{transaction:true,invitation:message=>captured.push(message)});
    let peer=1;
    const sessions=new Map();
    async function person(email) {
      const id=randomUUID();
      await admin.query('INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,$2,$2,true,now(),now())',[id,email]);
      const mail=[];
      const login=openEmailCodeLogin({...options,peerAddress:`192.0.2.${peer++}`,deliver:async message=>mail.push(message)});clients.push(login);
      assert.equal((await login.requestCode(request(EMAIL_CODE_PATHS.request,{email}))).status,202);
      assert.equal(mail.length,1);
      const response=await login.verifyCode(request(EMAIL_CODE_PATHS.verify,{email,otp:mail[0].code}));
      assert.equal(response.status,200);
      const cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
      const identity=await openIdentity(options);clients.push(identity);
      const session=await identity.session(new Headers({cookie}));
      assert.equal(session.principalId,id);sessions.set(cookie,session.sessionId);
      return {id,email,cookie};
    }
    const workspace=randomUUID(), a=await person('owner@example.test'), b=await person('operator@example.test'), c=await person('viewer@example.test');
    await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')",[workspace,`fixture-${workspace}`]);
    await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())',[workspace,`fixture-${workspace}`]);
    await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",[randomUUID(),workspace,a.id]);
    for(const [person,role] of [[b,'operator'],[c,'viewer']]) {
      const invite=await auth.handler(library('invite-member',{organizationId:workspace,email:person.email,role},a.cookie));
      assert.equal(invite.status,200,await invite.clone().text());
      const row=await invite.json();
      assert.equal(captured.at(-1).role,role);assert.equal(captured.at(-1).invitationId,row.id);
      const accepted=await auth.handler(library('accept-invitation',{invitationId:row.id},person.cookie));
      assert.equal(accepted.status,200,await accepted.clone().text());
      assert.equal((await admin.query('SELECT role FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2',[workspace,person.id])).rows[0].role,role);
      const denied=await auth.handler(library('invite-member',{organizationId:workspace,email:`denied-${role}@example.test`,role:'viewer'},person.cookie));
      assert.equal(denied.status,403);
      assert.equal((await denied.json()).code,'YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION');
    }
    const member=(await admin.query('SELECT id FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2',[workspace,b.id])).rows[0].id;
    assert.equal((await auth.handler(library('update-member-role',{organizationId:workspace,memberId:member,role:'viewer'},a.cookie))).status,200);
    assert.equal((await auth.handler(library('remove-member',{organizationId:workspace,memberIdOrEmail:member},a.cookie))).status,200);
    const sole=(await admin.query('SELECT id FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2',[workspace,a.id])).rows[0].id;
    const lastOwner=await auth.handler(library('update-member-role',{organizationId:workspace,memberId:sole,role:'viewer'},a.cookie));
    assert.equal(lastOwner.status,400);
    assert.equal((await lastOwner.json()).code,'YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER');
    const initial=await auth.handler(library('invite-member',{organizationId:workspace,email:'retry@example.test',role:'operator'},a.cookie));
    assert.equal(initial.status,200);const initialRow=await initial.json();
    const retry=await auth.handler(library('invite-member',{organizationId:workspace,email:'retry@example.test',role:'operator',resend:true},a.cookie));
    assert.equal(retry.status,200);assert.equal((await retry.json()).id,initialRow.id);
    assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_invitation WHERE organization_id=$1 AND email='retry@example.test'",[workspace])).rows[0].n,1);

    let authorizations=0;
    const delivered=[];
    const proof=(cookie,headers={origin})=>new Request(origin+'/memberships',{method:'POST',headers:{cookie,[WORKSPACE_SESSION_HEADER]:sessions.get(cookie),...headers}});
    async function authorize(request,facts) {
      authorizations++;
      assert.ok(Object.isFrozen(facts));
      const admission=createWorkspaceAdmission({kind:'hosted',profile:Symbol('fixture'),trustedOrigin:origin,
        membership:async()=>facts});
      await admission.withAdmission('memberships.manage',{requestedWorkspaceId:facts.workspaceId,correlationId:'membership-fixture'},request,
        async context=>{assert.equal(context.principalId,facts.principalId);assert.equal(context.sessionId,facts.sessionId);});
    }
    function lifecycle(overrides={}) {
      const client=openMembershipLifecycle({...options,authorize,deliver:async message=>{
        // A different connection can see the invitation only after COMMIT.
        assert.equal((await admin.query('SELECT status FROM noticeos_identity.auth_invitation WHERE id=$1',[message.invitationId])).rows[0].status,'pending');
        delivered.push(message);
      },...overrides});clients.push(client);return client;
    }
    async function addMember(w,person,role) {
      const id=randomUUID();await admin.query('INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,$4,now())',[id,w,person.id,role]);return id;
    }
    async function ownedWorkspace(members) {
      const id=randomUUID();
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')",[id,`fixture-${id}`]);
      await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())',[id,`fixture-${id}`]);
      const ids=[];for(const [person,role] of members)ids.push(await addMember(id,person,role));return {id,ids};
    }
    async function waitForLocks(n) {
      const deadline=Date.now()+3000;
      while(Date.now()<deadline) {
        const count=(await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='noticeos_identity' AND wait_event_type='Lock' AND query LIKE '%auth_organization%'")).rows[0].n;
        if(count>=n)return;
      }
      assert.fail('Expected independent membership connections to wait for the organization lock');
    }
    const d=await person('invitee@example.test'), outsider=await person('outsider@example.test'), second=await person('second-owner@example.test');
    const product=lifecycle();
    const invite=await product.execute(proof(a.cookie),workspace,{kind:'invite',email:d.email,role:'operator'});
    assert.equal(invite.status,200);const inviteId=(await invite.json()).invitationId;
    assert.equal(delivered.at(-1).invitationId,inviteId);
    const beforeAccept=authorizations;
    await assert.rejects(product.accept(proof(d.cookie,{origin,[WORKSPACE_SESSION_HEADER]:randomUUID()}),inviteId),{name:'IdentityRefused'});
    await assert.rejects(product.accept(proof(outsider.cookie),inviteId),{name:'IdentityRefused'});
    const accepted=await product.accept(proof(d.cookie),inviteId);
    assert.equal(accepted.status,200);assert.equal(accepted.headers.has('set-cookie'),false);
    assert.equal(authorizations,beforeAccept,'Recipient acceptance does not confer membership administration');
    assert.equal((await admin.query('SELECT role FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2',[workspace,d.id])).rows[0].role,'operator');
    await assert.rejects(product.execute(proof(d.cookie),workspace,{kind:'accept',invitationId:inviteId}),{name:'IdentityRefused',message:'Membership action refused'});
    for(const person of [c,d,outsider]) await assert.rejects(product.execute(proof(person.cookie),workspace,{kind:'invite',email:'blocked@example.test',role:'viewer'}),{name:'IdentityRefused'});
    assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_invitation WHERE email='blocked@example.test'")).rows[0].n,0);

    const other=await ownedWorkspace([[a,'owner'],[second,'viewer']]);
    await t.test('owner roster uses bounded workspace-only keyset pages',async()=>{
      const stale=proof(a.cookie);stale.headers.set('x-noticeos-session-id',randomUUID());
      const before=authorizations;
      await assert.rejects(product.execute(stale,workspace,{kind:'list',collection:'members'}),{name:'IdentityRefused'});
      assert.equal(authorizations,before,'A replaced session refuses before membership authorization');
      const listed=await product.execute(proof(a.cookie),workspace,{kind:'list',collection:'members'});
      assert.equal(listed.headers.get('cache-control'),'no-store');
      const first=await listed.json();assert.equal(first.nextCursor,null);
      assert.deepEqual(first.items.map(row=>row.email).sort(),[a.email,c.email,d.email].sort());
      assert.ok(first.items.every(row=>Object.keys(row).sort().join(',')==='email,id,name,role'));
      for(const person of[c,d,outsider])await assert.rejects(product.execute(proof(person.cookie),workspace,{kind:'list',collection:'members'}),{name:'IdentityRefused'});
      const large=await ownedWorkspace([[a,'owner']]);
      const people=Array.from({length:101},(_,i)=>({id:randomUUID(),member:randomUUID(),email:`roster-${i}@example.test`}));
      await admin.query(`INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified)
        SELECT id::uuid,email,email,true FROM jsonb_to_recordset($1::jsonb) AS p(id text,email text)`,[JSON.stringify(people)]);
      await admin.query(`INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at)
        SELECT member::uuid,$2::uuid,id::uuid,'viewer',now() FROM jsonb_to_recordset($1::jsonb) AS p(id text,member text)`,[JSON.stringify(people),large.id]);
      const page=await(await product.execute(proof(a.cookie),large.id,{kind:'list',collection:'members'})).json();
      assert.equal(page.items.length,100);assert.equal(page.nextCursor,page.items.at(-1).id);
      const next=await(await product.execute(proof(a.cookie),large.id,{kind:'list',collection:'members',after:page.nextCursor})).json();
      assert.equal(next.items.length,2);assert.equal(next.nextCursor,null);
      assert.equal(new Set([...page.items,...next.items].map(row=>row.id)).size,102);
      await assert.rejects(product.execute(proof(a.cookie),large.id,{kind:'list',collection:'members',after:'foreign'}),{name:'IdentityRefused'});
    });
    await assert.rejects(product.execute(proof(a.cookie),workspace,{kind:'remove',memberId:other.ids[1]}),{name:'IdentityRefused'});
    const foreignInvite=(await (await product.execute(proof(a.cookie),other.id,{kind:'invite',email:'foreign@example.test',role:'viewer'})).json()).invitationId;
    await assert.rejects(product.execute(proof(a.cookie),workspace,{kind:'cancel',invitationId:foreignInvite}),{name:'IdentityRefused'});
    await assert.rejects(product.execute(proof(outsider.cookie),other.id,{kind:'accept',invitationId:foreignInvite}),{name:'IdentityRefused'});
    assert.equal((await admin.query('SELECT status FROM noticeos_identity.auth_invitation WHERE id=$1',[foreignInvite])).rows[0].status,'pending');

    // Two separate adapter pools wait behind the same held organization row.
    const race=await ownedWorkspace([[a,'owner']]);
    const raceId=(await (await product.execute(proof(a.cookie),race.id,{kind:'invite',email:outsider.email,role:'viewer'})).json()).invitationId;
    const block=await admin.connect();
    try {
      await block.query('BEGIN');await block.query('SELECT id FROM noticeos_identity.auth_organization WHERE id=$1 FOR UPDATE',[race.id]);
      const outcomes=Promise.allSettled([lifecycle().execute(proof(outsider.cookie),race.id,{kind:'accept',invitationId:raceId}),
        lifecycle().execute(proof(outsider.cookie),race.id,{kind:'accept',invitationId:raceId})]);
      await waitForLocks(2);await block.query('COMMIT');
      const settled=await outcomes;assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);assert.equal(settled.filter(r=>r.status==='rejected').length,1);
    } finally {await block.query('ROLLBACK');block.release();}
    assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2',[race.id,outsider.id])).rows[0].n,1);

    const owners=await ownedWorkspace([[a,'owner'],[second,'owner']]);
    let release,entered;
    const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{entered=resolve;});
    const first=lifecycle({authorize:async(request,facts)=>{await authorize(request,facts);entered();await gate;}});
    const firstResult=first.execute(proof(a.cookie),owners.id,{kind:'remove',memberId:owners.ids[1]});
    let removals;
    try {
      await Promise.race([ready,firstResult.then(()=>assert.fail('The held authorization must remain pending'))]);
      removals=Promise.allSettled([firstResult,lifecycle().execute(proof(second.cookie),owners.id,{kind:'remove',memberId:owners.ids[0]})]);
      await waitForLocks(1);
    } finally {release();}
    const removed=await removals;assert.equal(removed.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_member WHERE organization_id=$1 AND role='owner'",[owners.id])).rows[0].n,1);
    const demotions=await ownedWorkspace([[a,'owner'],[second,'owner']]);
    const demoted=await Promise.allSettled([lifecycle().execute(proof(a.cookie),demotions.id,{kind:'change-role',memberId:demotions.ids[0],role:'viewer'}),
      lifecycle().execute(proof(second.cookie),demotions.id,{kind:'change-role',memberId:demotions.ids[1],role:'viewer'})]);
    assert.equal(demoted.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_member WHERE organization_id=$1 AND role='owner'",[demotions.id])).rows[0].n,1);

    const suspend=await ownedWorkspace([[a,'owner']]);const lock=await admin.connect();
    try {
      await lock.query('BEGIN');await lock.query('SELECT id FROM noticeos_identity.auth_organization WHERE id=$1 FOR UPDATE',[suspend.id]);
      const outcome=Promise.allSettled([product.execute(proof(a.cookie),suspend.id,{kind:'invite',email:'suspended@example.test',role:'viewer'})]);
      await waitForLocks(1);await lock.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1",[suspend.id]);await lock.query('COMMIT');
      assert.equal((await outcome)[0].status,'rejected');
    } finally {await lock.query('ROLLBACK');lock.release();}
    assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_invitation WHERE organization_id=$1',[suspend.id])).rows[0].n,0);

    const snapshot=await ownedWorkspace([[a,'owner']]);const held=await admin.connect();
    try {
      await held.query('BEGIN');await held.query('SELECT id FROM noticeos_identity.auth_organization WHERE id=$1 FOR UPDATE',[snapshot.id]);
      const original=proof(a.cookie),input={kind:'invite',email:'snapshot@example.test',role:'viewer'};
      const pending=product.execute(original,snapshot.id,input);original.headers.set('origin','https://foreign.example.test');input.email='mutated@example.test';input.role='owner';
      await waitForLocks(1);await held.query('COMMIT');assert.equal((await pending).status,200);
    } finally {await held.query('ROLLBACK');held.release();}
    assert.deepEqual((await admin.query('SELECT email,role FROM noticeos_identity.auth_invitation WHERE organization_id=$1',[snapshot.id])).rows,[{email:'snapshot@example.test',role:'viewer'}]);

    const deliveredBefore=delivered.length;
    await admin.query("CREATE FUNCTION noticeos_identity.fixture_commit_refuse() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'generated commit failure'; END$$");
    await admin.query('CREATE CONSTRAINT TRIGGER fixture_commit_refuse AFTER INSERT ON noticeos_identity.auth_invitation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION noticeos_identity.fixture_commit_refuse()');
    try {await assert.rejects(product.execute(proof(a.cookie),workspace,{kind:'invite',email:'rollback@example.test',role:'viewer'}),{name:'IdentityRefused'});}
    finally {await admin.query('DROP TRIGGER fixture_commit_refuse ON noticeos_identity.auth_invitation');await admin.query('DROP FUNCTION noticeos_identity.fixture_commit_refuse()');}
    assert.equal(delivered.length,deliveredBefore);assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_invitation WHERE email='rollback@example.test'")).rows[0].n,0);

    let fail=true;
    const delivery=lifecycle({deliver:async()=>{if(fail)throw new Error('generated delivery failure');}});
    let saved;
    await assert.rejects(delivery.execute(proof(a.cookie),workspace,{kind:'invite',email:'postcommit@example.test',role:'viewer'}),error=>{
      assert.ok(error instanceof InvitationDeliveryFailed);assert.equal(error.message,'Invitation saved; delivery failed.');saved=error.invitationId;return true;
    });
    assert.equal((await admin.query('SELECT status FROM noticeos_identity.auth_invitation WHERE id=$1',[saved])).rows[0].status,'pending');
    fail=false;assert.equal((await (await delivery.execute(proof(a.cookie),workspace,{kind:'resend',invitationId:saved})).json()).invitationId,saved);
    assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_invitation WHERE organization_id=$1 AND email='postcommit@example.test'",[workspace])).rows[0].n,1);

    const expire=(await (await product.execute(proof(a.cookie),workspace,{kind:'invite',email:second.email,role:'viewer'})).json()).invitationId;
    await admin.query("UPDATE noticeos_identity.auth_invitation SET expires_at=now()-interval '1 second' WHERE id=$1",[expire]);
    await assert.rejects(product.execute(proof(second.cookie),workspace,{kind:'accept',invitationId:expire}),{name:'IdentityRefused'});
    assert.equal((await admin.query('SELECT status FROM noticeos_identity.auth_invitation WHERE id=$1',[expire])).rows[0].status,'pending');
    const verified=(await (await product.execute(proof(a.cookie),workspace,{kind:'invite',email:second.email,role:'viewer'})).json()).invitationId;
    await admin.query('UPDATE noticeos_identity.auth_user SET email_verified=false WHERE id=$1',[second.id]);
    try {await assert.rejects(product.execute(proof(second.cookie),workspace,{kind:'accept',invitationId:verified}),{name:'IdentityRefused'});}
    finally {await admin.query('UPDATE noticeos_identity.auth_user SET email_verified=true WHERE id=$1',[second.id]);}
    await admin.query("UPDATE noticeos_identity.auth_invitation SET role='corrupt' WHERE id=$1",[verified]);
    await assert.rejects(product.execute(proof(second.cookie),workspace,{kind:'accept',invitationId:verified}),{name:'IdentityRefused'});
    await admin.query("UPDATE noticeos_identity.auth_invitation SET role='viewer' WHERE id=$1",[verified]);
    assert.equal((await product.execute(proof(a.cookie),workspace,{kind:'cancel',invitationId:verified})).status,200);
    await assert.rejects(product.execute(proof(second.cookie),workspace,{kind:'accept',invitationId:verified}),{name:'IdentityRefused'});

    const revokee=await person('revoked-session@example.test'), revoke=await ownedWorkspace([[revokee,'owner']]);
    const revokeLock=await admin.connect();
    try {
      await revokeLock.query('BEGIN');await revokeLock.query('SELECT id FROM noticeos_identity.auth_organization WHERE id=$1 FOR UPDATE',[revoke.id]);
      const outcome=Promise.allSettled([product.execute(proof(revokee.cookie),revoke.id,{kind:'invite',email:'revoked@example.test',role:'viewer'})]);
      await waitForLocks(1);await revokeLock.query('DELETE FROM noticeos_identity.auth_session WHERE user_id=$1',[revokee.id]);await revokeLock.query('COMMIT');
      assert.equal((await outcome)[0].status,'rejected');
    } finally {await revokeLock.query('ROLLBACK');revokeLock.release();}
    assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_invitation WHERE organization_id=$1',[revoke.id])).rows[0].n,0);
    const ignored=lifecycle({authorize:async(request,facts)=>{await authorize(request,facts);return {workspaceId:other.id,role:'owner'};}});
    const ignoredId=(await (await ignored.execute(proof(a.cookie),workspace,{kind:'invite',email:'original-authority@example.test',role:'viewer'})).json()).invitationId;
    assert.equal((await admin.query('SELECT organization_id FROM noticeos_identity.auth_invitation WHERE id=$1',[ignoredId])).rows[0].organization_id,workspace);
    const throwing=lifecycle({authorize:async()=>{throw new Error('generated policy failure');}});
    await assert.rejects(throwing.execute(proof(a.cookie),workspace,{kind:'invite',email:'policy-rollback@example.test',role:'viewer'}),{name:'IdentityRefused',message:'Membership action refused'});
    assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_invitation WHERE email='policy-rollback@example.test'")).rows[0].n,0);
    const referer=proof(a.cookie,{referer:origin+'/memberships','sec-fetch-site':'same-origin'});
    assert.equal((await product.execute(referer,workspace,{kind:'invite',email:'truthful-referer@example.test',role:'viewer'})).status,200);
    await assert.rejects(product.execute(proof(a.cookie,{referer:'https://foreign.example.test/member','sec-fetch-site':'same-origin'}),workspace,
      {kind:'invite',email:'foreign-referer@example.test',role:'viewer'}),{name:'IdentityRefused'});
    assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_invitation WHERE email='foreign-referer@example.test'")).rows[0].n,0);
    await product.close();assert.equal(product.close(),product.close());
    await assert.rejects(product.execute(proof(a.cookie),workspace,{kind:'invite',email:'after-close@example.test',role:'viewer'}),{name:'IdentityRefused',message:'Membership is closed'});

    await t.test('ordinary Worker runtimes preserve invitation replay and the last owner',async()=>{
      const wranglerRequire=createRequire(createRequire(path.join(REPO_ROOT,'workers/ingest/package.json')).resolve('wrangler/package.json'));
      const wranglerPath=wranglerRequire.resolve('wrangler/package.json');
      const metadata=JSON.parse(readFileSync(wranglerPath,'utf8'));
      const build=path.join(root,'build');mkdirSync(build);
      const config=path.join(root,'wrangler.json');
      writeFileSync(config,JSON.stringify({name:'noticeos-membership-fixture',main:path.join(REPO_ROOT,'scripts/membership-worker.fixture.mjs'),
        compatibility_date:'2026-07-06',compatibility_flags:['nodejs_compat'],send_metrics:false}));
      const home=path.join(root,'build-client');mkdirSync(home);
      const env={PATH:`${path.dirname(process.execPath)}:/usr/bin:/bin`,HOME:home,TMPDIR:root,
        XDG_CONFIG_HOME:path.join(home,'config'),XDG_CACHE_HOME:path.join(home,'cache'),
        NODE_OPTIONS:`--import=${path.join(REPO_ROOT,'scripts/script-tests-setup.mjs')}`,
        WRANGLER_SEND_METRICS:'false',WRANGLER_HIDE_BANNER:'true',BETTER_AUTH_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1',NO_COLOR:'1'};
      stopLocalSecretReads(env);
      const compiled=spawnSync(process.execPath,[path.join(path.dirname(wranglerPath),metadata.bin.wrangler),
        'deploy','--dry-run','--config',config,'--outdir',build],{cwd:root,env,encoding:'utf8',timeout:60000});
      assert.equal(compiled.error,undefined);assert.equal(compiled.status,0,compiled.stderr);
      const bundle=path.join(build,'membership-worker.fixture.js');assert.ok(!readFileSync(bundle,'utf8').includes('node:sqlite'));
      const {Miniflare}=wranglerRequire('miniflare');
      const runtimes=[],messages=[];let outside=0;
      try {
        for(let i=0;i<2;i++)runtimes.push(new Miniflare({modules:true,modulesRoot:build,scriptPath:bundle,
          compatibilityDate:'2026-07-06',compatibilityFlags:['nodejs_compat'],
          bindings:{FIXTURE_CONNECTION:options.connectionString,FIXTURE_ORIGIN:origin,FIXTURE_SECRET:options.sessionSecret},
          serviceBindings:{CAPTURE_MAIL:async request=>{
            const message=await request.json();
            assert.equal((await admin.query('SELECT status FROM noticeos_identity.auth_invitation WHERE id=$1',[message.invitationId])).rows[0].status,'pending');
            messages.push(message);return new Response(null,{status:204});
          }},outboundService:async()=>{outside++;throw new Error('No outside HTTP in membership fixture');}}));
        const dispatch=(index,cookie,w,command,headers={origin})=>runtimes[index].dispatchFetch(origin+'/memberships',{
          method:'POST',headers:{'content-type':'application/json',cookie,[WORKSPACE_SESSION_HEADER]:sessions.get(cookie),...headers},body:JSON.stringify({workspaceId:w,command})});
        const workerPerson=await person('worker-recipient@example.test'),worker=await ownedWorkspace([[a,'owner'],[c,'viewer']]);
        for(const headers of [{},{origin:'null'},{origin:'https://foreign.example.test'},{origin,'sec-fetch-site':'cross-site'}])
          assert.equal((await dispatch(0,a.cookie,worker.id,{kind:'invite',email:'csrf-worker@example.test',role:'viewer'},headers)).status,403);
        assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_invitation WHERE organization_id=$1',[worker.id])).rows[0].n,0);
        const created=await dispatch(0,a.cookie,worker.id,{kind:'invite',email:workerPerson.email,role:'operator'});
        assert.equal(created.status,200);const id=(await created.json()).invitationId;
        assert.equal(messages.length,1);assert.equal(messages[0].invitationId,id);
        const accepted=await Promise.all(runtimes.map((_,index)=>dispatch(index,workerPerson.cookie,worker.id,{kind:'accept',invitationId:id})));
        assert.deepEqual(accepted.map(response=>response.status).sort(),[200,403]);
        assert.equal((await admin.query('SELECT role FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2',[worker.id,workerPerson.id])).rows[0].role,'operator');
        for(const person of [c,workerPerson])assert.equal((await dispatch(1,person.cookie,worker.id,{kind:'invite',email:'forbidden-worker@example.test',role:'viewer'})).status,403);
        // Each response waits for the request-owned adapter close after its
        // denied transaction; the next independent request still succeeds.
        assert.equal((await dispatch(1,a.cookie,worker.id,{kind:'invite',email:'after-rollback@example.test',role:'viewer'})).status,200);
        assert.equal((await dispatch(0,a.cookie,worker.id,{kind:'remove',memberId:other.ids[1]})).status,403);
        const workerOwners=await ownedWorkspace([[a,'owner'],[second,'owner']]);
        const changes=await Promise.all([dispatch(0,a.cookie,workerOwners.id,{kind:'change-role',memberId:workerOwners.ids[0],role:'viewer'}),
          dispatch(1,second.cookie,workerOwners.id,{kind:'change-role',memberId:workerOwners.ids[1],role:'viewer'})]);
        assert.deepEqual(changes.map(response=>response.status).sort(),[200,403]);
        assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_member WHERE organization_id=$1 AND role='owner'",[workerOwners.id])).rows[0].n,1);
        assert.equal(outside,0);
      } finally {
        const disposed=await Promise.allSettled(runtimes.map(runtime=>runtime.dispose()));
        for(const result of disposed)if(result.status==='rejected')throw result.reason;
      }
    });
  } finally {
    const closed=await Promise.allSettled([...clients.map(client=>client.close()),database?.destroy(),admin?.end()].filter(Boolean));
    owner?.close();
    assert.equal(existsSync(path.join(root,'pg/data/postmaster.pid')),false,'Retain the fixture if its owned server absence is uncertain');
    rmSync(root,{recursive:true,force:true});
    for(const result of closed)if(result.status==='rejected')throw result.reason;
  }
});

test('unsafe browser evidence and malformed selectors refuse before any connection', {timeout:5000}, async()=>{
  let connections=0,decisions=0,mail=0;
  const server=net.createServer(socket=>{connections++;socket.destroy();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address();
  const client=openMembershipLifecycle({connectionString:`postgres://noticeos_identity:generated@127.0.0.1:${port}/fixture`,
    trustedOrigin:origin,sessionSecret:randomBytes(48).toString('base64url'),authorize:async()=>{decisions++;},deliver:async()=>{mail++;}});
  try {
    for(const headers of [{},{origin:'null'},{origin:'https://foreign.example.test'},
      {origin,'sec-fetch-site':'cross-site'}]) {
      await assert.rejects(client.execute(new Request(origin+'/member',{method:'POST',headers}),randomUUID(),{kind:'invite',email:'safe@example.test',role:'viewer'}),{name:'IdentityRefused'});
    }
    const valid=new Request(origin+'/member',{method:'POST',headers:{origin}});
    for(const input of [{kind:'unknown',invitationId:randomUUID()},{kind:'invite',email:'safe@example.test',role:'admin'},
      JSON.parse('{"kind":"invite","email":"safe@example.test","role":"viewer","__proto__":{}}'),
      {kind:'invite',email:'safe@example.test',role:'viewer',extra:true},{kind:'remove',memberId:'not-a-uuid'}]) {
      await assert.rejects(client.execute(valid,randomUUID(),input),{name:'IdentityRefused'});
    }
    await assert.rejects(client.execute(valid,'not-a-workspace',{kind:'invite',email:'safe@example.test',role:'viewer'}),{name:'IdentityRefused'});
    assert.deepEqual({connections,decisions,mail},{connections:0,decisions:0,mail:0});
  } finally {await client.close();await new Promise(resolve=>server.close(resolve));}
});
