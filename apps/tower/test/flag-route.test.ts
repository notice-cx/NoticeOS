// @vitest-environment node
import type { WorkspaceStore } from "@noticeos/postgres";
import { beforeEach, describe, expect, it } from "vitest";
import { SNOOZE_MAX_DAYS } from "../shared/snooze";
import { handleFlagRequest } from "../worker/flag-route";
import { readAlert, storeAlert } from "./alert-rows";
import { type TestStore, createTestStore } from "./postgres-store";
import { addSites } from "./sites";

// PATCH /api/flags/:id, against a real Postgres copy. The date rules are
// asserted here and not only in the browser, because a horizon only the
// picker enforces is a horizon anyone with a fetch call can ignore.

const NOW = "2026-07-29T22:00:00.000Z";
const DAY = 86_400_000;

let testDb: TestStore;
let store: WorkspaceStore;
/** The one alert's number, and the URL that names it. */
let ID: number;
let URL_: URL;

beforeEach(async () => {
  testDb = await createTestStore();
  await addSites(testDb, [{ id: "meadow.example", domain: null, displayName: "Meadow Board", status: "live", senseOnly: 0, createdAt: NOW }]);
  store = testDb.call;
  ID = await storeAlert(store, {
    asset: "meadow.example",
    firedAt: "2026-07-29T20:00:00.000Z",
    severity: "warn",
    kind: "anomaly",
    metric: "signups",
    message: "drop",
    ruleId: "flow-poisson-low",
    ruleInputs: "{}",
  });
  URL_ = new URL(`https://tower.local/api/flags/${ID}`);
});

/** The alert's row, over these of its columns. */
async function columns(names: string[]): Promise<Record<string, unknown>> {
  const row = await readAlert(store, ID);
  if (!row) throw new Error(`no alert ${ID}`);
  return Object.fromEntries(names.map((name) => [name, row[name as keyof typeof row]]));
}

