import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTasksApi, writeResponse, IDEMPOTENCY_HEADER } from './hosted-tasks-api.mjs';
import { WORKSPACE_SESSION_HEADER, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { TaskStateRefused } from './hosted-task-command.mjs';
const [A,B,P,S,PERSON] = ['11111111','22222222','33333333','44444444','55555555'].map(prefix=>`${prefix}-1111-4111-8111-111111111111`);
const origin='https://tower.example.test';
function request(path,method='GET',body,workspace=A){return new Request(origin+path,{method,headers:{origin,
  'sec-fetch-site':'same-origin',[WORKSPACE_SELECTION_HEADER]:workspace,[WORKSPACE_SESSION_HEADER]:S,
  ...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});}
function fixture(){
  const calls=[],catalogReads=[],actorReads=[];let role='operator',active=true,epicsFail=false,actorsFail=false,title='Task',comment='Actual comment';
  const admission=createWorkspaceAdmission({kind:'hosted',profile:Symbol(),trustedOrigin:origin,membership:async(_headers,workspaceId)=>active?{
    principalId:PERSON,sessionId:S,expiresAt:new Date(Date.now()+60000).toISOString(),workspaceId,role,workspaceStatus:'active'}:null});
  const catalog=Object.freeze([{projectId:P,logicalKey:'example',displayName:'Example',prefix:'tt'}]);
  const handler=createHostedTasksApi({profile:'hosted',trustedOrigin:origin,admission,directory:{catalog:async workspace=>{catalogReads.push(workspace);return catalog;}},
    workspaceActors:async workspace=>{actorReads.push(workspace);if(actorsFail)throw new Error('unavailable');return[{principalId:PERSON,displayName:workspace===A?'Person A':'Person B'}];},
    executor:{execute:async(proof,workspace,command,controls)=>{
      calls.push({proof,workspace,command,controls});
      const kind=command.operation.kind;
      if(kind==='ready')return[{id:'tt-a'}];
      if(kind==='active-board')return[{id:'tt-a',title:workspace===A?'Private A':'Private B',status:'open',priority:2,comment_count:1}];
      if(kind==='closed-board')return[{id:'tt-old',status:'closed',closed_at:'2000-01-01T00:00:00Z'},
        {id:'tt-closed',status:'closed',closed_at:new Date().toISOString()}];
      if(kind==='epics'){if(epicsFail)throw new Error('unavailable');return[{epic:{id:'tt-e',title:'Roadmap',status:'open'},total_children:12,closed_children:5}];}
      if(kind==='show')return[{id:command.operation.taskId,title,status:'open',comment_count:1}];
      if(kind==='comments')return[{id:'comment',author:PERSON,text:comment,created_at:'2026-10-01T01:00:00Z'}];
      if(kind==='create')return{id:'tt-new'};
      return[];
    }}});
  return{handler,title:value=>{title=value;},comment:value=>{comment=value;},calls,catalogReads,actorReads,role:value=>{role=value;},active:value=>{active=value;},epicsFail:()=>{epicsFail=true;},actorsFail:()=>{actorsFail=true;}};
}
test('selected-workspace actor presentation is private, fresh and never changes immutable attribution',async()=>{
  const f=fixture();
  for(const workspace of[A,B]){
    const data=await(await f.handler(request(`/api/tasks/tt-a?project=${P}`,'GET',undefined,workspace))).json();
    assert.deepEqual(data.actors,[{principalId:PERSON,displayName:workspace===A?'Person A':'Person B'}]);
    assert.equal(data.comments[0].author,PERSON);
  }
  f.actorsFail();
  const unavailable=await(await f.handler(request(`/api/tasks/tt-a?project=${P}`))).json();
  assert.deepEqual(unavailable.actors,[]);assert.equal(unavailable.comments[0].author,PERSON);
  const count=f.actorReads.length;f.active(false);
  assert.equal((await f.handler(request(`/api/tasks/tt-a?project=${P}`))).status,403);
  assert.equal(f.actorReads.length,count,'unadmitted requests acquire no roster');
});
test('two workspace boards use explicit catalog selectors and complete lists with one aggregate deadline',async()=>{
  const f=fixture();
  for(const workspace of[A,B]){
    const reply=await f.handler(request(`/api/tasks?project=${P}`, 'GET',undefined,workspace));assert.equal(reply.status,200);
    const data=await reply.json();assert.equal(data.project,'example');assert.equal(data.repo,'');
    assert.equal(data.tasks.find(row=>row.id==='tt-a').title,workspace===A?'Private A':'Private B');
    assert.equal(data.tasks.find(row=>row.id==='tt-a').ready,true);assert.equal(data.tasks.some(row=>row.id==='tt-old'),false);
    assert.equal(data.epics[0].total,12);assert.equal(data.epics[0].closed,5);
    const calls=f.calls.filter(call=>call.workspace===workspace);
    assert.deepEqual(calls.map(call=>call.command.operation.kind),['ready','active-board','closed-board','epics']);
    assert.equal(new Set(calls.map(call=>call.controls.deadline)).size,1);
  }
});
test('detail reads actual comment bodies and history retains explicit project selection',async()=>{
  const f=fixture();const reply=await f.handler(request(`/api/tasks/tt-a?project=${P}`));
  assert.equal(reply.status,200);const data=await reply.json();assert.equal(data.comments[0].text,'Actual comment');
  assert.equal(data.repo,'');assert.deepEqual(f.calls.map(call=>call.command.operation.kind),['ready','show','comments']);
  assert.equal((await f.handler(request(`/api/tasks/tt-a/history?project=${P}&limit=4`))).status,200);
  assert.deepEqual(f.calls.at(-1).command.operation,{kind:'history',taskId:'tt-a',limit:4});
});

test('statistics are a scoped read with strict selectors and no board enrichment',async()=>{
  const f=fixture();
  const reply=await f.handler(request('/api/tasks/agent-stats'));
  assert.equal(reply.status,200);
  const data=await reply.json();
  assert.equal(data.projects,1);assert.deepEqual(data.broken,[]);
  assert.deepEqual(f.calls.map(call=>call.command.operation.kind),['active-board','closed-board']);
  assert.deepEqual(f.actorReads,[]);
  const count=f.calls.length;
  for(const path of['/api/tasks/agent-stats?project=unknown',`/api/tasks/agent-stats?project=${P}&project=${P}`,'/api/tasks/agent-stats?closedDays=300']) {
    assert.equal((await f.handler(request(path))).status,400);
  }
  assert.equal(f.calls.length,count);
  assert.equal((await f.handler(request('/api/tasks/agent-stats','POST',{}))).status,400);
  f.active(false);
  assert.equal((await f.handler(request('/api/tasks/agent-stats'))).status,403);
  assert.equal(f.calls.length,count);
});
test('malformed selectors and mutation authority fields refuse before catalog or executor',async()=>{
  const f=fixture();
  for(const path of['/api/tasks/tt-a',`/api/tasks?project=${P}&status=unknown`,`/api/tasks?project=${P}&status=open,open`,
    `/api/tasks?project=${P}&project=${P}`,`/api/tasks/tt-a/history?project=${P}&limit=201`,
    `/api/tasks?project=${P}&actor=owner`])assert.equal((await f.handler(request(path))).status,400,path);
  for(const body of[{projectId:P,title:'Task',workspaceId:A},{projectId:P,title:'Task',actor:'owner'},
    `{"projectId":"${P}","title":"a","ti\\u0074le":"b"}`])assert.equal((await f.handler(request('/api/tasks','POST',body))).status,400);
  assert.deepEqual(f.catalogReads,[]);assert.deepEqual(f.calls,[]);
});
test('catalog metadata never grants permission; revocation and role changes are fresh',async()=>{
  const f=fixture();const writable=await(await f.handler(request('/api/tasks/capabilities'))).json();assert.equal(writable.writable,true);
  f.role('viewer');assert.equal((await(await f.handler(request('/api/tasks/capabilities'))).json()).writable,false);
  assert.equal((await f.handler(request('/api/tasks','POST',{projectId:P,title:'Task'}))).status,403);assert.equal(f.calls.length,0);
  f.role('operator');assert.equal((await f.handler(request('/api/tasks','POST',{projectId:P,title:'Task'}))).status,200);
  f.active(false);assert.equal((await f.handler(request(`/api/tasks?project=${P}`))).status,403);
});
test('decision capability metadata is current and every exact decision path uses shared admission',async()=>{
  const f=fixture();
  const first=await(await f.handler(request('/api/tasks/capabilities'))).json();
  assert.ok(first.operations.includes('respond'));assert.ok(first.operations.includes('dismiss'));assert.ok(first.operations.includes('resolve'));
  for(const[path,value,kind]of[['/api/tasks/tt-a/respond',{response:'Answer'},'respond'],
    ['/api/tasks/tt-a/dismiss',{},'dismiss'],['/api/gates/tt-a/resolve',{reason:'Approved'},'resolve-gate']]){
    assert.equal((await f.handler(request(path,'POST',{projectId:P,...value}))).status,200);
    assert.equal(f.calls.at(-1).command.operation.kind,kind);
  }
  f.role('viewer');const viewer=await(await f.handler(request('/api/tasks/capabilities'))).json();
  assert.equal(viewer.operations.includes('resolve'),false);
  const reads=f.catalogReads.length,count=f.calls.length;
  assert.equal((await f.handler(request('/api/gates/tt-a/resolve','POST',{projectId:P}))).status,403);
  assert.equal(f.catalogReads.length,reads);assert.equal(f.calls.length,count);
  f.role('operator');f.active(false);
  assert.equal((await f.handler(request('/api/tasks/tt-a/respond','POST',{projectId:P,response:'Answer'}))).status,403);
});
test('unsupported project is never inferred from a task prefix; optional epic failure stays unknown',async()=>{
  const f=fixture();
  assert.equal((await f.handler(request(`/api/tasks/tt-a?project=${B}`))).status,403);assert.equal(f.calls.length,0);
  f.epicsFail();const data=await(await f.handler(request(`/api/tasks?project=${P}&status=open`))).json();
  assert.equal(data.epics,null);assert.equal(data.tasks.length,1);
});
test('an Idempotency-Key is checked before admission and needs a receipt store',async()=>{
  const f=fixture();
  const keyed=(path,method,body,key)=>{const r=request(path,method,body);r.headers.set(IDEMPOTENCY_HEADER,key);return r;};
  for(const[path,method,body,key]of[[`/api/tasks?project=${P}`,'GET',undefined,'agent-retry-0001'],
    ['/api/tasks','POST',{projectId:P,title:'Task'},'short'],['/api/tasks','POST',{projectId:P,title:'Task'},'bad key with spaces'],
    ['/api/tasks/tt-a/respond','POST',{projectId:P,response:'Answer'},'agent-retry-0001']]){
    assert.equal((await f.handler(keyed(path,method,body,key))).status,400,`${method} ${path} ${key}`);
  }
  assert.deepEqual(f.catalogReads,[]);assert.deepEqual(f.calls,[]);
  // This fixture configures no receipt store: a key it cannot honor is refused, not ignored.
  const reply=await f.handler(keyed('/api/tasks','POST',{projectId:P,title:'Task'},'agent-retry-0001'));
  assert.equal(reply.status,503);assert.deepEqual(await reply.json(),{error:'idempotency_unavailable'});assert.deepEqual(f.calls,[]);
  assert.equal(writeResponse({status:'pending'}).status,409);assert.equal(writeResponse({status:'conflict'}).status,409);
  assert.deepEqual(await writeResponse({status:'done',value:{id:'tt-a'},replayed:true}).json(),{id:'tt-a'});
});
test('a card edit refused because the task shipped its card says so, as a decision refused by its task does',async()=>{
  const admission=createWorkspaceAdmission({kind:'hosted',profile:Symbol(),trustedOrigin:origin,membership:async(_headers,workspaceId)=>({
    principalId:PERSON,sessionId:S,expiresAt:new Date(Date.now()+60000).toISOString(),workspaceId,role:'operator',workspaceStatus:'active'})});
  const handler=createHostedTasksApi({profile:'hosted',trustedOrigin:origin,admission,
    directory:{catalog:async()=>Object.freeze([{projectId:P,logicalKey:'example',displayName:'Example',prefix:'tt'}])},
    executor:{execute:async(_proof,_workspace,command)=>{
      if(command.operation.kind==='update')throw new TaskStateRefused('tt-a','other',{kind:'shipped',closedAt:'2026-10-21T09:30:00Z'});
      return[{id:'tt-a',status:'closed'}];
    }}});
  const card={valuePerMonth:400,likelihood:0.4,reviewMinutes:20,daysToSignal:28,measurability:'cohort'};
  const reply=await handler(request('/api/tasks/tt-a','PATCH',{projectId:P,card}));
  assert.equal(reply.status,409);
  assert.deepEqual(await reply.json(),{error:'task_refused',detail:'tt-a shipped on 2026-10-21, and its card stays as it shipped.'});
});
test('a closed-only read may ask for eight weeks of history; any other read keeps its week',async()=>{
  const f=fixture();
  const reply=await f.handler(request(`/api/tasks?project=${P}&status=closed&closedDays=56`));assert.equal(reply.status,200);
  const data=await reply.json();
  assert.equal(data.closedSince,new Date(Date.parse(data.readAt)-56*86400000).toISOString().slice(0,10));
  assert.deepEqual(f.calls.map(call=>call.command.operation.kind),['closed-board']);
  for(const path of[`/api/tasks?project=${P}&closedDays=56`,`/api/tasks?project=${P}&status=open,closed&closedDays=56`,
    `/api/tasks?project=${P}&status=closed&closedDays=57`,`/api/tasks?project=${P}&status=closed&closedDays=0`,
    `/api/tasks?project=${P}&status=closed&closedDays=2w`]){
    assert.equal((await f.handler(request(path))).status,400,path);
  }
});

test('successful task reads validate current content, omit answer times, and never bypass admission', async () => {
  const f=fixture();
  const conditional=(path,etag,workspace=A)=>{const r=request(path,'GET',undefined,workspace);r.headers.set('if-none-match',etag);return f.handler(r);};
  const paths=['/api/tasks/projects','/api/tasks/capabilities',`/api/tasks?project=${P}&status=open`,
    `/api/tasks/tt-a?project=${P}`,`/api/tasks/tt-a/history?project=${P}`];
  for(const path of paths){
    const initial=await f.handler(request(path));assert.equal(initial.status,200);
    const etag=initial.headers.get('etag');assert.match(etag,/^"[a-f0-9]{32}"$/u);
    const data=await initial.json();
    const same=await conditional(path,`"unrelated", W/${etag}`);
    assert.equal(same.status,304,path);assert.equal(await same.text(),'');
    assert.equal(same.headers.get('etag'),etag);assert.equal(same.headers.get('cache-control'),'no-store');
    assert.equal(same.headers.get('content-type'),null);
    if(data.readAt)assert.ok(JSON.parse(same.headers.get('x-noticeos-answer-times')).readAt);
    assert.equal((await conditional(path,'*')).status,200);
    assert.equal((await conditional(path,'"unknown"')).status,200);
    f.active(false);const denied=await conditional(path,etag);assert.equal(denied.status,403);assert.equal(denied.headers.get('etag'),null);f.active(true);
  }
  const detail=`/api/tasks/tt-a?project=${P}`;
  const before=(await f.handler(request(detail))).headers.get('etag');
  f.title('Changed task');const changed=await conditional(detail,before);assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),before);
  f.comment('Changed comment');const comment=await conditional(detail,changed.headers.get('etag'));assert.equal(comment.status,200);assert.notEqual(comment.headers.get('etag'),changed.headers.get('etag'));
  const board=`/api/tasks?project=${P}&status=open`,boardTag=(await f.handler(request(board))).headers.get('etag');
  assert.equal((await conditional(board,boardTag,B)).status,200,'validators cannot substitute another workspace board');
  const capabilities=(await f.handler(request('/api/tasks/capabilities'))).headers.get('etag');f.role('viewer');
  assert.equal((await conditional('/api/tasks/capabilities',capabilities)).status,200);
  const write=await f.handler(request('/api/tasks','POST',{projectId:P,title:'Task'}));assert.equal(write.headers.get('etag'),null);
});
