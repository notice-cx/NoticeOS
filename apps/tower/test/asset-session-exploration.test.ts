// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { JourneyDefinition } from '@noticeos/contract/journeys';
import { explorationDateOffset, type SessionExplorationReport } from '@noticeos/contract/session-exploration';
import { readAssetSessionExploration } from '../worker/asset-session-exploration';
import { createTestStore } from './postgres-store';
import { addSites } from './sites';
import { storeReport, storeReports } from './alert-rows';
const now=new Date('2026-10-26T12:00:00Z');
const definition:JourneyDefinition={id:'explore',label:'Exploration',goal:'Explore sections',kind:'exploration',status:'active',version:1,steps:[{id:'entry',label:'Entry',alternatives:[{eventName:'page_view'}]},{id:'next',label:'Next section',alternatives:[{eventName:'page_view'}]}]};
function report(date='2026-10-25'):SessionExplorationReport{return {schemaVersion:1,source:'first-party',journeyId:'explore',journeyVersion:1,definitionId:'sections-v1',date,timeZone:'UTC',sessionTimeoutMinutes:30,sessions:100,surfaces:[{id:'guides',label:'Guides'},{id:'recipes',label:'Recipes'}],paths:[{surfaces:['guides'],sessions:60,ending:'exit'},{surfaces:['guides','recipes','guides'],sessions:40,ending:'exit'}]};}
const row=(date:string, reports:unknown, revision=1)=>({asset:'example.com',date,revision,generatedAt:`${date}T01:00:00Z`,receivedAt:`${date}T0${revision}:00:00Z`,envelope:{asset:'example.com',generatedAt:`${date}T01:00:00Z`,capabilities:[],metrics:{},...(reports===undefined?{}:{sessionExploration:reports})}});
describe('asset stored session exploration',()=>{
 it('reads complete session periods, correction revisions and reports omitted from a later envelope',async()=>{
   const f=await createTestStore();await addSites(f,[{id:'example.com',displayName:'Example',status:'live'},{id:'other.example',displayName:'Other',status:'live'}]);
   await storeReports(f.call,Array.from({length:7},(_,i)=>{const date=explorationDateOffset('2026-10-20',i);return row(date,[report(explorationDateOffset(date,-1))]);}));
   await storeReport(f.call,row('2026-10-26',[{...report(),sessions:120,paths:[{surfaces:['recipes'],sessions:120,ending:'exit'}]}],2));
   await storeReport(f.call,row('2026-10-26',undefined,3));
   await storeReport(f.call,{...row('2026-10-26',[{...report(),sessions:999}]),asset:'other.example'});
   const [s]=await readAssetSessionExploration(f.call,'example.com',[definition],now);
   expect(s?.current7).toMatchObject({quality:'complete',coveredDays:7,sessions:720,observedSessions:720});
   expect(s?.current7.paths.find(p=>p.surfaces.length===3)?.sessions).toBe(240);
   expect(s?.prior7.sessions).toBeNull();
   const [changed]=await readAssetSessionExploration(f.call,'example.com',[{...definition,version:2}],now);
   expect(changed?.current7.sessions).toBeNull();
 });
 it('retains recent days for all eight journeys across the eastern local-day boundary',async()=>{
   const f=await createTestStore();await addSites(f,[{id:'example.com',displayName:'Example',status:'live'}]);
   const defs=Array.from({length:8},(_,i)=>({...definition,id:`explore${i}`}));
   const rows=Array.from({length:65},(_,i)=>{
     const date=explorationDateOffset('2026-08-23',i), generatedAt=`${date}T11:00:00Z`;
     return {asset:'example.com',date:generatedAt.slice(0,10),generatedAt,receivedAt:generatedAt,envelope:{sessionExploration:defs.map(d=>({...report(date),journeyId:d.id,timeZone:'Pacific/Kiritimati'}))}};
   });
   await storeReports(f.call,rows);
   const snapshots=await readAssetSessionExploration(f.call,'example.com',defs,now);
   expect(snapshots).toHaveLength(8);
   for(const s of snapshots) expect(s.current7).toMatchObject({sessions:700,quality:'complete',endDate:'2026-10-26'});
 });
 it('leaves malformed historical reports unavailable rather than falling back to stale counts',async()=>{
   const f=await createTestStore();await addSites(f,[{id:'example.com',displayName:'Example',status:'live'}]);
   await storeReport(f.call,row('2026-10-26',[report()]));
   await storeReport(f.call,row('2026-10-26',[{...report(),sessions:-1}],2));
   const [s]=await readAssetSessionExploration(f.call,'example.com',[definition],now);
   expect(s?.current7.sessions).toBeNull();
   expect(await readAssetSessionExploration(f.call,'example.com',[],now)).toEqual([]);
 });
});
