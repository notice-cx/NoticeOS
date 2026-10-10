// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGa4Realtime } from "@/lib/api";

const hourlyActiveUsers = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  today: hour < 2 ? [3, 5][hour]! : null,
  sameDayLastWeek: hour + 2,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GA4 realtime browser contract", () => {
  it.each([false, true])("releases an unread failure stream and keeps its HTTP status (cancel fails: %s)", async (cancelFails) => {
    const cancel = vi.fn(() => {
      if (cancelFails) throw new Error("transport already aborted");
    });
    const response = new Response(new ReadableStream({ cancel }), { status: 503 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(fetchGa4Realtime()).rejects.toThrow("GET /api/ga4/realtime failed: 503");
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
  });

  it("keeps the HTTP failure when its response has no body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(fetchGa4Realtime()).rejects.toThrow("GET /api/ga4/realtime failed: 503");
  });

  it.each([{ rateLimit: 123 }, { rateLimit: 'made-up' }, { hourlyErrorCode: {} }])('rejects malformed diagnostic fields: %j', async (fields) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ generatedAt: '2026-09-11T00:00:00Z', assets: [{ asset: 'meals.example', status: 'success', activeUsers5m: 7, activeUsers30m: 26, hourlyActiveUsers, observedAt: '2026-09-11T00:00:00Z', errorCode: null, ...fields }] })));
    await expect(fetchGa4Realtime()).rejects.toThrow('invalid payload');
  });
  it.each([true, false])('requires an explicit hourly failure when live counts work but the chart is missing (%s)', async (hasReason) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      generatedAt: '2026-09-11T00:00:00Z', assets: [{
        asset: 'meals.example', status: 'success', activeUsers5m: 7, activeUsers30m: 26,
        hourlyActiveUsers: null, observedAt: '2026-09-11T00:00:00Z', errorCode: null,
        ...(hasReason ? { hourlyErrorCode: 'ga4_intraday_http_429' } : {}),
      }],
    })));
    if (hasReason) await expect(fetchGa4Realtime()).resolves.toMatchObject({ assets: [{ activeUsers5m: 7, hourlyActiveUsers: null }] });
    else await expect(fetchGa4Realtime()).rejects.toThrow('invalid payload');
  });
  // The minute pulse's thirty buckets.
  const pulse = [...Array.from({ length: 28 }, (_, minute) => minute % 4), 3, null];
  const live = (fields: Record<string, unknown>) =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ generatedAt: '2026-09-11T00:00:00Z', assets: [{
      asset: 'site.example', status: 'success', activeUsers5m: 7, activeUsers30m: 26, hourlyActiveUsers,
      observedAt: '2026-09-11T00:00:00Z', errorCode: null, ...fields,
    }] })));
  it.each([{ activeUsersByMinute: pulse }, { activeUsersByMinute: null }, {}])('accepts a minute pulse, a refused one, or none: %j', async (fields) => {
    live(fields);
    await expect(fetchGa4Realtime()).resolves.toMatchObject({ assets: [{ activeUsers30m: 26 }] });
  });
  it.each([
    ['twenty-nine minutes', pulse.slice(1)],
    ['a negative minute', [...pulse.slice(0, -1), -1]],
    ['a fractional minute', [...pulse.slice(0, -1), 1.5]],
    ['a minute that is not a count', [...pulse.slice(0, -1), '3']],
  ])('rejects a pulse of %s', async (_case, activeUsersByMinute) => {
    live({ activeUsersByMinute });
    await expect(fetchGa4Realtime()).rejects.toThrow('invalid payload');
  });
  it('rejects a pulse on a failed read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ generatedAt: '2026-09-11T00:00:00Z', assets: [{
      asset: 'site.example', status: 'error', activeUsers5m: null, activeUsers30m: null, hourlyActiveUsers: null,
      activeUsersByMinute: pulse, observedAt: '2026-09-11T00:00:00Z', errorCode: 'ga4_realtime_http_500',
    }] })));
    await expect(fetchGa4Realtime()).rejects.toThrow('invalid payload');
  });
  it("accepts a fully typed success/error portfolio payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          generatedAt: "2026-07-29T12:00:00.000Z",
          assets: [
            {
              asset: "meals.example",
              status: "success",
              activeUsers5m: 7,
              activeUsers30m: 26,
              hourlyActiveUsers,
              observedAt: "2026-07-29T12:00:00.000Z",
              errorCode: null,
            },
            {
              asset: "nosh.example",
              status: "error",
              activeUsers5m: null,
              activeUsers30m: null,
              hourlyActiveUsers: null,
              observedAt: "2026-07-29T12:00:00.000Z",
              errorCode: "ga4_realtime_http_403",
            },
          ],
        }),
      ),
    );

    await expect(fetchGa4Realtime()).resolves.toMatchObject({
      assets: [
        { asset: "meals.example", activeUsers5m: 7, activeUsers30m: 26 },
        { asset: "nosh.example", status: "error" },
      ],
    });
  });

  it("rejects a failure represented as zero users", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          generatedAt: "2026-07-29T12:00:00.000Z",
          assets: [
            {
              asset: "meals.example",
              status: "error",
              activeUsers5m: 0,
              activeUsers30m: 0,
              hourlyActiveUsers: null,
              observedAt: "2026-07-29T12:00:00.000Z",
              errorCode: "ga4_realtime_http_503",
            },
          ],
        }),
      ),
    );

    await expect(fetchGa4Realtime()).rejects.toThrow("invalid payload");
  });

  it("rejects an error without an auditable error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          generatedAt: "2026-07-29T12:00:00.000Z",
          assets: [
            {
              asset: "meals.example",
              status: "error",
              activeUsers5m: null,
              activeUsers30m: null,
              hourlyActiveUsers: null,
              observedAt: "2026-07-29T12:00:00.000Z",
              errorCode: null,
            },
          ],
        }),
      ),
    );

    await expect(fetchGa4Realtime()).rejects.toThrow("invalid payload");
  });
});
