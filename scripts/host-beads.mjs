#!/usr/bin/env node
// Optional agent compatibility adapter. The application image owns the client;
// no host binary, application listener or ambient server setting is used.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDeclaredTaskClient, taskClientEnvironment } from './task-client.mjs';
import { localDockerEndpoint } from './postgres-compose.mjs';
import { runCommand } from './run-command.mjs';
import { readDoltProfile, readDoltCredentials, isDoltProjectName } from './dolt-profile.mjs';

const refuse = () => { throw new Error('Bundled task client refused its declaration or resources.'); };
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n,]/u.test(value);
const actorName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !/[\0\r\n]/u.test(value);
const INPUT_LIMIT = 1024 * 1024;
const inputCommands = new Set(['create', 'new', 'update', 'comment']);
const booleanFlags = new Set(['sandbox', 'json', 'ignore-schema-skew', 'readonly', 'no-color', 'quiet', 'verbose', 'cpu-profile', 'help',
  'claim', 'force', 'allow-empty-description', 'ephemeral', 'persistent', 'no-history', 'history', 'silent', 'dry-run', 'validate', 'no-inherit-labels']);
const valueFlags = new Set(['actor', 'mem-profile', 'dolt-auto-commit', 'title', 'description', 'body', 'message', 'design', 'acceptance',
  'notes', 'append-notes', 'parent', 'assignee', 'priority', 'labels', 'type', 'id', 'author', 'if-assignee', 'if-status', 'status', 'defer',
  'due', 'repo', 'metadata', 'add-label', 'remove-label', 'set-labels', 'set-metadata', 'unset-metadata', 'spec-id', 'context', 'skills',
  'deps', 'estimate', 'file', 'graph']);
const issueShortValues = new Set(['a', 'd', 'm', 'p', 't', 'l', 'e', 's']);
const globalValueFlags = new Set(['actor', 'mem-profile', 'dolt-auto-commit']);
const globalBooleanFlags = new Set(['sandbox', 'json', 'ignore-schema-skew', 'readonly', 'no-color', 'quiet', 'verbose', 'cpu-profile', 'help']);
function lintInvocation(args) {
  let command = null; let json = false; let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg === '--json' || arg === '--json=true') json = true;
    else if (arg === '--json=false') json = false;
    else if (arg === '--help' || arg === '--help=true' || /^-[qv]*h[qvh]*$/u.test(arg)) help = true;
    else if (arg === '--help=false') help = false;
    else if (followingValue(arg, null) || (command === 'lint' && ['--type', '--status', '-t', '-s'].includes(arg))) index++;
    else if (!arg.startsWith('-') && command === null) command = arg;
  }
  return { lint: command === 'lint', json, help };
}
function booleanFlag(name, command) {
  return globalBooleanFlags.has(name) || (['create', 'new', 'update'].includes(command) && (booleanFlags.has(name) || name === 'stdin')) ||
    (command === 'comment' && name === 'stdin');
}
function longValueFlag(name, command) {
  if (globalValueFlags.has(name)) return true;
  if (['create', 'new', 'update'].includes(command)) return valueFlags.has(name) || ['body-file', 'description-file', 'design-file'].includes(name);
  return command === 'comment' ? name === 'file' : command === 'comments-add' && ['author', 'file'].includes(name);
}
function shortValueFlag(arg, command) {
  return ['create', 'new', 'update'].includes(command) ? issueShortValues.has(arg[1]) || (command !== 'update' && arg[1] === 'f') :
    command === 'comments-add' && ['a', 'f'].includes(arg[1]);
}
function nextCommand(command, arg) {
  if (arg.startsWith('-')) return command;
  if (command === null) return arg;
  return command === 'comments' ? arg === 'add' ? 'comments-add' : 'other' : command;
}
function followingValue(arg, command) {
  return (arg.startsWith('--') && !arg.includes('=') &&
    longValueFlag(arg.slice(2), command)) ||
    (arg.length === 2 && arg[0] === '-' && shortValueFlag(arg, command));
}
function provedInputContext(args) {
  let command = null;
  const supported = () => inputCommands.has(command) || command === 'comments-add';
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') return supported();
    if (!arg.startsWith('-') || arg === '-') { command = nextCommand(command, arg); continue; }
    if (followingValue(arg, command)) { if (typeof args[++index] !== 'string') return false; continue; }
    if (/^-[qvh]+$/u.test(arg) || (!arg.startsWith('--') && shortValueFlag(arg, command) && arg.length > 2)) continue;
    if (arg.startsWith('--') && (arg.includes('=') || booleanFlag(arg.slice(2), command))) continue;
    return false;
  }
  return supported();
}
function alternateSelector(args) {
  const forbidden = arg => /^-C/u.test(arg) || /^(?:--directory|--db|--global|--server-(?:host|port|user)|--database)(?:=|$)/u.test(arg);
  // Only proven input syntax gets literal-value/end-marker exceptions. Keep
  // the original conservative all-token guard for every unknown context.
  if (!provedInputContext(args)) return args.some(forbidden);
  let command = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]; if (arg === '--') break;
    if (forbidden(arg)) return true;
    command = nextCommand(command, arg);
    if (followingValue(arg, command)) index++;
  }
  return false;
}

