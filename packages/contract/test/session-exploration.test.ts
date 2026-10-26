import { describe, expect, it } from 'vitest';
import { PulseEnvelope } from '../src/schema';
import { buildSessionExplorationSnapshot, explorationComparison, explorationDateOffset, explorationFacts, readSessionExplorationReport, readSessionExplorationReports, type SessionExplorationReport, type SessionReportReceipt } from '../src/session-exploration.mjs';
const now = new Date('2026-10-26T12:00:00Z');
function report(date = '2026-10-25'): SessionExplorationReport {
  return {schemaVersion:1, source:'first-party', journeyId:'explore', journeyVersion:1, definitionId:'sections-v1', date, timeZone:'UTC', sessionTimeoutMinutes:30, sessions:100,
    surfaces:[{id:'guides',label:'Guides'},{id:'recipes',label:'Recipes'}], paths:[{surfaces:['guides'],sessions:50,ending:'exit'},{surfaces:['guides','recipes','guides'],sessions:40,ending:'exit'},{surfaces:['recipes'],sessions:10,ending:'unknown'}]};
}
function receipt(r:SessionExplorationReport, receivedAt = '2026-10-26T01:00:00Z'): SessionReportReceipt {return {reports:[r],generatedAt:'2026-10-26T01:00:00Z',receivedAt};}
const envelope = (sessionExploration: unknown) => ({asset:'example.com',generatedAt:'2026-10-26T01:00:00Z',capabilities:[],metrics:{},sessionExploration});
describe('session aggregate contract', () => {
  it('accepts optional reports through the existing envelope without changing ordinary reports', () => {
    expect(PulseEnvelope.parse(envelope([report()])).sessionExploration).toEqual([report()]);
    const {sessionExploration: _, ...ordinary}=envelope([]); expect(PulseEnvelope.parse(ordinary)).toEqual(ordinary);
  });
  it('preserves repeated sections as positions within one mutually exclusive session path', () => {
    expect(readSessionExplorationReport(report())?.paths[1]).toEqual({surfaces:['guides','recipes','guides'],sessions:40,ending:'exit'});
  });
  it.each([
    {sessions:99}, {sessions:-1}, {sessions:1.5}, {sessions:Number.MAX_SAFE_INTEGER}, {date:'2026-02-30'}, {timeZone:'Unknown/Zone'}, {journeyVersion:0}, {source:'ga4'},
    {paths:[{surfaces:['missing'],sessions:1,ending:'exit'}]}, {paths:[{surfaces:[],sessions:1,ending:'exit'}]}, {paths:[{surfaces:['guides','guides'],sessions:1,ending:'exit'}]}, {paths:[{surfaces:['guides'],sessions:1,ending:'bounce'}]},
    {paths:[{surfaces:['guides'],sessions:1,ending:'exit',sessionId:'secret'}]}, {surfaces:[{id:'https://example.com?a=secret',label:'Guides'}]}, {rawEvents:[]},
  ])('rejects malformed, overcounted or raw data %j', change => {expect(PulseEnvelope.safeParse(envelope([{...report(),...change}])).success).toBe(false);});
  it('rejects duplicate buckets/days and bounds path depth/count/category count', () => {
    const r=report(); expect(readSessionExplorationReport({...r,paths:[r.paths[0],r.paths[0]]})).toBeNull();
    expect(readSessionExplorationReports([r,r])).toBeNull();
    expect(readSessionExplorationReport({...r,paths:[{surfaces:Array(9).fill('guides'),sessions:1,ending:'exit'}]})).toBeNull();
    expect(readSessionExplorationReport({...r,paths:Array(129).fill(r.paths[0])})).toBeNull();
    expect(readSessionExplorationReport({...r,surfaces:Array.from({length:33},(_,i)=>({id:`s${i}`,label:`Section ${i}`}))})).toBeNull();
  });
  it('closes local days after the inactivity timeout, including a DST boundary', () => {
    const r={...report('2026-11-01'),timeZone:'America/New_York'};
    expect(readSessionExplorationReports([r],'2026-11-02T05:29:59Z')).toBeNull();
    expect(readSessionExplorationReports([r],'2026-11-02T05:30:00Z')).toEqual([r]);
    expect(readSessionExplorationReports([report('2026-10-26')],now.toISOString())).toBeNull();
  });
});
describe('stored session history', () => {
  it('uses latest revisions, ignores repeated deliveries and keeps missing destinations separate from exits', () => {
    const old=report(), corrected={...old,sessions:120};
    const s=buildSessionExplorationSnapshot('explore',[receipt(old),receipt(corrected,'2026-10-26T02:00:00Z'),receipt(old,'2026-10-26T00:00:00Z')],now);
    expect(s.current7).toMatchObject({quality:'partial',sessions:120,observedSessions:100,coveredDays:1,expectedDays:7});
    expect(explorationFacts(s.current7)).toEqual({exploredSessions:40,unobservedSessions:20,uncertainSessions:30,exitSessions:90,explorationRate:1/3,exact:false});
    expect(s.prior7.sessions).toBeNull();
  });
  it('retains real zero-session days and full compatible weekly history', () => {
    const receipts=Array.from({length:56},(_,i)=>receipt({...report(explorationDateOffset('2026-08-31',i)),sessions:0,paths:[]}));
    const s=buildSessionExplorationSnapshot('explore',receipts,now);
    expect(s.current28).toMatchObject({quality:'complete',sessions:0,coveredDays:28});
    expect(s.weekly).toHaveLength(8);expect(s.weekly.every(p=>p.quality==='complete')).toBe(true);
    expect(explorationFacts(s.current7).explorationRate).toBeNull();
  });
  it.each([{definitionId:'sections-v2'},{timeZone:'Etc/GMT+1'},{sessionTimeoutMinutes:60}])('withholds mixed measurement definitions %j', change => {
    const s=buildSessionExplorationSnapshot('explore',[receipt(report('2026-10-24')),receipt({...report(),...change})],now);
    expect(s.current7.quality).toBe('unavailable'); expect(s.current7.sessions).toBeNull();
  });
  it('never converts unknown prefixes or truncated paths into exits', () => {
    const r={...report(),paths:[{surfaces:['guides'],sessions:100,ending:'continued' as const}]};
    const facts=explorationFacts(buildSessionExplorationSnapshot('explore',[receipt(r)],now).current7);
    expect(facts).toMatchObject({exploredSessions:0,uncertainSessions:100,exitSessions:0,exact:false});
  });
  it('compares only complete adjacent windows with matching semantics', () => {
    const receipts=Array.from({length:56},(_,i)=>receipt({...report(explorationDateOffset('2026-08-31',i)),paths:[{surfaces:['guides','recipes'],sessions:100,ending:'exit'}]}));
    const s=buildSessionExplorationSnapshot('explore',receipts,now);
    expect(explorationComparison(s.current28,s.prior28)).toBe(0);
    expect(explorationComparison(s.current28,{...s.prior28,definitionId:'other'})).toBeNull();
    expect(explorationComparison(s.current28,{...s.prior28,quality:'partial'})).toBeNull();
    expect(explorationComparison(s.current7,s.prior28)).toBeNull();
  });
  it('does not combine another journey or a future/unclosed day', () => {
    const s=buildSessionExplorationSnapshot('explore',[receipt({...report(),journeyId:'other'}),receipt(report('2026-10-26'))],now);
    expect(s.current7.sessions).toBeNull();
  });
});
