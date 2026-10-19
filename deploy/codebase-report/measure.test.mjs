import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LIMITS, batches, boundEnvelope, buildEnvelope, churnSummary, complexitySummary, contentExclusion, directDependencies,
  globMatcher, ingestEndpoint, main, manifestDependencies, normalizeRemote, parseArgs, parseCsv, parseDeadCode, parseGitLog,
  parseJscpd, parseLizard, parseScc, parseSentMeasure, pathRules, postEnvelope, readRepoConfig, REASONS, safeRelativePath,
  selectFiles, sentMeasures, sizeSummary, summaryLine, versionOf,
} from './measure.mjs';

const REPO = '/repo';
const COMMIT = 'a'.repeat(40);

test('a path that could leave the repository is refused; a messy one is normalized', () => {
  assert.equal(safeRelativePath('./src//a.ts'), 'src/a.ts');
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../b', 'a\\b', 'C:/x', 'a\0b', 'a\nb', 'x'.repeat(LIMITS.pathChars + 1), '.', './']) {
    assert.equal(safeRelativePath(bad), null, JSON.stringify(bad));
  }
});

test('arguments: the site id is required, folders stay inside the repository, the token is never an argument', () => {
  const parsed = parseArgs(['--asset', 'example.com', '--repo', '/repo', '--paths', 'apps/site, packages/ui/', '--ref', 'main']);
  assert.deepEqual(parsed, {
    asset: 'example.com', repo: '/repo', paths: ['apps/site', 'packages/ui'], ref: 'main', out: null, post: null,
    sent: { measures: {}, unmeasured: {} },
  });
  assert.equal(parseArgs(['--asset', 'example.com']).repo, '/repo');
  assert.throws(() => parseArgs([]), /--asset/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--token', 'x']), /Usage/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--asset', 'example.org']), /Usage/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--paths', '../other']), /inside the repository/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--paths', Array.from({ length: 21 }, (_, i) => `p${i}`).join(',')]), /1 to 20/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--ref', 'main; rm']), /--ref/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--out']), /needs a value/u);
});