function inputSelection(args) {
  let command = null; let unsupported = false; let positional = 0;
  const sources = []; const textGroups = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { positional += args.length - index - 1; break; }
    if (!arg.startsWith('-') || arg === '-') {
      if (command === null) {
        if (arg === 'comments') command = 'comments';
        else if (inputCommands.has(arg)) command = arg;
        else return null;
      } else if (command === 'comments') {
        if (arg !== 'add') return null;
        command = 'comments-add';
      } else positional++;
      continue;
    }
    const equal = arg.indexOf('=');
    const name = arg.startsWith('--') ? arg.slice(2, equal === -1 ? undefined : equal) : null;
    const textFile = (command === 'comment' || command === 'comments-add') && name === 'file';
    const issueFile = ['create', 'new', 'update'].includes(command) && ['body-file', 'description-file', 'design-file'].includes(name);
    const shortFile = command === 'comments-add' && arg.startsWith('-f') && !arg.startsWith('--');
    if (textFile || issueFile || shortFile) {
      const inline = equal !== -1 || (shortFile && arg.length > 2);
      const valueIndex = inline ? index : index + 1;
      const value = inline ? equal !== -1 ? arg.slice(equal + 1) : arg.slice(2) : args[++index];
      if (typeof value !== 'string' || !value) refuse();
      sources.push({ index: valueIndex, inline,
        prefix: shortFile ? '-f' + (equal !== -1 ? '=' : '') : `--${name}=`, path: value,
        group: issueFile ? name === 'design-file' ? 'design' : 'body' : 'comment' });
      continue;
    }
    if (name === 'stdin' && inputCommands.has(command)) {
      const value = equal === -1 ? 'true' : arg.slice(equal + 1);
      if (!['true', 'false'].includes(value)) refuse();
      if (value === 'true') sources.push({ path: '-', group: command === 'comment' ? 'comment' : 'body' });
      continue;
    }
    if (name === 'help' && (equal === -1 || arg.slice(equal + 1) === 'true')) return null;
    if (/^-[qv]*h[qvh]*$/u.test(arg)) return null;
    if (['create', 'new'].includes(command) && ['file', 'graph'].includes(name)) unsupported = true;
    if (['create', 'new'].includes(command) && !name && arg.startsWith('-f')) unsupported = true;
    if (['description', 'body', 'message'].includes(name)) textGroups.add('body');
    if (name === 'design') textGroups.add('design');
    if (name && (booleanFlag(name, command) || equal !== -1)) continue;
    if (name && longValueFlag(name, command)) {
      if (typeof args[++index] !== 'string') refuse();
      continue;
    }
    if (/^-[qvh]+$/u.test(arg)) continue;
    if (!name && shortValueFlag(arg, command)) {
      if (['d', 'm'].includes(arg[1])) textGroups.add('body');
      if (arg.length === 2 && typeof args[++index] !== 'string') refuse();
      continue;
    }
    unsupported = true;
  }
  if (!sources.length) return null;
  if (unsupported || command === 'comments' || sources.length !== 1 || textGroups.has(sources[0].group) ||
    (sources[0].group === 'comment' && positional !== 1)) refuse();
  return sources[0];
}

