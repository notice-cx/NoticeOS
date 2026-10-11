#!/usr/bin/env node
// The command index, generated from package.json and each script's own header.
//
// `package.json` `scripts` is the one list of commands this repo offers, and
// the first comment line of each script file is its one-line description. A
// hand-kept table of the same facts drifts the day a script is added or
// renamed, so scripts/README.md carries this index between two markers and
// `pnpm generate -- --check` (run by scripts/scripts-index.test.mjs) fails
// when the committed block no longer matches what the code says.
//
//   node scripts/scripts-index.mjs            print the index
//   node scripts/scripts-index.mjs --write    rewrite the block in scripts/README.md
//   node scripts/scripts-index.mjs --check    exit 1 when the block is stale

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const README = 'scripts/README.md';
export const START = '<!-- scripts-index:start -->';
export const END = '<!-- scripts-index:end -->';

/** The script file a package command runs, repo-relative, or null for a composite command. */
export function scriptFile(command) {
  const match = /(?:^|\s)node\s+(?:--[^\s]+\s+)*((?:scripts|apps\/tower\/e2e)\/[\w./-]+\.mjs)\b/u.exec(command);
  return match?.[1] ?? null;
}

/** The authored source of a script: the `.mts` beside a generated `.mjs`, else the file itself. */
export function authoredSource(root, file) {
  const authored = file.replace(/\.mjs$/u, '.mts');
  return existsSync(path.join(root, authored)) ? authored : file;
}

/** The first sentence of a script's header comment, without the file's own
 * name; a sentence wrapped over several comment lines is joined. */
export function headerLine(source, file) {
  const lines = source.split('\n');
  let index = 0;
  if (lines[0]?.startsWith('#!')) index = 1;
  const words = [];
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line && !words.length) continue;
    const text = line.replace(/^\/\/\s?/u, '').replace(/^\/\*\*?\s?/u, '').replace(/^\*\s?/u, '').replace(/\*\/\s*$/u, '').trim();
    if (!text || text.startsWith('import ') || text.startsWith('export ') || text.startsWith('const ')) break;
    words.push(text);
    if (/[.?!]$/u.test(text) || words.length === 4) break;
  }
  const base = path.basename(file).replace(/\.(?:mjs|mts)$/u, '');
  const text = words.join(' ')
    .replace(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.(?:mjs|mts)\\s*[—:-]\\s*`, 'u'), '')
    .replace(/^`pnpm [\w:-]+`:\s*/u, '');
  const sentence = /^.*?[.?!](?=\s|$)/u.exec(text)?.[0] ?? text;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1).trimEnd();
}

/** What a composite command (no script file of its own) does. */
const COMPOSITE = {
  typecheck: 'Typecheck every workspace.',
  test: 'Every workspace\'s unit tests.',
  build: 'Build every workspace.',
  'test:scripts': 'The root suite: every scripts/*.test.mjs.',
  'test:task-store': 'The task-store suite against a real Dolt server in Docker.',
  'test:journeys': 'The Tower\'s browser journeys, then the flow walker.',
};

/**
 * A command's own line in its script's header, for a script that serves more
 * than one command: a comment line `pnpm <name> [args]` followed by two or more
 * spaces and a sentence starting with a capital. Null when the header has none.
 */
export function usageLine(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`^//\\s+pnpm ${escaped}(?=\\s)[^\\n]*?\\s{2,}([A-Z][^\\n]*)$`, 'u');
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('#!')) break;
    const match = pattern.exec(trimmed);
    if (match) return match[1].trim();
  }
  return null;
}

/** One row per package script: name, command, the script's own line for it. */
export function indexRows(root = REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  return Object.entries(manifest.scripts ?? {}).map(([name, command]) => {
    const file = scriptFile(command);
    let description = COMPOSITE[name] ?? '';
    if (file) {
      const source = authoredSource(root, file);
      if (existsSync(path.join(root, source))) {
        const text = readFileSync(path.join(root, source), 'utf8');
        description = usageLine(text, name) ?? headerLine(text, source);
      } else description = '(missing file)';
    }
    return { name, command, file, description };
  });
}