test('--measure carries the build, test and vulnerable-package results of the caller\'s own steps, validated', () => {
  const parsed = parseArgs(['--asset', 'example.com', '--measure', 'build_passed=success', '--measure', 'tests_passed=failure',
    '--measure', 'vulnerable_dependencies=3']);
  assert.deepEqual(parsed.sent, { measures: { build_passed: 1, tests_passed: 0, vulnerable_dependencies: 3 }, unmeasured: {} });
  for (const [text, value] of [['build_passed=true', 1], ['build_passed=1', 1], ['build_passed=PASSED', 1], ['tests_passed=false', 0],
    ['tests_passed=0', 0], ['vulnerable_dependencies=0', 0]]) {
    assert.equal(parseSentMeasure(text).value, value, text);
  }
  assert.deepEqual(parseSentMeasure('tests_passed=skipped'), { key: 'tests_passed', unmeasured: REASONS.stepDidNotRun });
  assert.deepEqual(parseSentMeasure('build_passed=cancelled'), { key: 'build_passed', unmeasured: REASONS.stepDidNotRun });
  for (const bad of ['code_lines=5', 'build_passed', '=1', 'build_passed=maybe', 'tests_passed=', 'vulnerable_dependencies=-1',
    'vulnerable_dependencies=1.5', 'vulnerable_dependencies=many', 'toString=1']) {
    assert.throws(() => parseSentMeasure(bad), /--measure/u, bad);
  }
  assert.throws(() => parseArgs(['--asset', 'example.com', '--measure', 'build_passed=success', '--measure', 'build_passed=failure']), /twice/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--measure']), /needs a value/u);
});

test('a measure the caller did not send stays absent with its reason; a sent one joins the measures', () => {
  assert.deepEqual(sentMeasures(null), {
    measures: {},
    unmeasured: { build_passed: REASONS.buildNotSent, tests_passed: REASONS.testsNotSent, vulnerable_dependencies: REASONS.auditNotSent },
  });
  const sent = sentMeasures({ measures: { build_passed: 0, vulnerable_dependencies: 2 }, unmeasured: { tests_passed: REASONS.stepDidNotRun } });
  assert.deepEqual(sent, { measures: { build_passed: 0, vulnerable_dependencies: 2 }, unmeasured: { tests_passed: REASONS.stepDidNotRun } });
  const envelope = buildEnvelope(envelopeInput({ measures: { code_lines: 100, ...sent.measures }, unmeasured: sent.unmeasured }));
  assert.deepEqual(Object.keys(envelope.measures), ['code_lines', 'build_passed', 'vulnerable_dependencies']);
  assert.deepEqual(envelope.unmeasured, { tests_passed: REASONS.stepDidNotRun });
  for (const reason of Object.values(REASONS)) assert.ok(reason.length <= LIMITS.reasonChars, reason);
});

test('the report goes to the ingest over https, or plain http on this machine only', () => {
  assert.equal(ingestEndpoint('https://ingest.example.com'), 'https://ingest.example.com/api/codebase-report');
  assert.equal(ingestEndpoint('https://ingest.example.com/base/'), 'https://ingest.example.com/base/api/codebase-report');
  assert.equal(ingestEndpoint('https://ingest.example.com/api/codebase-report'), 'https://ingest.example.com/api/codebase-report');
  assert.equal(ingestEndpoint('http://127.0.0.1:8791'), 'http://127.0.0.1:8791/api/codebase-report');
  assert.throws(() => ingestEndpoint('http://ingest.example.com'), /https/u);
  assert.throws(() => ingestEndpoint('https://user:secret@ingest.example.com'), /credentials/u);
  assert.throws(() => ingestEndpoint('ftp://ingest.example.com'), /https/u);
  assert.throws(() => ingestEndpoint('not a url'), /ingest address/u);
});

test('the default exclusions: installed, built, locked, minified, binary and prose files are not measured', () => {
  const rules = pathRules();
  for (const file of ['node_modules/x/index.js', 'apps/web/node_modules/y.js', 'dist/app.js', 'packages/a/build/out.js', '.next/server.js',
    'coverage/lcov.js', 'vendor/lib.php', 'pnpm-lock.yaml', 'apps/web/package-lock.json', 'go.sum', 'public/app.min.js', 'a/b.min.css',
    'app.js.map', 'logo.png', 'font.woff2', 'icon.svg', 'README.md', 'docs/guide.md', 'data/table.csv', 'LICENSE', 'licenses/x-LICENSE.txt',
    'CHANGELOG.md']) {
    assert.ok(rules.exclusion(file), file);
  }
  for (const file of ['src/index.ts', 'src/build.ts', 'distribution/a.ts', 'package.json', 'styles/app.css', 'db/schema.sql']) {
    assert.equal(rules.exclusion(file), null, file);
  }
});

test('test files are found by the common conventions and the repository list', () => {
  const rules = pathRules(readRepoConfig(JSON.stringify({ exclude: ['legacy/', '*.gen.ts'], tests: ['qa/**'] })));
  for (const file of ['test/a.js', 'src/__tests__/a.tsx', 'apps/web/e2e/flow.ts', 'src/a.test.ts', 'src/a.spec.tsx', 'pkg/a_test.go',
    'tests/test_api.py', 'app/test_models.py', 'spec/model_spec.rb', 'src/FooTest.java', 'conftest.py', 'qa/smoke/run.ts',
    'scripts/test-fixtures/a.mjs', 'scripts/test-helpers.mjs', 'src/a.fixture.mjs', 'db/fixtures/seed.sql']) {
    assert.equal(rules.isTest(file), true, file);
  }
  for (const file of ['src/testing-library-free.tsx', 'src/contest.ts', 'src/attest.ts', 'src/latest/a.ts']) {
    assert.equal(rules.isTest(file), false, file);
  }
  assert.ok(rules.exclusion('legacy/old.ts'));
  assert.ok(rules.exclusion('src/api.gen.ts'));
  assert.equal(rules.exclusion('src/legacy.ts'), null);
});

test('repository globs: * stays in a folder, ** crosses folders, a bare name matches anywhere, a slashed one is anchored', () => {
  const match = (pattern, file) => globMatcher(pattern)(file);
  assert.equal(match('generated', 'src/generated/a.ts'), true);
  assert.equal(match('*.snap', 'a/b/c.snap'), true);
  assert.equal(match('src/*.ts', 'src/a.ts'), true);
  assert.equal(match('src/*.ts', 'src/x/a.ts'), false);
  assert.equal(match('src/**/*.ts', 'src/x/y/a.ts'), true);
  assert.equal(match('src/**/*.ts', 'src/a.ts'), true);
  assert.equal(match('apps/legacy', 'apps/legacy/x/y.ts'), true);
  assert.equal(match('apps/legacy', 'other/apps/legacy/y.ts'), false);
  assert.equal(match('/top.ts', 'top.ts'), true);
  assert.equal(match('*.{gen,auto}.ts', 'a/b.auto.ts'), true);
  assert.equal(match('a.b', 'aXb'), false);
});

test("a mistake in the repository's settings stops the run instead of changing the numbers unseen", () => {
  assert.deepEqual(readRepoConfig(null), { exclude: [], tests: [] });
  assert.throws(() => readRepoConfig('{'), /not valid JSON/u);
  assert.throws(() => readRepoConfig('[]'), /one object/u);
  assert.throws(() => readRepoConfig('{"excludes": []}'), /"excludes"/u);
  assert.throws(() => readRepoConfig('{"exclude": "dist"}'), /list/u);
  assert.throws(() => readRepoConfig('{"tests": [""]}'), /list/u);
});

test("a file's own head marks it generated, minified or binary; a marker inside code is not a comment", () => {
  const head = (text) => Buffer.from(text);
  assert.equal(contentExclusion('a.mjs', head('// Generated by pnpm generate. Edit the sibling .mts source.\nexport {};\n')), 'generated');
  assert.equal(contentExclusion('a.go', head('// Code generated by protoc-gen-go. DO NOT EDIT.\npackage a\n')), 'generated');
  assert.equal(contentExclusion('a.py', head('# @generated\n')), 'generated');
  assert.equal(contentExclusion('a.md', head('<!-- generated from model.json -->\n')), 'generated');
  assert.equal(contentExclusion('a.ts', head('const label = "generated by the tool";\n')), null);
  assert.equal(contentExclusion('a.ts', head('export const a = 1;\n'.repeat(8) + '// generated by x\n')), null);
  assert.equal(contentExclusion('a.bin', Buffer.from([1, 0, 2])), 'binary');
  assert.equal(contentExclusion('a.js', head('x'), { size: 10_000, lines: 2 }), 'minified');
  assert.equal(contentExclusion('a.ts', head('x'), { size: 10_000, lines: 2 }), null);
});

test('only regular files inside the repository are measured; links, missing and generated files are left out', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-select-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-outside-'));
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
  write('apps/site/src/a.ts', 'export const a = 1;\n');
  write('apps/site/src/a.test.ts', 'test();\n');
  write('apps/site/src/gen.mjs', '// Generated by a tool.\nexport {};\n');
  write('apps/other/b.ts', 'export const b = 2;\n');
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'x');
  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(repo, 'apps/site/src/link.ts'));
  const tracked = ['apps/site/src/a.ts', 'apps/site/src/a.test.ts', 'apps/site/src/gen.mjs', 'apps/site/src/link.ts',
    'apps/site/src/deleted.ts', 'apps/other/b.ts', '../escape.ts'];
  const { files, skipped } = selectFiles(repo, tracked, { paths: ['apps/site'], config: readRepoConfig(null) });
  assert.deepEqual(files, [{ path: 'apps/site/src/a.ts', test: false }, { path: 'apps/site/src/a.test.ts', test: true }]);
  assert.deepEqual([...skipped], ['apps/site/src/gen.mjs']);
});

