// A unit-test worker that dies names the file it was running (bead ro-ujb9.179).
//
// When a Vitest fork exits mid-file — out of memory, a native crash, a test that
// kills its own process — Vitest reports "[vitest-pool]: Worker forks emitted
// error … Worker exited unexpectedly", counts the file as neither passed nor
// failed ("165 passed (166)") and names no file. A crash nobody can attribute
// can be neither fixed nor ruled out. The run already knows which file it was:
// the one that started and never ended. This prints it, after the summary
// (and any file its worker had not reached yet, as "not started"):
//
//   Unit test files that never finished — their test worker exited:
//     test/some-file.test.ts — while running "the test that was running"
//
// It is always on and silent on a clean run. `UNIT_TEST_TRACE=1` also prints
// each file as it starts (`▶ test/…`), for a run that hangs rather than dies.
//
// It joins through a plugin rather than the `reporters` option, which would
// replace Vitest's own choice of reporters (default, or its agent reporter, and
// GitHub's annotations in CI) instead of adding to them. Authored TypeScript:
// `pnpm config:generate` writes the `.mjs` both Vitest configs import.

/** The variable that turns on the per-file start line. */
export const UNIT_TEST_TRACE_ENV: string = 'UNIT_TEST_TRACE';

/** The parts of Vitest's `TestModule` read here. */
export interface ModuleLike {
  readonly moduleId: string;
  readonly relativeModuleId: string;
  state(): string;
}

/** The parts of Vitest's `TestCase` read here. */
export interface CaseLike {
  readonly fullName: string;
  readonly module: ModuleLike;
}

/** A file the run started or queued and never finished, and the test inside it
 * that had started and not ended, when the run heard of one. A worker that
 * runs several files in turn (the ingest suite's `isolate: false`) leaves the
 * ones it had not reached yet `started: false`. */
export interface UnfinishedFile {
  file: string;
  started: boolean;
  test: string | null;
}

/** Still `queued` (a crash while importing) or `pending` (a crash mid-file) at
 * the end of a run: every other state is an ending. */
const UNFINISHED_STATES: ReadonlySet<string> = new Set(['queued', 'pending']);

/** The files that never finished, each with the test that was running in it. */
export function unfinishedFiles(
  modules: readonly ModuleLike[],
  running: ReadonlyMap<string, string>,
): UnfinishedFile[] {
  return modules
    .filter((module) => UNFINISHED_STATES.has(module.state()))
    .map((module) => ({
      file: module.relativeModuleId,
      started: module.state() === 'pending',
      test: running.get(module.moduleId) ?? null,
    }))
    // The file that was running first: it is the one to look at.
    .sort((a, b) => Number(b.started) - Number(a.started));
}

/** The lines printed for them, or null when there is nothing to say. */
export function unfinishedReport(files: readonly UnfinishedFile[]): string | null {
  if (files.length === 0) return null;
  const lines = files.map(({ file, started, test }) =>
    `  ${file} — ${test !== null ? `while running ${JSON.stringify(test)}` : started ? 'started' : 'not started'}`);
  return `\nUnit test files that never finished — their test worker exited:\n${lines.join('\n')}\n`;
}

/** Is the per-file start line on? */
export function traceOn(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[UNIT_TEST_TRACE_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** The reporter: which test each file is in, and what never finished. */
export function attributionReporter(options: {
  env?: Readonly<Record<string, string | undefined>>;
  write?: (text: string) => void;
} = {}) {
  const env = options.env ?? process.env;
  const write = options.write ?? ((text: string) => { process.stderr.write(text); });
  const trace = traceOn(env);
  // Module id -> the full name of the test that started in it and has not ended.
  const running = new Map<string, string>();
  return {
    onTestModuleStart(module: ModuleLike): void {
      if (trace) write(`▶ ${module.relativeModuleId}\n`);
    },
    onTestCaseReady(testCase: CaseLike): void {
      running.set(testCase.module.moduleId, testCase.fullName);
    },
    onTestCaseResult(testCase: CaseLike): void {
      if (running.get(testCase.module.moduleId) === testCase.fullName) running.delete(testCase.module.moduleId);
    },
    onTestRunEnd(modules: readonly ModuleLike[], unhandledErrors: readonly unknown[], reason: string): void {
      // An interrupted run leaves files unfinished on purpose; a dead worker
      // always leaves an unhandled error behind.
      if (reason === 'interrupted' || unhandledErrors.length === 0) return;
      const report = unfinishedReport(unfinishedFiles(modules, running));
      if (report !== null) write(report);
    },
  };
}

/** The Vitest plugin both unit suites list: it adds the reporter beside the
 * ones Vitest chose. */
export function unitTestAttribution(env: Readonly<Record<string, string | undefined>> = process.env) {
  return {
    name: 'unit-test-attribution',
    configureVitest({ vitest }: { vitest: { config: { reporters: unknown[] } } }): void {
      vitest.config.reporters.push(attributionReporter({ env }));
    },
  };
}