const cell = (text) => text.replace(/\|/gu, '\\|').replace(/\s+/gu, ' ').trim();

/** The index's sections, by what a person is doing; the first prefix that matches wins. */
export const GROUPS = [
  { title: 'Run the installation', prefixes: ['os:'] },
  { title: 'Change the database', prefixes: ['db:'] },
  { title: 'Settings and credentials', prefixes: ['config:', 'creds:'] },
  { title: 'Signals and imports', prefixes: ['signals:', 'bing-ai:', 'reclamation:', 'mediavine', 'pulse:'] },
  { title: 'Check the code and the screens', prefixes: ['check:', 'audit:'] },
  { title: 'Tests', prefixes: ['test'] },
  { title: 'The repository', prefixes: [''] },
];

export function groupOf(name) {
  return GROUPS.find(({ prefixes }) => prefixes.some((prefix) => prefix === '' || name === prefix || name.startsWith(prefix)));
}

export function renderIndex(rows) {
  const row = ({ name, command, file, description }) => {
    const runs = file ? `${file}${command.slice(command.indexOf(file) + file.length).trimEnd()}` : `${cell(command).slice(0, 80)}${command.length > 80 ? '…' : ''}`;
    return `| \`${name}\` | ${cell(description) || '—'} | \`${cell(runs)}\` |`;
  };
  const lines = [START, ''];
  for (const group of GROUPS) {
    const members = rows.filter((entry) => groupOf(entry.name) === group);
    if (!members.length) continue;
    lines.push(`### ${group.title}`, '', '| `pnpm …` | What it does | Runs |', '|---|---|---|', ...members.map(row), '');
  }
  lines.push(
    `Generated by \`pnpm generate\` from \`package.json\` and each script's header; \`scripts/scripts-index.test.mjs\` fails when this block is stale.`,
    '',
    END,
  );
  return lines.join('\n');
}

export function currentBlock(readme) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < 0 || end < start) return null;
  return readme.slice(start, end + END.length);
}

export function withBlock(readme, block) {
  const current = currentBlock(readme);
  // A function replacer: a `$` inside the block is never a replacement pattern.
  if (current) return readme.replace(current, () => block);
  // No markers yet: the index goes before the first section heading.
  const at = readme.search(/^# /mu);
  return at < 0 ? `${readme.trimEnd()}\n\n${block}\n` : `${readme.slice(0, at)}${block}\n\n${readme.slice(at)}`;
}

/** The documentation site's commands page: the same block under a page heading. */
export const DOCS_PAGE = 'docs/reference/commands.md';

export function renderDocsPage(block) {
  return [
    '---',
    'title: Commands',
    'description: Every command the repository offers, generated from package.json and each script\'s own header.',
    '---',
    '',
    '# Commands',
    '',
    'Every command is a `pnpm` script in the repository\'s `package.json`. Run one from a checkout as `pnpm <name>`; pass a script\'s own options after `--`, for example `pnpm os:migrate -- --apply`. The procedures behind the commands that need one are in [`scripts/README.md`](https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md).',
    '',
    block,
    '',
  ].join('\n');
}

/** Every file that carries the index, with the content it should hold. */
export function targets(root = REPO_ROOT) {
  const block = renderIndex(indexRows(root));
  return [
    { file: README, content: (text) => withBlock(text, block), current: (text) => currentBlock(text) === block },
    { file: DOCS_PAGE, content: () => renderDocsPage(block), current: (text) => text === renderDocsPage(block) },
  ];
}

export function main(argv = process.argv.slice(2), root = REPO_ROOT) {
  let stale = 0;
  for (const target of targets(root)) {
    const file = path.join(root, target.file);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (argv.includes('--write')) {
      writeFileSync(file, target.content(text));
    } else if (argv.includes('--check')) {
      if (!target.current(text)) {
        stale += 1;
        process.stderr.write(`${target.file}: the command index is stale; run pnpm generate\n`);
      }
    } else if (target.file === README) {
      process.stdout.write(`${renderIndex(indexRows(root))}\n`);
    }
  }
  return stale ? 1 : 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) process.exitCode = main();