test("scc's per-file JSON becomes one row per file", () => {
  const text = JSON.stringify([
    { Name: 'TypeScript', Files: [
      { Language: 'TypeScript', Location: 'src/a.ts', Code: 120, Comment: 10, Blank: 5, Lines: 135 },
      { Language: 'TypeScript', Location: './src/b.ts', Code: 30, Comment: 0 },
    ] },
    { Name: 'CSS', Files: [{ Language: 'CSS', Location: 'styles/app.css', Code: 40, Comment: 2 }, { Language: 'CSS', Location: '../x.css', Code: 1 }] },
  ]);
  assert.deepEqual(parseScc(text), [
    { path: 'src/a.ts', language: 'TypeScript', code: 120, comment: 10 },
    { path: 'src/b.ts', language: 'TypeScript', code: 30, comment: 0 },
    { path: 'styles/app.css', language: 'CSS', code: 40, comment: 2 },
  ]);
  assert.throws(() => parseScc('{}'), /list of languages/u);
});

test('line counts exclude tests; the test share is capped at 1 and languages are ranked by size', () => {
  const rows = [
    { path: 'src/a.ts', language: 'TypeScript', code: 100, comment: 5 },
    { path: 'src/b.ts', language: 'TypeScript', code: 50, comment: 0 },
    { path: 'src/c.css', language: 'CSS', code: 200, comment: 1 },
    { path: 'src/a.test.ts', language: 'TypeScript', code: 70, comment: 0 },
  ];
  const summary = sizeSummary(rows, new Set(['src/a.test.ts']));
  assert.deepEqual(summary.measures, { code_lines: 350, comment_lines: 6, files: 3, languages: 2, test_lines: 70, test_ratio: 0.2 });
  assert.deepEqual(summary.byLanguage.map((row) => row.language), ['CSS', 'TypeScript']);
  assert.deepEqual(summary.largestFiles[0], { path: 'src/c.css', code_lines: 200 });
  const heavy = sizeSummary([{ path: 'a.ts', language: 'TypeScript', code: 10, comment: 0 }, { path: 'a.test.ts', language: 'TypeScript', code: 30, comment: 0 }], new Set(['a.test.ts']));
  assert.equal(heavy.measures.test_ratio, 3);
  const none = sizeSummary([{ path: 'a.test.ts', language: 'TypeScript', code: 30, comment: 0 }], new Set(['a.test.ts']));
  assert.equal(none.measures.test_ratio, undefined);
  assert.match(none.unmeasured.test_ratio, /No code lines/u);
});

