import { describe, expect, it } from 'vitest';
import { CodebaseHistoryImport } from '../src/codebase-history.js';
import { comparableCodebaseTools } from '../src/codebase-instrument.js';
import { effectiveReleaseAnnotations, releaseAnnotationNote, releaseFromNote } from '../src/release-annotations.js';

const tools = { image: `example.com/measure@sha256:${'a'.repeat(64)}`, profile: 'b'.repeat(64), scc: '3', jscpd: '5', lizard: '1' };
const report = { asset: 'example.com', generatedAt: '2026-11-02T12:00:00Z', history: { effectiveAt: '2026-10-01T23:59:59Z', selectionRef: 'main' }, repository: { commit: 'a'.repeat(40), ref: 'main', committedAt: '2026-09-30T12:00:00Z' }, tools, measures: { code_lines: 50 } };
const release = (commit: string, sequence: number, extra = {}) => ({ source: 'releases.jsonl', sequence, id: String(sequence).repeat(64), commit, recordedAt: `2026-10-01T1${sequence}:00:00Z`, supersedes: [], ...extra });

describe('history import contract', () => {
  it('keeps effective, commit and measured timestamps distinct; requires pinned comparable instruments', () => {
    const bundle = { version: 1, asset: 'example.com', reports: [report], releases: [] };
    expect(CodebaseHistoryImport.safeParse(bundle).success).toBe(true);
    expect(CodebaseHistoryImport.safeParse({ ...bundle, reports: [{ ...report, asset: 'other.example' }] }).success).toBe(false);
    expect(CodebaseHistoryImport.safeParse({ ...bundle, reports: [{ ...report, history: undefined }] }).success).toBe(false);
    expect(CodebaseHistoryImport.safeParse({ ...bundle, reports: [{ ...report, tools: { ...tools, image: 'example.com/measure:main' } }] }).success).toBe(false);
    expect(CodebaseHistoryImport.safeParse({ ...bundle, reports: [{ ...report, history: { ...report.history, effectiveAt: '2027-01-01T00:00:00Z' } }] }).success).toBe(false);
    expect(comparableCodebaseTools(tools, { ...tools })).toBe(true);
    expect(comparableCodebaseTools(tools, { ...tools, profile: undefined })).toBe(false);
    expect(comparableCodebaseTools(tools, { ...tools, image: 'another' })).toBe(false);
  });

  it('collapses superseded attempts, same-commit retries, and existing deploy annotations without losing ordinary events', () => {
    const a = release('a'.repeat(40), 1);
    const b = release('b'.repeat(40), 2, { supersedes: [a.commit] });
    const retry = release(b.commit, 3);
    const items = [a, b, retry].map(row => ({ at: row.recordedAt, kind: 'external', ref: row.commit, note: releaseAnnotationNote(row) }));
    expect(releaseFromNote(items[0]!.note)).toEqual(a);
    expect(effectiveReleaseAnnotations(items)).toEqual([items[2]]);
    const deploy = { at: '2026-10-01T15:00:00Z', kind: 'deploy', ref: b.commit, note: 'Confirmed deploy' };
    expect(effectiveReleaseAnnotations([...items, deploy])).toEqual([deploy]);
    expect(releaseFromNote('ordinary note')).toBeNull();
  });
});
