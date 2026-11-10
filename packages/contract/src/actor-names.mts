// A copy of the display-name rule in Ntasks's packages/domain/src/actors.ts; it must pass Ntasks's spec/naming.json.

export const ACTOR_KINDS = ['person', 'agent', 'service', 'visitor'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Who an actor is: the actor string as recorded, its kind, and the name a reader is shown. */
export interface ActorIdentity {
  readonly id: string;
  readonly kind: ActorKind;
  readonly name: string;
}

type Names = readonly (readonly [RegExp, string])[];

/** The names an agent's client registers under, each shown as its product. */
const PRODUCTS: Names = [
  [/^claude[ _-]?code$/iu, 'Claude Code'],
  [/^codex(?:[ _-](?:cli|mcp(?:[ _-]client)?))?$/iu, 'Codex'],
  [/^claude(?:\.ai)?$/iu, 'Claude'],
];
/**
 * The bare names the old task hub recorded for the agents that wrote to it,
 * which services acting for an agent still use. They only ever make a name
 * an agent's, never the reverse, so no agent can be shown as a person.
 */
const IMPORTED_AGENTS: Names = [
  [/^claude(?:$|[/-]|\s+code$)/iu, 'Claude Code'],
  [/^claude\s+(?:opus|sonnet|haiku|fable)\b/iu, 'Claude Code'],
  [/^(?:lane-.+|lead)$/iu, 'Claude Code'],
  [/^(?:codex(?:$|[/-])|\/root$)/iu, 'Codex'],
];
const IMPORTED_SERVICES: Names = [[/^beads$/iu, 'Old task hub']];

/** The label a client adds to the name it registers, such as the ` (ntasks)` in `Claude Code (ntasks)`. */
const CLIENT_SUFFIX = /\s+\([^()]*\)$/u;

function lookUp(name: string, ...tables: readonly Names[]): string | null {
  for (const table of tables) {
    const found = table.find(([pattern]) => pattern.test(name));
    if (found) return found[1];
  }
  return null;
}

/**
 * The kind of sender an actor is and the name to show it by. The prefix
 * names the kind. An agent is shown by its product, without the label its
 * client adds; a service acting for an agent as that agent; and a bare name
 * the old task hub recorded for an agent as that agent. Every other name is
 * shown as recorded.
 */
export function actorIdentity(actor: string): ActorIdentity {
  const prefixed = /^(agent|service|person|visitor):(.+)$/su.exec(actor);
  const prefix = prefixed?.[1];
  const rest = prefixed?.[2] ?? actor;
  if (prefix === 'agent') {
    const registered = rest.replace(CLIENT_SUFFIX, '') || rest;
    return { id: actor, kind: 'agent', name: lookUp(registered, PRODUCTS, IMPORTED_AGENTS) ?? registered };
  }
  if (prefix === 'service') {
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return { id: actor, kind: 'service', name: rest };
    const agent = rest.slice(slash + 1);
    return { id: actor, kind: 'agent', name: lookUp(agent, IMPORTED_AGENTS, PRODUCTS) ?? agent };
  }
  if (prefix === 'person' || prefix === 'visitor') return { id: actor, kind: prefix, name: rest };
  const agent = lookUp(actor, IMPORTED_AGENTS);
  if (agent !== null) return { id: actor, kind: 'agent', name: agent };
  const service = lookUp(actor, IMPORTED_SERVICES);
  if (service !== null) return { id: actor, kind: 'service', name: service };
  return { id: actor, kind: 'person', name: actor };
}

/** One key per sender a reader sees: actors shown as the same kind and name share it. */
export function actorKey(actor: string): string {
  const { kind, name } = actorIdentity(actor);
  return `${kind}:${name}`;
}

/** A model an agent named: the id it is grouped by, null when no rule knows it, and the name a reader is shown. */
export interface ModelIdentity {
  readonly id: string | null;
  readonly name: string;
}

const capital = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
const version = (major: string, minor: string | undefined, separator: string): string =>
  minor === undefined ? major : `${major}${separator}${minor}`;

/**
 * The model an agent named, as one id and one name: a transport prefix, a
 * date, an effort level and spelling go, while versions and variants stay
 * apart. `Opus 5.5`, `claude-opus-5.5` and `Claude Opus 5.5` are all
 * `claude-opus-5-5`, shown as Claude Opus 5.5. Null when it named none. A
 * model no rule knows has no id and keeps the words it was given.
 */
export function modelIdentity(value: string | null | undefined): ModelIdentity | null {
  const given = value?.trim() ?? '';
  if (given === '') return null;
  const name = given
    .toLowerCase()
    .replace(/^(?:anthropic|openai|google|models)[/:.]/u, '')
    .replace(/\[\d+[km]\]$/u, '')
    .replace(/(?:[-_ ](?:20\d{6}|20\d{2}-\d{2}-\d{2}|latest|preview|thinking|low|medium|high|xhigh|ultra))+$/u, '')
    .replace(/[_ ]+/gu, '-');
  const forward = /^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+))?$/u.exec(name);
  const reverse = forward ? null : /^claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable)$/u.exec(name);
  if (forward || reverse) {
    const family = (forward?.[1] ?? reverse?.[3])!;
    const major = (forward?.[2] ?? reverse?.[1])!;
    const minor = forward ? forward[3] : reverse?.[2];
    return {
      id: `claude-${family}-${version(major, minor, '-')}`,
      name: `Claude ${capital(family)} ${version(major, minor, '.')}`,
    };
  }
  const gpt = /^gpt-(\d+)(?:[.-](\d+))?(?:-(codex|sol|astra|luna|mini|nano|pro))?(?:-(mini|max))?$/u.exec(name);
  if (gpt) {
    const [, major, minor, variant, size] = gpt;
    const number = version(major!, minor, '.');
    return {
      id: ['gpt', number, variant, size].filter(Boolean).join('-'),
      name: [`GPT-${number}`, variant === undefined ? undefined : capital(variant), size].filter(Boolean).join(' '),
    };
  }
  const reasoning = /^(o[1-9])(?:-(mini|pro))?$/u.exec(name);
  if (reasoning) {
    const parts = [reasoning[1], reasoning[2]].filter(Boolean);
    return { id: parts.join('-'), name: parts.join(' ') };
  }
  const gemini = /^gemini-(\d+)(?:[.-](\d+))?-(pro|flash|flash-lite)$/u.exec(name);
  if (gemini) {
    const [, major, minor, variant] = gemini;
    const number = version(major!, minor, '.');
    return { id: `gemini-${number}-${variant!}`, name: `Gemini ${number} ${variant!.split('-').map(capital).join(' ')}` };
  }
  return { id: null, name: given };
}
