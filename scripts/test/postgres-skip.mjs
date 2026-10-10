// Where Postgres cannot start, a root script test skips — one way.
//
// `findPostgres()` answers null on a machine without server binaries rather
// than throwing, and `initdb` can still refuse later (run as root, or in a
// sandbox without shared memory). Both reach a test as `PostgresUnavailable`
// only once it opens a cluster. So a test guards the opening, not the lookup:
// it hands this the call that starts Postgres. NOTICEOS_REQUIRE_POSTGRES=1,
// which CI sets, turns the skip back into a failure.

import { PostgresUnavailable } from '../postgres-dev.mjs';
import { postgresRequired } from '../postgres-test-cluster.mjs';

/**
 * What `open()` answers; or, where Postgres cannot start here, null after
 * skipping test `t` with the reason.
 * @template T
 * @param {{ skip(message?: string): void }} t
 * @param {() => T | Promise<T>} open
 * @returns {Promise<T | null>}
 */
export async function skipWithoutPostgres(t, open) {
  try {
    return await open();
  } catch (error) {
    if (!(error instanceof PostgresUnavailable) || postgresRequired()) throw error;
    t.skip(error.message);
    return null;
  }
}