function inputFile(file) {
  const parent = fs.realpathSync(path.dirname(file));
  directory(parent); file = path.join(parent, path.basename(file));
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !(before.mode & 0o444) || before.size > INPUT_LIMIT) refuse();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) refuse();
    const bytes = Buffer.alloc(INPUT_LIMIT + 1); let length = 0; let read;
    while (length < bytes.length && (read = fs.readSync(fd, bytes, length, bytes.length - length, null))) length += read;
    const after = fs.fstatSync(fd);
    if (length > INPUT_LIMIT || length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) refuse();
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

function inputStream(source) {
  if (Buffer.isBuffer(source) || typeof source === 'string') {
    if ((Buffer.isBuffer(source) ? source.length : Buffer.byteLength(source)) > INPUT_LIMIT) refuse();
    return Promise.resolve(Buffer.from(source));
  }
  if (!source || source.isTTY || ['on', 'once', 'resume', 'pause', 'destroy', 'removeListener'].some(name => typeof source[name] !== 'function')) refuse();
  if (source.readableEnded) return Promise.resolve(Buffer.alloc(0));
  if (source.destroyed || source.closed || source.errored) refuse();
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const finish = (error) => {
      clearTimeout(timer);
      source.removeListener('data', data); source.removeListener('end', end); source.removeListener('error', failed); source.removeListener('close', closed);
      source.pause();
      if (error) { source.destroy(); reject(new Error('Task input refused.')); }
      else resolve(Buffer.concat(chunks, size));
    };
    const data = chunk => {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') { finish(true); return; }
      const length = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (size + length > INPUT_LIMIT) { finish(true); return; }
      size += length; chunks.push(Buffer.from(chunk));
    };
    const end = () => finish(false); const failed = () => finish(true); const closed = () => finish(true);
    const timer = setTimeout(failed, 30_000);
    source.on('data', data); source.once('end', end); source.once('error', failed); source.once('close', closed); source.resume();
  });
}

/** Only the selected command's single explicit text input crosses the boundary.
 * Bytes never become argv, environment values or additional host mounts. */
export async function hostBeadsInput(args, { cwd, stdin = process.stdin } = {}) {
  const selected = inputSelection(args);
  if (!selected) return { args, stdin: null };
  const bytes = selected.path === '-' ? await inputStream(stdin) : inputFile(path.resolve(cwd, selected.path));
  const forwarded = [...args];
  if (selected.index !== undefined) forwarded[selected.index] = selected.inline ? `${selected.prefix}-` : '-';
  return { args: forwarded, stdin: bytes };
}
function directory(file) {
  for (let current = file; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
    if (path.dirname(current) === current) break;
  }
}
function privateFile(file) {
  if (!absolute(file)) refuse(); directory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 64 * 1024) refuse();
  return fs.readFileSync(file, 'utf8');
}

export function readHostBeadsPlan(file) {
  try {
    const input = JSON.parse(privateFile(file));
    if (input.format !== 'noticeos-host-beads-v1' || !/^sha256:[0-9a-f]{64}$/u.test(input.image ?? '') ||
      !(typeof input.network === 'string' && input.network.endsWith('_default') && isDoltProjectName(input.network.slice(0, -'_default'.length))) || !absolute(input.clientProfile) ||
      !actorName(input.fallbackActor) ||
      !Array.isArray(input.spokes) || !input.spokes.length || input.spokes.length > 64 || input.spokes.some(spoke => !absolute(spoke)) ||
      new Set(input.spokes).size !== input.spokes.length) refuse();
    privateFile(input.clientProfile);
    const client = readDeclaredTaskClient(input.clientProfile);
    privateFile(client.credentialsFile); directory(client.clientHome);
    if (client.host !== 'dolt' || client.port !== 3306 || client.user !== 'noticeos') refuse();
    return { format: input.format, image: input.image, network: input.network, client, spokes: [...input.spokes], fallbackActor: input.fallbackActor };
  } catch { refuse(); }
}

