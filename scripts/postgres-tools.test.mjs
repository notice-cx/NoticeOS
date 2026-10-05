import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsUrl = new URL('./postgres-tools.mjs', import.meta.url).href;
const devUrl = new URL('./postgres-dev.mjs', import.meta.url).href;

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noticeos-postgres-tools-'));
  const bin = path.join(dir, 'bin');
  const configured = path.join(dir, 'configured');
  const home = path.join(dir, 'home');
  const log = path.join(dir, 'commands.jsonl');
  for (const name of [bin, configured, home]) mkdirSync(name);
  writeFileSync(path.join(bin, 'which'), `#!${process.execPath}\nimport { existsSync } from 'node:fs';\nimport path from 'node:path';\nconst target = path.join(${JSON.stringify(bin)}, process.argv[2]);\nif (!existsSync(target)) process.exit(1);\nconsole.log(target);\n`, { mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tool = (name, body, where = bin) => {
    const target = path.join(where, name);
    writeFileSync(target, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: ${JSON.stringify(name)}, args }) + '\\n');\n${body}\n`, { mode: 0o700 });
    return target;
  };
  const client = (where = bin, version = '18.6') => tool('psql', `if (JSON.stringify(args) !== '["--version"]') process.exit(73);\nconsole.log('psql (PostgreSQL) ${version}');`, where);
  const run = (code = 'console.log(JSON.stringify({ client: tools.findPsql(), server: tools.findPostgres(), minimum: tools.MINIMUM_MAJOR }));') =>
    execFileSync(process.execPath, ['--input-type=module', '-e', `import * as tools from ${JSON.stringify(toolsUrl)};\n${code}`], {
      encoding: 'utf8', env: { HOME: home, PATH: bin, LANG: 'C', ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) },
    }).trim();
  const commands = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { dir, bin, configured, tool, client, run, commands };
}

test('client-only discovery needs no server and runs only the version query', t => {
  const f = fixture(t), psql = f.client();
  assert.deepEqual(JSON.parse(f.run()), {
    client: { psql, version: 'psql (PostgreSQL) 18.6', major: 18 }, server: null, minimum: 15,
  });
  assert.deepEqual(f.commands(), [{ tool: 'psql', args: ['--version'] }]);
});

test('configured tool directory wins; missing tools fall back to PATH without execution', t => {
  const f = fixture(t), configuredPsql = f.client(f.configured), pathPsql = f.client();
  f.tool('pg_config', `if (JSON.stringify(args) !== '["--bindir"]') process.exit(73);\nconsole.log(${JSON.stringify(f.configured)});`);
  const initdb = f.tool('initdb', 'process.exit(73);');
  const pgCtl = f.tool('pg_ctl', 'process.exit(73);');
  const found = JSON.parse(f.run());
  assert.equal(found.client.psql, configuredPsql);
  assert.notEqual(found.client.psql, pathPsql);
  assert.equal(found.server.psql, configuredPsql);
  assert.equal(found.server.initdb, initdb);
  assert.equal(found.server.pgCtl, pgCtl);
  assert.equal(found.server.major, 18);
  assert.deepEqual(f.commands(), [
    { tool: 'pg_config', args: ['--bindir'] }, { tool: 'psql', args: ['--version'] },
    { tool: 'pg_config', args: ['--bindir'] }, { tool: 'psql', args: ['--version'] },
  ]);
});

test('unavailable discovery returns null and a failed pg_config falls back to the client', t => {
  const f = fixture(t);
  assert.deepEqual(JSON.parse(f.run()), { client: null, server: null, minimum: 15 });
  assert.deepEqual(f.commands(), []);
  f.tool('pg_config', 'process.exit(1);');
  const psql = f.client(f.bin, '14.12');
  const found = JSON.parse(f.run());
  assert.deepEqual(found.client, { psql, version: 'psql (PostgreSQL) 14.12', major: 14 });
  assert.equal(found.server, null);
  assert.deepEqual(f.commands(), [
    { tool: 'pg_config', args: ['--bindir'] }, { tool: 'psql', args: ['--version'] },
    { tool: 'pg_config', args: ['--bindir'] },
  ]);
});

test('import is inert and development exports remain the same discovery functions', t => {
  const f = fixture(t);
  f.client();
  f.tool('pg_config', 'process.exit(73);');
  assert.equal(f.run(`import * as dev from ${JSON.stringify(devUrl)};\nconsole.log(JSON.stringify({ same: dev.findPsql === tools.findPsql && dev.findPostgres === tools.findPostgres && dev.MINIMUM_MAJOR === tools.MINIMUM_MAJOR, exports: Object.keys(tools).sort() }));`), JSON.stringify({ same: true, exports: ['MINIMUM_MAJOR', 'findPostgres', 'findPsql'] }));
  assert.deepEqual(f.commands(), []);
  const source = readFileSync(fileURLToPath(toolsUrl), 'utf8');
  for (const dependency of source.matchAll(/from ['"]([^'"]+)['"]/gu)) assert.match(dependency[1], /^node:/u);
});
