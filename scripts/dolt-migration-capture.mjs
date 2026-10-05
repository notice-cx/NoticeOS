// Explicit cold capture for an existing native source. This is not a service
// stop/start command, migration, fresh-profile adapter or live-data reader test.
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runCommand } from './run-command.mjs';

const refuse = () => { throw new Error('Stopped-source capture refused; any partial private copy was preserved without a completion marker.'); };
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/u.test(value);
const safeName = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/u.test(value);

function serviceAliasTransition(service, files, sourceDirectory) {
  if (service.aliasTransition === undefined) return null;
  const evidence = service.aliasTransition;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
    Object.keys(evidence).sort().join() !== 'originalPlistName,originalPlistSha256,stoppedLabel,userId' ||
    service.name !== 'dolt' || service.label !== 'homebrew.mxcl.dolt' || evidence.stoppedLabel !== 'sh.brew.dolt' ||
    !Number.isSafeInteger(evidence.userId) || evidence.userId !== process.getuid() ||
    !safeName(evidence.originalPlistName) || !/^[0-9a-f]{64}$/u.test(evidence.originalPlistSha256 ?? '')) refuse();
  const saved = files.find(file => file.name === evidence.originalPlistName);
  const savedPath = saved && path.resolve(saved.path);
  if (!saved?.required || savedPath === sourceDirectory || savedPath.startsWith(`${sourceDirectory}${path.sep}`)) refuse();
  return { stoppedLabel: evidence.stoppedLabel, userId: evidence.userId,
    originalPlistName: evidence.originalPlistName, originalPlistSha256: evidence.originalPlistSha256 };
}

/** Every read-only command needed to prove the declared source is unloaded. */
export function stoppedDoltServiceReads(plan) {
  const reads = [[plan.service.brew, 'services', 'info', plan.service.name, '--json']];
  const evidence = plan.service.aliasTransition;
  if (evidence) {
    const saved = plan.files.find(file => file.name === evidence.originalPlistName);
    reads.push(['/usr/bin/plutil', '-extract', 'Label', 'raw', '-o', '-', saved.path]);
    for (const domain of ['gui', 'user']) reads.push(['/bin/launchctl', 'print', `${domain}/${evidence.userId}/${plan.service.label}`]);
  }
  return reads;
}

function absenceReply(plan, domain) {
  return `Bad request.\nCould not find service "${plan.service.label}" in domain for ` +
    `${domain === 'gui' ? 'user gui' : 'uid'}: ${plan.service.aliasTransition.userId}\n`;
}

/** Bind an alias-aware capture's recorded service proofs to its approved plan. */
export function verifyStoppedDoltServiceEvidence(plan, proof, inventory) {
  const evidence = plan.service.aliasTransition;
  if (!evidence) return;
  const recorded = proof?.identityEvidence;
  if (proof?.name !== plan.service.name || proof.label !== evidence.stoppedLabel || proof.running !== false || proof.loaded !== false ||
    recorded?.originalLabel !== plan.service.label || recorded.stoppedLabel !== evidence.stoppedLabel ||
    recorded.savedPlist?.name !== evidence.originalPlistName || recorded.savedPlist.sha256 !== evidence.originalPlistSha256 ||
    inventory?.files?.[`metadata/${evidence.originalPlistName}`]?.sha256 !== evidence.originalPlistSha256 ||
    !Array.isArray(recorded.originalLabelAbsent) || recorded.originalLabelAbsent.length !== 2) refuse();
  for (const [index, domain] of ['gui', 'user'].entries()) {
    const result = recorded.originalLabelAbsent[index];
    if (result?.target !== `${domain}/${evidence.userId}/${plan.service.label}` || result.exitCode !== 113 ||
      result.stdout !== '' || result.stderr !== absenceReply(plan, domain)) refuse();
  }
}

/** Pure declarations. The caller must first obtain approval for the precise
 * stop, writer fence, file-copy destinations and any later target changes. */
export function stoppedDoltCapturePlan(input) {
  if (!input || !absolute(input.sourceDirectory) || !absolute(input.outputDirectory) ||
    !/^\d+\.\d+\.\d+$/u.test(input.sourceVersion ?? '') ||
    !Array.isArray(input.databases) || !input.databases.length || input.databases.some(name => !safeName(name)) ||
    new Set(input.databases).size !== input.databases.length ||
    !input.service || !absolute(input.service.brew) || !absolute(input.service.home) ||
    !safeName(input.service.name) || typeof input.service.label !== 'string' || !/^[a-zA-Z0-9_.-]+$/u.test(input.service.label) ||
    !Array.isArray(input.files) || input.files.length > 64 || input.files.some(file =>
      !file || !safeName(file.name) || !absolute(file.path) || typeof file.required !== 'boolean') ||
    new Set(input.files.map(file => file.name)).size !== input.files.length ||
    !input.writerFence || typeof input.writerFence !== 'string' || input.writerFence.length > 2048 ||
    !input.approval || typeof input.approval !== 'string' || input.approval.length > 256) refuse();
  const sourceDirectory = path.resolve(input.sourceDirectory);
  const outputDirectory = path.resolve(input.outputDirectory);
  if (outputDirectory === sourceDirectory || outputDirectory.startsWith(`${sourceDirectory}${path.sep}`) ||
    sourceDirectory.startsWith(`${outputDirectory}${path.sep}`)) refuse();
  const aliasTransition = serviceAliasTransition(input.service, input.files, sourceDirectory);
  return { sourceDirectory, outputDirectory, sourceVersion: input.sourceVersion,
    databases: [...input.databases], service: { brew: input.service.brew, home: input.service.home,
      name: input.service.name, label: input.service.label, ...(aliasTransition ? { aliasTransition } : {}) },
    files: input.files.map(file => ({ name: file.name, path: file.path, required: file.required })),
    writerFence: input.writerFence, approval: input.approval };
}

