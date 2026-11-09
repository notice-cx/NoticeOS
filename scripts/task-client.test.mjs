import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readDeclaredTaskClient, taskChildEnvironment, taskClientEnvironment, declaredTaskClient } from './task-client.mjs';

function doltHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-task-client-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dolt = path.join(home, 'dolt'); fs.mkdirSync(dolt, { mode: 0o700 });
  const profile = { project: 'noticeos-start-0123456789abcdef', composeFile: path.join(dolt, 'compose.yaml'),
    secretsDir: path.join(dolt, 'secrets'), credentialsFile: path.join(dolt, 'credentials'), port: 5773 };
  fs.mkdirSync(profile.secretsDir, { mode: 0o700 });
  fs.mkdirSync(path.join(dolt, 'client-home'), { mode: 0o700 });
  fs.writeFileSync(path.join(dolt, 'profile.json'), JSON.stringify(profile), { mode: 0o600 });
  for (const name of ['root', 'noticeos']) fs.writeFileSync(path.join(profile.secretsDir, name), 'a'.repeat(64) + '\n', { mode: 0o600 });
  fs.writeFileSync(profile.credentialsFile, '[127.0.0.1:5773]\npassword=' + 'a'.repeat(64) + '\n', { mode: 0o600 });
  return { home, dolt, profile };
}

test('the selected Dolt home derives the task client, and a missing profile is never replaced by another', t => {
  const { home, dolt, profile } = doltHome(t);
  const env = { NOTICEOS_DOLT_HOME: home, BEADS_DOLT_SERVER_HOST: 'foreign' };
  assert.equal(declaredTaskClient(env).port, profile.port);
  assert.equal(taskChildEnvironment(env).BEADS_CREDENTIALS_FILE, profile.credentialsFile);
  assert.equal(taskChildEnvironment(env).BEADS_DOLT_SERVER_HOST, '127.0.0.1');
  fs.rmSync(path.join(dolt, 'profile.json'));
  assert.throws(() => taskChildEnvironment(env), /fallback was refused/u);
  assert.throws(() => taskChildEnvironment({ NOTICEOS_DOLT_HOME: '' }), /absolute installation/u);
});

test('without a selected Dolt home there is no task client, whatever the installation folder holds', t => {
  const { home } = doltHome(t);
  const env = { NOTICEOS_HOME: home, NOTICEOS_TASK_CLIENT_PROFILE: path.join(home, 'task-client.json'), PATH: '/bin' };
  assert.equal(declaredTaskClient(env), null);
  assert.equal(taskChildEnvironment(env), env);
});

test('a declared client file gives its bd children only its own selectors, and is refused when unsafe', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-task-client-file-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = { host: 'dolt', port: 3306, user: 'noticeos', clientHome: path.join(home, 'client-home'), credentialsFile: path.join(home, 'credentials') };
  fs.mkdirSync(profile.clientHome, { mode: 0o700 });
  fs.writeFileSync(profile.credentialsFile, '[dolt:3306]\npassword=synthetic-private-sentinel\n', { mode: 0o600 });
  const file = path.join(home, 'client.json'); fs.writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
  assert.deepEqual(readDeclaredTaskClient(file), profile);
  const env = taskClientEnvironment(profile, { PATH: '/own/tools', HOME: '/other', BEADS_DOLT_PASSWORD: 'private', DATABASE_URL: 'private' });
  assert.equal(env.BEADS_DOLT_SERVER_HOST, 'dolt'); assert.equal(env.HOME, profile.clientHome); assert.equal(env.PATH, '/own/tools');
  for (const key of ['DATABASE_URL', 'BEADS_DOLT_PASSWORD']) assert.equal(env[key], undefined);
  assert.ok(!JSON.stringify(env).includes('synthetic-private-sentinel'));
  fs.chmodSync(profile.credentialsFile, 0o644);
  assert.throws(() => readDeclaredTaskClient(file), /cannot be read/u);
});
