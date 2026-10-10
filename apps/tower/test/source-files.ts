// The Tower's own sources, as the source-lint tests read them.
import { readdirSync } from "node:fs";
import path from "node:path";

/** Every `.ts`/`.tsx` under a directory, absolute. */
export function typeScriptSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return typeScriptSources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** A source with its block and whole-line comments removed, so a rule reads
 * code rather than prose about the code. */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}
