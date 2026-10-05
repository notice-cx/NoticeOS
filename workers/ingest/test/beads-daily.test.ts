import { env } from 'cloudflare:test';
import { javascriptInstant } from '@noticeos/postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BEADS_CLOSED_LIMIT,
  BEADS_DAILY_RETENTION_DAYS,
  closedOn,
  mergeClosedIds,
  readSnapshotProjects,
} from '../src/beads-daily.js';
import { BEADS_SNAPSHOT_RETENTION_DAYS, type BeadsSnapshotInput, writeBeadsSnapshot } from '../src/beads-snapshots.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { asOwner, call, emptyTables, reset, storedCount } from './helpers.js';

// The daily rollup behind the Tasks strip's six numbers (db/0032, bead
// `ro-78qo.23`; on Postgres since bead ro-ujb9.76.4.3).
//
// It is driven through the REAL route, not by calling the writer, because the
// thing being asserted is that filing a photograph also files the day.

beforeEach(reset);

type DailyRow = {
  asset: string;
  day: string;
  captured_at: string;
  waiting: number | null;
  urgent: number | null;
  open: number;
  in_progress: number;
  blocked: number;
  closed_ids: string | null;
};

function closedIssue(id: string, closedAt: string) {
  return {
    id,
    title: id,
    status: 'closed',
    priority: 2,
    issueType: 'task',
    assignee: null,
    updatedAt: closedAt,
    closedAt,
    parent: null,
    deferUntil: null,
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    asset: 'meals.example',
    prefix: 'mp',
    ok: true,
    error: null,
    counts: {
      open: 4,
      highPriority: 2,
      ready: 1,
      inProgress: 1,
      blocked: 0,
      closedRecent: 0,
      waiting: 1,
    },
    ready: [],
    inProgress: [],
    recentlyClosed: [],
    ...overrides,
  };
}

