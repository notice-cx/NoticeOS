import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DOCKERFILE, pinnedTaskTools } from './task-store-test-tools.mjs';

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
