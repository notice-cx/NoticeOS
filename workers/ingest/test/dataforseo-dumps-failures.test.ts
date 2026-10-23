import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runDataForSeoDumps } from '../src/dataforseo-dumps.js';
import { ARCHIVE_RUNS, pgAll, pgCount, pgFirst } from './helpers.js';
import {
  NOW,
  LAUNCHED_ASSETS,
  FAST_RETRY,
  providerFetch,
  resetWithFernsLaunched,
} from './dataforseo-dumps-fixture';

beforeEach(resetWithFernsLaunched);

describe('DataForSEO weekly archives', () => {
  /** DataForSEO's envelope status ('Ok.') is about the call being accepted and
   * says nothing about the task inside it; a failure row must not carry that
   * phrase as its reason. */
  describe('a failure never speaks in the provider’s success phrase', () => {
    async function backlinksFailures(): Promise<
      { errorCode: string; errorMessage: string }[]
    > {
      return (
        await pgAll<{ errorCode: string; errorMessage: string }>(`SELECT DISTINCT error_code AS "errorCode", error_message AS "errorMessage"
             FROM ${ARCHIVE_RUNS}
            WHERE integration = 'dataforseo'
              AND report = 'backlinks-summary'
              AND status = 'error'`)
      ).results;
    }

    it('takes the failing task’s reason from under an "Ok." envelope', async () => {
      const { fetchImpl } = providerFetch({
        failPath: '/backlinks/summary/live',
        failWith: {
          status: 500,
          body: {
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0,
            tasks: [
              {
                status_code: 50000,
                status_message: 'Internal Error.',
                cost: 0,
                result: null,
              },
            ],
          },
        },
      });
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });

      expect(result).toMatchObject({ failed: LAUNCHED_ASSETS });
      expect(await backlinksFailures()).toEqual([
        {
          errorCode: 'dataforseo_http_500',
          errorMessage: 'Internal Error. Gave up after 3 attempts.',
        },
      ]);
    });

    it('states the failure in its own words when every level says "Ok."', async () => {
      const { fetchImpl } = providerFetch({
        failPath: '/backlinks/summary/live',
        failWith: {
          status: 500,
          body: { status_code: 20000, status_message: 'Ok.', cost: 0, tasks: [] },
        },
      });
      await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });

      expect(await backlinksFailures()).toEqual([
        {
          errorCode: 'dataforseo_http_500',
          errorMessage:
            'DataForSEO backlinks-summary returned HTTP 500. Gave up after 3 attempts.',
        },
      ]);
    });

    it('names the family when an accepted task reports only that it was created', async () => {
      // 20100 "Task Created." is the async handshake, not an answer: the family
      // collected nothing, and the row must not claim a success phrase as why.
      const { fetchImpl } = providerFetch({
        failPath: '/backlinks/summary/live',
        failWith: {
          status: 200,
          body: {
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0.011,
            tasks: [
              {
                status_code: 20100,
                status_message: 'Task Created.',
                cost: 0.011,
                result: null,
              },
            ],
          },
        },
      });
      await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
      });

      expect(await backlinksFailures()).toEqual([
        {
          errorCode: 'dataforseo_task_20100',
          errorMessage: 'DataForSEO backlinks-summary returned no successful task.',
        },
      ]);
    });
  });

  /** A domain the provider has never crawled answers with an empty result:
   * that is an answer, not an unreadable response. */
  describe('a provider that holds nothing for a target has still answered', () => {
    const backlinksBody = (task: Record<string, unknown>) => ({
      status: 200,
      body: {
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0.0102,
        tasks: [
          {
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0.0102,
            ...task,
          },
        ],
      },
    });

    async function backlinksOutcomes(failWith: {
      status: number;
      body: unknown;
    }) {
      const { fetchImpl } = providerFetch({
        failPath: '/backlinks/summary/live',
        failWith,
      });
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });
      return result.outcomes.filter(
        (outcome) => outcome.report === 'backlinks-summary',
      );
    }

    it('stores an explicit zero as a zero-row collection, body and all', async () => {
      const outcomes = await backlinksOutcomes(
        backlinksBody({ result_count: 0, result: [] }),
      );

      expect(outcomes).toHaveLength(LAUNCHED_ASSETS);
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({
          status: 'success',
          providerRows: 0,
          errorCode: null,
        });
        // The verbatim response is archived, so the NEXT reader of this shape
        // has the body itself rather than a 500-character error message — a
        // failed family writes a manifest row and no object at all.
        expect(typeof outcome.objectKey).toBe('string');
      }
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
            WHERE integration = 'dataforseo' AND report = 'backlinks-summary'
              AND status = 'error'`,
        ),
      ).toBe(0);
    });

    it('will not read a response that contradicts itself as nothing', async () => {
      // `result_count: 1` with an empty array is not the provider counting to
      // zero, it is an answer we could not read. Storing it as an empty
      // success would turn "we could not read it" into "there was nothing".
      const outcomes = await backlinksOutcomes(
        backlinksBody({ result_count: 1, result: [] }),
      );

      expect(outcomes[0]).toMatchObject({
        status: 'error',
        errorCode: 'dataforseo_invalid_response',
      });
      const stored = await pgFirst<{ errorMessage: string }>(`SELECT error_message AS "errorMessage" FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo' AND report = 'backlinks-summary'
            AND status = 'error' LIMIT 1`);
      // The row says what the response carried, because no object was written
      // and this row is the whole of the evidence.
      expect(stored?.errorMessage).toBe(
        'DataForSEO backlinks-summary returned a task with no readable result ' +
          '(result_count 1, result items 0).',
      );
    });

    it('will not read a null result item as nothing either', async () => {
      const outcomes = await backlinksOutcomes(
        backlinksBody({ result_count: 1, result: [null] }),
      );

      expect(outcomes[0]).toMatchObject({
        status: 'error',
        errorCode: 'dataforseo_invalid_response',
      });
      const stored = await pgFirst<{ errorMessage: string }>(`SELECT error_message AS "errorMessage" FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo' AND report = 'backlinks-summary'
            AND status = 'error' LIMIT 1`);
      expect(stored?.errorMessage).toBe(
        'DataForSEO backlinks-summary returned a task with no readable result ' +
          '(result_count 1, result items 1).',
      );
    });
  });
});
