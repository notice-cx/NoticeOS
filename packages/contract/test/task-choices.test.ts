import { describe, expect, it } from 'vitest';
import { choiceName, readTaskChoice, readTaskChoices, TASK_CHOICE_LIMITS, taskChoicesOf, taskChoicesProblem } from '../src/task-choices.mjs';
import { SERVER_TASK_METADATA, TASK_METADATA } from '../src/task-metadata.mjs';

const THREE = {
  question: 'Which page keeps the traffic?',
  options: [
    { key: 'a', label: 'Keep the old page', detail: 'Nothing moves.' },
    { key: 'b', label: 'Redirect to the new page', recommended: true },
    { key: 'c', label: 'Keep both', recommended: false },
  ],
};

describe('a task carries its choices as data', () => {
  it('accepts a question with two to six options keyed in order and one recommended, and stores it plainly', () => {
    expect(taskChoicesProblem(THREE)).toBeNull();
    expect(taskChoicesOf(THREE)).toEqual({ question: THREE.question, options: [
      { key: 'a', label: 'Keep the old page', detail: 'Nothing moves.' },
      { key: 'b', label: 'Redirect to the new page', recommended: true },
      { key: 'c', label: 'Keep both' },
    ] });
    const six = { question: 'Pick one', options: 'abcdef'.split('').map((key, index) => ({ key, label: `Option ${key}`, ...(index === 5 ? { recommended: true } : {}) })) };
    expect(taskChoicesProblem(six)).toBeNull();
  });

  it('names the field at fault for a set it refuses', () => {
    const problem = (value: unknown) => taskChoicesProblem(value)?.field;
    expect(problem(null)).toBe('choices');
    expect(problem({ ...THREE, extra: 1 })).toBe('choices.extra');
    expect(problem({ ...THREE, question: ' ' })).toBe('choices.question');
    expect(problem({ ...THREE, question: 'x'.repeat(TASK_CHOICE_LIMITS.question + 1) })).toBe('choices.question');
    expect(problem({ question: 'One?', options: [{ key: 'a', label: 'Only', recommended: true }] })).toBe('choices.options');
    expect(problem({ question: 'Seven?', options: 'abcdefg'.split('').map(key => ({ key, label: key, recommended: key === 'a' })) })).toBe('choices.options');
    expect(taskChoicesProblem({ ...THREE, options: THREE.options.map(option => ({ ...option, recommended: true })) }))
      .toEqual({ field: 'choices.options', rule: 'exactly one option with recommended: true; these have 3' });
    expect(problem({ ...THREE, options: THREE.options.map(({ recommended: _r, ...option }) => option) })).toBe('choices.options');
    expect(taskChoicesProblem({ ...THREE, options: [THREE.options[0], { ...THREE.options[1], key: 'z' }, THREE.options[2]] }))
      .toEqual({ field: 'choices.options[1].key', rule: 'b: keys run a, b, c… in the order the options are shown' });
    expect(problem({ ...THREE, options: [THREE.options[1], THREE.options[0], THREE.options[2]] })).toBe('choices.options[0].key');
    expect(problem({ ...THREE, options: [{ ...THREE.options[0], label: 'Two\nlines' }, THREE.options[1], THREE.options[2]] })).toBe('choices.options[0].label');
    expect(problem({ ...THREE, options: [{ ...THREE.options[0], label: 'x'.repeat(TASK_CHOICE_LIMITS.label + 1) }, THREE.options[1], THREE.options[2]] }))
      .toBe('choices.options[0].label');
    expect(problem({ ...THREE, options: [{ ...THREE.options[0], detail: '' }, THREE.options[1], THREE.options[2]] })).toBe('choices.options[0].detail');
    expect(problem({ ...THREE, options: [{ ...THREE.options[0], colour: 'red' }, THREE.options[1], THREE.options[2]] })).toBe('choices.options[0].colour');
    expect(problem({ ...THREE, options: [{ ...THREE.options[0], recommended: 'yes' }, THREE.options[1], THREE.options[2]] })).toBe('choices.options[0].recommended');
  });

  it('reads a task\'s choices and its pick from metadata, and nothing else', () => {
    const metadata = { noticeos_choices: THREE, noticeos_choice: { option: 'b', label: 'Redirect to the new page', by: 'person', at: '2026-10-16T12:00:00Z' } };
    expect(readTaskChoices(metadata)?.options.map(option => option.key)).toEqual(['a', 'b', 'c']);
    expect(readTaskChoice(metadata)).toEqual({ option: 'b', label: 'Redirect to the new page', by: 'person', at: '2026-10-16T12:00:00Z' });
    expect(readTaskChoice({ noticeos_choice: { ...metadata.noticeos_choice, note: 'Ship it Friday' } })?.note).toBe('Ship it Friday');
    for (const broken of [null, [], { noticeos_choices: 'a,b' }, { noticeos_choices: { question: 'One?', options: [] } }]) {
      expect(readTaskChoices(broken)).toBeNull();
    }
    for (const broken of [{ noticeos_choice: { option: 'g', label: 'x', by: 'p', at: '2026-10-16' } },
      { noticeos_choice: { option: 'a', label: 'x', by: '', at: '2026-10-16' } },
      { noticeos_choice: { option: 'a', label: 'x', by: 'p', at: 'soon' } }]) expect(readTaskChoice(broken)).toBeNull();
    expect(choiceName('b', 'Redirect to the new page')).toBe('(b) Redirect to the new page');
  });

  it('keeps both keys out of a caller\'s metadata: only the server writes them', () => {
    expect(TASK_METADATA.choices.name).toBe('noticeos_choices');
    expect(TASK_METADATA.choice.name).toBe('noticeos_choice');
    expect(SERVER_TASK_METADATA).toEqual(expect.arrayContaining(['noticeos_choices', 'noticeos_choice']));
  });
});
