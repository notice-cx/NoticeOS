#!/usr/bin/env node
// Enroll the verified first owner of an explicitly selected standalone workspace.
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { openEmailCodeLogin } from '../packages/postgres/src/email-code.mjs';
import { openPlatformProvisioning, StandaloneOwnerMigrationRequired } from '../packages/postgres/src/platform-provisioning.mjs';
import { isPrivateTowerOrigin } from './browser-request-policy.mjs';
import { EMAIL_CODE_PATHS, emailEnrollmentUrl } from './identity-protocol.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { ntasksActivationVerifier } from './ntasks-activation.mjs';
import { readLocalIdentityMail, smtpIdentityMail } from './local-identity-mail.mjs';

const format = 'noticeos-standalone-owner/1';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const email = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/u;
const token = /^ntasks_service\.[A-Za-z0-9._~-]{1,1024}$/u;
const invalid = () => new Error('The private standalone owner plan or command is invalid.');
const mailRequired = 'Restore the private SMTP mail file beside the owner plan before requesting a code.';
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

function localDatabase(value, role) {
  if (typeof value !== 'string') throw invalid();
  const url = new URL(value);
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !['postgres', '127.0.0.1'].includes(url.hostname)
    || url.username !== role || !url.password || !/^\/[a-z0-9_]+$/u.test(url.pathname) || url.hash
    || (url.search && url.search !== '?sslmode=disable')) throw invalid();
  return url;
}

function readPlan(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || realpathSync(file) !== file) throw invalid();
  const handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 16_384) throw invalid();
    const input = JSON.parse(readFileSync(handle, 'utf8'));
    const fields = ['format', 'workspaceId', 'intendedEmail', 'trustedOrigin', 'identityDatabaseUrl', 'platformDatabaseUrl', 'identitySecret', 'ntasks'];
    if (Object.hasOwn(input ?? {}, 'mail')) fields.push('mail');
    if (Object.hasOwn(input ?? {}, 'mailDelivery')) fields.push('mailDelivery');
    if (!exact(input, fields) || input.format !== format || !uuid.test(input.workspaceId)
      || typeof input.intendedEmail !== 'string' || input.intendedEmail.length > 320 || !email.test(input.intendedEmail)
      || typeof input.identitySecret !== 'string' || !/^[A-Za-z0-9_-]{64}$/u.test(input.identitySecret)
      || typeof input.trustedOrigin !== 'string') throw invalid();
    const platform = localDatabase(input.platformDatabaseUrl, 'noticeos_platform');
    const identity = localDatabase(input.identityDatabaseUrl, 'noticeos_identity');
    if (platform.host !== identity.host || platform.pathname !== identity.pathname) throw invalid();
    const tower = new URL(input.trustedOrigin);
    if (tower.origin !== input.trustedOrigin || (tower.protocol !== 'https:'
      && (tower.protocol !== 'http:' || (tower.hostname !== '127.0.0.1' && !isPrivateTowerOrigin(input.trustedOrigin))))) throw invalid();
    const tasks = input.ntasks;
    if (!exact(tasks, ['origin', 'workspaceId', 'projectId']) || !uuid.test(tasks.workspaceId) || !uuid.test(tasks.projectId)
      || typeof tasks.origin !== 'string') throw invalid();
    const origin = new URL(tasks.origin);
    if (origin.origin !== tasks.origin || (origin.protocol !== 'https:'
      && (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'))) throw invalid();
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

export async function runStandaloneOwner(args, input, { smtpLaunch } = {}) {
  const [action, file, enrollmentId] = args;
  if (!['prepare', 'send-code', 'verify-code', 'activate'].includes(action)
    || (action === 'prepare' ? args.length !== 2 : args.length !== 3 || !uuid.test(enrollmentId))) throw invalid();
  const plan = readPlan(file);
  const localTowerOrigin = isPrivateTowerOrigin(plan.trustedOrigin) ? plan.trustedOrigin : undefined;
  const binding = { workspaceId: plan.workspaceId, ntasksWorkspaceId: plan.ntasks.workspaceId,
    ntasksOrigin: plan.ntasks.origin, projectId: plan.ntasks.projectId };
  if (action === 'send-code' || action === 'verify-code') {
    if (!plan.mail && !plan.smtp) throw new Error('Configure delivery to the intended email before requesting an enrollment code.');
    const smtp = plan.smtp && smtpIdentityMail(plan.smtp, recipient => recipient === plan.intendedEmail, { launch: smtpLaunch });
    const login = openEmailCodeLogin({ connectionString: plan.identityDatabaseUrl, trustedOrigin: plan.trustedOrigin, localTowerOrigin,
      sessionSecret: plan.identitySecret, peerAddress: '127.0.0.1', standaloneOwnerWorkspaceId: plan.workspaceId,
      async deliver(message) {
        if (!smtp) return sendMail(plan.mail, plan.intendedEmail, message);
        if (!/^\d{6}$/u.test(message.code)) throw new Error('Mail delivery refused.');
        await smtp({ from: plan.smtp.from, to: message.email, subject: 'Your NoticeOS sign-in code',
          text: `Your NoticeOS sign-in code is ${message.code}.` });
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
      return { workspaceId: plan.workspaceId, enrollmentId, emailVerified: verify };
    } finally { await login.close(); }
  }

  const serviceToken = action === 'activate' ? await readCredential(input, 1056, token, tokenRequired) : null;
  const provisioning = openPlatformProvisioning({ platformConnectionString: plan.platformDatabaseUrl,
    identityConnectionString: plan.identityDatabaseUrl, trustedOrigin: plan.trustedOrigin, localTowerOrigin, sessionSecret: plan.identitySecret,
    async verifyProject(mapping, budget) {
      if (serviceToken === null || mapping.workspaceId !== plan.workspaceId || mapping.projectId !== plan.ntasks.projectId) throw invalid();
      await ntasksActivationVerifier({ ...mapping, origin: plan.ntasks.origin, ntasksWorkspaceId: plan.ntasks.workspaceId,
        serviceToken })(mapping, budget);
    } });
  try {
    if (action === 'activate') return await provisioning.activateStandaloneOwner({ ...binding, enrollmentId, intendedEmail: plan.intendedEmail });
    const prepared = await provisioning.prepareStandaloneOwner({ ...binding, intendedEmail: plan.intendedEmail,
      expiresAt: new Date(Date.now() + 6 * 86400_000).toISOString() });
    return { ...prepared, enrollmentUrl: emailEnrollmentUrl(plan.trustedOrigin, { kind: 'platform', id: prepared.enrollmentId }) };
  } finally { await provisioning.close(); }
}

async function main(args) {
  try {
    process.stdout.write(JSON.stringify(await runStandaloneOwner(args, process.stdin)) + '\n');
    return 0;
  } catch (error) {
    const safe = new Set([invalid().message, 'Configure delivery to the intended email before requesting an enrollment code.',
      'Email enrollment did not complete.', mailRequired, codeRequired, tokenRequired]);
    const message = error instanceof StandaloneOwnerMigrationRequired || safe.has(error?.message) ? error.message
      : 'Standalone owner enrollment refused. Check the selected workspace, verified email and project binding.';
    process.stderr.write(message + '\n');
    return 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main(process.argv.slice(2));