async function post(body: unknown) {
  return call(
    new Request('https://ingest.local/api/beads-snapshot', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${OPERATOR_TOKEN}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Every stored day, in D1's terms: the project as `asset`, the instant as
 * JavaScript writes it, the closed ids as JSON text. */
async function rows(): Promise<DailyRow[]> {
  const stored = await env.STORE.read((tx) =>
    tx.query<DailyRow>(
      `SELECT project AS asset, day, captured_at, waiting, urgent, open, in_progress, blocked, closed_ids::text AS closed_ids
         FROM noticeos.task_daily_counts ORDER BY day ASC, project COLLATE "C" ASC`,
    ),
  );
  return stored.map((row) => ({ ...row, captured_at: javascriptInstant(row.captured_at) }));
}

// One clock per run: a test crossing midnight must keep all captures on the
// same named days. Use completed days so an afternoon capture is never future
// dated when this suite runs before noon (ro-ujb9.27).
const FIXTURE_NOW = Date.now();
const DAY_MS = 86_400_000;

/** An instant on a completed UTC day, with zero naming the latest completed
 * day. The cases reach back at most four days: the latest completed day is
 * inside snapshot retention (two days), every day inside the rollup's own. A
 * capture older than snapshot retention still files its day — the rollup reads
 * the incoming photograph, never the stored ones (ro-ujb9.76.16). */
function tick(daysAgo: number, time = 'T12:00:00.000Z', nowMs = FIXTURE_NOW): string {
  const day = new Date(nowMs - (daysAgo + 1) * DAY_MS).toISOString().slice(0, 10);
  return `${day}${time}`;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

describe('daily rollup fixture clock', () => {
  it.each([
    ['2026-09-06T00:00:00.000Z', '2026-09-05'],
    ['2026-09-06T07:00:00.000Z', '2026-09-05'],
    ['2026-09-06T23:59:59.999Z', '2026-09-05'],
    ['2026-10-01T00:00:00.000Z', '2026-09-30'],
    ['2027-01-01T00:00:00.000Z', '2026-12-31'],
    ['2028-03-01T00:00:00.000Z', '2028-02-29'],
  ])('keeps every capture in the past and inside retention at %s', (instant, expectedDay) => {
    const nowMs = Date.parse(instant);
    expect(dayOf(tick(0, undefined, nowMs))).toBe(expectedDay);
    for (const daysAgo of [0, 1, 2, 3]) {
      const early = tick(daysAgo, 'T08:00:00.000Z', nowMs);
      const late = tick(daysAgo, 'T20:00:00.000Z', nowMs);
      expect(dayOf(early)).toBe(dayOf(late));
      expect(Date.parse(early)).toBeLessThan(Date.parse(late));
      expect(Date.parse(late)).toBeLessThan(nowMs);
      expect(Date.parse(early)).toBeGreaterThan(nowMs - BEADS_DAILY_RETENTION_DAYS * DAY_MS);
    }
    expect(Date.parse(tick(0, 'T08:00:00.000Z', nowMs))).toBeGreaterThan(
      nowMs - BEADS_SNAPSHOT_RETENTION_DAYS * DAY_MS,
    );
  });
});

describe('the daily rollup — one row per project per day', () => {
  it('files a row for the capture day beside the photograph', async () => {
    const at = tick(0, 'T09:00:00.000Z');
    const res = await post({ capturedAt: at, projects: [project()] });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { historyDays: number | null }).historyDays).toBe(1);
    expect(await rows()).toEqual([
      {
        asset: 'meals.example',
        day: dayOf(at),
        captured_at: at,
        waiting: 1,
        urgent: 2,
        open: 4,
        in_progress: 1,
        blocked: 0,
        closed_ids: '[]',
      },
    ]);
  });

  it('keeps the LATEST capture of a day rather than appending to it', async () => {
    const early = tick(0, 'T08:00:00.000Z');
    const late = tick(0, 'T20:00:00.000Z');
    await post({ capturedAt: early, projects: [project()] });
    await post({
      capturedAt: late,
      projects: [project({ counts: { ...project().counts, open: 9, blocked: 3 } })],
    });

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ captured_at: late, open: 9, blocked: 3 });
  });

  it('refuses to walk a day backwards on a backdated capture', async () => {
    const late = tick(0, 'T20:00:00.000Z');
    const early = tick(0, 'T08:00:00.000Z');
    await post({ capturedAt: late, projects: [project({ counts: { ...project().counts, open: 9 } })] });
    // A poller that queued a tick behind a slow `bd` reports when it LOOKED,
    // which can be earlier than a capture already stored. It must not overwrite
    // the newer state with an older one.
    await post({ capturedAt: early, projects: [project({ counts: { ...project().counts, open: 1 } })] });

    expect((await rows())[0]).toMatchObject({ captured_at: late, open: 9 });
  });

  it('leaves a day with no capture out of the table — a gap, never a zero', async () => {
    const older = tick(3);
    const newer = tick(1);
    await post({ capturedAt: older, projects: [project()] });
    await post({ capturedAt: newer, projects: [project()] });

    // Two captures two days apart write two rows, and the day between them is
    // simply absent: the OS did not measure "no work" on it.
    expect((await rows()).map((row) => row.day)).toEqual([dayOf(older), dayOf(newer)]);
  });

  it('writes nothing for a project the poller could not read', async () => {
    await post({
      capturedAt: tick(0),
      projects: [
        project(),
        {
          asset: 'nosh.example',
          prefix: 'nom',
          ok: false,
          error: 'bd active exited 1: no such directory',
          counts: { open: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0 },
          ready: [],
          inProgress: [],
          recentlyClosed: [],
        },
      ],
    });

    // A failed read is the absence of an answer, not an answer of zero.
    expect((await rows()).map((row) => row.asset)).toEqual(['meals.example']);
  });

  it('stores an unmeasured count as unknown rather than as none', async () => {
    // An older poller sends neither `waiting` nor `highPriority`.
    await post({
      capturedAt: tick(0),
      projects: [
        project({ counts: { open: 4, ready: 1, inProgress: 1, blocked: 0, closedRecent: 0 } }),
      ],
    });

    expect((await rows())[0]).toMatchObject({ waiting: null, urgent: null, open: 4 });
  });
});