const JSCPD_REPORT = JSON.stringify({
  duplicates: [
    { format: 'typescript', lines: 12, fragment: 'const SECRET_SOURCE_TEXT = 1;', firstFile: { name: '/repo/src/a.ts', start: 10 }, secondFile: { name: '/repo/src/b.ts', start: 88 } },
    { format: 'typescript', lines: 48, fragment: 'x', firstFile: { name: '/repo/src/c.ts', start: 1 }, secondFile: { name: '/repo/src/c.ts', start: 200 } },
    { format: 'typescript', lines: 30, fragment: 'x', firstFile: { name: '/repo/src/a.ts', start: 1 }, secondFile: { name: '/elsewhere/z.ts', start: 1 } },
    { format: 'typescript', lines: 30, fragment: 'x', firstFile: { name: '/repo/src/a.test.ts', start: 1 }, secondFile: { name: '/repo/src/a.ts', start: 1 } },
  ],
  statistics: { total: { clones: 4, duplicatedLines: 1930, percentage: 4.0444, lines: 48210 } },
});

test("jscpd's clone report keeps totals and file pairs, never the repeated text", () => {
  const parsed = parseJscpd(JSCPD_REPORT, { repo: REPO, measured: new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']) });
  assert.deepEqual(parsed.measures, { duplicated_lines: 1930, duplication_percent: 4, duplicate_blocks: 4 });
  assert.deepEqual(parsed.duplicates, [
    { lines: 48, files: [{ path: 'src/c.ts', startLine: 1 }, { path: 'src/c.ts', startLine: 200 }] },
    { lines: 12, files: [{ path: 'src/a.ts', startLine: 10 }, { path: 'src/b.ts', startLine: 88 }] },
  ]);
  assert.ok(!JSON.stringify(parsed).includes('SECRET_SOURCE_TEXT'));
  assert.throws(() => parseJscpd('{"duplicates": []}', { repo: REPO, measured: new Set() }), /no totals/u);
});

test("jscpd's unused-code report lists unused files first, then exports, inside the measured code only", () => {
  const text = JSON.stringify({
    findings: [
      { category: 'unused-export', path: 'src/u.ts', name: 'helper', lines: 3 },
      { category: 'unused-file', path: 'src/old.ts', name: '', lines: 50 },
      { category: 'unused-file', path: 'src/older.ts', name: '', lines: 80 },
      { category: 'unused-file', path: 'src/a.test.ts', name: '', lines: 10 },
      { category: 'unused-import', path: 'src/u.ts', name: 'x', lines: 1 },
      { category: 'unused-file', path: '/repo/src/abs.ts', name: '', lines: 5 },
      { category: 'unused-file', path: '../../etc/x.ts', name: '', lines: 5 },
    ],
  });
  const parsed = parseDeadCode(text, { repo: REPO, measured: new Set(['src/u.ts', 'src/old.ts', 'src/older.ts', 'src/abs.ts']) });
  assert.deepEqual(parsed.measures, { unused_files: 3, unused_exports: 1 });
  assert.deepEqual(parsed.unused, [
    { kind: 'file', path: 'src/older.ts' }, { kind: 'file', path: 'src/old.ts' }, { kind: 'file', path: 'src/abs.ts' },
    { kind: 'export', path: 'src/u.ts', name: 'helper' },
  ]);
  const nested = parseDeadCode(JSON.stringify({ findings: [{ category: 'unused-file', path: 'src/x.ts', lines: 1 }] }),
    { repo: REPO, measured: new Set(['apps/site/src/x.ts']), paths: ['apps/site'] });
  assert.deepEqual(nested.unused, [{ kind: 'file', path: 'apps/site/src/x.ts' }]);
  assert.throws(() => parseDeadCode('{}', { repo: REPO, measured: new Set() }), /findings/u);
});

test("lizard's CSV becomes one row per function, quoted fields and all", () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\n'), [['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
  const csv = [
    '7,4,46,1,7,"generatorSteps@20-26@/repo/scripts/generate.mjs","/repo/scripts/generate.mjs","generatorSteps","generatorSteps ( check )",20,26',
    '40,41,300,2,210,"render@120-330@/tmp/links/3.ts","/tmp/links/3.ts","render","render ( a , b, \\"c\\" )",120,330',
    '1,1,4,0,1,"(anonymous)@29-29@/elsewhere/x.js","/elsewhere/x.js","(anonymous)","(anonymous)",29,29',
    'NLOC,CCN,token,PARAM,length,location,file,function,long_name,start,end',
  ].join('\n');
  const map = { '/repo/scripts/generate.mjs': 'scripts/generate.mjs', '/tmp/links/3.ts': 'src/x.mts' };
  assert.deepEqual(parseLizard(csv, (file) => map[file] ?? null), [
    { path: 'scripts/generate.mjs', name: 'generatorSteps', line: 20, complexity: 4, length: 7 },
    { path: 'src/x.mts', name: 'render', line: 120, complexity: 41, length: 210 },
  ]);
});

test('complexity: functions above 15 are hard to change; the mean has one decimal', () => {
  const fn = (complexity, line = 1) => ({ path: 'src/a.ts', name: `f${line}`, line, complexity, length: 10 });
  const summary = complexitySummary([fn(1, 1), fn(15, 2), fn(16, 3), fn(41, 4), fn(2, 5)]);
  assert.deepEqual(summary.measures, { functions: 5, complex_functions: 2, max_function_complexity: 41, mean_function_complexity: 15 });
  assert.deepEqual(summary.complexFunctions.map((row) => row.complexity), [41, 16]);
  assert.deepEqual(complexitySummary([]).measures, { functions: 0, complex_functions: 0 });
});

test('git history: commits, files touched and large commits count only measured files', () => {
  const many = Array.from({ length: 20 }, (_, i) => `1\t1\tsrc/f${i}.ts`).join('\0');
  const log = [
    `\x1e${'1'.repeat(40)}\0\n5\t0\tsrc/a.ts\0-\t-\tsrc/logo.png\0`,
    `\x1e${'2'.repeat(40)}\0\n1\t1\tpnpm-lock.yaml\0`,
    `\x1e${'3'.repeat(40)}\0\n${many}\0`,
    `\x1e${'4'.repeat(40)}\0\n2\t2\tsrc/a.ts\0`,
  ].join('');
  const commits = parseGitLog(log);
  assert.equal(commits.length, 4);
  assert.deepEqual(commits[0].files, ['src/a.ts', 'src/logo.png']);
  const rules = pathRules();
  assert.deepEqual(churnSummary(commits, (file) => !rules.exclusion(file)), { commits_30d: 3, files_touched_30d: 21, large_commits_30d: 1 });
  assert.deepEqual(parseGitLog(''), []);
});

test("tool versions are read from each tool's own --version line", () => {
  assert.equal(versionOf('scc version 3.7.0\n'), '3.7.0');
  assert.equal(versionOf('jscpd 5.4.0\n'), '5.4.0');
  assert.equal(versionOf('1.24.0\n'), '1.24.0');
  assert.equal(versionOf('no version'), null);
});

test('the remote is kept without scheme, credentials or .git, or not at all', () => {
  assert.equal(normalizeRemote('https://user:secret@github.com/example/site.git'), 'github.com/example/site');
  assert.equal(normalizeRemote('git@github.com:example/site.git\n'), 'github.com/example/site');
  assert.equal(normalizeRemote('ssh://git@git.example.com:2222/team/site'), 'git.example.com:2222/team/site');
  assert.equal(normalizeRemote('/srv/git/site.git'), null);
  assert.equal(normalizeRemote('file:///srv/git/site'), null);
  assert.equal(normalizeRemote(''), null);
});

test('direct dependencies: every manifest counted once, local and workspace packages left out', () => {
  const root = JSON.stringify({ name: 'site', devDependencies: { typescript: '5', '@example/ui': 'workspace:*' } });
  const app = JSON.stringify({ name: '@example/ui', dependencies: { react: '19', typescript: '5', local: 'file:../x' } });
  const total = directDependencies([
    { file: 'package.json', text: root }, { file: 'packages/ui/package.json', text: app },
    { file: 'requirements.txt', text: '# pinned\nDjango==5.0\nrequests>=2 # http\n-r base.txt\n' },
    { file: 'go.mod', text: 'module example.com/x\nrequire (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v1.0.0 // indirect\n)\nrequire github.com/e/f v2.0.0\n' },
    { file: 'Cargo.toml', text: '[package]\nname = "x"\n[dependencies]\nserde = "1"\n[dev-dependencies]\ntokio = { version = "1" }\n[dependencies.rand]\nversion = "0.8"\n' },
  ]);
  assert.equal(total, 2 + 2 + 2 + 3);
  assert.equal(directDependencies([{ file: 'src/a.ts', text: '' }]), null);
  assert.equal(manifestDependencies('package.json', '{'), null);
});

const envelopeInput = (overrides = {}) => ({
  asset: 'example.com',
  generatedAt: '2026-10-15T03:12:44Z',
  repository: { ref: 'main', commit: COMMIT, committedAt: '2026-10-14T22:01:00Z' },
  paths: null,
  tools: { scc: '3.7.0', jscpd: '5.4.0', lizard: '1.24.0' },
  measures: { code_lines: 100, functions: 0, complex_functions: 0 },
  unmeasured: { unused_files: 'Unused code is checked in JavaScript, TypeScript and Python only.', code_lines: 'ignored: it was measured' },
  byLanguage: [],
  findings: { duplicates: [], complexFunctions: [], unused: [], largestFiles: [] },
  ...overrides,
});

test('an absent measure stays absent with its reason; nothing unmeasured is written as 0', () => {
  const envelope = buildEnvelope(envelopeInput());
  assert.deepEqual(envelope.measures, { code_lines: 100, functions: 0, complex_functions: 0 });
  assert.equal('unused_files' in envelope.measures, false);
  assert.deepEqual(envelope.unmeasured, { unused_files: 'Unused code is checked in JavaScript, TypeScript and Python only.' });
  assert.equal('paths' in envelope, false);
  assert.deepEqual(Object.keys(envelope), ['asset', 'generatedAt', 'repository', 'tools', 'measures', 'unmeasured', 'byLanguage', 'findings']);
  assert.deepEqual(buildEnvelope(envelopeInput({ paths: ['apps/site'] })).paths, ['apps/site']);
});

test('a list whose tool did not run is left out; an empty list means none were found', () => {
  const envelope = buildEnvelope(envelopeInput({ byLanguage: undefined, findings: { duplicates: [], complexFunctions: undefined, unused: undefined, largestFiles: undefined } }));
  assert.equal('byLanguage' in envelope, false);
  assert.deepEqual(envelope.findings, { duplicates: [] });
});

test("every list is cut to the contract's limit and every path checked", () => {
  const file = (i) => ({ path: `src/f${i}.ts`, startLine: 1 });
  const envelope = boundEnvelope({
    ...envelopeInput(),
    byLanguage: Array.from({ length: 30 }, (_, i) => ({ language: `L${i}`, files: 1, code_lines: 1 })),
    findings: {
      duplicates: [
        ...Array.from({ length: 30 }, (_, i) => ({ lines: 50 - i, files: Array.from({ length: 14 }, (_, j) => file(i * 100 + j)) })),
      ].concat([{ lines: 1, files: [file(1), { path: '../x.ts', startLine: 1 }] }]),
      complexFunctions: [{ path: '/abs.ts', name: 'x', line: 1, complexity: 99, length: 1 },
        ...Array.from({ length: 30 }, (_, i) => ({ path: `src/c${i}.ts`, name: 'f', line: 1, complexity: 40, length: 1 }))],
      unused: [{ kind: 'dependency', name: 'lodash' }, ...Array.from({ length: 80 }, (_, i) => ({ kind: 'file', path: `src/u${i}.ts` }))],
      largestFiles: Array.from({ length: 30 }, (_, i) => ({ path: `src/l${i}.ts`, code_lines: 100 - i })),
    },
  });
  assert.equal(envelope.byLanguage.length, LIMITS.byLanguage);
  assert.equal(envelope.findings.duplicates.length, LIMITS.duplicates);
  assert.ok(envelope.findings.duplicates.every((row) => row.files.length <= LIMITS.duplicateFiles));
  assert.equal(envelope.findings.complexFunctions.length, LIMITS.complexFunctions);
  assert.equal(envelope.findings.complexFunctions[0].path, 'src/c0.ts');
  assert.equal(envelope.findings.unused.length, LIMITS.unused);
  assert.deepEqual(envelope.findings.unused[0], { kind: 'dependency', name: 'lodash' });
  assert.equal(envelope.findings.largestFiles.length, LIMITS.largestFiles);
});

// Lists at their limits stay well under 256 KiB, so a smaller bound exercises the cut.
test('a body past its bound loses findings, never measures', () => {
  const bodyBytes = 64 * 1024;
  const long = 'd/'.repeat(240);
  const envelope = boundEnvelope({
    ...envelopeInput(),
    findings: {
      duplicates: Array.from({ length: 20 }, (_, i) => ({ lines: 9, files: Array.from({ length: 10 }, (_, j) => ({ path: `${long}${i}-${j}.ts`, startLine: 1 })) })),
      complexFunctions: Array.from({ length: 20 }, (_, i) => ({ path: `${long}c${i}.ts`, name: 'n'.repeat(200), line: 1, complexity: 20, length: 1 })),
      unused: Array.from({ length: 50 }, (_, i) => ({ kind: 'export', path: `${long}u${i}.ts`, name: 'n'.repeat(200) })),
      largestFiles: Array.from({ length: 10 }, (_, i) => ({ path: `${long}l${i}.ts`, code_lines: 1 })),
    },
  }, { bodyBytes });
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= bodyBytes);
  assert.deepEqual(envelope.measures, envelopeInput().measures);
  assert.ok(envelope.findings.unused.length < 50);
  assert.throws(() => boundEnvelope(envelopeInput(), { bodyBytes: 100 }), /even without its findings/u);
});