function directory(file, io, privateOwned = false) {
  for (let current = file; ; current = path.dirname(current)) {
    const stat = io.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
    if (privateOwned && current === file && (stat.uid !== process.getuid() || (stat.mode & 0o077))) refuse();
    if (path.dirname(current) === current) return;
  }
}

async function stopped(plan, run) {
  const options = { cwd: plan.service.home, timeoutMs: 20_000,
    env: { HOME: plan.service.home, PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1' } };
  const [binary, ...args] = stoppedDoltServiceReads(plan)[0];
  const result = await run(binary, args, options);
  if (result.code !== 0 || typeof result.stdout !== 'string' || result.stdout.length > 64 * 1024) refuse();
  const rows = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== 1) refuse();
  const row = rows[0];
  // Unloading prevents KeepAlive from restarting the source during the copy.
  // Merely failing a TCP health check or seeing a nonzero exit code is unsafe.
  const transition = plan.service.aliasTransition;
  if (row.name !== plan.service.name || row.service_name !== (transition?.stoppedLabel ?? plan.service.label) ||
    row.running !== false || row.loaded !== false || row.schedulable !== false || row.pid !== null ||
    !['none', 'stopped'].includes(row.status)) refuse();
  return { name: row.name, label: row.service_name, running: false, loaded: false, checkedAt: new Date().toISOString() };
}

async function originalServiceAbsent(plan, run, io) {
  const evidence = plan.service.aliasTransition;
  if (!evidence) return null;
  const saved = plan.files.find(file => file.name === evidence.originalPlistName);
  const stat = regularFile(saved.path, io);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 64 * 1024 ||
    hashFile(saved.path, io).sha256 !== evidence.originalPlistSha256) refuse();
  const options = { cwd: plan.service.home, timeoutMs: 10_000,
    env: { HOME: plan.service.home, PATH: '/usr/bin:/bin' } };
  const [[parser, ...parserArgs], ...absenceReads] = stoppedDoltServiceReads(plan).slice(1);
  const label = await run(parser, parserArgs, options);
  if (label.code !== 0 || label.stdout !== `${plan.service.label}\n` || label.stderr !== '') refuse();
  const originalLabelAbsent = [];
  for (const [binary, ...args] of absenceReads) {
    const target = args[1]; const domain = target.split('/')[0];
    const result = await run(binary, args, options);
    // This exact host-qualified absent-service result is distinct from a live
    // label, a different identity, a permission failure or any generic error.
    if (result.code !== 113 || result.stdout !== '' || result.stderr !== absenceReply(plan, domain)) refuse();
    originalLabelAbsent.push({ target, exitCode: result.code, stdout: result.stdout, stderr: result.stderr });
  }
  return { originalLabel: plan.service.label, stoppedLabel: evidence.stoppedLabel,
    savedPlist: { name: evidence.originalPlistName, sha256: evidence.originalPlistSha256 }, originalLabelAbsent };
}

function regularFile(file, io) {
  directory(path.dirname(file), io);
  const before = io.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4 * 1024 ** 3) refuse();
  return before;
}

function tree(root, io, prefix = '', state = { files: 0, bytes: 0 }) {
  const result = { directories: [], files: {} };
  for (const entry of io.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    const file = path.join(root, relative);
    if (entry.isDirectory()) {
      directory(file, io);
      result.directories.push(relative);
      const nested = tree(root, io, relative, state);
      result.directories.push(...nested.directories);
      Object.assign(result.files, nested.files);
    } else {
      const stat = regularFile(file, io);
      if (++state.files > 100_000 || (state.bytes += stat.size) > 64 * 1024 ** 3) refuse();
      result.files[relative] = { bytes: stat.size };
    }
  }
  return result;
}

