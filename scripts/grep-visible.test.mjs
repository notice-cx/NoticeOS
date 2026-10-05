import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkoutRelative, installationDir } from './installation.mjs';

// A FILE THE DEFAULT SEARCH SKIPS IS WORSE THAN A MISSING ONE, because the
// search reports success. `scripts/os-up.mjs` — the largest file in the repo and
// the whole runner — carried a literal NUL byte inside a template literal
// (`${kind}<NUL>${key}`, the handoff map key), and macOS's BSD grep classifies a
// file holding one as binary. `grep -n panelReviewTitle scripts/os-up.mjs` found
// NOTHING while `grep -an` found three hits, so an agent grepping for a symbol
// defined there got only the test file's references and reasonably concluded the
// implementation had never been written. That happened on 2026-08-04 (bead
// ro-20n), and commit 7e761ce is the same defect in another file two days
// earlier: whatever writes this byte writes it more than once.
//
// So this is the standing check. It is not about NUL specifically being illegal
// — it is about a tracked source file staying findable by the tool everyone
// actually reaches for first.
//
// TWO CHECKS, because neither alone is enough:
//
//  1. `grep -c ''` against the file's real line count. This is the symptom as it
//     was reported: on the poisoned os-up.mjs, `grep -c ''` printed nothing at
//     all and exited 1 while `wc -l` said 3728. One batched grep for the whole
//     candidate list, so the cost is a single process.
//  2. A NUL scan in this process. Check 1 has a blind spot — on a SMALL file BSD
//     grep still counts the lines correctly and only suppresses the matching
//     lines, which is the same invisibility with a healthy-looking count. And
//     check 1 is only as strict as the local grep: GNU grep counts binary files
//     happily, so on another machine it would have no teeth at all. This one is
//     the cause, and it reads the same everywhere.
//
// The blind spot in check 1 was not hypothetical: the first run of check 2 found
// TWO more offenders that check 1 was perfectly happy with —
// `scripts/signal-panels-refresh.mjs` and `workers/ingest/src/auth.ts`, both
// grep-invisible, both the same literal-NUL-in-a-template-literal habit. They are
// carried below as named, bead-carrying exceptions because they belong to lanes
// ro-20n could not touch; they are not evidence that the check is too strict.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

/** This installation's own folder, as the one resolver places it
 * (scripts/installation.mts), repo-relative with a trailing slash — or null
 * when it sits outside the checkout, where `git ls-files` never lists it. Its
 * files are the operator's data (decision log, notes, host settings), not
 * source, and unit tests never read them (bead ro-ujb9.92,
 * scripts/test-config-isolation.mts). */
const INSTALLATION_PREFIX = (() => {
  const relative = checkoutRelative(installationDir({ root: REPO_ROOT }), { root: REPO_ROOT });
  return path.isAbsolute(relative) ? null : `${relative}/`;
})();

/**
 * Files known to hold the byte, still holding it, and tracked in the register.
 *
 * The sweep that first ran this check found three offenders, not one — the same
 * literal-NUL-in-a-template-literal habit in three places, which is what ro-20n
 * predicted ("whatever wrote this byte writes it more than once"). Two of them
 * belong to lanes the fixing agent was not permitted to touch, and neither is
 * fixed by pretending the guard cannot see them: an entry here says the hazard is
 * KNOWN and TRACKED rather than fixed, which is strictly better than a place the
 * guard is blind (the same discipline `scripts/no-second-runtime.test.mjs` runs
 * on its allowlists).
 *
 * An entry must name the bead that removes it, and the pruning assertion below
 * deletes it the moment it stops being true. There is no "grandfathered" state.
 */
const KNOWN_GREP_INVISIBLE = new Map([]);

/** The tracked files an agent greps: source and prose. Deliberately NOT every
 * tracked file — fixtures, archives and binary assets may legitimately hold
 * anything, and a guard that cries about them gets muted. `git ls-files` rather
 * than a directory walk so untracked scratch files and node_modules are out by
 * construction. The installation's own folder is out too (above). */
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

// A guard that scans nothing passes forever — the failure this whole file is
// about. If the listing collapses, that is a hard failure, not a quiet pass.
const FILES = candidates();

test('the grep-visibility sweep actually has files to sweep', () => {
  assert.ok(
    FILES.length > 100,
    `only ${FILES.length} tracked source file(s) found — the git ls-files call did not resolve, ` +
      'so this guard is checking almost nothing',
  );
  assert.ok(FILES.includes('scripts/os-up.mjs'), 'the file that motivated this check must be in it');
  // The product's prose is swept; the installation's own files never are.
  assert.ok(FILES.includes('config/decisions.md'), "the product's decision log is swept");
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
    if (KNOWN_GREP_INVISIBLE.has(name)) continue;
    const found = firstNul(name);
    if (found) offenders.push(`${name}: NUL byte at offset ${found.at} (line ${found.line})`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files hold a NUL byte and are invisible to plain grep:\n  ${offenders.join('\n  ')}\n` +
      'grep reports success and returns nothing, so a search for a symbol defined there reads ' +
      'as "never implemented" (bead ro-20n; precedent 7e761ce). If the byte is a deliberate ' +
      'string value, write it as the escape `\\0` / `\\u0000` — same character at runtime, ' +
      'visible source.',
  );
});

// A tracked exception nobody prunes is a rule that has quietly stopped being one
// — and here it is worse than that: a stale entry would hide a file that had
// been fixed and then re-poisoned.
test('every known-invisible file still exists and still needs its entry', () => {
  const tracked = new Set(FILES);
  for (const [name, reason] of KNOWN_GREP_INVISIBLE) {
    assert.ok(
      tracked.has(name),
      `${name} is carried as a known exception but is not a tracked source file — drop the entry`,
    );
    assert.match(reason, /bead ro-/, `${name} needs the bead that removes it, not a label`);
    assert.ok(
      firstNul(name) !== null,
      `${name} no longer holds a NUL — it is fixed, so delete its KNOWN_GREP_INVISIBLE entry ` +
        '(and close the bead named in it with the commit hash)',
    );
  }
});

test("grep's own line count agrees with the file's", () => {
  // One spawn for the whole list. `-c ''` matches every line, so the count grep
  // reports IS its idea of how many lines the file has; a file it has given up on
  // reports a different number, or nothing at all.
  const counted = spawnSync('grep', ['-c', '', ...FILES], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (counted.error) {
    // No grep on this machine is not a reason to fail the suite; the NUL scan
    // above is the portable half and it has already run.
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
    if (KNOWN_GREP_INVISIBLE.has(name)) continue;
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
      'That is the ro-20n symptom: grep has classified the file as binary and searches it ' +
      'report success while finding nothing. Look for a NUL byte (the test above names the ' +
      'offset) or another control byte, and replace it with its escape.',
  );
});
