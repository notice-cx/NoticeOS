#!/usr/bin/env node
// One protected plan, explicit operations. No service lifecycle or automatic
// schema/cutover step is inferred from a capture/restore command.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stoppedDoltCapturePlan, captureStoppedDoltSource, verifyStoppedDoltCapture,
  stoppedDoltServiceReads, verifyStoppedDoltServiceEvidence } from './dolt-migration-capture.mjs';
import { restoreNativeDoltCapture } from './dolt-migration-restore.mjs';
import { startDoltPlan, validateDoltProfile } from './dolt-host.mjs';

const failure = () => { throw new Error('Migration plan or operation refused; protected resources were not overwritten.'); };

export function readDoltMigrationPlan(file) {
  if (!path.isAbsolute(file ?? '')) failure();
  for (let current = path.dirname(file); ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) failure();
    if (path.dirname(current) === current) break;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 64 * 1024) failure();
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (input.format !== 'noticeos-dolt-migration-plan-v1' || !input.target ||
    !path.isAbsolute(input.target.root ?? '') || !path.isAbsolute(input.target.home ?? '') ||
    !Number.isInteger(input.target.towerPort) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/u.test(input.target.globalConfigName ?? '')) failure();
  const capture = stoppedDoltCapturePlan(input.capture);
  const target = validateDoltProfile(startDoltPlan({ root: input.target.root, home: input.target.home, port: input.target.towerPort }));
  return { format: input.format, capture, target, globalConfigName: input.target.globalConfigName };
}

export function describeDoltMigrationPlan(plan) {
  return { format: plan.format, sourceDirectory: plan.capture.sourceDirectory, sourceVersion: plan.capture.sourceVersion,
    databases: plan.capture.databases, sourceFilePaths: plan.capture.files.map(file => ({ name: file.name, path: file.path, required: file.required })),
    sourceServiceRead: stoppedDoltServiceReads(plan.capture)[0],
    ...(plan.capture.service.aliasTransition ? { sourceServiceIdentityReads: stoppedDoltServiceReads(plan.capture).slice(1) } : {}),
    captureDirectory: plan.capture.outputDirectory, writerFence: plan.capture.writerFence, approval: plan.capture.approval,
    target: plan.target, globalConfigName: plan.globalConfigName,
    captureScope: 'Only after exact source service is stopped/unloaded and all other writers are fenced; full immutable byte copy, no source SQL or service changes.',
    restoreScope: 'Only new target project/volume; qualified 2.2.3 to 2.4.0; target credentials/grants adapted offline before listener; no Beads migration or spoke updates.' };
}

export function verifyDoltMigrationCapture(plan) {
  const marker = verifyStoppedDoltCapture(plan.capture.outputDirectory);
  verifyStoppedDoltServiceEvidence(plan.capture, marker.serviceBefore, marker.inventory);
  verifyStoppedDoltServiceEvidence(plan.capture, marker.serviceAfter, marker.inventory);
  if (marker.sourceDirectory !== plan.capture.sourceDirectory || marker.sourceVersion !== plan.capture.sourceVersion ||
    JSON.stringify(marker.databases) !== JSON.stringify(plan.capture.databases) ||
    JSON.stringify(marker.sourceFiles) !== JSON.stringify(plan.capture.files) ||
    marker.approval !== plan.capture.approval || marker.writerFence !== plan.capture.writerFence) failure();
  return marker;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, ...options } = {}) {
  try {
    if (argv.length !== 3 || !['describe', 'capture', 'verify', 'restore'].includes(argv[0]) || argv[1] !== '--plan') failure();
    const plan = readDoltMigrationPlan(argv[2]); let result;
    if (argv[0] === 'describe') result = describeDoltMigrationPlan(plan);
    else if (argv[0] === 'capture') result = await captureStoppedDoltSource(plan.capture, options);
    else if (argv[0] === 'restore') {
      verifyDoltMigrationCapture(plan);
      result = await restoreNativeDoltCapture(plan.target, plan.capture.outputDirectory, { ...options, globalConfigName: plan.globalConfigName });
    }
    else {
      const marker = verifyDoltMigrationCapture(plan);
      result = { format: marker.format, sourceVersion: marker.sourceVersion, databases: marker.databases,
        files: Object.keys(marker.inventory.files).length, complete: true };
    }
    stdout.write(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch {
    stderr.write('Dolt migration refused. Keep any partial private resources for explicit recovery; no overwrite or automatic retry.\n'); return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