function hashFile(file, io) {
  const stat = regularFile(file, io);
  const fd = io.openSync(file, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
  try {
    const opened = io.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) refuse();
    const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024);
    let bytes;
    while ((bytes = io.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
    return { bytes: opened.size, sha256: hash.digest('hex') };
  } finally { io.closeSync(fd); }
}

function hashTree(root, io) {
  const result = tree(root, io);
  for (const relative of Object.keys(result.files)) result.files[relative] = hashFile(path.join(root, relative), io);
  return result;
}

function metadata(plan, io) {
  const files = {};
  for (const file of plan.files) {
    directory(path.dirname(file.path), io);
    const stat = io.lstatSync(file.path, { throwIfNoEntry: false });
    if (!stat) {
      if (file.required) refuse();
      files[file.name] = null;
    } else {
      regularFile(file.path, io);
      if (stat.size > 16 * 1024 ** 2) refuse();
      files[file.name] = io.readFileSync(file.path);
    }
  }
  return files;
}

/** Requires the declared Homebrew service to be stopped AND unloaded, with
 * explicit saved identity and exact original-label absence for an alias change,
 * before reading data. This check does not establish a global writer fence;
 * the operator must exclude every other writer and record it in writerFence.
 * No SQL, backup procedure, Dolt binary, Docker call or source mutation occurs. */
export async function captureStoppedDoltSource(input, { fs: io = nodeFs, run = runCommand } = {}) {
  try {
    const plan = stoppedDoltCapturePlan(input); const output = plan.outputDirectory;
    if (io.lstatSync(output, { throwIfNoEntry: false })) refuse();
    directory(path.dirname(output), io, true);
    const serviceBefore = await stopped(plan, run);
    const identityBefore = await originalServiceAbsent(plan, run, io);
    if (identityBefore) serviceBefore.identityEvidence = identityBefore;
    directory(plan.sourceDirectory, io);
    for (const database of plan.databases) directory(path.join(plan.sourceDirectory, database, '.dolt'), io);
    const before = hashTree(plan.sourceDirectory, io);
    const extraBefore = metadata(plan, io);
    io.mkdirSync(output, { mode: 0o700 });
    const data = path.join(output, 'data'); const extra = path.join(output, 'metadata');
    io.mkdirSync(data, { mode: 0o700 }); io.mkdirSync(extra, { mode: 0o700 });
    for (const relative of before.directories) io.mkdirSync(path.join(data, relative), { mode: 0o700 });
    for (const [relative, file] of Object.entries(before.files)) {
      const target = path.join(data, relative);
      io.copyFileSync(path.join(plan.sourceDirectory, relative), target, io.constants.COPYFILE_EXCL | io.constants.COPYFILE_FICLONE);
      io.chmodSync(target, 0o600);
      if (JSON.stringify(hashFile(target, io)) !== JSON.stringify(file)) refuse();
    }
    const presence = {};
    for (const [name, bytes] of Object.entries(extraBefore)) {
      presence[name] = bytes !== null;
      io.writeFileSync(path.join(extra, bytes === null ? `${name}.absent` : name), bytes ?? '', { mode: 0o600, flag: 'wx' });
    }
    const serviceAfter = await stopped(plan, run);
    const identityAfter = await originalServiceAbsent(plan, run, io);
    if (identityAfter) serviceAfter.identityEvidence = identityAfter;
    const after = hashTree(plan.sourceDirectory, io);
    const extraAfter = metadata(plan, io);
    if (JSON.stringify(after) !== JSON.stringify(before) ||
      Object.keys(extraBefore).some(name => (extraBefore[name] === null) !== (extraAfter[name] === null) ||
        (extraBefore[name] !== null && !extraBefore[name].equals(extraAfter[name])))) refuse();
    const inventory = hashTree(output, io);
    verifyStoppedDoltServiceEvidence(plan, serviceBefore, inventory);
    verifyStoppedDoltServiceEvidence(plan, serviceAfter, inventory);
    const marker = { format: 'noticeos-native-dolt-capture-v1', complete: true,
      sourceDirectory: plan.sourceDirectory, sourceVersion: plan.sourceVersion, databases: plan.databases,
      sourceFiles: plan.files, metadataPresent: presence, approval: plan.approval, writerFence: plan.writerFence,
      serviceBefore, serviceAfter, inventory, capturedAt: new Date().toISOString() };
    io.writeFileSync(path.join(output, 'capture.json'), JSON.stringify(marker, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return { format: marker.format, databases: [...plan.databases], files: Object.keys(inventory.files).length,
      bytes: Object.values(inventory.files).reduce((total, file) => total + file.bytes, 0) };
  } catch { refuse(); }
}

/** Verify an immutable completed native capture before any target operation. */
export function verifyStoppedDoltCapture(folder, { fs: io = nodeFs } = {}) {
  try {
    if (!absolute(folder)) refuse();
    directory(folder, io, true);
    const markerFile = path.join(folder, 'capture.json'); regularFile(markerFile, io);
    const marker = JSON.parse(io.readFileSync(markerFile, 'utf8'));
    if (marker.format !== 'noticeos-native-dolt-capture-v1' || marker.complete !== true ||
      !/^\d+\.\d+\.\d+$/u.test(marker.sourceVersion) || !marker.databases?.length ||
      marker.databases.some(name => !safeName(name)) || !marker.inventory) refuse();
    const actual = hashTree(folder, io); delete actual.files['capture.json'];
    if (JSON.stringify(actual.files) !== JSON.stringify(marker.inventory.files) ||
      JSON.stringify(actual.directories) !== JSON.stringify(marker.inventory.directories)) refuse();
    return marker;
  } catch { refuse(); }
}
