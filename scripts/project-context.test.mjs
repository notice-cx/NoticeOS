import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main, prepareProjectContext } from './project-context.mjs';
import { runCommand } from './run-command.mjs';

const STANZA = '- Work handed off from the NoticeOS Tower carries `noticeos_*` metadata.\n- Read the NoticeOS task-hub contract linked above.';
async function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-context-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'asset');
  fs.mkdirSync(repo);
  const sourceRoot = path.join(base, 'noticeos-source');
  fs.mkdirSync(path.join(sourceRoot, 'config'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'docs/templates'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'config/beads.README.md'), `# Task contract\n<!-- spoke-stanza:begin -->\n${STANZA}\n<!-- spoke-stanza:end -->\n`);
  fs.writeFileSync(path.join(sourceRoot, 'docs/templates/project-freeze-register.md'), '# Freeze register\n\n## Active freezes\n\nUnknown measurement windows; owner review and readback required.\n\n## Closed windows\n\nNone recorded.\n');
  const env = { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = args => runCommand('git', ['-C', repo, ...args], { cwd: repo, env });
  assert.equal((await git(['init', '--quiet'])).code, 0);
  const calls = [];
  const options = { env, sourceRoot, run: async (binary, args, controls) => {
    calls.push({ binary, args });
    assert.equal(binary, 'git', 'only offline Git reads may run');
    assert.ok(['rev-parse', 'ls-files'].includes(args[2]));
    return runCommand(binary, args, controls);
  } };
  return { base, repo, sourceRoot, git, calls, options, write: (name, text, opts) => fs.writeFileSync(path.join(repo, name), text, opts) };
}

test('check mode changes no files and explicit preparation copies the canonical rules with unknown measurement state', async t => {
  const f = await fixture(t);
  const before = fs.readdirSync(f.repo);
  const planned = await prepareProjectContext(f.repo, f.options);
  assert.equal(planned.mode, 'check');
  assert.equal(planned.tasks, 'not_checked');
  assert.deepEqual(fs.readdirSync(f.repo), before);
  const prepared = await prepareProjectContext(f.repo, { ...f.options, write: true });
  assert.equal(prepared.mode, 'prepared');
  const agents = fs.readFileSync(path.join(f.repo, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(STANZA));
  assert.match(agents, /NoticeOS Tower.*noticeos_\*/u);
  const link = /\[NoticeOS task-hub contract\]\(([^)]+)\)/u.exec(agents)[1];
  assert.equal(fs.realpathSync(path.resolve(f.repo, decodeURIComponent(link))), path.join(f.sourceRoot, 'config/beads.README.md'));
  assert.match(fs.readFileSync(path.join(f.repo, 'docs/freeze-register.md'), 'utf8'), /Unknown measurement windows/u);
  assert.equal(fs.existsSync(path.join(f.repo, '.beads')), false);
  assert.equal(fs.existsSync(path.join(f.repo, 'CLAUDE.md')), false);
  assert.deepEqual((await prepareProjectContext(f.repo, { ...f.options, write: true })).files, []);
});

test('existing agent instructions, uncommitted work and an active measurement register survive preparation byte-for-byte', async t => {
  const f = await fixture(t);
  const agents = '# Owner rules\n\nKeep this product accessible.\n';
  const claude = '# Build commands\n\nRun the local fixture suite.\n';
  const freeze = '# Freeze register\n\n## Active freezes\n\nPricing page; 2026-10-01 to 2026-10-28; readback ex-synthetic.\n\n## Closed windows\n\nPrior experiment evidence.\n';
  f.write('AGENTS.md', agents); f.write('CLAUDE.md', claude);
  f.write('unrelated.txt', 'uncommitted owner work');
  fs.mkdirSync(path.join(f.repo, 'docs')); f.write('docs/freeze-register.md', freeze);
  await prepareProjectContext(f.repo, { ...f.options, write: true });
  assert.ok(fs.readFileSync(path.join(f.repo, 'AGENTS.md'), 'utf8').startsWith(agents));
  assert.ok(fs.readFileSync(path.join(f.repo, 'CLAUDE.md'), 'utf8').startsWith(claude));
  assert.equal(fs.readFileSync(path.join(f.repo, 'docs/freeze-register.md'), 'utf8'), freeze);
  assert.equal(fs.readFileSync(path.join(f.repo, 'unrelated.txt'), 'utf8'), 'uncommitted owner work');
  assert.equal(fs.readdirSync(f.repo).some(name => name.includes('.noticeos-')), false);
});

