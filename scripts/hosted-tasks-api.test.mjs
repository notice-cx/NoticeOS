import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTasksApi, writeResponse, IDEMPOTENCY_HEADER } from './hosted-tasks-api.mjs';
import { WORKSPACE_SESSION_HEADER, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
const [A,B,P,S,PERSON] = ['11111111','22222222','33333333','44444444','55555555'].map(prefix=>`${prefix}-1111-4111-8111-111111111111`);
const origin='https://tower.example.test';
function request(path,method='GET',body,workspace=A){return new Request(origin+path,{method,headers:{origin,
  'sec-fetch-site':'same-origin',[WORKSPACE_SELECTION_HEADER]:workspace,[WORKSPACE_SESSION_HEADER]:S,
  ...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});}
function fixture(){
  const calls=[],catalogReads=[],actorReads=[];let role='operator',active=true,epicsFail=false,actorsFail=false;
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
      if(kind==='show')return[{id:command.operation.taskId,title:'Task',status:'open',comment_count:1}];
      if(kind==='comments')return[{id:'comment',author:PERSON,text:'Actual comment',created_at:'2026-10-01T01:00:00Z'}];
      if(kind==='create')return{id:'tt-new'};
      return[];
    }}});
  return{handler,calls,catalogReads,actorReads,role:value=>{role=value;},active:value=>{active=value;},epicsFail:()=>{epicsFail=true;},actorsFail:()=>{actorsFail=true;}};
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