export function selectHostBeadsSpoke(plan, cwd, args) {
  if (!absolute(cwd) || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) refuse();
  let selected = null; let command = null; const remaining = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]; let value = null;
    if (arg === '--') { remaining.push(...args.slice(index)); break; }
    if (arg === '-C' || arg === '--directory') value = args[++index];
    else if (arg.startsWith('--directory=')) value = arg.slice('--directory='.length);
    else if (arg.startsWith('-C')) value = arg.slice(2);
    else {
      remaining.push(arg);
      command = nextCommand(command, arg);
      if (followingValue(arg, command)) {
        if (typeof args[index + 1] !== 'string') refuse();
        remaining.push(args[++index]);
      }
      continue;
    }
    if (selected !== null || typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) refuse();
    selected = path.resolve(cwd, value);
  }
  const target = selected ?? cwd;
  if (!plan.spokes.includes(target)) refuse();
  return { cwd: target, args: remaining };
}

export function hostBeadsArguments(plan, cwd, args, { actor = plan.fallbackActor } = {}) {
  const selectedSpoke = selectHostBeadsSpoke(plan, cwd, args); cwd = selectedSpoke.cwd; args = selectedSpoke.args;
  if (!absolute(cwd) || !plan.spokes.includes(cwd) || !Array.isArray(args) || !args.length ||
    args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
    alternateSelector(args) || !actorName(actor)) refuse();
  directory(cwd); directory(path.join(cwd, '.beads'));
  // Beads 1.3.1 gates workspace writes beside .beads. Share that exact inode
  // with other host/container clients rather than silently running ungated.
  const gate = path.join(cwd, '.beads.gate.lock');
  const gateStat = fs.lstatSync(gate);
  if (!gateStat.isFile() || gateStat.isSymbolicLink() || gateStat.nlink !== 1 || gateStat.uid !== process.getuid() ||
    (gateStat.mode & 0o022) || gateStat.size > 64 * 1024) refuse();
  const client = { ...plan.client, clientHome: '/client-home', credentialsFile: '/client/credentials' };
  const selected = { ...taskClientEnvironment(client, {}), BEADS_ACTOR: actor };
  const uid = process.getuid(); const gid = process.getgid();
  return ['run', '--rm', '--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
    '--user', `${uid}:${gid}`, '--network', plan.network, '--workdir', '/spoke',
    '--tmpfs', `/tmp:mode=1777`, '--tmpfs', `/client-home:uid=${uid},gid=${gid},mode=700`,
    '--mount', `type=bind,source=${path.join(cwd, '.beads')},target=/spoke/.beads`,
    '--mount', `type=bind,source=${gate},target=/spoke/.beads.gate.lock`,
    '--mount', `type=bind,source=${plan.client.credentialsFile},target=/client/credentials,readonly`,
    ...Object.entries(selected).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--entrypoint', '/usr/local/bin/bd', plan.image, ...args];
}

export async function runHostBeads(file, args, { cwd = process.cwd(), env = process.env, run = runCommand, stdin = process.stdin } = {}) {
  const plan = readHostBeadsPlan(file);
  const selectedSpoke = selectHostBeadsSpoke(plan, cwd, args); cwd = selectedSpoke.cwd; args = selectedSpoke.args;
  // Validate the original command/spoke before any caller-supplied input read.
  hostBeadsArguments(plan, cwd, args, { actor: env.BEADS_ACTOR ?? plan.fallbackActor });
  const lint = lintInvocation(args);
  // Pinned Beads JSON counts warnings, not checked issues. Never present its
  // zero-warning object as evidence of validation or implement another linter.
  if (lint.lint && lint.json && !lint.help) return { code: 1, stdout: '',
    stderr: 'Task lint JSON does not report checked tasks. Use bd lint <id> without --json.\n' };
  const input = await hostBeadsInput(args, { cwd, stdin });
  const command = hostBeadsArguments(plan, cwd, input.args, { actor: env.BEADS_ACTOR ?? plan.fallbackActor });
  if (input.stdin !== null) command.splice(1, 0, '-i');
  const selected = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']
    .filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  const endpoint = await localDockerEndpoint(run, { env: selected, cwd });
  if (!endpoint) refuse();
  const frozen = { ...selected, DOCKER_HOST: endpoint }; delete frozen.DOCKER_CONTEXT;
  const network = await run('docker', ['network', 'inspect', plan.network, '--format', '{{.Name}}'], { cwd, env: frozen, timeoutMs: 30_000 });
  if (network.code !== 0 || network.stdout.trim() !== plan.network) refuse();
  const result = await run('docker', command, { cwd, env: frozen, timeoutMs: 300_000, ...(input.stdin !== null ? { stdin: input.stdin } : {}) });
  const password = privateFile(plan.client.credentialsFile).split('\n').find(line => line.startsWith('password=')).slice('password='.length);
  const output = { ...result, stdout: (result.stdout ?? '').replaceAll(password, '[redacted]'), stderr: (result.stderr ?? '').replaceAll(password, '[redacted]') };
  // Pinned lint skips failed ID lookups but exits zero. Keep its diagnostics
  // and fail the command when any requested issue could not be checked.
  if (lint.lint && output.code === 0 && /^(?:Error getting [^\r\n]+:|Issue not found: [^\r\n]+)/mu.test(output.stderr)) {
    output.code = 1;
    output.stderr += 'Task lint did not check every requested task. Correct the IDs and retry.\n';
  }
  return output;
}

/** Create only a new optional wrapper folder; never replace the user's bd.
 * The protected maintenance plan separately selects PATH/entrypoint changes. */
export function prepareHostBeads(file) {
  try {
    const input = JSON.parse(privateFile(file));
    if (input.format !== 'noticeos-host-beads-prepare-v1' || !absolute(input.directory) || !absolute(input.doltHome) ||
      !/^sha256:[0-9a-f]{64}$/u.test(input.image ?? '') || !actorName(input.fallbackActor) || !Array.isArray(input.spokes) || !input.spokes.length ||
      input.spokes.length > 64 || input.spokes.some(spoke => !absolute(spoke)) || new Set(input.spokes).size !== input.spokes.length) refuse();
    directory(path.dirname(input.directory));
    const parent = fs.lstatSync(path.dirname(input.directory));
    if (parent.uid !== process.getuid() || (parent.mode & 0o077) || fs.lstatSync(input.directory, { throwIfNoEntry: false })) refuse();
    const profile = readDoltProfile(input.doltHome); if (!profile) refuse();
    privateFile(profile.credentialsFile);
    const password = readDoltCredentials(profile).noticeos.trim();
    for (const spoke of input.spokes) { directory(spoke); directory(path.join(spoke, '.beads')); }
    fs.mkdirSync(input.directory, { mode: 0o700 });
    const clientHome = path.join(input.directory, 'client-home'); fs.mkdirSync(clientHome, { mode: 0o700 });
    const credentialsFile = path.join(input.directory, 'credentials');
    fs.writeFileSync(credentialsFile, `[dolt:3306]\npassword=${password}\n`, { mode: 0o600, flag: 'wx' });
    const clientProfile = path.join(input.directory, 'client.json');
    fs.writeFileSync(clientProfile, JSON.stringify({ host: 'dolt', port: 3306, user: 'noticeos', credentialsFile, clientHome }) + '\n', { mode: 0o600, flag: 'wx' });
    const plan = path.join(input.directory, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify({ format: 'noticeos-host-beads-v1', image: input.image, network: `${profile.project}_default`, clientProfile, spokes: input.spokes, fallbackActor: input.fallbackActor }) + '\n', { mode: 0o600, flag: 'wx' });
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const wrapper = path.join(input.directory, 'bd');
    const script = fileURLToPath(import.meta.url);
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(fs.realpathSync(process.execPath))} ${quote(script)} --plan ${quote(plan)} -- "$@"\n`, { mode: 0o700, flag: 'wx' });
    return { format: 'noticeos-host-beads-v1', wrapper, plan, image: input.image, network: `${profile.project}_default`, hostEntrypointChanged: false };
  } catch { refuse(); }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const { stdout = process.stdout, stderr = process.stderr } = options;
  try {
    if (argv.length === 3 && argv[0] === 'prepare' && argv[1] === '--plan') {
      stdout.write(JSON.stringify(prepareHostBeads(argv[2]), null, 2) + '\n'); return 0;
    }
    if (argv.length < 4 || argv[0] !== '--plan' || argv[2] !== '--') refuse();
    const result = await runHostBeads(argv[1], argv.slice(3), options);
    stdout.write(result.stdout ?? ''); stderr.write(result.stderr ?? ''); return result.code;
  } catch { stderr.write('Bundled task client refused. Use its protected declaration from an allowed project.\n'); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
