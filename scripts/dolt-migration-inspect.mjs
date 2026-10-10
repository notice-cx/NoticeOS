// Explicit metadata custody for an existing-hub migration.
// No service, subprocess, network, credential lookup or installation fallback.
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 256 * 1024;
const MAX_PROJECTS = 32;
const FILE_NAMES = ['task-host.json', 'beads.json', 'dolt-server.yaml'];
const fail = () => { throw new Error('Task migration metadata refused; check explicit paths and file formats.'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/u.test(value);
const port = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
const identifier = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/u.test(value);
const assetId = value => typeof value === 'string' && value.length <= 253 && /^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9_-]*)*$/u.test(value);

function absolute(value) {
  if (!text(value) || !path.isAbsolute(value)) fail();
  return path.resolve(value);
}

// Reject linked ancestors too: approving one pathname does not approve a
// symlink's different destination. No directory contents are enumerated.
function directory(file, io) {
  for (let current = file; ; current = path.dirname(current)) {
    const stat = io.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    if (path.dirname(current) === current) break;
  }
}

function read(file, io) {
  directory(path.dirname(file), io);
  const stat = io.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail();
  const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = io.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) fail();
    // A growing file cannot turn this bounded read into an unbounded allocation.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = io.readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > MAX_BYTES) fail();
    return bytes.subarray(0, used).toString('utf8');
  } finally { io.closeSync(fd); }
}

function row(value) {
  if (!object(value) || !assetId(value.asset) || !identifier(value.prefix) || !identifier(value.database)) fail();
  return { asset: value.asset, prefix: value.prefix, database: value.database };
}

function rows(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PROJECTS) fail();
  const selected = value.map(row);
  for (const field of ['asset', 'prefix', 'database']) {
    if (new Set(selected.map(item => item[field])).size !== selected.length) fail();
  }
  return selected;
}

function endpoint(value, root) {
  if (!object(value) || !['127.0.0.1', 'localhost', '::1'].includes(value.host) || !port(value.port) || !identifier(value.user)) fail();
  const result = { host: value.host, port: value.port, user: value.user };
  if (value.dataDir !== undefined) {
    if (!text(value.dataDir)) fail();
    // The exported hub path is relative to the explicit repository root.
    result.dataDir = value.dataDir;
    result.dataDirResolved = path.resolve(root, value.dataDir);
  }
  return result;
}

