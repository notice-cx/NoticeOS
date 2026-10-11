import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY } from './published-image.mjs';
import { mainImage, pullReleaseImage } from './stack-deploy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = 'a'.repeat(40);
const SCHEMA = 'b'.repeat(64);
const MANIFEST = 'c'.repeat(64);
const ID = `sha256:${'d'.repeat(64)}`;
const inputs = async () => ({ source: { commit: COMMIT, schema: SCHEMA }, manifest: MANIFEST });

/** A registry and Docker that answer for one published image with `labels`. */
function registry({ published = true, labels = {}, architecture = 'arm64' } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push(args.join(' '));
    if (args.includes('pull')) return { code: published ? 0 : 1, stdout: '', stderr: 'manifest unknown' };
    if (args.includes('--format')) return { code: 0, stdout: `${ID}\n` };
    if (args.includes('inspect')) {
      return { code: 0, stdout: JSON.stringify([{ Id: ID, Os: 'linux', Architecture: architecture, Config: { Labels: {
        'org.opencontainers.image.revision': COMMIT, 'cx.noticeos.schema': SCHEMA, 'cx.noticeos.source': MANIFEST, ...labels } } }]) };
    }
    return { code: 0, stdout: '' };
  };
  return { calls, run };
}
const quiet = { write() {} };
const pull = (docker, platform = 'linux/arm64') => pullReleaseImage({ dockerHost: 'unix:///var/run/docker.sock', platform, run: docker.run, out: quiet, inputs });

test('the published image for main\'s commit is used when it was built from exactly this checkout\'s source', async () => {
  const docker = registry();
  assert.deepEqual(await pull(docker), { commit: COMMIT, image: ID, source: MANIFEST, schemaHash: SCHEMA, platform: 'linux/arm64' });
  assert.ok(docker.calls[0].endsWith(`pull --quiet --platform linux/arm64 ${RELEASE_REPOSITORY}:${COMMIT}`), docker.calls[0]);
});

test('an image that claims another commit, schema, source or platform is refused, never deployed', async () => {
  for (const labels of [{ 'org.opencontainers.image.revision': 'e'.repeat(40) }, { 'cx.noticeos.schema': 'e'.repeat(64) }, { 'cx.noticeos.source': 'e'.repeat(64) }]) {
    await assert.rejects(pull(registry({ labels })), /was not built from this checkout's source; nothing was changed\. Add -- --build to build it here\./u);
  }
  await assert.rejects(pull(registry({ architecture: 'amd64' })), /was not built from this checkout's source/u);
});

test('with nothing published it builds here and says why; --build never asks the registry', async () => {
  assert.equal(await pull(registry({ published: false })), null);
  const built = { image: ID, built: true };
  let shown = '';
  let pulled = 0;
  assert.equal(await mainImage({ out: { write: (text) => { shown += text; } }, pull: async () => { pulled += 1; return null; }, make: async () => built }), built);
  assert.equal(pulled, 1);
  assert.match(shown, /No published image for this commit yet .* building it here instead\./u);
  assert.equal(await mainImage({ build: true, out: quiet, pull: async () => assert.fail('the registry was asked'), make: async () => built }), built);
  const published = { image: ID };
  assert.equal(await mainImage({ out: quiet, pull: async () => published, make: async () => assert.fail('it built anyway') }), published);
});

test('the release workflow publishes to the repository the commands pull from, only after CI passes on main', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/release-image.yml'), 'utf8');
  assert.ok(!workflow.includes(RELEASE_REPOSITORY), 'the workflow reads the repository from scripts/published-image.mjs rather than restating it');
  assert.match(workflow, /RELEASE_REPOSITORY/u);
  assert.match(workflow, /workflows: \[CI\]/u);
  assert.match(workflow, /conclusion == 'success'/u);
  assert.match(workflow, /--build-only/u);
  for (const platform of ['linux/amd64', 'linux/arm64']) assert.ok(workflow.includes(platform), platform);
  assert.match(workflow, /actions\/attest-build-provenance@/u);
});
