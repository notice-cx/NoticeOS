// The fresh installation's declared task server. Never infer a target from
// Docker inventory, a default port, global credentials or the current hub.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { devNull } from 'node:os';
import { doorIsHeld } from './ingest-door.mjs';
import { localDockerEndpoint } from './postgres-compose.mjs';
import { runCommand } from './run-command.mjs';
import { startDoltPlan, validateDoltProfile, validateIsolatedDoltProfile, readDoltProfile, doltEnvironment, readDoltCredentials } from './dolt-profile.mjs';
export { startDoltPlan, validateDoltProfile, validateIsolatedDoltProfile, readDoltProfile, doltEnvironment, readDoltCredentials } from './dolt-profile.mjs';
export const DOLT_VERSION = '2.4.0';
export const DOLT_IMAGE = 'dolthub/dolt-sql-server:2.4.0@sha256:8771be743f1b81b1e9d8d12b9587798446fa0bf34c56ec5b7b14539f895daa0b';
const refusal = (line) => ({ ok: false, line });
export function doltComposeArgs(profile) {
    validateDoltProfile(profile);
    return ['compose', '-p', profile.project, '-f', profile.composeFile, '--env-file', devNull];
}
export async function doltExecutor(profile, { run = runCommand, env = process.env } = {}) {
    const selected = doltEnvironment(profile, env);
    const endpoint = await localDockerEndpoint(run, { env: selected });
    if (!endpoint)
        throw new Error('Dolt needs a local Docker endpoint.');
    // Freeze the verified endpoint rather than allowing a context change between
    // the guard and subsequent requests. No host-wide listing is used.
    delete selected.DOCKER_CONTEXT;
    selected.DOCKER_HOST = endpoint;
    return (args, timeoutMs = 30_000) => run('docker', args, { env: selected, timeoutMs });
}
export async function preflightDolt(plan, { env = process.env, run = runCommand, held = doorIsHeld } = {}) {
    try {
        const prior = readDoltProfile(plan.home);
        const profile = validateIsolatedDoltProfile(prior ?? startDoltPlan(plan));
        if (prior) {
            const expected = startDoltPlan(plan);
            if (profile.project !== expected.project || profile.port !== expected.port)
                return refusal('The declared task server does not match this installation.');
            readDoltCredentials(profile);
            const execute = await doltExecutor(profile, { env, run });
            const volume = await execute(['volume', 'inspect', `${profile.project}_dolt-data`]);
            const service = await execute([...doltComposeArgs(profile), 'ps', '--all', '--quiet', 'dolt']);
            if (volume.code !== 0 || service.code !== 0 || !service.stdout.trim())
                return refusal('Declared task resources are missing; explicit recovery is required.');
            return { ok: true, created: false, profile, env: doltEnvironment(profile, env) };
        }
        if (fs.existsSync(path.join(plan.home, 'dolt')))
            return refusal('Task setup files already exist; explicit recovery is required.');
        if (await held(`http://127.0.0.1:${profile.port}`))
            return refusal('The derived task port (--port + 3) is in use.');
        const execute = await doltExecutor(profile, { env, run });
        const service = await execute([...doltComposeArgs(profile), 'ps', '--all', '--quiet', 'dolt']);
        if (service.code !== 0 || service.stdout.trim())
            return refusal('Task service absence is unproven; choose a new installation or recover explicitly.');
        const volume = await execute(['volume', 'inspect', `${profile.project}_dolt-data`]);
        if (volume.code === 0 || !/no such volume/iu.test(volume.stderr))
            return refusal('Task volume absence is unproven; choose a new installation or recover explicitly.');
        return { ok: true, created: false, profile };
    }
    catch {
        return refusal('Task server preflight failed; nothing was set up.');
    }
}
export async function prepareFreshDolt(plan, { fresh = false, env = process.env, run = runCommand, held = doorIsHeld } = {}) {
    try {
        const prior = readDoltProfile(plan.home);
        if (!prior && !fresh)
            return refusal('An existing installation needs explicit task-server setup.');
        const checked = await preflightDolt(plan, { env, run, held });
        if (!checked.ok)
            return checked;
        const profile = checked.profile;
        if (!prior) {
            fs.mkdirSync(path.dirname(profile.credentialsFile), { mode: 0o700 });
            fs.mkdirSync(profile.secretsDir, { mode: 0o700 });
            fs.mkdirSync(path.join(path.dirname(profile.credentialsFile), 'client-home'), { mode: 0o700 });
            const root = randomBytes(32).toString('hex');
            const noticeos = randomBytes(32).toString('hex');
            for (const [name, text] of [['root', `${root}\n`], ['noticeos', `${noticeos}\n`]]) {
                fs.writeFileSync(path.join(profile.secretsDir, name), text, { flag: 'wx', mode: 0o600 });
            }
            fs.writeFileSync(profile.credentialsFile, `[127.0.0.1:${profile.port}]\npassword=${noticeos}\n`, { flag: 'wx', mode: 0o600 });
            fs.writeFileSync(path.join(plan.home, 'dolt', 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        }
        readDoltCredentials(profile);
        const execute = await doltExecutor(profile, { env, run });
        const started = await execute([...doltComposeArgs(profile), 'up', '--detach', '--wait', '--wait-timeout', '90', 'dolt'], 120_000);
        if (started.code !== 0)
            return refusal('Task server startup failed; files preserved. Recover explicitly before retrying.');
        return { ok: true, created: !prior, profile, env: doltEnvironment(profile, env) };
    }
    catch {
        return refusal('Task server setup failed; any files were preserved for explicit recovery.');
    }
}
