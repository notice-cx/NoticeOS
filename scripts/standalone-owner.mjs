#!/usr/bin/env node
// Enroll the verified first owner of an explicitly selected standalone workspace.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { openEmailCodeLogin } from '../packages/postgres/src/email-code.mjs';
import { openPlatformProvisioning, PlatformProjectReserved, StandaloneOwnerMigrationRequired } from '../packages/postgres/src/platform-provisioning.mjs';
import { isPrivateTowerOrigin } from './browser-request-policy.mjs';
import { EMAIL_CODE_PATHS, emailEnrollmentUrl } from './identity-protocol.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { ntasksActivationVerifier } from './ntasks-activation.mjs';
import { readLocalIdentityMail, smtpIdentityMail } from './local-identity-mail.mjs';
import { MANAGED_START_PORTS } from './start-ports.mjs';

const format = 'noticeos-standalone-owner/1';
const newWorkspaceFormat = 'noticeos-local-workspace-owner/1';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const email = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/u;
const { z } = createRequire(new URL('../packages/contract/package.json', import.meta.url))('zod');
const enrollmentEmail = z.email();
const token = /^ntasks_service\.[A-Za-z0-9._~-]{1,1024}$/u;
const invalid = () => new Error('The private standalone owner plan or command is invalid.');
const mailRequired = 'Restore the private SMTP mail file beside the owner plan before requesting a code.';
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

function localDatabase(value, role, newWorkspace) {
  if (typeof value !== 'string') throw invalid();
  const url = new URL(value);
  const databaseName = newWorkspace ? /^\/[a-zA-Z0-9_-]{1,63}$/u : /^\/[a-z0-9_]+$/u;
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !['postgres', '127.0.0.1'].includes(url.hostname)
    || url.username !== role || !url.password || !databaseName.test(url.pathname) || url.hash
    || (url.search && url.search !== '?sslmode=disable')) throw invalid();
  return url;
}

