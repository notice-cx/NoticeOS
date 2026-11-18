// Estimate and prepare scoped copies of a standalone installation's historical
// archive through the running app. Use the complete backup's size in bytes
// for the storage check before copying.
import { statfs } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DOOR, doorRequest, doorUrl, localDoorFetch, operatorToken } from './ingest-door.mjs';
import { invokedDirectly, resolveHomeRoot, runtimeChildEnv } from './os-runtime.mjs';

const ROUTE = '/api/legacy-archives';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SEQUENCE = /^(?:0|[1-9][0-9]{0,18})$/u;
const REQUEST_TIMEOUT_MS = 120_000;
const CODE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const validCount = value => Number.isSafeInteger(value) && value >= 0;

export function archiveTransitionArgs(args) {
  if (args.length === 1 && args[0] === '--plan') return { mode: 'plan' };
  if (args.length === 4 && args[0] === '--prepare' && UUID.test(args[1]) && args[2] === '--backup-bytes'
    && /^[1-9][0-9]{0,14}$/u.test(args[3])) {
    return { mode: 'prepare', workspaceId: args[1], backupBytes: Number(args[3]) };
  }
  throw new Error('Use --plan or --prepare <workspace UUID> --backup-bytes <verified complete backup bytes>.');
}

export async function freeArchiveBytes() {
  const { OS_UP_PERSIST_STATE: state } = runtimeChildEnv(resolveHomeRoot(CODE_ROOT));
  const { bavail, bsize } = await statfs(state, { bigint: true });
  return bavail * bsize;
}

/** Original locators stay in both the working archive and the next full backup. */
export function archiveAdditionalBytes(plan) {
  return BigInt(plan.bytes) + 8192n * BigInt(plan.objects);
}

export async function transitionCustomerArchive(args, {
  door = DEFAULT_DOOR, get = localDoorFetch, token = operatorToken, availableBytes = freeArchiveBytes, onProgress = () => {},
} = {}) {
  const auth = await token();
  const url = doorUrl(door, ROUTE);
  const read = async (options = {}) => (await doorRequest(get, url,
    { token: auth, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...options })).json();
  const plan = await read();
  if (!UUID.test(plan?.workspaceId ?? '') || !SEQUENCE.test(plan.through ?? '')
    || ![plan.objects, plan.bytes, plan.otherObjects, plan.archiveBytes, plan.verified, plan.copiedBytes, plan.stagedObjects, plan.stagedBytes].every(validCount)
    || plan.bytes > plan.archiveBytes || plan.verified + plan.stagedObjects > plan.objects || plan.copiedBytes + plan.stagedBytes > plan.bytes
    || typeof plan.complete !== 'boolean') {
    throw new Error('The local archive inventory is invalid.');
  }
  const additional = archiveAdditionalBytes(plan);
  const estimate = { ...plan, estimatedAdditionalArchiveBytes: additional.toString(),
    estimatedAdditionalNextBackupBytes: additional.toString(), availableArchiveBytes: String(await availableBytes()) };
  if (args.mode === 'plan') return estimate;
  if (plan.workspaceId !== args.workspaceId) throw new Error('The running app belongs to a different workspace.');
  if (plan.otherObjects) throw new Error('The archive manifest has unsupported keys. Preparation requires the whole selected workspace.');
  if (plan.complete) return estimate;
  const remaining = archiveAdditionalBytes({ bytes: plan.bytes - plan.copiedBytes - plan.stagedBytes,
    objects: plan.objects - plan.verified - plan.stagedObjects });
  const required = BigInt(args.backupBytes) + additional + remaining;
  if (BigInt(estimate.availableArchiveBytes) < required) throw new Error(`Allow at least ${required} bytes for archive copies and the next backup.`);
  const { workspaceId, through, objects, bytes } = plan;
  let verified = plan.verified;
  let copiedBytes = plan.copiedBytes;
  while (verified < objects) {
    const result = await read({ method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, through, objects, bytes }) });
    if (result?.workspaceId !== workspaceId || result.through !== through || result.objects !== objects || result.bytes !== bytes
      || !validCount(result.verified) || result.verified <= verified || result.verified > objects
      || !validCount(result.copiedBytes) || result.copiedBytes <= copiedBytes || result.copiedBytes > bytes
      || result.complete !== (result.verified === objects) || result.complete && result.copiedBytes !== bytes) {
      throw new Error('The archive copy progress did not advance.');
    }
    verified = result.verified;
    copiedBytes = result.copiedBytes;
    onProgress(result);
  }
  return { ...estimate, complete: true, verified, copiedBytes, stagedObjects: 0, stagedBytes: 0 };
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  try {
    const options = archiveTransitionArgs(process.argv.slice(2));
    const result = await transitionCustomerArchive(options, { onProgress: progress => {
      process.stderr.write(`Verified ${progress.verified} of ${progress.objects} archive objects.\n`);
    } });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
