import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readDeclaredTaskClient, taskChildEnvironment, taskClientEnvironment, declaredTaskClient } from './task-client.mjs';
import { taskHubPortDescription } from './runner/task-hub.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-task-client-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = { host: 'dolt', port: 3306, user: 'noticeos', clientHome: path.join(home, 'client-home'), credentialsFile: path.join(home, 'credentials') };
  fs.mkdirSync(profile.clientHome, { mode: 0o700 });
  fs.writeFileSync(profile.credentialsFile, '[dolt:3306]\npassword=synthetic-private-sentinel\n', { mode: 0o600 });
  const file = path.join(home, 'client.json'); fs.writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
  return { home, profile, file };
}

test('runner and Tower get an identical declared client without inherited secrets/selectors', t => {
  const { profile, file } = fixture(t);
  const poison = { PATH: '/own/tools', LANG: 'C', HOME: '/other', BEADS_DOLT_PASSWORD: 'private', BEADS_DOLT_SERVER_HOST: 'foreign', BEADS_ACTOR: 'other',
    DATABASE_URL: 'private', DOCKER_HOST: 'private', NOTICEOS_TASK_CLIENT_PROFILE: file };
  assert.deepEqual(readDeclaredTaskClient(file), profile);
  const env = taskChildEnvironment(poison);
  assert.deepEqual(env, taskClientEnvironment(profile, poison));
  assert.equal(env.BEADS_DOLT_SERVER_HOST, 'dolt'); assert.equal(env.BEADS_DOLT_SERVER_PORT, '3306');
  assert.equal(env.HOME, profile.clientHome); assert.equal(env.BEADS_CREDENTIALS_FILE, profile.credentialsFile);
  assert.equal(env.BEADS_DOLT_AUTO_START, '0');
  for (const key of ['DATABASE_URL', 'DOCKER_HOST', 'BEADS_DOLT_PASSWORD', 'BEADS_ACTOR']) assert.equal(env[key], undefined);
  assert.ok(!JSON.stringify(env).includes('synthetic-private-sentinel'));
  assert.equal(taskHubPortDescription(poison), 'dolt:3306 (separately hosted declared service)');
  assert.equal(taskHubPortDescription({}, { beadsHubHost: '127.0.0.1', beadsHubPort: 3308 }), '127.0.0.1:3308 (loopback only, hosted by brew services — not us)');
});

test('a declared client never falls back after missing/malformed/insecure/mismatched files', t => {
  for (const defect of ['missing', 'invalid', 'permissions', 'endpoint', 'symlink', 'home']) {
    const own = fixture(t);
    if (defect === 'missing') fs.rmSync(own.file);
    if (defect === 'invalid') fs.writeFileSync(own.file, '{');
    if (defect === 'permissions') fs.chmodSync(own.profile.credentialsFile, 0o644);
    if (defect === 'endpoint') fs.writeFileSync(own.profile.credentialsFile, '[foreign:3306]\npassword=synthetic\n');
    if (defect === 'symlink') { fs.renameSync(own.file, own.file + '.target'); fs.symlinkSync(own.file + '.target', own.file); }
    if (defect === 'home') fs.chmodSync(own.profile.clientHome, 0o755);
    assert.throws(() => taskChildEnvironment({ NOTICEOS_TASK_CLIENT_PROFILE: own.file, BEADS_DOLT_SERVER_HOST: 'foreign' }), /cannot be read/, defect);
  }
});

test('one selected native Dolt home derives the client and health endpoint without legacy fallback', t => {
  const f = fixture(t);
  const dolt = path.join(f.home, 'dolt'); fs.mkdirSync(dolt, { mode: 0o700 });
  const profile = { project: 'noticeos-start-0123456789abcdef', composeFile: path.join(dolt, 'compose.yaml'),
    secretsDir: path.join(dolt, 'secrets'), credentialsFile: path.join(dolt, 'credentials'), port: 5773 };
  fs.mkdirSync(profile.secretsDir, { mode: 0o700 });
  fs.mkdirSync(path.join(dolt, 'client-home'), { mode: 0o700 });
  fs.writeFileSync(path.join(dolt, 'profile.json'), JSON.stringify(profile), { mode: 0o600 });
  for (const name of ['root', 'noticeos']) fs.writeFileSync(path.join(profile.secretsDir, name), 'a'.repeat(64) + '\n', { mode: 0o600 });
  fs.writeFileSync(profile.credentialsFile, '[127.0.0.1:5773]\npassword=' + 'a'.repeat(64) + '\n', { mode: 0o600 });
  const env = { NOTICEOS_DOLT_HOME: f.home, BEADS_DOLT_SERVER_HOST: 'foreign' };
  assert.equal(declaredTaskClient(env).port, profile.port);
  assert.equal(taskChildEnvironment(env).BEADS_CREDENTIALS_FILE, profile.credentialsFile);
  assert.equal(taskChildEnvironment(env).BEADS_DOLT_SERVER_HOST, '127.0.0.1');
  assert.equal(taskHubPortDescription(env), '127.0.0.1:5773 (separately hosted declared service)');
  assert.throws(() => taskChildEnvironment({ ...env, NOTICEOS_TASK_CLIENT_PROFILE: f.file }), /one declared task profile/u);
  fs.rmSync(path.join(dolt, 'profile.json'));
  assert.throws(() => taskChildEnvironment(env), /fallback was refused/u);
  assert.throws(() => taskHubPortDescription(env), /fallback was refused/u);
  assert.throws(() => taskChildEnvironment({ NOTICEOS_DOLT_HOME: '' }), /absolute installation/u);
});
