#!/usr/bin/env node
// Prepare repository context only. Task provisioning and provider access have
// separate operator-owned boundaries; this command never contacts either.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './run-command.mjs';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN = '<!-- noticeos-project:begin -->';
const END = '<!-- noticeos-project:end -->';
const IGNORE = ['/.beads/', '/.beads.gate.lock'];
const LIMIT = 1024 * 1024;
const refuse = () => { throw new Error('Project context preparation refused; preserve existing files and review the setup guide.'); };

function regularDirectory(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
    if (current === path.dirname(current)) return;
  }
}

function contents(file) {
  const before = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > LIMIT) refuse();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size > LIMIT) refuse();
    return { text: fs.readFileSync(fd, 'utf8'), mode: opened.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}

function agentBlock(repo, sourceRoot) {
  const contract = fs.readFileSync(path.join(sourceRoot, 'config/beads.README.md'), 'utf8');
  const match = /<!-- spoke-stanza:begin -->\n([\s\S]+?)\n<!-- spoke-stanza:end -->/u.exec(contract);
  if (!match) refuse();
  const link = path.relative(repo, path.join(sourceRoot, 'config/beads.README.md')).split(path.sep).map(encodeURIComponent).join('/');
  return `${BEGIN}\n## NoticeOS project context\n\n` +
    `Read the [NoticeOS task-hub contract](${link}) before task work.\n` +
    'Read `docs/freeze-register.md` before changing any measured surface. Unknown measurement state blocks a verdict.\n' +
    'Keep this project\'s goals, verification commands, protected operations and dated STATE in its own context pack.\n' +
    'Production reads and writes require the owner\'s explicit approval for the exact target, action and verification.\n' +
    'Provider credentials are connected in NoticeOS. This repository never pulls external analytics about itself.\n\n' +
    `<!-- spoke-stanza:begin -->\n${match[1]}\n<!-- spoke-stanza:end -->\n${END}\n`;
}

function instructions(previous, block) {
  if (previous === null) return `# Project instructions\n\n${block}`;
  if (previous.includes(BEGIN) || previous.includes(END)) {
    if (previous.split(BEGIN).length !== 2 || previous.split(END).length !== 2 || !previous.includes(block.trimEnd())) refuse();
    return previous;
  }
  // Existing task instructions need human reconciliation, not a second block
  // whose rules silently disagree with the first.
  if (previous.includes('<!-- spoke-stanza:') || previous.includes('- `bd ready`')) refuse();
  return `${previous}${previous.endsWith('\n') ? '' : '\n'}\n${block}`;
}

export async function projectContextPlan(repo, { run = runCommand, env = process.env, sourceRoot = SOURCE } = {}) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo) || /[\0\r\n]/u.test(repo)) refuse();
  regularDirectory(repo);
  const ownEnv = { PATH: env.PATH ?? '', HOME: repo, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0' };
  const root = await run('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { cwd: repo, env: ownEnv });
  if (root.code !== 0 || root.stdout.trim() !== repo) refuse();
  const tracked = await run('git', ['-C', repo, 'ls-files', '-z', '--', '.beads', '.beads.gate.lock'], { cwd: repo, env: ownEnv });
  if (tracked.code !== 0 || tracked.stdout !== '') refuse();
  const docs = path.join(repo, 'docs');
  const docsStat = fs.lstatSync(docs, { throwIfNoEntry: false });
  if (docsStat) regularDirectory(docs);
  const changes = [];
  const add = (relative, before, text) => {
    if (before?.text !== text) changes.push({ relative, before, text });
  };
  const block = agentBlock(repo, sourceRoot);
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const before = contents(path.join(repo, name));
    if (name === 'CLAUDE.md' && before === null) continue;
    add(name, before, instructions(before?.text ?? null, block));
  }
  const ignore = contents(path.join(repo, '.gitignore'));
  // Append at the end so earlier broad negations cannot expose task state.
  const suffix = `# Local NoticeOS task connection\n${IGNORE.join('\n')}\n`;
  const oldIgnore = ignore?.text ?? '';
  if (!oldIgnore.endsWith(suffix)) add('.gitignore', ignore, `${oldIgnore}${oldIgnore && !oldIgnore.endsWith('\n') ? '\n' : ''}${suffix}`);
  const freeze = contents(path.join(docs, 'freeze-register.md'));
  if (freeze === null) add('docs/freeze-register.md', null, fs.readFileSync(path.join(sourceRoot, 'docs/templates/project-freeze-register.md'), 'utf8'));
  // Existing measurement state is never replaced or interpreted here.
  const gate = path.join(repo, '.beads.gate.lock');
  const gateStat = fs.lstatSync(gate, { throwIfNoEntry: false });
  if (gateStat && (!gateStat.isFile() || gateStat.isSymbolicLink() || gateStat.nlink !== 1 || gateStat.uid !== process.getuid() || (gateStat.mode & 0o077))) refuse();
  const beads = fs.lstatSync(path.join(repo, '.beads'), { throwIfNoEntry: false });
  if (beads) {
    regularDirectory(path.join(repo, '.beads'));
    if (!gateStat) changes.push({ relative: '.beads.gate.lock', before: null, text: '', mode: 0o600 });
  }
  return { repo, changes, createDocs: !docsStat && changes.some(change => change.relative.startsWith('docs/')) };
}

export async function prepareProjectContext(repo, { write = false, ...options } = {}) {
  const plan = await projectContextPlan(repo, options);
  if (write) {
    // Check the whole plan again before the first mutation.
    for (const change of plan.changes) {
      const current = contents(path.join(repo, change.relative));
      if ((current?.text ?? null) !== (change.before?.text ?? null)) refuse();
    }
    if (plan.createDocs) fs.mkdirSync(path.join(repo, 'docs'));
    for (const change of plan.changes) {
      const file = path.join(repo, change.relative);
      regularDirectory(path.dirname(file));
      if (change.before === null) {
        fs.writeFileSync(file, change.text, { flag: 'wx', mode: change.mode ?? 0o644 });
      } else {
        // An exclusive sibling avoids partial rewrites of existing instructions.
        const stage = `${file}.noticeos-${process.pid}`;
        let created = false;
        try {
          fs.writeFileSync(stage, change.text, { flag: 'wx', mode: change.before.mode });
          created = true;
          const current = contents(file);
          if (!current || current.text !== change.before.text) refuse();
          fs.renameSync(stage, file);
          created = false;
        } finally {
          if (created) fs.unlinkSync(stage);
        }
      }
    }
  }
  return { mode: write ? 'prepared' : 'check', files: plan.changes.map(change => change.relative),
    tasks: 'not_checked', measurementState: 'owner_review_required' };
}

export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, ...options } = {}) {
  try {
    let repo = null; let mode = null;
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      if (arg === '--repo' && repo === null && argv[index + 1]) repo = argv[++index];
      else if (['--check', '--write'].includes(arg) && mode === null) mode = arg;
      else refuse();
    }
    if (!repo || !mode) refuse();
    out.write(JSON.stringify(await prepareProjectContext(path.resolve(repo), { ...options, write: mode === '--write' }), null, 2) + '\n');
    return 0;
  } catch {
    err.write('Project context refused. Use --repo <absolute checkout> and --check or --write; review docs/project-setup.md.\n');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
