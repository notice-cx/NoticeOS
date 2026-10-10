// wall:fit's verdict over several frames, with the browser replaced: a loader
// hook hands the CLI a page whose measurements are the frames below.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = new URL('./wall-fit-check.mjs', import.meta.url).pathname;

const FAKE_PAGE = `
const frames = JSON.parse(process.env.WALL_FIT_FRAMES);
export async function withChromePage(binary, viewport, read) {
  return read({
    send: async () => ({}),
    // The readiness probe is the one expression that is not the measurement.
    evaluate: async (expression) => (expression.startsWith('!!') ? true : frames.shift()),
  });
}
`;
const HOOKS = `
export async function resolve(specifier, context, next) {
  if (specifier === './surface-audit.mjs' && context.parentURL?.endsWith('/wall-fit-check.mjs')) {
    return { url: new URL('./fake-surface-audit.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
`;
const REGISTER = `import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
`;

async function runCli(t, frames) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wall-fit-check-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'fake-surface-audit.mjs'), FAKE_PAGE);
  await fs.writeFile(path.join(dir, 'hooks.mjs'), HOOKS);
  await fs.writeFile(path.join(dir, 'register.mjs'), REGISTER);
  const child = spawn(
    process.execPath,
    ['--import', path.join(dir, 'register.mjs'), CLI, '--json', '--chrome', 'fixture', '--samples', String(frames.length), '--settle-ms', '1'],
    { env: { PATH: process.env.PATH, WALL_FIT_FRAMES: JSON.stringify(frames) }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

const frame = ({ tight, content, x = [], y = [], ink = [], clipped = [], regions }) => ({
  viewport: { width: 1920, height: 1080 },
  tight,
  content,
  offenders: { x, y },
  ink,
  clipped,
  regions,
});

test('the worst frame wins per axis, regions come from the tallest frame, and offenders are unioned', async (t) => {
  const frames = [
    // First paint: fits, one small sideways leak and a little ink.
    frame({
      tight: { right: 1900, bottom: 1000 }, content: { right: 1920, bottom: 1080 },
      x: [{ el: '.strip', kind: 'text', axis: 'x', by: 4 }],
      ink: [{ el: '.feed', kind: 'ink', axis: 'y', delta: 2 }],
      regions: 'first',
    }),
    // Late data lands: the tallest painted frame, spilling downwards.
    frame({
      tight: { right: 1880, bottom: 1110 }, content: { right: 1920, bottom: 1110 },
      y: [{ el: '.sites', kind: 'box', axis: 'y', by: 30 }],
      ink: [{ el: '.feed', kind: 'ink', axis: 'y', delta: 6 }],
      regions: 'tallest',
    }),
    // The sideways leak grows in a frame that is not the tallest.
    frame({
      tight: { right: 1930, bottom: 1050 }, content: { right: 1930, bottom: 1080 },
      x: [{ el: '.strip', kind: 'text', axis: 'x', by: 10 }],
      clipped: [{ el: '.name', kind: 'run', axis: 'x', delta: 3 }],
      regions: 'last',
    }),
  ];
  const { code, stdout, stderr } = await runCli(t, frames);
  assert.equal(code, 1, stderr);
  const { fits, samples, report } = JSON.parse(stdout);
  assert.equal(fits, false);
  assert.equal(samples, 3);
  assert.equal(report.regions, 'tallest');
  assert.deepEqual(report.content, { right: 1930, bottom: 1110 });
  assert.deepEqual(report.tight, { right: 1930, bottom: 1110 });
  assert.deepEqual(report.spread, [{ right: 1900, bottom: 1000 }, { right: 1880, bottom: 1110 }, { right: 1930, bottom: 1050 }]);
  assert.deepEqual(report.offenders.x, [{ el: '.strip', kind: 'text', axis: 'x', by: 10 }]);
  assert.deepEqual(report.offenders.y, [{ el: '.sites', kind: 'box', axis: 'y', by: 30 }]);
  assert.deepEqual(report.ink, [{ el: '.feed', kind: 'ink', axis: 'y', delta: 6 }]);
  assert.deepEqual(report.clipped, [{ el: '.name', kind: 'run', axis: 'x', delta: 3 }]);
  assert.deepEqual(report.worst, { x: report.offenders.x[0], y: report.offenders.y[0] });
});

test('frames that all fit exit 0', async (t) => {
  const fitting = frame({ tight: { right: 1900, bottom: 1000 }, content: { right: 1920, bottom: 1080 }, regions: 'only' });
  const { code, stdout, stderr } = await runCli(t, [fitting, fitting]);
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).fits, true);
});
