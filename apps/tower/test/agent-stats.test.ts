import { describe, expect, it } from 'vitest';
import { canonicalAgentModel, readAgentStats, type AgentStatsTask } from '@noticeos/contract/agent-stats';

const NOW = Date.parse('2026-10-15T12:00:00.000Z'), HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW - hours * HOUR).toISOString();
function task(id: string, model: string | null, over: Partial<AgentStatsTask> = {}): AgentStatsTask {
  return { id, status: 'closed', priority: 2, issueType: 'task', awaitType: null, assignee: 'random-worker',
    startedAt: at(4), closedAt: at(2), updatedAt: at(2), metadata: model ? { noticeos_claimed_model: model } : null, ...over };
}
const stats = (tasks: AgentStatsTask[]) => readAgentStats([{ project: 'example', tasks }], NOW);

describe('canonical model identities', () => {
  it.each([
    ['Opus 5.5', 'Claude Opus 5.5'], ['claude-opus-5-5-20261001', 'Claude Opus 5.5'],
    ['anthropic/claude-opus-5.5-thinking', 'Claude Opus 5.5'], ['Claude 3.5 Sonnet', 'Claude Sonnet 3.5'],
    ['GPT-6.1-Sol-xhigh', 'GPT-6.1 Sol'], ['openai/gpt-6.1-sol', 'GPT-6.1 Sol'],
    ['GPT-5.3-Codex', 'GPT-5.3 Codex'], ['gpt-5-3-codex-high', 'GPT-5.3 Codex'],
    ['models/gemini-2.5-flash-preview', 'Gemini 2.5 Flash'], ['o3-mini', 'o3 mini'],
    ['build-verifier', 'Other'], ['claude-session', 'Other'], [null, 'Other'],
  ])('groups %s as %s', (input, expected) => expect(canonicalAgentModel(input)).toBe(expected));

  it('retains different versions and model variants', () => {
    expect(canonicalAgentModel('Opus 5.5')).not.toBe(canonicalAgentModel('Opus 5.6'));
    expect(canonicalAgentModel('gpt-5.3')).not.toBe(canonicalAgentModel('gpt-5.3-codex'));
    expect(canonicalAgentModel('gemini-2.5-pro')).not.toBe(canonicalAgentModel('gemini-2.5-flash'));
  });
});

