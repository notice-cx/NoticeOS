import { describe, expect, it } from 'vitest';
import { readTaskCard, scoreTaskCard, TASK_CARD_LIMITS, TASK_CARD_POLICY, taskCardOf, taskCardProblem } from '../src/task-card.mjs';
import { isTaskChangeClass, readTaskChangeClass, TASK_CHANGE_CLASS_LABELS, TASK_CHANGE_CLASSES } from '../src/task-change-class.mjs';
import { SERVER_TASK_METADATA, TASK_METADATA } from '../src/task-metadata.mjs';

const CARD = {
  valuePerMonth: 1100,
  likelihood: 0.7,
  reviewMinutes: 10,
  buildMinutes: 120,
  daysToSignal: 14,
  measurability: 'holdout',
  revenueFamily: 'ads',
  durability: 0.8,
  kill: { state: 'Sessions still under baseline', date: '2026-11-11' },
  note: 'Sessions fell 25% after the redesign; ad revenue follows sessions.',
  by: 'codex',
  at: '2026-10-14T09:00:00Z',
};

describe('a task carries why it is worth doing as a card', () => {
  it('accepts the documented fields and stores them plainly, with no absent field present', () => {
    expect(taskCardProblem(CARD)).toBeNull();
    expect(taskCardOf(CARD)).toEqual(CARD);
    const least = { valuePerMonth: -40, likelihood: 0.5, reviewMinutes: 0, daysToSignal: 30, measurability: 'unmeasured' };
    expect(taskCardProblem(least)).toBeNull();
    expect(Object.keys(taskCardOf(least)!)).toEqual(['valuePerMonth', 'likelihood', 'reviewMinutes', 'daysToSignal', 'measurability']);
  });

  it('names the field at fault for a card it refuses', () => {
    const problem = (value: unknown) => taskCardProblem(value)?.field;
    expect(problem(null)).toBe('card');
    expect(problem({ ...CARD, extra: 1 })).toBe('card.extra');
    expect(problem({ ...CARD, valuePerMonth: '1100' })).toBe('card.valuePerMonth');
    expect(problem({ ...CARD, likelihood: 1 })).toBe('card.likelihood');
    expect(problem({ ...CARD, likelihood: 0 })).toBe('card.likelihood');
    expect(problem({ ...CARD, reviewMinutes: -1 })).toBe('card.reviewMinutes');
    expect(problem({ ...CARD, daysToSignal: 2.5 })).toBe('card.daysToSignal');
    expect(problem({ ...CARD, daysToSignal: 0 })).toBe('card.daysToSignal');
    expect(problem({ ...CARD, measurability: 'guess' })).toBe('card.measurability');
    expect(problem({ ...CARD, revenueFamily: 'tips' })).toBe('card.revenueFamily');
    expect(problem({ ...CARD, durability: 2 })).toBe('card.durability');
    expect(problem({ ...CARD, kill: { state: 'x' } })).toBe('card.kill.date');
    expect(problem({ ...CARD, kill: { state: 'x', date: '2026-02-30' } })).toBe('card.kill.date');
    expect(problem({ ...CARD, kill: { state: ' ', date: '2026-11-11' } })).toBe('card.kill.state');
    expect(problem({ ...CARD, kill: { state: 'x', date: '2026-11-11', why: 1 } })).toBe('card.kill.why');
    expect(problem({ ...CARD, note: 'a'.repeat(TASK_CARD_LIMITS.note + 1) })).toBe('card.note');
    expect(problem({ ...CARD, note: 'two\nlines' })).toBe('card.note');
    expect(problem({ ...CARD, at: 'yesterday' })).toBe('card.at');
    expect(taskCardOf({ ...CARD, likelihood: 1 })).toBeNull();
  });

  it('reads a card from a task\'s metadata and answers null for anything else', () => {
    expect(readTaskCard({ [TASK_METADATA.card.name]: CARD })).toEqual(CARD);
    expect(readTaskCard({ [TASK_METADATA.card.name]: { ...CARD, likelihood: 'high' } })).toBeNull();
    expect(readTaskCard({})).toBeNull();
    expect(readTaskCard(null)).toBeNull();
    expect(readTaskCard('card')).toBeNull();
  });

  it('is written by whoever files the task, so it is not a server-only key', () => {
    expect(SERVER_TASK_METADATA).not.toContain(TASK_METADATA.card.name);
    expect(SERVER_TASK_METADATA).not.toContain(TASK_METADATA.changeClass.name);
  });
});

describe('policy v1.0 scores a card', () => {
  it('divides the expected monthly change by the review cost and the horizon in weeks', () => {
    const scored = scoreTaskCard(taskCardOf(CARD)!, { operatorRateUsdPerMin: 2 });
    // 0.7 × 1100 × 0.8 = 616 a month; 10 min × $2 = $20; 14 days = 2 weeks.
    expect(scored.expectedPerMonth).toBeCloseTo(616);
    expect(scored.costUsd).toBe(20);
    expect(scored.horizonWeeks).toBe(2);
    expect(scored.score).toBeCloseTo(616 / 20 / 2);
    expect(scored.policy).toBe(TASK_CARD_POLICY);
  });

  it('never discounts by less than two weeks, and never divides by a free review', () => {
    const quick = taskCardOf({ ...CARD, daysToSignal: 3, reviewMinutes: 0 })!;
    const scored = scoreTaskCard(quick, { operatorRateUsdPerMin: 0 });
    expect(scored.horizonWeeks).toBe(TASK_CARD_LIMITS.horizonFloorWeeks);
    expect(scored.costUsd).toBe(0.01);
    expect(Number.isFinite(scored.score)).toBe(true);
    const slow = scoreTaskCard(taskCardOf({ ...CARD, daysToSignal: 70 })!, { operatorRateUsdPerMin: 2 });
    expect(slow.horizonWeeks).toBe(10);
    expect(slow.score).toBeLessThan(scoreTaskCard(taskCardOf(CARD)!, { operatorRateUsdPerMin: 2 }).score);
  });

  it('ranks a durable gain above a search-dependent one with the same expected value', () => {
    const durable = scoreTaskCard(taskCardOf({ ...CARD, durability: 1.2 })!, { operatorRateUsdPerMin: 2 });
    const fragile = scoreTaskCard(taskCardOf({ ...CARD, durability: 0.5 })!, { operatorRateUsdPerMin: 2 });
    expect(durable.score).toBeGreaterThan(fragile.score);
  });
});

describe('a task carries the kind of change it makes', () => {
  it('knows the five classes of the autonomy ladder and their words on screen', () => {
    expect(TASK_CHANGE_CLASSES).toEqual(['content-data', 'copy', 'template', 'feature', 'infra']);
    expect(TASK_CHANGE_CLASS_LABELS.infra).toBe('Infrastructure');
    expect(isTaskChangeClass('template')).toBe(true);
    expect(isTaskChangeClass('design')).toBe(false);
  });

  it('reads the class from metadata and answers null for anything else', () => {
    expect(readTaskChangeClass({ [TASK_METADATA.changeClass.name]: 'copy' })).toBe('copy');
    expect(readTaskChangeClass({ [TASK_METADATA.changeClass.name]: 'other' })).toBeNull();
    expect(readTaskChangeClass(null)).toBeNull();
  });
});
