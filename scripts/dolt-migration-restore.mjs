// Native capture has its own truthful source-version format. Never pretend it
// was made by the current managed backup helper or rewrite its completion marker.
import * as fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { verifyStoppedDoltCapture } from './dolt-migration-capture.mjs';
import { DOLT_VERSION, doltExecutor, doltComposeArgs, validateIsolatedDoltProfile, startDoltPlan } from './dolt-host.mjs';

const refuse = () => { throw new Error('Native restore refused or failed; any new target resources were preserved for explicit recovery.'); };

export async function restoreNativeDoltCapture(profile, captureDirectory, { globalConfigName = 'global-config', ...options } = {}) {
  try {
    validateIsolatedDoltProfile(profile);
    const home = path.dirname(path.dirname(profile.credentialsFile));
    for (let current = home; ; current = path.dirname(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (current === home && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) refuse();
      if (path.dirname(current) === current) break;
    }
    const expected = startDoltPlan({ root: path.resolve(path.dirname(profile.composeFile), '../../..'), home, port: profile.port - 3 });
    if (Object.keys(expected).some(key => profile[key] !== expected[key])) refuse();
    // Compatibility is qualified for this exact pair. New pairs require their
    // own proof; no semver inference or accidental downgrade is accepted.
    const marker = verifyStoppedDoltCapture(captureDirectory);
    if (marker.sourceVersion !== '2.2.3' || DOLT_VERSION !== '2.4.0' ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/u.test(globalConfigName) ||
      !Object.hasOwn(marker.metadataPresent, globalConfigName) ||
      Object.hasOwn(marker.inventory.files, 'data/.noticeos-initialized') ||
      fs.lstatSync(path.dirname(profile.credentialsFile), { throwIfNoEntry: false })) refuse();
    const execute = await doltExecutor(profile, options);
    const args = doltComposeArgs(profile);
    const service = await execute([...args, 'ps', '--all', '--quiet', 'dolt']);
    const volume = await execute(['volume', 'inspect', `${profile.project}_dolt-data`]);
    if (service.code !== 0 || service.stdout.trim() || volume.code === 0 || !/no such volume/iu.test(volume.stderr)) refuse();
    fs.mkdirSync(path.dirname(profile.credentialsFile), { mode: 0o700 });
    fs.mkdirSync(profile.secretsDir, { mode: 0o700 });
    fs.mkdirSync(path.join(path.dirname(profile.credentialsFile), 'client-home'), { mode: 0o700 });
    const passwords = Object.fromEntries(['root', 'noticeos'].map(name => [name, randomBytes(32).toString('hex')]));
    for (const [name, password] of Object.entries(passwords)) fs.writeFileSync(path.join(profile.secretsDir, name), `${password}\n`, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(profile.credentialsFile, `[127.0.0.1:${profile.port}]\npassword=${passwords.noticeos}\n`, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(path.dirname(profile.credentialsFile), 'profile.json'), JSON.stringify(profile, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const stage = `/var/lib/dolt/.noticeos-native-restore-${randomBytes(16).toString('hex')}`;
    if ((await execute([...args, 'create', 'dolt'], 120_000)).code !== 0 ||
      (await execute([...args, 'cp', `${captureDirectory}/.`, `dolt:${stage}`], 300_000)).code !== 0 ||
      (await execute([...args, 'run', '--rm', '--no-deps', '--no-TTY', '--entrypoint', '/bin/bash', 'dolt',
        '/etc/noticeos/restore-native.sh', stage, globalConfigName], 300_000)).code !== 0 ||
      (await execute([...args, 'up', '--detach', '--wait', '--wait-timeout', '90', 'dolt'], 120_000)).code !== 0) refuse();
    return { format: marker.format, sourceVersion: marker.sourceVersion, targetVersion: DOLT_VERSION,
      databases: [...marker.databases], authentication: 'Target profile accounts added; original root@localhost removed only on target.' };
  } catch { refuse(); }
}