describe('the daily rollup — what closed that day', () => {
  it('counts CLOSINGS across the day, not the length of the capped list', async () => {
    const at = (hour: string) => tick(0, `T${hour}:00:00.000Z`);
    // Nine beads close over the day. Every capture can carry at most five, so
    // any single capture bucketed by day would report five at most.
    const closes = Array.from({ length: 9 }, (_unused, index) => `mp-c${index}`);
    for (let index = 0; index < closes.length; index++) {
      const hour = String(9 + index).padStart(2, '0');
      // The photograph the poller sends: the five most recent closes.
      const visible = closes.slice(Math.max(0, index - 4), index + 1);
      await post({
        capturedAt: at(hour),
        projects: [
          project({
            counts: { ...project().counts, closedRecent: index + 1 },
            recentlyClosed: visible.map((id) => closedIssue(id, at(hour))),
          }),
        ],
      });
    }

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.closed_ids!).sort()).toEqual([...closes].sort());
    expect(JSON.parse(stored[0]!.closed_ids!)).toHaveLength(9);
    expect(BEADS_CLOSED_LIMIT).toBe(5);
  });

  it('counts only the closings dated that day', async () => {
    const captureDay = tick(0, 'T15:00:00.000Z');
    const previousDay = tick(1, 'T15:00:00.000Z');
    await post({
      capturedAt: captureDay,
      projects: [
        project({
          counts: { ...project().counts, closedRecent: 3 },
          recentlyClosed: [
            closedIssue('mp-a', captureDay),
            closedIssue('mp-b', captureDay),
            closedIssue('mp-c', previousDay),
          ],
        }),
      ],
    });

    expect(JSON.parse((await rows())[0]!.closed_ids!)).toEqual(['mp-a', 'mp-b']);
  });

  it('records a day whose closings were never observable as unknown', () => {
    // Five rows, all dated the same day, is the one shape that cannot be read:
    // the list is at its cap and nothing older survives in it, so five closings
    // and fifty look identical. Only the FIRST write of a day asks this — after
    // that the union across the day's captures is the answer.
    const day = '2026-09-01';
    const capped = project({
      recentlyClosed: Array.from({ length: BEADS_CLOSED_LIMIT }, (_unused, index) =>
        closedIssue(`mp-${index}`, `${day}T0${index}:00:00.000Z`),
      ),
    }) as unknown as Parameters<typeof closedOn>[0];

    expect(closedOn(capped, day).complete).toBe(false);
    expect(mergeClosedIds(undefined, closedOn(capped, day), true)).toBeNull();
  });

  it('is complete when the list still holds a row from an earlier day', () => {
    const day = '2026-09-01';
    const withOlder = project({
      recentlyClosed: [
        closedIssue('mp-0', `${day}T01:00:00.000Z`),
        closedIssue('mp-1', `${day}T02:00:00.000Z`),
        closedIssue('mp-2', `${day}T03:00:00.000Z`),
        closedIssue('mp-3', `${day}T04:00:00.000Z`),
        closedIssue('mp-old', '2026-08-31T23:00:00.000Z'),
      ],
    }) as unknown as Parameters<typeof closedOn>[0];

    // The cap was never reached by THIS day's closings, so the four are all of
    // them.
    expect(closedOn(withOlder, day)).toEqual({
      ids: ['mp-0', 'mp-1', 'mp-2', 'mp-3'],
      complete: true,
    });
  });

  it('keeps "unknown" for the rest of a day rather than restarting the count', () => {
    // A floor pretending to be a measurement is the more comfortable of the two
    // lies, so the null is sticky.
    expect(mergeClosedIds(null, { ids: ['mp-late'], complete: true }, false)).toBeNull();
  });

  it('unions rather than replaces once the day is under way', () => {
    expect(
      JSON.parse(mergeClosedIds('["mp-a"]', { ids: ['mp-a', 'mp-b'], complete: true }, false)!),
    ).toEqual(['mp-a', 'mp-b']);
  });
});

