// A product default the Tower compiles in as its Worker's fallback, judged by
// the same register and knob declarations every Save is judged by (bead
// ro-ujb9.222). vite.config.ts runs it at the build boundary, beside the time
// zone and the display config it already parses there, so a malformed default
// fails the build naming the file instead of reaching every read of an
// installation that has not seeded its store.
//
// `scripts/config-documents.mjs` is plain ESM with no `node:` or package
// import, so it loads before Vite's resolver exists.

import { documentRefusal } from "../../../scripts/config-documents.mjs";

export function checkedDefault<T>(file: string, doc: unknown): T {
  const refusal = documentRefusal(file, doc);
  if (refusal !== null) throw new Error(`${file}: ${refusal}`);
  return doc as T;
}
