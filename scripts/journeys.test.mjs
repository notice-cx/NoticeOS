import assert from 'node:assert/strict';
import test from 'node:test';
import { journeyDefinitionId, journeyDefinitionsRefusal, readJourneyPeriod, readJourneySnapshot } from '../packages/contract/src/journeys.mjs';
import { archiveFamily, archiveRows } from './signal-archive.mjs';
import { buildExecutiveSnapshot, journeysSnapshot } from './signal-insights.mjs';

const definition = { id: 'activation', label: 'Activation', goal: 'First useful action', kind: 'funnel', status: 'active', version: 1, steps: [
  { id: 'account', label: 'Account created', alternatives: [{ eventName: 'sign_up' }] },
  { id: 'saved', label: 'Plan saved', alternatives: [{ eventName: 'plan_save', parameters: [{name:'action',value:'save'}] }], withinSeconds: 86400 },
] };
const period = (kind='current7', startDate='2026-10-12', endDate='2026-10-18', users=[100,40]) => ({kind,startDate,endDate,complete:true,quality:'complete',steps:definition.steps.map((step,index) => ({id:step.id,users:users[index]}))});
const archive = (p, fields={}) => ({ schemaVersion:1,asset:'example.com',integration:'ga4',report:'journeys-hash',reportDate:p.endDate,collectedAt:'2026-10-20T00:00:00Z',providerTruncated:false,dataState:'provider-snapshot', pages:[{request:{},response:{journeyId:definition.id,definitionId:journeyDefinitionId(definition),definition,propertyId:'123',timeZone:'UTC',identity:'ga4-active-users',period:{kind:p.kind,startDate:p.startDate,endDate:p.endDate,complete:true},quality:p.quality,steps:p.steps,...fields}}] });
const config = {assets:{'example.com':{journeys:[definition]}}};
const families = (archives) => new Map([['ga4-journeys',archives.flatMap((a) => archiveRows(a,new Map()))]]);

test('definitions validate bounded exact alternatives and identity excludes display copy', () => {
  assert.equal(journeyDefinitionsRefusal([definition]),null);
  assert.equal(journeyDefinitionId({...definition,label:'New label',goal:'Other goal'}),journeyDefinitionId(definition));
  assert.notEqual(journeyDefinitionId({...definition,version:2}),journeyDefinitionId(definition));
  assert.notEqual(journeyDefinitionsRefusal([definition,definition]),null);
  assert.notEqual(journeyDefinitionsRefusal([{...definition,steps:[{...definition.steps[0],withinSeconds:5},definition.steps[1]]}]),null);
});

test('period reader rejects invented dates, increasing counts and unreviewed fields', () => {
  assert.equal(readJourneyPeriod(period('current7','2026-02-24','2026-02-30')),null);
  assert.equal(readJourneyPeriod(period('current7',undefined,undefined,[40,100])),null);
  assert.equal(readJourneyPeriod({...period(),secret:'unexpected'}),null);
  assert.equal(readJourneyPeriod({...period(),quality:'sampled'}),null);
  assert.equal(readJourneyPeriod({...period(),quality:'unavailable'}),null);
});

test('archive periods survive normalization and direct windows never add weekly uniques', () => {
  const a = archive(period());
  assert.equal(archiveFamily(a),'ga4-journeys');
  const snapshot = journeysSnapshot(families([a,archive(period('week')),archive(period('prior7','2026-10-05','2026-10-11',[80,30]))]),'example.com',config,'2026-10-20T01:00:00Z');
  assert.equal(snapshot.funnels[0].current7.steps[0].users,100);
  assert.equal(snapshot.funnels[0].prior7.steps[0].users,80);
  assert.equal(snapshot.funnels[0].current28,null);
  assert.equal(snapshot.funnels[0].weekly.length,1);
  assert.equal(readJourneySnapshot({...snapshot,unreviewed:true}),null);
  assert.equal(readJourneySnapshot({...snapshot,funnels:[snapshot.funnels[0],snapshot.funnels[0]]}),null);
});