describe('the daily rollup — first run and retention', () => {
  it('seeds itself from the photographs the store still holds', async () => {
    // The state the operator is in the minute after `pnpm migrate:local`: a week
    // of snapshots, and an empty rollup.
    for (const daysAgo of [3, 2, 1]) {
      for (const hour of ['08', '20']) {
        await env.STORE.write((tx) =>
          tx.execute(
            `INSERT INTO noticeos.task_snapshots (workspace_id, captured_at, payload) VALUES ($1::uuid, $2::timestamptz, $3::jsonb)`,
            [
              tx.workspaceId,
              tick(daysAgo, `T${hour}:00:00.000Z`),
              JSON.stringify({
                projects: [
                  {
                    asset: 'meals.example',
                    ok: true,
                    counts: { open: hour === '20' ? 7 : 2, inProgress: 1, blocked: 0, waiting: 1 },
                    recentlyClosed: [],
                  },
                ],
              }),
            ],
          ),
        );
      }
    }
    await emptyTables(['task_daily_counts']);

    const res = await post({ capturedAt: tick(0), projects: [project()] });
    const stored = await rows();

    // Three backfilled days plus the capture day, each holding its LAST capture.
    expect(stored).toHaveLength(4);
    expect(stored.slice(0, 3).map((row) => row.open)).toEqual([7, 7, 7]);
    expect(((await res.json()) as { historyDays: number }).historyDays).toBe(4);
  });

  it('seeds once, not on every capture', async () => {
    await post({ capturedAt: tick(0, 'T08:00:00.000Z'), projects: [project()] });
    await post({
      capturedAt: tick(0, 'T09:00:00.000Z'),
      projects: [project({ counts: { ...project().counts, open: 11 } })],
    });

    // The second POST's own photograph is in the store by then; a
    // backfill that ran again would re-create that day's row and lose the union.
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ open: 11 });
  });

  it('drops a day older than the retention window', async () => {
    await env.STORE.write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.task_daily_counts (workspace_id, project, day, captured_at, open, in_progress, blocked, closed_ids)
         VALUES ($1::uuid, $2, $3::date, $4::timestamptz, 1, 0, 0, '[]')`,
        [tx.workspaceId, 'meals.example', '2020-01-01', '2020-01-01T00:00:00.000Z'],
      ),
    );

    await post({ capturedAt: tick(0), projects: [project()] });

    expect((await rows()).map((row) => row.day)).not.toContain('2020-01-01');
    expect(BEADS_DAILY_RETENTION_DAYS).toBe(400);
  });
});

describe('the daily rollup — one unit of work with its photograph', () => {
  it('keeps no photograph when its day cannot be written', async () => {
    // A capture is one transaction: the day and the photograph land together
    // or not at all. The store is made to refuse the day, as the owner.
    await asOwner(`CREATE FUNCTION noticeos.refuse_task_day() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejection'; END $$;
CREATE TRIGGER refuse_task_day BEFORE INSERT ON noticeos.task_daily_counts FOR EACH ROW EXECUTE FUNCTION noticeos.refuse_task_day();`);
    try {
      await expect(writeBeadsSnapshot(env, { capturedAt: tick(0), projects: [project()] } as BeadsSnapshotInput)).rejects.toThrow();
      expect(await rows()).toEqual([]);
      expect(await storedCount('SELECT count(*)::int AS n FROM noticeos.task_snapshots')).toBe(0);
    } finally {
      await asOwner(`DROP TRIGGER refuse_task_day ON noticeos.task_daily_counts;
DROP FUNCTION noticeos.refuse_task_day();`);
    }
  });

  it('unions two captures of one day taken at once, and keeps one whole photograph', async () => {
    // Captures run one at a time behind the workspace's snapshot lock, as D1's
    // one writer ran them. Without it both read the day and the newest row
    // before either wrote: one day's closings were lost, and two photographs
    // stayed whole.
    for (let round = 0; round < 3; round += 1) {
      await reset();
      const at = tick(0, `T1${round}:00:00.000Z`);
      const board = (id: string) => ({
        capturedAt: at,
        projects: [project({ counts: { ...project().counts, closedRecent: 1 }, recentlyClosed: [closedIssue(id, at)] })],
      });
      const [a, b] = await Promise.all([post(board('mp-a')), post(board('mp-b'))]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(JSON.parse((await rows())[0]!.closed_ids!).sort()).toEqual(['mp-a', 'mp-b']);
      const whole = await storedCount(
        `SELECT count(*)::int AS n FROM noticeos.task_snapshots WHERE payload -> 'projects' -> 0 ? 'ready'`,
      );
      expect(whole).toBe(1);
    }
  });
});

describe('reading a stored payload for the rollup', () => {
  it('drops a project the row cannot name and keeps the rest', () => {
    const parsed = readSnapshotProjects(
      JSON.stringify({
        projects: [
          { asset: '', counts: { open: 1, inProgress: 0, blocked: 0 } },
          { asset: 'a', counts: { open: 1, inProgress: 0, blocked: 0 }, recentlyClosed: [] },
        ],
      }),
    );
    expect(parsed.map((entry) => entry.asset)).toEqual(['a']);
  });

  it('drops a project whose required counts are damaged rather than reading zeroes', () => {
    expect(
      readSnapshotProjects(
        JSON.stringify({ projects: [{ asset: 'a', counts: { open: 'lots' } }] }),
      ),
    ).toEqual([]);
  });

  it('answers nothing for a payload it cannot parse', () => {
    expect(readSnapshotProjects('{ not json')).toEqual([]);
  });
});