test('an existing local connection remains untouched and its private lock and ignore rules support the Docker adapter', async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.repo, '.beads'));
  f.write('.beads/metadata.json', '{"backend":"dolt","dolt_database":"ex_tasks","project_id":"synthetic-original"}');
  f.write('.beads/config.yaml', 'no-git-ops: true\nimport.auto: false\nexport.auto: false\n');
  f.write('.gitignore', '*\n!/.beads/\n');
  const metadata = fs.readFileSync(path.join(f.repo, '.beads/metadata.json'));
  await prepareProjectContext(f.repo, { ...f.options, write: true });
  assert.deepEqual(fs.readFileSync(path.join(f.repo, '.beads/metadata.json')), metadata);
  assert.equal(fs.readFileSync(path.join(f.repo, '.beads/config.yaml'), 'utf8'), 'no-git-ops: true\nimport.auto: false\nexport.auto: false\n');
  const lock = fs.lstatSync(path.join(f.repo, '.beads.gate.lock'));
  assert.equal(lock.mode & 0o777, 0o600); assert.equal(lock.size, 0);
  assert.equal((await f.git(['check-ignore', '.beads/metadata.json', '.beads.gate.lock'])).code, 0);
});

test('tracked task connections are refused before any context or freeze write', async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.repo, '.beads')); f.write('.beads/metadata.json', 'synthetic tracked connection');
  assert.equal((await f.git(['add', '.beads/metadata.json'])).code, 0);
  await assert.rejects(prepareProjectContext(f.repo, { ...f.options, write: true }));
  assert.equal(fs.existsSync(path.join(f.repo, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(f.repo, 'docs')), false);
});

test('conflicting or malformed task instruction blocks require review without partial changes', async t => {
  for (const text of ['# Rules\n- `bd ready` against another hub\n', '<!-- spoke-stanza:begin -->old rules', '<!-- noticeos-project:begin -->broken block']) {
    const f = await fixture(t); f.write('CLAUDE.md', text);
    await assert.rejects(prepareProjectContext(f.repo, { ...f.options, write: true }));
    assert.equal(fs.readFileSync(path.join(f.repo, 'CLAUDE.md'), 'utf8'), text);
    assert.equal(fs.existsSync(path.join(f.repo, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(f.repo, '.gitignore')), false);
  }
});

test('aliases, symlink targets and hard links cannot redirect writes or alter another file', async t => {
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.gitignore', 'docs/freeze-register.md', '.beads.gate.lock']) {
    for (const link of ['symbolic', 'hard']) {
      const f = await fixture(t);
      const target = path.join(f.base, 'owner-file'); fs.writeFileSync(target, 'preserve owner file', { mode: 0o600 });
      if (name.startsWith('docs/')) fs.mkdirSync(path.join(f.repo, 'docs'));
      if (link === 'symbolic') fs.symlinkSync(target, path.join(f.repo, name));
      else fs.linkSync(target, path.join(f.repo, name));
      await assert.rejects(prepareProjectContext(f.repo, { ...f.options, write: true }));
      assert.equal(fs.readFileSync(target, 'utf8'), 'preserve owner file');
    }
  }
  for (const name of ['docs', '.beads']) {
    const f = await fixture(t);
    const target = path.join(f.base, 'other-directory'); fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(f.repo, name));
    await assert.rejects(prepareProjectContext(f.repo, { ...f.options, write: true }));
    assert.deepEqual(fs.readdirSync(target), []);
  }
  const f = await fixture(t); const alias = path.join(f.base, 'alias'); fs.symlinkSync(f.repo, alias);
  await assert.rejects(prepareProjectContext(alias, { ...f.options, write: true }));
});

test('a changed managed section or broad-access lock is refused and existing measurement state is preserved', async t => {
  const f = await fixture(t);
  await prepareProjectContext(f.repo, { ...f.options, write: true });
  const file = path.join(f.repo, 'AGENTS.md');
  const changed = fs.readFileSync(file, 'utf8').replace('Production reads and writes', 'Owner changed this rule: production reads and writes');
  fs.writeFileSync(file, changed);
  await assert.rejects(prepareProjectContext(f.repo, { ...f.options, write: true }));
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
  const other = await fixture(t); other.write('.beads.gate.lock', '', { mode: 0o644 });
  await assert.rejects(prepareProjectContext(other.repo, { ...other.options, write: true }));
  assert.equal(fs.existsSync(path.join(other.repo, 'AGENTS.md')), false);
});

test('CLI requires an explicit check or write and never prints file contents or creates a connection', async t => {
  const f = await fixture(t); f.write('AGENTS.md', 'private owner instruction');
  let output = ''; const sink = { write: text => { output += text; } };
  assert.equal(await main(['--repo', f.repo], { ...f.options, out: sink, err: sink }), 1);
  assert.equal(await main(['--repo', f.repo, '--check'], { ...f.options, out: sink, err: sink }), 0);
  assert.equal(output.includes('private owner instruction'), false);
  assert.equal(fs.readFileSync(path.join(f.repo, 'AGENTS.md'), 'utf8'), 'private owner instruction');
  assert.equal(fs.existsSync(path.join(f.repo, '.beads')), false);
});
