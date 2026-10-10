// How many workers each unit suite starts.
//
// `pnpm -r test` runs the Tower suite (jsdom) and the ingest suite (Workers
// pool) at the same time, and Vitest's default gives each of them every core
// but one. Half the cores per suite finishes `pnpm -r test` faster than the
// default and never oversubscribes a 4-core runner (2 + 2).
//
// `UNIT_TEST_WORKERS` overrides it for both suites — a whole number of
// workers, or a percentage of the cores — the way `JOURNEY_WORKERS` does for
// the browser journeys. Authored TypeScript: `pnpm config:generate` writes the
// `.mjs` the Vitest configs import and the `.d.mts` beside it.

/** The variable that overrides the worker count. */
export const UNIT_TEST_WORKERS_ENV: string = 'UNIT_TEST_WORKERS';

/** Half the cores per suite: the two suites together use them all once. */
export const DEFAULT_UNIT_TEST_WORKERS: string = '50%';

/** Vitest's `maxWorkers` for one unit suite. */
export function unitTestWorkers(env: Readonly<Record<string, string | undefined>> = process.env): string | number {
  const value = env[UNIT_TEST_WORKERS_ENV]?.trim();
  if (!value) return DEFAULT_UNIT_TEST_WORKERS;
  const count = /^\d+$/.test(value) ? Number(value) : null;
  if (count !== null && count >= 1) return count;
  const percent = /^(\d{1,3})%$/.exec(value);
  if (percent && Number(percent[1]) >= 1 && Number(percent[1]) <= 100) return value;
  throw new Error(`${UNIT_TEST_WORKERS_ENV} must be a whole number of workers or a percentage of the cores, not ${JSON.stringify(value)}`);
}