function readPlan(file, newWorkspace, invalid) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || realpathSync(file) !== file) throw invalid();
  const handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 16_384) throw invalid();
    const input = JSON.parse(readFileSync(handle, 'utf8'));
    const fields = ['format', 'workspaceId', 'intendedEmail', 'trustedOrigin', 'identityDatabaseUrl', 'platformDatabaseUrl', 'identitySecret', 'ntasks'];
    if (newWorkspace) fields.push('slug', 'displayName', 'serviceId');
    if (Object.hasOwn(input ?? {}, 'mail')) fields.push('mail');
    if (Object.hasOwn(input ?? {}, 'mailDelivery')) fields.push('mailDelivery');
    const secret = input?.identitySecret;
    const validSecret = typeof secret === 'string'
      && (newWorkspace ? secret.length >= 32 && secret.length <= 512 : /^[A-Za-z0-9_-]{64}$/u.test(secret));
    if (!exact(input, fields) || input.format !== (newWorkspace ? newWorkspaceFormat : format)
      || typeof input.workspaceId !== 'string' || !uuid.test(input.workspaceId)
      || typeof input.intendedEmail !== 'string' || input.intendedEmail.length > 320 || !enrollmentEmail.safeParse(input.intendedEmail).success
      || !validSecret
      || typeof input.trustedOrigin !== 'string') throw invalid();
    if (newWorkspace && (typeof input.slug !== 'string' || typeof input.displayName !== 'string'
      || typeof input.serviceId !== 'string' || !uuid.test(input.serviceId))) throw invalid();
    const platform = localDatabase(input.platformDatabaseUrl, 'noticeos_platform', newWorkspace);
    const identity = localDatabase(input.identityDatabaseUrl, 'noticeos_identity', newWorkspace);
    if (platform.host !== identity.host || platform.pathname !== identity.pathname) throw invalid();
    const tower = new URL(input.trustedOrigin);
    if (tower.origin !== input.trustedOrigin || (tower.protocol !== 'https:'
      && (tower.protocol !== 'http:' || (tower.hostname !== '127.0.0.1' && !isPrivateTowerOrigin(input.trustedOrigin))))) throw invalid();
    const tasks = input.ntasks;
    if (!exact(tasks, ['origin', 'workspaceId', 'projectId'])
      || typeof tasks.workspaceId !== 'string' || !uuid.test(tasks.workspaceId)
      || typeof tasks.projectId !== 'string' || !uuid.test(tasks.projectId)
      || typeof tasks.origin !== 'string') throw invalid();
    const origin = new URL(tasks.origin);
    if (origin.origin !== tasks.origin || (origin.protocol !== 'https:'
      && (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'))) throw invalid();
    if (newWorkspace && (platform.hostname !== '127.0.0.1' || tower.hostname !== '127.0.0.1'
      || tower.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:'
      || !platform.port || !tower.port || !origin.port
      || [...MANAGED_START_PORTS, Number(platform.port), Number(tower.port), Number(tower.port) + 1].includes(Number(origin.port)))) throw invalid();
    if (input.mail !== undefined && (input.mailDelivery !== undefined || !exact(input.mail, ['sendmail', 'from'])
      || typeof input.mail.sendmail !== 'string' || !path.isAbsolute(input.mail.sendmail)
      || /[\r\n\0]/u.test(input.mail.sendmail) || typeof input.mail.from !== 'string' || !email.test(input.mail.from))) throw invalid();
    let smtp;
    if (input.mailDelivery !== undefined) {
      try { smtp = readLocalIdentityMail(input.mailDelivery, file); }
      catch { throw new Error(mailRequired); }
    }
    return { ...input, intendedEmail: input.intendedEmail.toLowerCase(), smtp };
  } finally { closeSync(handle); }
}

async function sendMail(config, intendedEmail, message) {
  if (message.email !== intendedEmail || !/^\d{6}$/u.test(message.code)) throw new Error('Mail delivery refused.');
  const child = spawn(config.sendmail, ['-i', '-t'], { env: { PATH: '/usr/bin:/bin' },
    signal: AbortSignal.timeout(10_000), killSignal: 'SIGKILL', stdio: ['pipe', 'ignore', 'ignore'] });
  const finished = new Promise(resolve => {
    child.on('error', () => undefined);
    child.once('close', code => resolve(code === 0));
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(`From: ${config.from}\nTo: ${intendedEmail}\nSubject: Your NoticeOS sign-in code\nContent-Type: text/plain; charset=utf-8\n\nYour NoticeOS sign-in code is ${message.code}.\n`);
  if (!await finished) throw new Error('Mail delivery refused.');
}

async function readCredential(input, limit, format, failure) {
  let value = '';
  for await (const part of input) {
    value += String(part);
    if (value.length > limit) throw new Error(failure);
  }
  value = value.trim();
  if (!format.test(value)) throw new Error(failure);
  return value;
}

const codeRequired = 'Provide the six-digit email code on standard input.';
const tokenRequired = 'Provide the project-scoped Ntasks service credential on standard input.';
const newWorkspaceInvalid = () => new Error('The private local workspace owner plan or command is invalid.');

export async function runStandaloneOwner(args, input, { smtpLaunch } = {}) {
  return runOwnerEnrollment(args, input, { smtpLaunch });
}

function ntasksProject(plan) {
  // The directory uses the physical IDs. The credential reference pins the
  // exact origin and the planned workspace and scheduler.
  const { origin, workspaceId, projectId } = plan.ntasks;
  const hash = createHash('sha256').update(JSON.stringify([
    'local-ntasks/1', plan.workspaceId, plan.slug, plan.serviceId, origin, workspaceId, projectId,
  ])).digest('hex');
  return {
    projectId,
    executorRef: workspaceId,
    credentialRef: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    databaseKey: 'n_' + projectId.replaceAll('-', ''),
  };
}

async function runOwnerEnrollment(args, input, { newWorkspace = false, smtpLaunch } = {}) {
  const invalidPlan = newWorkspace ? newWorkspaceInvalid : invalid;
  const [action, file, enrollmentId] = args;
  const setup = action === 'prepare' || (newWorkspace && action === 'recover');
  if (setup ? args.length !== 2 : !['send-code', 'verify-code', 'activate'].includes(action)
    || args.length !== 3 || !uuid.test(enrollmentId)) throw invalidPlan();
  const plan = readPlan(file, newWorkspace, invalidPlan);
  const localTowerOrigin = isPrivateTowerOrigin(plan.trustedOrigin) ? plan.trustedOrigin : undefined;
  const binding = { workspaceId: plan.workspaceId, ntasksWorkspaceId: plan.ntasks.workspaceId,
    ntasksOrigin: plan.ntasks.origin, projectId: plan.ntasks.projectId };
  if (action === 'send-code' || action === 'verify-code') {
    if (!plan.mail && !plan.smtp) throw new Error('Configure delivery to the intended email before requesting an enrollment code.');
    const smtp = plan.smtp && smtpIdentityMail(plan.smtp, recipient => recipient === plan.intendedEmail, { launch: smtpLaunch });
    let delivered = false;
    const login = openEmailCodeLogin({ connectionString: plan.identityDatabaseUrl, trustedOrigin: plan.trustedOrigin, localTowerOrigin,
      sessionSecret: plan.identitySecret, peerAddress: '127.0.0.1',
      ...(newWorkspace ? { provisioningWorkspaceId: plan.workspaceId } : { standaloneOwnerWorkspaceId: plan.workspaceId }),
      async deliver(message) {
        if (smtp) {
          if (!/^\d{6}$/u.test(message.code)) throw new Error('Mail delivery refused.');
          await smtp({ from: plan.smtp.from, to: message.email, subject: 'Your NoticeOS sign-in code',
            text: `Your NoticeOS sign-in code is ${message.code}.` });
        } else await sendMail(plan.mail, plan.intendedEmail, message);
        delivered = true;
      } });
    try {
      const verify = action === 'verify-code';
      const request = new Request(plan.trustedOrigin + EMAIL_CODE_PATHS[verify ? 'verify' : 'request'], { method: 'POST',
        headers: { origin: plan.trustedOrigin, 'content-type': 'application/json' }, body: JSON.stringify({
          email: plan.intendedEmail, ...(verify ? { otp: await readCredential(input, 16, /^\d{6}$/u, codeRequired) } : {}),
        }) });
      const enrollment = { kind: 'platform', id: enrollmentId };
      const response = verify ? await login.verifyCode(request, enrollment) : await login.requestCode(request, enrollment);
      if (response.status !== (verify ? 200 : 202)) throw new Error('Email enrollment did not complete.');
      if (!verify && !delivered) throw new Error('No enrollment code was sent. Check the enrollment ID, address and expiry.');
      return { workspaceId: plan.workspaceId, enrollmentId, emailVerified: verify };
    } finally { await login.close(); }
  }

  const serviceToken = action === 'activate' ? await readCredential(input, 1056, token, tokenRequired) : null;
  const project = newWorkspace ? ntasksProject(plan) : null;
  const provisioning = openPlatformProvisioning({ platformConnectionString: plan.platformDatabaseUrl,
    identityConnectionString: plan.identityDatabaseUrl, trustedOrigin: plan.trustedOrigin, localTowerOrigin, sessionSecret: plan.identitySecret,
    async verifyProject(mapping, budget) {
      if (serviceToken === null || mapping.workspaceId !== plan.workspaceId || mapping.projectId !== plan.ntasks.projectId
        || (project && (mapping.executorRef !== project.executorRef || mapping.databaseKey !== project.databaseKey
          || mapping.credentialRef !== project.credentialRef))) throw invalidPlan();
      await ntasksActivationVerifier({ ...mapping, origin: plan.ntasks.origin, ntasksWorkspaceId: plan.ntasks.workspaceId,
        serviceToken })(mapping, budget);
    } });
  try {
    if (action === 'activate') {
      if (!project) return await provisioning.activateStandaloneOwner({ ...binding, enrollmentId, intendedEmail: plan.intendedEmail });
      const activated = await provisioning.activate({ workspaceId: plan.workspaceId, enrollmentId, projectId: project.projectId },
        { serviceId: plan.serviceId, intendedEmail: plan.intendedEmail });
      return { ...activated, serviceId: plan.serviceId };
    }
    const { workspaceId, intendedEmail, displayName, slug } = plan;
    const expiresAt = new Date(Date.now() + 6 * 86400_000).toISOString();
    let prepared;
    if (!project) prepared = await provisioning.prepareStandaloneOwner({ ...binding, intendedEmail, expiresAt });
    else if (action === 'recover') prepared = await provisioning.recoverPreparation({ workspaceId, displayName, intendedEmail }, project);
    else prepared = await provisioning.prepare({ workspaceId, slug, displayName, intendedEmail, expiresAt }, project);
    return { ...prepared, enrollmentUrl: emailEnrollmentUrl(plan.trustedOrigin, { kind: 'platform', id: prepared.enrollmentId }) };
  } finally { await provisioning.close(); }
}

export async function ownerEnrollmentMain(args, { newWorkspace = false } = {}) {
  try {
    process.stdout.write(JSON.stringify(await runOwnerEnrollment(args, process.stdin, { newWorkspace })) + '\n');
    return 0;
  } catch (error) {
    const safe = new Set([invalid().message, newWorkspaceInvalid().message, 'Configure delivery to the intended email before requesting an enrollment code.',
      'Email enrollment did not complete.', 'No enrollment code was sent. Check the enrollment ID, address and expiry.', mailRequired, codeRequired, tokenRequired]);
    const message = error instanceof StandaloneOwnerMigrationRequired || error instanceof PlatformProjectReserved || safe.has(error?.message) ? error.message
      : newWorkspace ? 'Local workspace owner enrollment refused. Check the workspace ID, verified email and project binding.'
        : 'Standalone owner enrollment refused. Check the selected workspace, verified email and project binding.';
    process.stderr.write(message + '\n');
    return newWorkspace && error instanceof PlatformProjectReserved ? 2 : 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await ownerEnrollmentMain(process.argv.slice(2));
