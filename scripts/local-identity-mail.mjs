import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FORMAT = 'noticeos-identity-smtp/1';
const MAIL_ADDRESS = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/u;
const clean = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const mailAddress = value => clean(value, 320) && MAIL_ADDRESS.test(value);
const failure = () => new Error('Identity mail delivery unavailable.');

/** The reference names a private bootstrap file beside the operator's own plan. */
export function readLocalIdentityMail(reference, planFile) {
  if (typeof reference !== 'string' || !/^[a-z][a-z0-9-]{0,100}\.json$/u.test(reference) || !path.isAbsolute(planFile)) throw failure();
  const file = path.join(path.dirname(planFile), reference);
  let fd;
  try {
    if (realpathSync(file) !== file) throw failure();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 8192) throw failure();
    const buffer = Buffer.alloc(8193);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 8192 || bytes !== stat.size) throw failure();
    const config = JSON.parse(buffer.toString('utf8', 0, bytes));
    if (!config || Object.keys(config).sort().join() !== 'format,from,password,url,username' || config.format !== FORMAT
      || !mailAddress(config.from) || !clean(config.url, 2048) || !clean(config.username, 512) || config.username.includes(':')
      || !clean(config.password, 1024)) throw failure();
    const url = new URL(config.url);
    if (url.protocol !== 'smtps:' || !url.hostname || url.username || url.password || url.search || url.hash
      || !['', '/'].includes(url.pathname) || !/^smtps:\/\//u.test(config.url)) throw failure();
    return Object.freeze({ from: config.from, url: url.href, username: config.username, password: config.password });
  } catch { throw failure(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

const option = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';

/** Pass relay authentication through an unlinked file descriptor, away from
 * command arguments, environment, child diagnostics and the message stream. */
function openCurlConfig(config, recipient) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noticeos-smtp-'));
  const file = path.join(dir, 'config');
  let fd;
  try {
    writeFileSync(file, `url = ${option(config.url)}\nuser = ${option(`${config.username}:${config.password}`)}\nmail-from = ${option(config.from)}\nmail-rcpt = ${option(recipient)}\n`,
      { mode: 0o600, flag: 'wx' });
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    rmSync(dir, { recursive: true });
    return fd;
  } catch {
    if (fd !== undefined) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
    throw failure();
  }
}

export function smtpIdentityMail(config, accepts, { launch = spawn, signal } = {}) {
  return async message => {
    if (message?.from !== config.from || !mailAddress(message.to) || !accepts(message.to)
      || !clean(message.subject, 128) || typeof message.text !== 'string' || !message.text || Buffer.byteLength(message.text) > 2048
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message.text) || /\r(?!\n)/u.test(message.text)) throw failure();
    const bounded = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
    bounded.throwIfAborted();
    const id = randomUUID();
    const wire = [`From: ${config.from}`, `To: ${message.to}`, `Subject: ${message.subject}`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${id}@${config.from.split('@')[1]}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '',
      message.text.replace(/\r?\n/gu, '\r\n'), ''].join('\r\n');
    const fd = openCurlConfig(config, message.to);
    let child;
    try {
      child = launch('/usr/bin/curl', ['--disable', '--config', '/dev/fd/3', '--silent', '--proto', '=smtps',
        '--tlsv1.2', '--connect-timeout', '5', '--max-time', '9', '--upload-file', '-'], {
        env: { PATH: '/usr/bin:/bin' }, signal: bounded, killSignal: 'SIGKILL', stdio: ['pipe', 'ignore', 'ignore', fd],
      });
    } catch { throw failure(); }
    finally { closeSync(fd); }
    const finished = new Promise(resolve => {
      child.on('error', () => undefined);
      child.once('close', code => resolve(code === 0));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(wire);
    if (!await finished) throw failure();
    return id;
  };
}
