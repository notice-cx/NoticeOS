import { describe, expect, it } from 'vitest';
// A copy of Ntasks's spec/naming.json: the examples every implementation of the rule must pass.
import naming from './naming.json' with { type: 'json' };
import { actorIdentity, actorKey, modelIdentity } from '../src/actor-names.mjs';

describe('actorIdentity', () => {
  it.each(naming.actors)('gives every actor in naming.json its kind and display name: $actor', (example) => {
    expect(actorIdentity(example.actor)).toEqual({ id: example.actor, kind: example.kind, name: example.name });
  });

  it('keys an agent and a person of the same name apart, and every spelling of one agent together', () => {
    expect(actorKey('agent:Claude Code (ntasks)')).toBe(actorKey('claude/fable-lead'));
    expect(actorKey('service:demo/claude')).toBe(actorKey('claude'));
    expect(actorKey('person:Claude Code')).not.toBe(actorKey('agent:Claude Code'));
    expect(actorKey('agent:Claude')).not.toBe(actorKey('agent:Claude Code'));
  });

  it.each(naming.actors)('keys $actor so that its key reads back as the same key', ({ actor }) => {
    expect(actorKey(actorKey(actor))).toBe(actorKey(actor));
  });
});

describe('modelIdentity', () => {
  it.each(naming.models)('gives every model in naming.json its id and display name: $model', (example) => {
    expect(modelIdentity(example.model)).toEqual(
      example.name === null ? null : { id: example.id, name: example.name },
    );
  });
});
