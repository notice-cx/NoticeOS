import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetConfigCache } from '../src/config-store.js';
import { ASSET_TOKENS } from './fixtures.js';
import { call, forgetConfigDocuments, pgCount, pgExecute, pgRows, reset } from './helpers.js';

const MEADOW = 'meadow.example';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

beforeEach(reset);

function codebaseRequest(body: unknown, token?: string): Request {
  return new Request('https://ingest.local/api/codebase-report', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function report(day: string, measures: Record<string, number>, hour = '03') {
  return {
    asset: MEADOW,
    generatedAt: `${day}T${hour}:00:00Z`,
    repository: { remote: 'github.com/example/site', ref: 'main', commit: COMMIT, committedAt: `${day}T01:00:00Z` },
    tools: { scc: '3.5.0', jscpd: '5.3.2', lizard: '1.17.31' },
    measures,
  };
}

async function send(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await call(codebaseRequest(body, ASSET_TOKENS[MEADOW]));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

interface StoredFlag extends Record<string, unknown> {
  flag_id: string;
  severity: string;
  kind: string;
  metric: string | null;
  message: string | null;
  rule_inputs: string;
  resolved_at: string | null;
  disposition: string | null;
  pulse_id: string | null;
}

async function flags(ruleId: string): Promise<StoredFlag[]> {
  return pgRows<StoredFlag>(
    `SELECT flag_id::text, severity, kind, metric, message, rule_inputs::text AS rule_inputs,
            resolved_at::text, disposition, pulse_id::text
       FROM noticeos.current_flags WHERE asset_id = $1 AND rule_id = $2 ORDER BY flag_id`,
    [MEADOW, ruleId],
  );
}
const open = async (ruleId: string) => (await flags(ruleId)).filter((f) => f.resolved_at === null);

describe('POST /api/codebase-report: status codes', () => {
  it('401 with no token, a wrong token, another asset\'s token, or no asset id', async () => {
    expect((await call(codebaseRequest(report('2026-10-01', {})))).status).toBe(401);
    expect((await call(codebaseRequest(report('2026-10-01', {}), 'not-the-token'))).status).toBe(401);
    expect((await call(codebaseRequest({ ...report('2026-10-01', {}), asset: 'ghost.example' }, ASSET_TOKENS[MEADOW]))).status).toBe(401);
    const { asset: _asset, ...anonymous } = report('2026-10-01', {});
    expect((await call(codebaseRequest(anonymous, ASSET_TOKENS[MEADOW]))).status).toBe(401);
  });

  it('400 for a body that is not JSON', async () => {
    expect((await call(codebaseRequest('{not json', ASSET_TOKENS[MEADOW]))).status).toBe(400);
  });

  it('413 for a body over the size limit, before it is read as JSON', async () => {
    expect((await call(codebaseRequest(' '.repeat(256 * 1024 + 1), ASSET_TOKENS[MEADOW]))).status).toBe(413);
  });

  it('422 with issues for an authenticated but invalid envelope', async () => {
    const { status, body } = await send({ ...report('2026-10-01', { duplication_percent: 140 }), extra: true });
    expect(status).toBe(422);
    expect(body.error).toBe('unprocessable_entity');
    const paths = (body.issues as { path: string }[]).map((i) => i.path);
    expect(paths).toContain('measures.duplication_percent');
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.codebase_reports`)).toBe(0);
  });

  it('201 with the report number, its day and its revision', async () => {
    const { status, body } = await send(report('2026-10-01', { code_lines: 1200 }));
    expect(status).toBe(201);
    expect(body).toEqual({ ok: true, reportNumber: expect.any(Number), reportDate: '2026-10-01', revision: 1 });
    const [row] = await pgRows<{ commit: string; ref: string; report_date: string }>(
      `SELECT commit, ref, report_date::text FROM noticeos.codebase_reports WHERE asset_id = $1`,
      [MEADOW],
    );
    expect(row).toEqual({ commit: COMMIT, ref: 'main', report_date: '2026-10-01' });
  });
});

describe('POST /api/codebase-report: revisions', () => {
  it('appends a same-day resend as the next revision; the day keeps its number', async () => {
    const first = await send(report('2026-10-01', { code_lines: 1200 }, '03'));
    const second = await send(report('2026-10-01', { code_lines: 1300 }, '09'));
    expect(second.body).toMatchObject({ reportNumber: first.body.reportNumber, reportDate: '2026-10-01', revision: 2 });
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.codebase_reports WHERE asset_id = $1`, [MEADOW])).toBe(2);
    const current = await pgRows<{ revision: number; lines: string }>(
      `SELECT revision, envelope::json -> 'measures' ->> 'code_lines' AS lines
         FROM noticeos.current_codebase_reports WHERE asset_id = $1`,
      [MEADOW],
    );
    expect(current).toEqual([{ revision: 2, lines: '1300' }]);
  });
});

describe('codebase rules', () => {
  it('growth fires against the report nearest 30 days back, with the numbers it used', async () => {
    await send(report('2026-09-01', { code_lines: 38100 }));
    await send(report('2026-10-01', { code_lines: 49900 }));
    const [flag] = await open('codebase-growth');
    expect(flag).toMatchObject({ severity: 'warn', kind: 'anomaly', metric: 'code_lines', pulse_id: null });
    expect(flag!.message).toBe('The code grew 31% in 30 days (38,100 → 49,900 lines).');
    const inputs = JSON.parse(flag!.rule_inputs) as Record<string, unknown>;
    expect(inputs).toMatchObject({
      code_lines: 49900,
      comparison_code_lines: 38100,
      added_lines: 11800,
      growth_percent_30d: 25,
      growth_min_lines: 500,
      comparison: { reportDate: '2026-09-01', days: 30 },
      report: { reportDate: '2026-10-01', revision: 1, commit: COMMIT },
    });
  });

  it('growth stays quiet with no report 28 to 45 days back, and under its thresholds', async () => {
    await send(report('2026-09-20', { code_lines: 1000 }));
    await send(report('2026-10-01', { code_lines: 90000 }));
    expect(await flags('codebase-growth')).toEqual([]);
    await send(report('2026-11-01', { code_lines: 95000 }));
    expect(await flags('codebase-growth')).toEqual([]);
  });

  it('duplication fires at its threshold and not below it', async () => {
    await send(report('2026-10-01', { duplication_percent: 7.9 }));
    expect(await flags('codebase-duplication')).toEqual([]);
    await send(report('2026-10-02', { duplication_percent: 8.4 }));
    const [flag] = await open('codebase-duplication');
    expect(flag).toMatchObject({ severity: 'warn', kind: 'opportunity', metric: 'duplication_percent', message: '8.4% of the code is repeated.' });
  });

  it('unused fires on files plus packages, and not below the threshold', async () => {
    await send(report('2026-10-01', { unused_files: 6, unused_dependencies: 3 }));
    expect(await flags('codebase-unused')).toEqual([]);
    await send(report('2026-10-02', { unused_files: 14, unused_dependencies: 3 }));
    const [flag] = await open('codebase-unused');
    expect(flag).toMatchObject({ severity: 'info', kind: 'opportunity', metric: null, message: '14 files and 3 packages are not used.' });
  });

  it('complexity fires when enough functions became hard to change in 30 days', async () => {
    await send(report('2026-09-01', { complex_functions: 23 }));
    await send(report('2026-10-01', { complex_functions: 27 }));
    expect(await flags('codebase-complexity')).toEqual([]);
    await send(report('2026-10-02', { complex_functions: 30 }));
    const [flag] = await open('codebase-complexity');
    expect(flag).toMatchObject({ severity: 'info', kind: 'opportunity', metric: 'complex_functions' });
    expect(flag!.message).toBe('7 more functions became hard to change in 31 days.');
  });

  it('resolves the rule\'s open alert before raising the current one, and leaves an acknowledged one alone', async () => {
    await send(report('2026-10-01', { duplication_percent: 9 }));
    const [first] = await open('codebase-duplication');
    await send(report('2026-10-02', { duplication_percent: 9.5 }));
    const afterSecond = await flags('codebase-duplication');
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond.find((f) => f.flag_id === first!.flag_id)!.resolved_at).not.toBeNull();
    const [second] = await open('codebase-duplication');
    expect(second!.message).toBe('9.5% of the code is repeated.');

    await pgExecute(`UPDATE noticeos.flags SET disposition = 'ack', disposition_at = now() WHERE flag_id = $1::bigint`, [second!.flag_id]);
    await send(report('2026-10-03', { duplication_percent: 3 }));
    const acknowledged = (await flags('codebase-duplication')).find((f) => f.flag_id === second!.flag_id)!;
    expect(acknowledged).toMatchObject({ disposition: 'ack', resolved_at: null });
    expect((await open('codebase-duplication')).map((f) => f.flag_id)).toEqual([second!.flag_id]);
  });

  it('a recovered rule resolves its open alert and raises none', async () => {
    await send(report('2026-10-01', { duplication_percent: 9 }));
    await send(report('2026-10-02', { duplication_percent: 2 }));
    expect(await open('codebase-duplication')).toEqual([]);
    expect(await flags('codebase-duplication')).toHaveLength(1);
  });

  it('a report that does not measure a rule\'s inputs neither raises nor resolves its alerts', async () => {
    await send(report('2026-09-01', { code_lines: 100, complex_functions: 0 }));
    await send(report('2026-10-01', { duplication_percent: 9, unused_files: 30 }));
    expect(await open('codebase-duplication')).toHaveLength(1);
    expect(await open('codebase-unused')).toHaveLength(1);
    await send(report('2026-10-02', {}));
    expect(await open('codebase-duplication')).toHaveLength(1);
    expect(await open('codebase-unused')).toHaveLength(1);
    expect(await flags('codebase-growth')).toEqual([]);
    expect(await flags('codebase-complexity')).toEqual([]);
  });

  it('reads its thresholds from the stored constants document first', async () => {
    await env.STORE.write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.config_documents (workspace_id, document_key, body, version, updated_at, updated_by)
         VALUES ($1::uuid, 'constants', $2::json, 1, now(), 'settings')`,
        [tx.workspaceId, JSON.stringify({ os_time_zone: 'UTC', flag_defaults: {}, codebase_rules: { duplication_percent: 50 } })],
      ),
    );
    forgetConfigCache();
    try {
      await send(report('2026-10-01', { duplication_percent: 9, unused_files: 10 }));
      expect(await flags('codebase-duplication')).toEqual([]);
      // A key the stored document lacks reads the compiled copy's.
      expect(await open('codebase-unused')).toHaveLength(1);
    } finally {
      await forgetConfigDocuments(['config/constants.json']);
      forgetConfigCache();
    }
  });
});
