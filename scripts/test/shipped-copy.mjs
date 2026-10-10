// How the copy guards (ui-lexicon.test.mjs, ui-noun.test.mjs) read a file: the
// text a person sees, with offsets that still point into the file.

import { readdirSync } from 'node:fs';
import path from 'node:path';

// Newlines SURVIVE the blanking, so the line number in a failure is the line
// in the file. Blanking them too makes every number after the first multi-line
// comment point at the wrong place, and a guard nobody can navigate from is a
// guard people learn to ignore.
const blank = (m) => m.replace(/[^\n]/g, ' ');

/** Comments only, offsets kept — the text an expression-level rule reads.
 * Block comments (JSX `{/* … *\/}` included) go whole; line comments only when
 * the `//` opens the line, so a `https://…` inside a string survives. */
export function commentsBlanked(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
}

/** Comments are not labels, and neither is a module path. `${…}` is an
 * EXPRESSION. `from "…"` and `import("…")` are module specifiers —
 * `@shared/changeset` and `components/decision-lanes` are file names. */
export function withoutComments(source) {
  return commentsBlanked(source)
    .replace(/\$\{[^{}]*\}/g, blank)
    .replace(/\bfrom\s+(["'])(?:[^"'\\\n]|\\.)*\1/g, blank)
    .replace(/\bimport\s*\(\s*(["'])(?:[^"'\\\n]|\\.)*\1\s*\)/g, blank);
}

/** Is the hit at `at` covered by one of `phrases`? Checked against THIS hit,
 * not "the line mentions a path somewhere". `window` is `text.slice(from, …)`,
 * so `from` maps back to file offsets. */
export function coveredByPhrase(window, from, at, phrases) {
  return phrases.some((phrase) => {
    for (let found = window.indexOf(phrase); found >= 0; found = window.indexOf(phrase, found + 1)) {
      const start = from + found;
      if (start <= at && at < start + phrase.length) return true;
    }
    return false;
  });
}

/** Every string VALUE in a parsed config, with a JSON-path label for the error
 * message. Keys are deliberately not yielded: a key is code. */
export function* stringValues(node, at = '$') {
  if (typeof node === 'string') yield [at, node];
  else if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) yield* stringValues(child, `${at}[${i}]`);
  } else if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) yield* stringValues(child, `${at}.${key}`);
  }
}

/** The `.ts`/`.tsx` files under `dir` (repo-relative), less `skip`. */
export function sourceFiles(root, dir, skip) {
  const found = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(root, rel, skip));
    else if (/\.tsx?$/.test(entry.name) && !skip.has(rel)) found.push(rel);
  }
  return found;
}