test('paths are batched to fit one command line', () => {
  assert.deepEqual(batches(['a', 'b', 'c'], { maxFiles: 2 }), [['a', 'b'], ['c']]);
  assert.deepEqual(batches(['aaaa', 'bbbb', 'cc'], { maxChars: 10 }), [['aaaa', 'bbbb'], ['cc']]);
  assert.deepEqual(batches([]), []);
});

test('the token travels in the Authorization header and nowhere else; a missing token stops --post before measuring', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: 201, text: async () => '{"ok":true,"reportNumber":1}' }; };
  const envelope = buildEnvelope(envelopeInput());
  const answer = await postEnvelope('https://ingest.example.com/api/codebase-report', envelope, 'token-value', fetchImpl);
  assert.equal(answer.ok, true);
  assert.equal(calls[0].init.headers.authorization, 'Bearer token-value');
  assert.ok(!calls[0].init.body.includes('token-value'));
  let said = '';
  const code = await main(['--asset', 'example.com', '--repo', '/nonexistent', '--post', 'https://ingest.example.com'],
    { env: {}, out: { write() {} }, err: { write: (text) => { said += text; } }, fetchImpl });
  assert.equal(code, 2);
  assert.match(said, /NOTICEOS_ASSET_TOKEN/u);
});

test('the summary line names what was and was not measured', () => {
  const envelope = buildEnvelope(envelopeInput({ measures: { code_lines: 48210, duplication_percent: 4, complex_functions: 23 } }));
  assert.equal(summaryLine(envelope), 'example.com at aaaaaaaaaaaa: 48210 lines of code, 4% repeated, 23 hard-to-change functions; not measured: unused_files.');
  const checks = buildEnvelope(envelopeInput({ measures: { build_passed: 1, tests_passed: 0, vulnerable_dependencies: 2 }, unmeasured: {} }));
  assert.equal(summaryLine(checks), 'example.com at aaaaaaaaaaaa: build passed, tests failed, 2 vulnerable packages.');
});
