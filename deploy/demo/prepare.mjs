// Offline secret preparation. No database, listener or inherited secret input.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function refuse() { throw new Error('Demo preparation refused.'); }
function plainDirectory(directory) {
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) refuse();
}
function readPlain(filename, limit = 65536) {
  if (fs.realpathSync(filename) !== filename || !fs.lstatSync(filename).isFile() || fs.statSync(filename).size > limit) refuse();
  return fs.readFileSync(filename);
}
export function demoPreparationConfig(value, now = Date.now()) {
  const keys = ['version', 'publicOrigin', 'seed', 'cutoff', 'release', 'serviceExpiresAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key))) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) refuse();
  const origin = new URL(value.publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== value.publicOrigin || origin.username || origin.password) refuse();
  if (value.version !== 1 || typeof value.seed !== 'string' || !value.seed || value.seed.length > 128 || !/^[a-f0-9]{40}$/u.test(value.release)) refuse();
  for (const name of ['cutoff', 'serviceExpiresAt']) {
    if (typeof value[name] !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value[name]) || !Number.isFinite(Date.parse(value[name])) || new Date(value[name]).toISOString() !== value[name]) refuse();
  }
  if (Date.parse(value.cutoff) > now) refuse();
  const expiry = Date.parse(value.serviceExpiresAt);
  if (expiry <= now || expiry - now > 366 * 86400000) refuse();
  return Object.freeze({ ...value });
}
export function prepareDemo({ configFile, bootstrapRoot, stateRoot, doltRoot, sourceRoot, artifactRoot, binaryPath, doltBinaryPath, uid = 1000, gid = 1000 }) {
  for (const directory of [bootstrapRoot, stateRoot, doltRoot]) plainDirectory(directory);
  const config = demoPreparationConfig(JSON.parse(readPlain(configFile)));
  if (readPlain(path.join(sourceRoot, 'source-commit')).toString().trim() !== config.release) refuse();
  const configHash = hash(JSON.stringify(config));
  const marker = path.join(bootstrapRoot, 'prepared.json');
  if (fs.existsSync(marker)) {
    const receipt = JSON.parse(readPlain(marker));
    if (receipt.version !== 1 || receipt.configHash !== configHash) refuse();
    for (const name of ['postgres-password', 'dolt-password', 'bootstrap.json']) {
      const target = path.join(bootstrapRoot, name); readPlain(target);
      if ((fs.statSync(target).mode & 0o777) !== 0o600 || fs.statSync(target).uid !== uid) refuse();
    }
    return receipt;
  }
  // Any interrupted preparation is retained for explicit recovery, never reset.
  if ([bootstrapRoot, stateRoot, doltRoot].some(directory => fs.readdirSync(directory).length)) refuse();
  const manifest = JSON.parse(readPlain(path.join(artifactRoot, 'manifest.json'), 2 * 1024 * 1024));
  if (manifest.version !== 1 || !/^[a-f0-9]{64}$/u.test(manifest.release)) refuse();
  const password = () => randomBytes(32).toString('hex');
  const postgresPassword = password(), doltPassword = password();
  const request = { version: 1, stateRoot, sourceRoot, artifactRoot, workerStateRoot: path.join(stateRoot, 'worker'),
    publicOrigin: config.publicOrigin, listen: { host: '0.0.0.0', port: 8080 }, seed: config.seed, cutoff: config.cutoff, release: config.release,
    serviceExpiresAt: config.serviceExpiresAt,
    postgres: { adminUrl: `postgres://postgres:${postgresPassword}@postgres:5432/noticeos?sslmode=disable` },
    dolt: { host: '127.0.0.1', port: 3306, adminUser: 'noticeos_owner', adminPassword: doltPassword, tls: false },
    binary: { path: binaryPath, sha256: hash(readPlain(binaryPath, 256 * 1024 * 1024)) },
    doltBinary: { path: doltBinaryPath, sha256: hash(readPlain(doltBinaryPath, 256 * 1024 * 1024)) } };
  for (const directory of [bootstrapRoot, stateRoot, doltRoot]) { fs.chownSync(directory, uid, gid); fs.chmodSync(directory, 0o700); }
  const write = (name, bytes) => { const target = path.join(bootstrapRoot, name); fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); fs.chownSync(target, uid, gid); };
  write('postgres-password', postgresPassword + '\n'); write('dolt-password', doltPassword + '\n');
  write('bootstrap.json', JSON.stringify(request) + '\n');
  const receipt = { version: 1, configHash, artifactRelease: manifest.release };
  write('prepared.json', JSON.stringify(receipt) + '\n');
  return receipt;
}
if (process.argv[1] === import.meta.filename) {
  try {
    if (process.argv.length !== 2) refuse();
    prepareDemo({ configFile: '/config/demo.json', bootstrapRoot: '/setup', stateRoot: '/state', doltRoot: '/dolt',
      sourceRoot: '/opt/noticeos', artifactRoot: '/opt/noticeos/demo-artifacts', binaryPath: '/usr/local/bin/bd', doltBinaryPath: '/usr/local/bin/dolt' });
    process.stdout.write('Demo preparation complete.\n');
  } catch { process.stderr.write('Demo preparation refused; preserve partial volumes for recovery.\n'); process.exitCode = 1; }
}