function patch(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function send(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await handleFlagRequest(patch(body), URL_, store, ID, NOW);
  return { status: res.status, json: await res.json() };
}

function daysFromNow(days: number): string {
  return new Date(Date.parse(NOW) + days * DAY).toISOString();
}

describe("PATCH /api/flags/:id — the alert lifecycle over HTTP", () => {
  it("snoozes to a validated date and reports when it comes back", async () => {
    const until = daysFromNow(3);
    expect(await send({ action: "snooze", until })).toEqual({
      status: 200,
      json: {
        ok: true,
        id: ID,
        asset: "meadow.example",
        action: "snooze",
        changedAt: NOW,
        snoozeUntil: until,
      },
    });
  });

  it("normalizes the date it stores rather than trusting the request's spelling", async () => {
    // A `<input type="date">` value, and an instant with no milliseconds:
    // both legal, neither is what the column should end up holding twice over.
    await send({ action: "snooze", until: "2026-08-05T00:00:00Z" });
    expect(await columns(["snooze_until"])).toEqual({ snooze_until: "2026-08-05T00:00:00.000Z" });
  });

  it("refuses a date in the past — a snooze that has already ended is not one", async () => {
    expect(await send({ action: "snooze", until: daysFromNow(-1) })).toMatchObject({
      status: 422,
      json: { error: "snooze_until_past" },
    });
  });

  it("refuses NOW itself, which would be silence with no duration", async () => {
    expect(await send({ action: "snooze", until: NOW })).toMatchObject({
      status: 422,
      json: { error: "snooze_until_past" },
    });
  });

  it("refuses a date past the horizon rather than accepting an indefinite mute", async () => {
    expect(
      await send({ action: "snooze", until: daysFromNow(SNOOZE_MAX_DAYS + 1) }),
    ).toMatchObject({ status: 422, json: { error: "snooze_until_too_far" } });
    expect(
      await send({ action: "snooze", until: daysFromNow(SNOOZE_MAX_DAYS) }),
    ).toMatchObject({ status: 200 });
  });

  it("refuses a snooze with no date, and gibberish where a date belongs", async () => {
    expect(await send({ action: "snooze" })).toMatchObject({
      status: 422,
      json: { error: "snooze_until_invalid" } });
    expect(await send({ action: "snooze", until: "next tuesday" })).toMatchObject({
      status: 422,
      json: { error: "snooze_until_invalid" } });
    expect(await send({ action: "snooze", until: 3 })).toMatchObject({
      status: 422,
      json: { error: "snooze_until_invalid" },
    });
  });

  it("leaves the flag untouched when it refuses", async () => {
    await send({ action: "snooze", until: daysFromNow(-1) });
    expect(await columns(["disposition", "snooze_until"])).toEqual({ disposition: null, snooze_until: null });
  });

  it("unsnoozes a parked alert and 409s a second attempt", async () => {
    await send({ action: "snooze", until: daysFromNow(3) });
    expect(await send({ action: "unsnooze" })).toMatchObject({
      status: 200,
      json: { action: "unsnooze", snoozeUntil: NOW },
    });
    // Not 404: the row is right there, it is simply no longer snoozed.
    expect(await send({ action: "unsnooze" })).toMatchObject({
      status: 409,
      json: { error: "flag_not_open" },
    });
  });

  it("rejects an unknown verb, a cross-origin write, and a non-JSON body", async () => {
    expect(await send({ action: "mute" })).toMatchObject({
      status: 422,
      json: { error: "invalid_flag_action" },
    });

    const foreign = await handleFlagRequest(
      patch({ action: "acknowledge" }, { origin: "https://evil.example" }),
      URL_,
      store,
      ID,
      NOW,
    );
    expect(foreign.status).toBe(403);

    const notJson = new Request(URL_, { method: "PATCH", body: "action=resolve" });
    expect((await handleFlagRequest(notJson, URL_, store, ID, NOW)).status).toBe(415);
  });

  it("still carries the two actions it always had", async () => {
    expect(await send({ action: "acknowledge" })).toMatchObject({
      status: 200,
      json: { action: "acknowledge", snoozeUntil: null },
    });
    expect(await send({ action: "resolve" })).toMatchObject({
      status: 409,
      json: { error: "flag_not_open" },
    });
  });
});

/** The tune arrives as which setting moved, never as a note: the store's
 * sentence is composed server-side from the same field metadata `/settings`
 * labels that field with, so nothing a caller types can land in the record
 * the false-positive rate is read from. */
describe("PATCH /api/flags/:id — recording a tune", () => {
  const TUNED = { setting: "alpha", from: 0.01, to: 0.05 };

  it("records the disposition and composes the note from the setting", async () => {
    expect(await send({ action: "tune", tuned: TUNED })).toEqual({
      status: 200,
      json: {
        ok: true,
        id: ID,
        asset: "meadow.example",
        action: "tune",
        changedAt: NOW,
        snoozeUntil: null,
      },
    });
    expect(await columns(["disposition", "disposition_note"])).toEqual({
      disposition: "tune",
      disposition_note: "Anomaly sensitivity (alpha) 0.01 → 0.05",
    });
  });

  it("refuses a setting these rules do not read", async () => {
    expect(
      await send({ action: "tune", tuned: { setting: "monthly_caps.data_usd", from: 1, to: 2 } }),
    ).toMatchObject({ status: 422, json: { error: "tune_setting_unknown" },
    });
  });

  it("refuses values that are not numbers", async () => {
    expect(
      await send({ action: "tune", tuned: { setting: "alpha", from: "0.01", to: "0.05" } }),
    ).toMatchObject({ status: 422, json: { error: "tune_values_invalid" },
    });
  });

  it("refuses a tune that changed nothing", async () => {
    expect(
      await send({ action: "tune", tuned: { setting: "alpha", from: 0.01, to: 0.01 } }),
    ).toMatchObject({ status: 422, json: { error: "tune_changed_nothing" } });
    expect(await columns(["disposition"])).toEqual({ disposition: null });
  });

  it("refuses a tune with no setting at all rather than writing an empty reason", async () => {
    expect(await send({ action: "tune" })).toMatchObject({
      status: 422,
      json: { error: "tune_setting_unknown" },
    });
  });

  it("refuses a row that is no longer open, and leaves it exactly as it was", async () => {
    await send({ action: "acknowledge" });
    expect(await send({ action: "tune", tuned: TUNED })).toMatchObject({
      status: 409,
      json: { error: "flag_not_open" },
    });
    expect(await columns(["disposition", "disposition_note"])).toEqual({
      disposition: "ack",
      disposition_note: "Marked read by operator",
    });
  });
});
