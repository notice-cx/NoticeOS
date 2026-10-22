import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DOCKERFILE, pinnedTaskTools, taskToolsKey } from './task-store-test-tools.mjs';

// The CI task-store job's tools come from the application image's own pins
// (scripts/task-store-test-tools.mjs); a Dockerfile change that moves them
// fails here rather than in the Docker job.

test('the task store suites use the exact task and Dolt clients the application image pins', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');
  for (const arch of ['amd64', 'arm64']) {
    const pins = pinnedTaskTools(dockerfile, arch);
    assert.match(pins.beads.url, new RegExp(`^https://github\\.com/gastownhall/beads/releases/download/v[0-9.]+/beads_[0-9.]+_linux_${arch}\\.tar\\.gz$`, 'u'));
    assert.match(pins.dolt.url, new RegExp(`^https://github\\.com/dolthub/dolt/releases/download/v[0-9.]+/dolt-linux-${arch}\\.tar\\.gz$`, 'u'));
    for (const pin of [pins.beads, pins.dolt]) {
      assert.match(pin.sha256, /^[0-9a-f]{64}$/u);
      assert.ok(dockerfile.includes(`${arch}) digest=${pin.sha256} ;;`), 'the digest is the image\'s own, not a copy');
    }
  }
  assert.notEqual(pinnedTaskTools(dockerfile, 'amd64').beads.sha256, pinnedTaskTools(dockerfile, 'arm64').beads.sha256);
  assert.throws(() => pinnedTaskTools(dockerfile, 'riscv64'), /no pinned task tools/u);
  assert.throws(() => pinnedTaskTools(dockerfile.replace(/amd64\) digest=[0-9a-f]{64} ;;/gu, ''), 'amd64'), /no amd64 download/u);
});

// A cached set of tools is keyed on what it holds: an unrelated Dockerfile
// change keeps it, a moved pin or a changed preparation replaces it.
test('the prepared task tools key changes only with their pins, architecture or preparation', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');
  const key = taskToolsKey(dockerfile, 'amd64', 'preparation');
  assert.match(key, /^[0-9a-f]{64}$/u);
  assert.equal(taskToolsKey(dockerfile, 'amd64', 'preparation'), key);
  assert.equal(taskToolsKey(`${dockerfile}\nENV UNRELATED=1\n`, 'amd64', 'preparation'), key);
  const pin = pinnedTaskTools(dockerfile, 'amd64').dolt.sha256;
  assert.notEqual(taskToolsKey(dockerfile.replace(pin, 'f'.repeat(64)), 'amd64', 'preparation'), key);
  assert.notEqual(taskToolsKey(dockerfile, 'arm64', 'preparation'), key);
  assert.notEqual(taskToolsKey(dockerfile, 'amd64', 'another preparation'), key);
});
