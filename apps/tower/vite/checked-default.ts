// A product default the Tower compiles in as its Worker's fallback, judged by
// the same declarations every Save is judged by, so a malformed default fails
// the build naming the file.
//
// `scripts/config-documents.mjs` is plain ESM with no `node:` or package
// import, so it loads before Vite's resolver exists.

import { documentRefusal } from "../../../scripts/config-documents.mjs";

export function checkedDefault<T>(file: string, doc: unknown): T {
  const refusal = documentRefusal(file, doc);
  if (refusal !== null) throw new Error(`${file}: ${refusal}`);
  return doc as T;
}
