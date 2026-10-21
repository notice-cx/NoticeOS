/** The makers whose published marks the Tower ships, in `public/agents`. */
export type AgentMaker = "anthropic" | "openai" | "google";

const MAKER_NAMES: readonly (readonly [AgentMaker, RegExp])[] = [
  ["anthropic", /\b(?:claude|opus|sonnet|haiku)\b/iu],
  ["openai", /\b(?:codex|openai|gpt|o[1-9])\b/iu],
  ["google", /\bgemini\b/iu],
];

/** Whose agent this is, by its own name first and then the models it named;
 * null for a name and models that belong to no maker, a person's included. */
export function agentMaker(name: string, models: readonly (string | null)[] = []): AgentMaker | null {
  for (const text of [name, ...models]) {
    const found = text ? MAKER_NAMES.find(([, pattern]) => pattern.test(text)) : undefined;
    if (found) return found[0];
  }
  return null;
}


export type EvidencePart = { kind: "text" | "commit" | "link"; text: string; href: string | null };

/**
 * A close reason split into the pointers it cites: `·`-separated parts that
 * are a commit hash or a link become chips, the rest stays the sentence it
 * was. Only a full http(s) address links; a bare domain is shown, not followed.
 */
export function evidenceParts(reason: string): EvidencePart[] {
  return reason.split(/\s+·\s+/u).map((part) => part.trim()).filter(Boolean).map((part): EvidencePart => {
    if (/^[0-9a-f]{7,40}$/u.test(part)) return { kind: "commit", text: part.slice(0, 7), href: null };
    if (/^https?:\/\/\S+$/iu.test(part)) return { kind: "link", text: part.replace(/^https?:\/\//iu, ""), href: part };
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/iu.test(part) && !/\s/u.test(part)) return { kind: "link", text: part, href: null };
    return { kind: "text", text: part, href: null };
  });
}