describe('aggregate agent statistics', () => {
  it('merges model aliases across random agents and projects, retaining all counts', () => {
    const work = readAgentStats([
      { project: 'first', tasks: [task('ex-a', 'Opus 5.5'), task('ex-b', 'GPT-6.1-Sol', { assignee: '/root' })] },
      { project: 'second', tasks: [task('ex-a', 'claude-opus-5-5', { assignee: 'claude/build-sponsor', priority: 0 })] },
    ], NOW);
    expect(work.workers.map(worker => [worker.name, worker.week])).toEqual([['Claude Opus 5.5', 2], ['GPT-6.1 Sol', 1]]);
    expect(work.race.players[0]).toMatchObject({ name: 'Claude Opus 5.5', points: 7, closes: [NOW - 2 * HOUR, NOW - 2 * HOUR] });
    expect(work.week).toBe(3);
  });

  it('omits inactive rows and all-zero assigned work, retaining historical velocity', () => {
    const work = stats([
      task('ex-old', 'Opus 5.5', { startedAt: at(810), closedAt: at(800) }),
      task('ex-open', null, { status: 'open', closedAt: null }),
      task('ex-deferred', 'GPT-6.1-Sol', { status: 'deferred', closedAt: null }),
      task('ex-working', 'Sonnet 5.5', { status: 'in_progress', closedAt: null }),
      task('ex-blocked', null, { status: 'blocked', closedAt: null }),
    ]);
    expect(work.workers.map(worker => worker.name)).toEqual(['Claude Sonnet 5.5', 'Other']);
    expect([work.week, work.inHand, work.blocked]).toEqual([0, 1, 1]);
    expect(work.race.players).toEqual([]);
    expect(work.velocity.weeks.reduce((sum, week) => sum + week.total, 0)).toBe(1);
  });

  it('groups every unknown identity under Other without losing anonymous closes', () => {
    const work = stats([task('ex-a', null), task('ex-b', 'Verifier 1', { assignee: 'Astra' }), task('ex-c', null, { assignee: null })]);
    expect(work.workers).toHaveLength(1);
    expect(work.workers[0]).toMatchObject({ name: 'Other', week: 3 });
    expect(work.race.players).toHaveLength(1);
    expect(work.velocity.names['']).toBe('Other');
    expect(work.trophies).toEqual([]);
    expect(work.week).toBe(3);
  });

  it('uses valid close attribution, falls back to the claim, and computes a task-weighted median', () => {
    const work = stats([
      task('ex-a', 'Opus 5.5', { metadata: { noticeos_claimed_model: 'Opus 5.5', noticeos_closed_model: 'GPT-6.1-Sol', noticeos_closed_by: 'closer', noticeos_closed_at: at(2) } }),
      task('ex-b', 'Opus 5.5', { startedAt: at(12) }),
      task('ex-c', 'Opus 5.5', { startedAt: at(13), metadata: { noticeos_claimed_model: 'Opus 5.5', noticeos_closed_model: 'GPT-6.1-Sol', noticeos_closed_by: 'old closer', noticeos_closed_at: at(200) } }),
      task('ex-d', 'Opus 5.5', { startedAt: at(14) }),
    ]);
    expect(work.workers.find(worker => worker.name === 'GPT-6.1 Sol')?.week).toBe(1);
    expect(work.workers.find(worker => worker.name === 'Claude Opus 5.5')?.week).toBe(3);
    expect(work.medianHours).toBe(10.5);
  });

  it('excludes gates, epics, invalid/future/out-of-history closes and invalid durations', () => {
    const work = stats([
      task('ex-epic', 'Opus 5.5', { issueType: 'epic' }), task('ex-gate', 'Opus 5.5', { issueType: 'gate' }),
      task('ex-await', 'Opus 5.5', { awaitType: 'human' }), task('ex-future', 'Opus 5.5', { closedAt: at(-1) }),
      task('ex-invalid', 'Opus 5.5', { closedAt: 'invalid' }), task('ex-old', 'Opus 5.5', { closedAt: at(56 * 24 + 1) }),
      task('ex-negative', 'Opus 5.5', { startedAt: at(1) }),
    ]);
    expect(work.week).toBe(1);
    expect(work.medianHours).toBeNull();
  });

  it('uses disjoint seven-day windows and never counts a future claim as a close', () => {
    const work = stats([task('ex-boundary', 'Opus 5.5', { closedAt: at(7 * 24) }), task('ex-previous', 'Opus 5.5', { closedAt: at(14 * 24) }), task('ex-now', 'Opus 5.5', { closedAt: at(0) })]);
    expect([work.week, work.lastWeek]).toEqual([1, 1]);
    expect(work.race.players[0]?.closes).toHaveLength(work.week);
  });

  it('lets the newest state win over an overlapping closed read', () => {
    const closed = task('ex-a', 'Opus 5.5'), reopened = { ...closed, status: 'open', updatedAt: at(1) };
    for (const tasks of [[closed, reopened], [reopened, closed]]) expect(stats(tasks).week).toBe(0);
  });

  it('returns aggregate-only payloads even for a large history', () => {
    const work = stats(Array.from({ length: 2000 }, (_, i) => task(`ex-${i}`, 'Opus 5.5')));
    const wire = JSON.stringify(work);
    expect(work.week).toBe(2000);
    for (const field of ['metadata', 'assignee', 'startedAt', 'description', 'ex-1999', 'random-worker']) expect(wire).not.toContain(field);
    expect(work.workers).toHaveLength(1);
  });
});