// Deliberately not a general YAML interpreter. Accept block mappings and
// simple scalar values; reject aliases, tags, merges, duplicate keys and
// unsupported selected values. Unknown subtrees never supply selected fields.
function yamlFields(source, allowed) {
  const result = {};
  const stack = [];
  const seen = new Set();
  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim() || /^\s*#/u.test(line) || /^\s*---\s*$/u.test(line)) continue;
    if (/\t/u.test(line)) fail();
    const match = /^( *)([a-zA-Z_][a-zA-Z0-9_.-]*):(?: +(.*))?$/u.exec(line);
    if (!match) fail();
    const indent = match[1].length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    if (indent && !stack.length) fail();
    const key = [...stack.map(item => item.key), match[2]].join('.');
    if (seen.has(key) || match[2] === '<<') fail();
    seen.add(key);
    const raw = match[3]?.trim();
    if (!raw || raw.startsWith('#')) { stack.push({ indent, key: match[2] }); continue; }
    if (!allowed.has(key)) continue;
    let value;
    if (raw.startsWith('"')) {
      const quoted = /^"(?:[^"\\]|\\.)*"/u.exec(raw)?.[0];
      if (!quoted || !/^\s*(?:#.*)?$/u.test(raw.slice(quoted.length))) fail();
      value = JSON.parse(quoted);
    } else if (raw.startsWith("'")) {
      const quoted = /^'(?:[^']|'')*'/u.exec(raw)?.[0];
      if (!quoted || !/^\s*(?:#.*)?$/u.test(raw.slice(quoted.length))) fail();
      value = quoted.slice(1, -1).replaceAll("''", "'");
    } else {
      value = raw.replace(/ +#.*$/u, '').trim();
      if (/^[!&*>{[|]/u.test(value) || !value) fail();
      if (/^(?:true|false)$/u.test(value)) value = value === 'true';
      else if (/^[0-9]+$/u.test(value)) value = Number(value);
    }
    result[key] = value;
  }
  return result;
}

function serverMetadata(raw, hub) {
  const fields = yamlFields(raw, new Set(['listener.host', 'listener.port', 'data_dir', 'cfg_dir', 'privilege_file', 'branch_control_file', 'user.name']));
  if (fields['listener.host'] !== hub.host || fields['listener.port'] !== hub.port) fail();
  const selected = { listener: { host: fields['listener.host'], port: fields['listener.port'] }, pathResolution: {} };
  for (const key of ['data_dir', 'cfg_dir', 'privilege_file', 'branch_control_file']) {
    if (fields[key] !== undefined) {
      if (!text(fields[key])) fail();
      selected[key] = fields[key];
      // A native service's working directory is not established by these files.
      selected.pathResolution[key] = { resolved: path.isAbsolute(fields[key]) ? path.resolve(fields[key]) : null,
        basis: path.isAbsolute(fields[key]) ? 'absolute' : 'unknown-server-working-directory' };
    }
  }
  if (!selected.data_dir) fail();
  if (fields['user.name'] !== undefined) {
    if (fields['user.name'] !== hub.user) fail();
    selected.user = fields['user.name'];
  }
  return selected;
}

function spokeMetadata(raw, config, declared, hub) {
  const value = JSON.parse(raw);
  if (!object(value)) fail();
  const selectors = [['dolt_mode', 'mode', 'server'], ['dolt_database', 'database', declared.database],
    ['dolt_server_host', 'host', hub.host], ['dolt_server_port', 'port', hub.port], ['dolt_server_user', 'user', hub.user]];
  const selected = { projectId: null };
  for (const [key, field, expected] of selectors) {
    // Metadata can omit defaults supplied elsewhere by a CLI or environment.
    // Absence is unknown; an explicit conflict is refused, never reconciled.
    const actual = value[key];
    if (actual !== undefined && (field === 'port' ? (!port(Number(actual)) || Number(actual) !== expected) : actual !== expected)) fail();
    selected[field] = actual === undefined ? null : field === 'port' ? Number(actual) : actual;
  }
  if (value.project_id !== undefined) {
    if (!text(value.project_id) || !/^[a-zA-Z0-9_-]+$/u.test(value.project_id)) fail();
    selected.projectId = value.project_id;
  }
  const fields = yamlFields(config, new Set(['issue-prefix', 'no-git-ops', 'import.auto', 'sync.remote']));
  if (fields['issue-prefix'] !== undefined && fields['issue-prefix'] !== declared.prefix) fail();
  for (const key of ['no-git-ops', 'import.auto']) if (fields[key] !== undefined && typeof fields[key] !== 'boolean') fail();
  // A remote URL can embed a credential. Report presence, never the value.
  selected.config = { prefix: fields['issue-prefix'] ?? null,
    noGitOps: fields['no-git-ops'] ?? null, importAuto: fields['import.auto'] ?? null,
    syncRemotePresent: Object.hasOwn(fields, 'sync.remote') };
  return selected;
}

/** Reuse an already approved maps-only receipt. This never rereads the three
 * installation declarations; the receipt is not proof of current membership. */
export function inspectDoltMigrationSpokes(receipt, { fs: io = fs } = {}) {
  try {
    const plan = doltMigrationReceipt(receipt);
    return { reads: plan.projects.flatMap(entry => Object.values(entry.files)),
      projects: plan.projects.map(entry => ({ ...entry,
        metadata: spokeMetadata(read(entry.files.metadata, io), read(entry.files.config, io), entry, plan.hub) })),
      storedMembershipVerified: false };
  } catch { fail(); }
}

export function doltMigrationReceipt(receipt) {
  try {
    if (!object(receipt) || receipt.format !== 'noticeos-dolt-migration-metadata-v1' || receipt.scope !== 'maps-only') fail();
    const hub = endpoint({ host: receipt.hub?.host, port: receipt.hub?.port, user: receipt.hub?.user });
    const selected = rows(receipt.projects);
    const projects = selected.map((entry, index) => {
      const repo = absolute(receipt.projects[index].repo);
      const files = { metadata: path.join(repo, '.beads', 'metadata.json'), config: path.join(repo, '.beads', 'config.yaml') };
      if (receipt.projects[index].files?.metadata !== files.metadata || receipt.projects[index].files?.config !== files.config) fail();
      return { ...entry, repo, files };
    });
    if (new Set(projects.map(item => item.repo)).size !== projects.length) fail();
    return { hub, projects };
  } catch { fail(); }
}

export function readDoltMigrationReceipt(file, { fs: io = fs } = {}) {
  try { return JSON.parse(read(absolute(file), io)); } catch { fail(); }
}

/** Explicit paths only. mapsOnly reads three files and merely names candidate
 * spoke files. Full mode requires every declared checkout to be pre-approved
 * by its exact --spoke path before any spoke directory is inspected. */
export function inspectDoltMigration({ repoRoot, installation, spokes = [], mapsOnly = false }, { fs: io = fs } = {}) {
  try {
    const root = absolute(repoRoot);
    const folder = absolute(installation);
    const approved = spokes.map(absolute);
    if (new Set(approved).size !== approved.length || approved.length > MAX_PROJECTS || (mapsOnly && approved.length)) fail();
    const host = JSON.parse(read(path.join(folder, FILE_NAMES[0]), io));
    const map = JSON.parse(read(path.join(folder, FILE_NAMES[1]), io));
    if (!object(host) || !object(map)) fail();
    const physical = rows(host.repositories);
    const logical = rows(map.spokes);
    const hub = endpoint(map.hub, root);
    const repositories = physical.map((entry, index) => {
      const declared = host.repositories[index];
      if (!text(declared.repo)) fail();
      return { ...entry, repo: path.resolve(root, declared.repo) };
    });
    if (new Set(repositories.map(item => item.repo)).size !== repositories.length) fail();
    for (const entry of logical) {
      if (!physical.some(item => item.asset === entry.asset && item.prefix === entry.prefix && item.database === entry.database)) fail();
    }
    const server = serverMetadata(read(path.join(folder, FILE_NAMES[2]), io), hub);
    if (hub.dataDirResolved && server.pathResolution.data_dir.resolved && hub.dataDirResolved !== server.pathResolution.data_dir.resolved) fail();
    if (!mapsOnly && (approved.length !== repositories.length || repositories.some(item => !approved.includes(item.repo)))) fail();
    // All scope/mapping checks happen before any spoke read.
    const projects = repositories.map(entry => {
      const files = { metadata: path.join(entry.repo, '.beads', 'metadata.json'), config: path.join(entry.repo, '.beads', 'config.yaml') };
      return { ...entry, active: logical.some(item => item.asset === entry.asset), files,
        ...(mapsOnly ? {} : { metadata: spokeMetadata(read(files.metadata, io), read(files.config, io), entry, hub) }) };
    });
    return { format: 'noticeos-dolt-migration-metadata-v1', scope: mapsOnly ? 'maps-only' : 'maps-and-spokes',
      reads: [...FILE_NAMES.map(name => path.join(folder, name)), ...(mapsOnly ? [] : projects.flatMap(item => Object.values(item.files)))],
      hub, server, projects, storedMembershipVerified: false };
  } catch { fail(); }
}

const USAGE = 'Usage: node scripts/dolt-migration-inspect.mjs --repo-root <absolute> --installation <absolute> --maps-only\n       Add exact --spoke <absolute> paths instead of --maps-only to inspect declared spoke metadata.\nNo network calls. Exported membership is not verified against the live store.\n';
export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, inspect = inspectDoltMigration } = {}) {
  try {
    const options = { spokes: [] };
    for (let i = 0; i < argv.length; i++) {
      const key = argv[i];
      if (key === '--help') { stdout.write(USAGE); return 0; }
      if (key === '--maps-only') { if (options.mapsOnly) fail(); options.mapsOnly = true; continue; }
      if (!['--repo-root', '--installation', '--spoke'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail();
      const value = argv[++i];
      if (key === '--spoke') options.spokes.push(value);
      else {
        const name = key === '--repo-root' ? 'repoRoot' : 'installation';
        if (options[name]) fail(); options[name] = value;
      }
    }
    const result = inspect(options);
    stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch { stderr.write('Task migration metadata refused; check explicit paths and file formats.\n'); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
