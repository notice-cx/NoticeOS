import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkoutRelative, installationDir } from './installation.mjs';

// A literal NUL byte in a source file makes BSD grep treat it as binary: a plain
// `grep -n symbol file` finds nothing and still exits as if it searched, so a
// symbol defined there looks never written. Two checks: a NUL scan (portable),
// and grep's own line count against the file's (catches any other byte grep
// gives up on).

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

/** This installation's own folder, repo-relative, or null when it sits outside
 * the checkout. Its files are the operator's data, not source. */
const INSTALLATION_PREFIX = (() => {
  const relative = checkoutRelative(installationDir({ root: REPO_ROOT }), { root: REPO_ROOT });
  return path.isAbsolute(relative) ? null : `${relative}/`;
})();

/** The tracked source and prose an agent greps; fixtures and binary assets may hold anything. */
function candidates() {
  const listed = spawnSync('git', ['ls-files', '-z', '*.mjs', '*.ts', '*.tsx', '*.md'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  return listed.stdout
    .split('\0')
    .filter((name) => name !== '')
    .filter((name) => INSTALLATION_PREFIX === null || !name.startsWith(INSTALLATION_PREFIX));
}

const FILES = candidates();

test('the grep-visibility sweep actually has files to sweep', () => {
  assert.ok(
    FILES.length > 100,
    `only ${FILES.length} tracked source file(s) found — the git ls-files call did not resolve, ` +
      'so this guard is checking almost nothing',
  );
  assert.ok(FILES.includes('scripts/os-up.mjs'));
  assert.ok(FILES.includes('config/constants.README.md'), "the product's config prose is swept");
  if (INSTALLATION_PREFIX !== null) {
    assert.deepEqual(FILES.filter((name) => name.startsWith(INSTALLATION_PREFIX)), []);
  }
});

/** Where the first NUL is, or null. */
function firstNul(name) {
  const buf = readFileSync(path.join(REPO_ROOT, name));
  const at = buf.indexOf(0);
  if (at < 0) return null;
  return { at, line: buf.subarray(0, at).toString('utf8').split('\n').length };
}

test('no tracked source file holds a byte that makes grep treat it as binary', () => {
  const offenders = [];
  for (const name of FILES) {
    const found = firstNul(name);
    if (found) offenders.push(`${name}: NUL byte at offset ${found.at} (line ${found.line})`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files hold a NUL byte and are invisible to plain grep:\n  ${offenders.join('\n  ')}\n` +
      'grep reports success and returns nothing, so a search for a symbol defined there reads ' +
      'as "never implemented". If the byte is a deliberate ' +
      'string value, write it as the escape `\\0` / `\\u0000` — same character at runtime, ' +
      'visible source.',
  );
});

test("grep's own line count agrees with the file's", () => {
  // `-c ''` matches every line, so the count is grep's idea of the file's length.
  const counted = spawnSync('grep', ['-c', '', ...FILES], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (counted.error) {
    assert.fail(`could not run grep: ${counted.error.message}`);
  }

  const reported = new Map();
  for (const row of counted.stdout.split('\n')) {
    const split = row.lastIndexOf(':');
    if (split < 0) continue;
    reported.set(row.slice(0, split), Number(row.slice(split + 1)));
  }

  const offenders = [];
  for (const name of FILES) {
    const buf = readFileSync(path.join(REPO_ROOT, name));
    if (buf.length === 0) continue;
    // What grep calls a line: every newline, plus a trailing unterminated one.
    let lines = 0;
    for (const byte of buf) if (byte === 0x0a) lines++;
    if (buf[buf.length - 1] !== 0x0a) lines++;

    const said = reported.get(name);
    if (said === undefined) {
      offenders.push(`${name}: grep reported no count at all (${lines} lines on disk)`);
    } else if (said !== lines) {
      offenders.push(`${name}: grep counted ${said} lines, the file has ${lines}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `grep does not agree with these files about what is in them:\n  ${offenders.join('\n  ')}\n` +
      'grep has classified the file as binary, and searches of it ' +
      'report success while finding nothing. Look for a NUL byte (the test above names the ' +
      'offset) or another control byte, and replace it with its escape.',
  );
});
