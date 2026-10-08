// The document head a profile ships. An installation's index.html carries the
// private desk's head (kept out of search); the public demo build swaps that
// marked block for demo-head.html, which asks to be indexed and previews with
// the Wall. Its absolute URLs carry a placeholder the demo server fills from
// its configured public origin (scripts/hosted-demo-server.mts), because one
// image serves whichever origin an operator gives it.
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import type { WorkspaceProfile } from '../../../scripts/product-env.mjs';

const BEGIN = '<!-- document-head:begin -->';
const END = '<!-- document-head:end -->';

/** index.html with the head block this profile ships. Refuses a page whose
 * markers moved, rather than shipping a demo head that never applied. */
export function documentHead(html: string, profile: WorkspaceProfile, demoHead: string): string {
  const start = html.indexOf(BEGIN), end = html.indexOf(END);
  if (start === -1 || end < start || html.indexOf(BEGIN, start + 1) !== -1 || html.indexOf(END, end + 1) !== -1) {
    throw new Error('index.html must carry exactly one document-head block.');
  }
  if (profile !== 'demo') return html;
  return `${html.slice(0, start + BEGIN.length)}\n${demoHead.trimEnd()}\n    ${html.slice(end)}`;
}

/** `demoHeadFile` comes from the config's own directory: the demo build
 * compiles the config with one `import.meta.url` for every module. */
export function documentHeadPlugin(profile: WorkspaceProfile, demoHeadFile: string): Plugin {
  const demoHead = readFileSync(demoHeadFile, 'utf8');
  return { name: 'noticeos-document-head', transformIndexHtml: { order: 'pre', handler: html => documentHead(html, profile, demoHead) } };
}