test('changed measurement definitions and incompatible property periods never compare', () => {
  const a=archive(period());
  const other=archive(period('prior7','2026-10-05','2026-10-11'),{propertyId:'456'});
  other.collectedAt='2026-10-19T00:00:00Z';
  const snapshot=journeysSnapshot(families([a,other]),'example.com',config,'2026-10-20T01:00:00Z');
  assert.equal(snapshot.funnels[0].prior7,null);
  const changed=structuredClone(config);changed.assets['example.com'].journeys[0].version=2;
  assert.equal(journeysSnapshot(families([a]),'example.com',changed,'2026-10-20T01:00:00Z').funnels.length,0);
});


test('stale rolling archives retain dated history but cannot pose as a current period', () => {
  const snapshot=journeysSnapshot(families([archive(period()),archive(period('week'))]),'example.com',config,'2026-10-23T01:00:00Z');
  assert.equal(snapshot.funnels[0].current7,null);
  assert.equal(snapshot.funnels[0].prior7,null);
  assert.equal(snapshot.funnels[0].weekly.length,1);
});


test('assets without journey declarations retain their existing executive snapshot shape', () => {
  const snapshot=buildExecutiveSnapshot({asset:'example.com',families:new Map(),archives:[],generatedAt:'2026-10-20T01:00:00Z'});
  assert.equal(Object.hasOwn(snapshot,'journeys'),false);
  const declared=buildExecutiveSnapshot({asset:'example.com',families:new Map(),archives:[],valueEvents:config,generatedAt:'2026-10-20T01:00:00Z'});
  assert.equal(declared.journeys.definitions.length,1);
});


test('visitor population remains optional and survives archives without changing funnel identity', () => {
  const visitors = {users:500,quality:'complete'};
  const snapshot = journeysSnapshot(families([archive(period(),{visitors})]),'example.com',config,'2026-10-20T01:00:00Z');
  assert.deepEqual(snapshot.funnels[0].current7.visitors,visitors);
  assert.equal(snapshot.funnels[0].definitionId,journeyDefinitionId(definition));
  assert.ok(readJourneyPeriod({...period(),visitors}));
  assert.ok(readJourneyPeriod({...period(),visitors:{users:null,quality:'unavailable',reason:'Provider unavailable'}}));
  for (const visitors of [{users:50,quality:'complete'},{users:null,quality:'complete'},
    {users:500,quality:'unavailable'},{users:-1,quality:'complete'},{users:500,quality:'complete',extra:true}]) {
    assert.equal(readJourneyPeriod({...period(),visitors}),null);
  }
});


test('first-party exploration has no invented GA4 steps and preserves legacy definitions', () => {
  const exploration = { id: 'section-exploration', label: 'Section exploration', goal: 'First-party session paths between site sections', kind: 'exploration', source: 'first-party', status: 'planned', version: 1, steps: [] };
  assert.equal(journeyDefinitionsRefusal([exploration]), null);
  assert.equal(journeyDefinitionsRefusal([{ ...definition, kind: 'exploration' }]), null);
  assert.notEqual(journeyDefinitionsRefusal([{ ...exploration, source: undefined }]), null);
  assert.notEqual(journeyDefinitionsRefusal([{ ...exploration, kind: 'funnel' }]), null);
  assert.notEqual(journeyDefinitionsRefusal([{ ...exploration, source: 'ga4' }]), null);
  assert.notEqual(journeyDefinitionsRefusal([{ ...exploration, steps: definition.steps }]), null);
  assert.notEqual(journeyDefinitionId(exploration), journeyDefinitionId({ ...exploration, source: undefined }));
  assert.equal(journeyDefinitionId(exploration), journeyDefinitionId({ ...exploration, label: 'Renamed', goal: 'Other goal' }));
});


test('only first-party exploration may declare a bounded reporting delay', () => {
  const exploration = { id: 'sections', label: 'Sections', goal: 'Section paths', kind: 'exploration', source: 'first-party', status: 'planned', version: 1, steps: [] };
  for (const reportingLagDays of [1, 2, 14]) assert.equal(journeyDefinitionsRefusal([{ ...exploration, reportingLagDays }]), null);
  for (const reportingLagDays of [0, 15, 1.5, '2', null]) assert.notEqual(journeyDefinitionsRefusal([{ ...exploration, reportingLagDays }]), null);
  assert.notEqual(journeyDefinitionsRefusal([{ ...definition, reportingLagDays: 2 }]), null);
  assert.notEqual(journeyDefinitionId(exploration), journeyDefinitionId({ ...exploration, reportingLagDays: 2 }));
});
