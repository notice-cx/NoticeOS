// @vitest-environment node
import type { WorkspaceStore } from "@noticeos/postgres";
import { beforeEach, describe, expect, it } from "vitest";
import {
  TUNE_CARRIED_MARK,
  decisionNoteOnly,
  tunedSettingNote,
  wasTuned,
} from "../shared/tune";
import { applyFlagAction } from "../worker/flag-actions";
import { everTunedSql, openFlagsSql, snoozedFlagsSql } from "../worker/flag-scope";
import { readAlert, readAlerts, storeAlert } from "./alert-rows";
import { type TestStore, createTestStore } from "./postgres-store";
import { addSites } from "./sites";

const NOW = "2026-07-29T22:00:00.000Z";

let testDb: TestStore;

beforeEach(async () => {
  testDb = await createTestStore();
  await addSites(testDb, [{ id: "meals.example", domain: null, displayName: "Meal Planner", status: "live", senseOnly: 0, createdAt: NOW }]);
});

/** The test's alerts, holding its sites. */
async function store(): Promise<WorkspaceStore> {
  return testDb.call;
}

/** One open alert: its number, which the actions take. */
async function insertOpenFlag(): Promise<number> {
  return storeAlert(await store(), {
    asset: "meals.example",
    firedAt: "2026-07-29T20:00:00.000Z",
    severity: "warn",
    kind: "anomaly",
    metric: "signups",
    message: "drop",
    ruleId: "flow-poisson-low",
    ruleInputs: "{}",
  });
}

/** The alert numbered `id`, over these of its columns. */
async function columns(id: number, names: string[]): Promise<Record<string, unknown>> {
  const row = await readAlert(await store(), id);
  if (!row) throw new Error(`no alert ${id}`);
  return Object.fromEntries(names.map((name) => [name, row[name as keyof typeof row]]));
}

describe("flag actions", () => {
  it("marks one event read without deleting its evidence", async () => {
    const id = await insertOpenFlag();
    expect(await applyFlagAction(await store(), id, "acknowledge", NOW)).toEqual({
      id,
      asset: "meals.example",
      action: "acknowledge",
      changedAt: NOW,
      // Only a snooze carries a return date; the other three say so explicitly.
      snoozeUntil: null,
    });

    expect(
      await columns(id, ["disposition", "disposition_at", "disposition_note", "message", "rule_inputs"]),
    ).toMatchObject({
      disposition: "ack",
      disposition_at: NOW,
      disposition_note: "Marked read by operator",
      message: "drop",
      rule_inputs: "{}",
    });
  });

  it("resolves one event and cannot mutate it a second time", async () => {
    const id = await insertOpenFlag();
    expect(await applyFlagAction(await store(), id, "resolve", NOW)).toMatchObject({
      id,
      action: "resolve",
    });
    expect(await columns(id, ["resolved_at"])).toEqual({ resolved_at: NOW });
    expect(await applyFlagAction(await store(), id, "acknowledge", NOW)).toBeNull();
  });

  it("returns null for a missing flag", async () => {
    expect(await applyFlagAction(await store(), 404, "resolve", NOW)).toBeNull();
  });
});

/** The band shows one row per condition, so the button under that row has to
 * mean what the row says. */
describe("flag actions act on the condition, not the firing", () => {
  async function insertFlag(
    ruleId: string,
    metric: string | null,
    firedAt: string,
    inputs = "{}",
    asset = "meals.example",
  ): Promise<number> {
    return storeAlert(await store(), {
      asset,
      firedAt,
      severity: "warn",
      kind: "anomaly",
      metric,
      message: "below baseline",
      ruleId,
      ruleInputs: inputs,
    });
  }

  const openIds = async (): Promise<number[]> =>
    (await readAlerts(await store(), "resolved_at IS NULL AND disposition IS NULL")).map((row) => row.id);

  it("resolves every open firing of a declared recurring condition", async () => {
    const ids: number[] = [];
    for (const day of ["04", "10", "20", "31"]) {
      ids.push(await insertFlag("asset-declared", "apiRequests", `2026-08-${day}T02:00:00.000Z`));
    }
    await applyFlagAction(await store(), ids[3]!, "resolve", NOW);
    expect(await openIds()).toEqual([]);
  });

  /** `watch-window-closed` fires twice on one asset with one metric, but each
   * firing carries its own watchWindowId and asks a different question. */
  it("leaves a sibling event alone when the rule is not declared recurring", async () => {
    const first = await insertFlag("watch-window-closed", "position", "2026-08-21T02:00:00.000Z",
      JSON.stringify({ watchWindowId: "aaa" }));
    const second = await insertFlag("watch-window-closed", "position", "2026-08-21T03:00:00.000Z",
      JSON.stringify({ watchWindowId: "bbb" }));

    await applyFlagAction(await store(), second, "resolve", NOW);
    expect(await openIds()).toEqual([first]);
  });

  it("does not reach across assets or across metrics", async () => {
    await addSites(testDb, [{ id: "nosh.example", domain: null, displayName: "Nosh", status: "live", senseOnly: 0, createdAt: NOW }]);
    const clicked = await insertFlag("asset-declared", "apiRequests", "2026-08-20T02:00:00.000Z");
    const otherMetric = await insertFlag("asset-declared", "signups", "2026-08-20T02:00:00.000Z");
    const otherAsset = await insertFlag("asset-declared", "apiRequests", "2026-08-20T02:00:00.000Z", "{}", "nosh.example");

    await applyFlagAction(await store(), clicked, "resolve", NOW);
    expect(await openIds()).toEqual([otherMetric, otherAsset]);
  });

  /** NULL never equals NULL in SQL: without an IS NULL arm this grouped rule
   * would match nothing and disposition only the clicked row. */
  it("groups a recurring rule that stores no metric at all", async () => {
    await insertFlag("asset-declared", null, "2026-08-20T02:00:00.000Z");
    const clicked = await insertFlag("asset-declared", null, "2026-08-21T02:00:00.000Z");

    await applyFlagAction(await store(), clicked, "acknowledge", NOW);
    expect(await openIds()).toEqual([]);
  });

  it("still reports null when the target is already gone", async () => {
    const id = await insertFlag("asset-declared", "apiRequests", "2026-08-20T02:00:00.000Z");
    await applyFlagAction(await store(), id, "resolve", NOW);
    expect(await applyFlagAction(await store(), id, "resolve", NOW)).toBeNull();
  });
});

/** Snooze is the only disposition that expires, so the store has to hand the
 * same condition back on its own. */
describe("snooze parks a condition until a date and gives it back", () => {
  const IN_THREE_DAYS = "2026-08-01T22:00:00.000Z";

  /** What every open list asks the store, through the one predicate they share. */
  const openIds = async (nowIso: string): Promise<number[]> =>
    (await readAlerts(await store(), openFlagsSql("", "$1::timestamptz"), [nowIso])).map((row) => row.id);

  const snoozedIds = async (nowIso: string): Promise<number[]> =>
    (await readAlerts(await store(), snoozedFlagsSql("", "$1::timestamptz"), [nowIso])).map((row) => row.id);

  it("writes the date, leaves the open list, and comes back when it passes", async () => {
    const id = await insertOpenFlag();
    expect(
      await applyFlagAction(await store(), id, "snooze", NOW, IN_THREE_DAYS),
    ).toEqual({
      id,
      asset: "meals.example",
      action: "snooze",
      changedAt: NOW,
      snoozeUntil: IN_THREE_DAYS,
    });

    expect(
      await columns(id, ["disposition", "disposition_at", "disposition_note", "snooze_until", "resolved_at", "message"]),
    ).toMatchObject({
      disposition: "snooze",
      disposition_at: NOW,
      disposition_note: "Snoozed by operator",
      snooze_until: IN_THREE_DAYS,
      resolved_at: null,
      message: "drop",
    });

    expect(await openIds(NOW)).toEqual([]);
    expect(await snoozedIds(NOW)).toEqual([id]);

    // One second past the date and the same row is open again: same id, no
    // second firing, and nothing had to run for it to happen.
    const after = "2026-08-01T22:00:01.000Z";
    expect(await openIds(after)).toEqual([id]);
    expect(await snoozedIds(after)).toEqual([]);
  });

  it("refuses to snooze without a date rather than parking it forever", async () => {
    const id = await insertOpenFlag();
    expect(await applyFlagAction(await store(), id, "snooze", NOW, null)).toBeNull();
    expect(await openIds(NOW)).toEqual([id]);
  });

  it("unsnooze ends the snooze now and keeps the record that it happened", async () => {
    const id = await insertOpenFlag();
    await applyFlagAction(await store(), id, "snooze", NOW, IN_THREE_DAYS);

    const back = "2026-07-30T09:00:00.000Z";
    expect(await applyFlagAction(await store(), id, "unsnooze", back)).toMatchObject({
      id,
      action: "unsnooze",
      snoozeUntil: back,
    });
    expect(await openIds(back)).toEqual([id]);
    expect(await snoozedIds(back)).toEqual([]);
    expect(await columns(id, ["disposition", "disposition_note"])).toEqual({
      disposition: "snooze",
      disposition_note: "Snooze ended by operator",
    });
  });

  it("cannot unsnooze what is not snoozed", async () => {
    const id = await insertOpenFlag();
    expect(await applyFlagAction(await store(), id, "unsnooze", NOW)).toBeNull();
  });

  it("parks every open firing of a declared recurring condition together", async () => {
    const ids: number[] = [];
    for (const day of ["04", "10", "20", "31"]) {
      ids.push(await storeAlert(await store(), {
        asset: "meals.example",
        firedAt: `2026-07-${day}T02:00:00.000Z`,
        severity: "warn",
        kind: "anomaly",
        metric: "apiRequests",
        message: "below baseline",
        ruleId: "asset-declared",
        ruleInputs: "{}",
      }));
    }
    await applyFlagAction(await store(), ids[3]!, "snooze", NOW, IN_THREE_DAYS);
    // All four, or the row that reads "4x" would go quiet and leave three
    // identical ones behind it.
    expect(await snoozedIds(NOW)).toEqual(ids);
  });

  it("marking an expired snooze read clears its date rather than leaving a stale one", async () => {
    const id = await insertOpenFlag();
    await applyFlagAction(await store(), id, "snooze", NOW, IN_THREE_DAYS);
    const after = "2026-08-02T00:00:00.000Z";
    expect(
      await applyFlagAction(await store(), id, "acknowledge", after),
    ).toMatchObject({ action: "acknowledge" });
    expect(await columns(id, ["disposition", "snooze_until"])).toEqual({ disposition: "ack", snooze_until: null });
    expect(await openIds(after)).toEqual([]);
  });
});

/** The tune disposition carries its own reason and is the only one that does
 * not settle the row: the alert stays in the queue with the record of what
 * was changed on it, which is what makes a rule's false-positive rate measurable. */
describe("tuning a rule records the tune on the alert it was tuned from", () => {
  const TUNED = { setting: "alpha", from: 0.01, to: 0.05 };

  const openIds = async (nowIso: string): Promise<number[]> =>
    (await readAlerts(await store(), openFlagsSql("", "$1::timestamptz"), [nowIso])).map((row) => row.id);

  const row = async (id: number) =>
    columns(id, ["disposition", "disposition_at", "disposition_note", "snooze_until", "resolved_at", "message"]);

  it("writes the disposition with the setting and both values as its reason", async () => {
    const id = await insertOpenFlag();
    expect(
      await applyFlagAction(await store(), id, "tune", NOW, null, TUNED),
    ).toEqual({
      id,
      asset: "meals.example",
      action: "tune",
      changedAt: NOW,
      snoozeUntil: null,
    });

    expect(await row(id)).toMatchObject({
      disposition: "tune",
      disposition_at: NOW,
      // The words the field itself wears, from `shared/tune`, never free text
      // sent by the browser.
      disposition_note: "Anomaly sensitivity (alpha) 0.01 → 0.05",
      snooze_until: null,
      resolved_at: null,
      message: "drop",
    });
  });

  it("leaves the alert OPEN, because the firing was not answered", async () => {
    const id = await insertOpenFlag();
    await applyFlagAction(await store(), id, "tune", NOW, null, TUNED);
    expect(await openIds(NOW)).toEqual([id]);
  });

  it("refuses a tune with no setting to name", async () => {
    const id = await insertOpenFlag();
    expect(await applyFlagAction(await store(), id, "tune", NOW)).toBeNull();
    expect(await row(id)).toMatchObject({ disposition: null });
  });

  it("may be tuned again — the panel holds three settings", async () => {
    const id = await insertOpenFlag();
    await applyFlagAction(await store(), id, "tune", NOW, null, TUNED);
    const later = "2026-07-29T22:05:00.000Z";
    expect(
      await applyFlagAction(await store(), id, "tune", later, null, {
        setting: "min_baseline_per_day",
        from: 3,
        to: 5,
      }),
    ).toMatchObject({ action: "tune" });
    expect(await row(id)).toMatchObject({
      disposition: "tune",
      disposition_note: "Minimum daily volume to test (min_baseline_per_day) 3 → 5",
    });
    expect(await openIds(later)).toEqual([id]);
  });

  it("never overwrites a decision the operator already made", async () => {
    const id = await insertOpenFlag();
    await applyFlagAction(await store(), id, "acknowledge", NOW);
    expect(
      await applyFlagAction(await store(), id, "tune", NOW, null, TUNED),
    ).toBeNull();
    expect(await row(id)).toMatchObject({
      disposition: "ack",
      disposition_note: "Marked read by operator",
    });
  });

  it("settles into the history keeping the tune, when the issue is resolved", async () => {
    const id = await insertOpenFlag();
    await applyFlagAction(await store(), id, "tune", NOW, null, TUNED);
    const later = "2026-07-30T09:00:00.000Z";
    await applyFlagAction(await store(), id, "resolve", later);
    // Resolve writes `resolved_at` and never touches the disposition.
    expect(await row(id)).toMatchObject({
      disposition: "tune",
      disposition_note: "Anomaly sensitivity (alpha) 0.01 → 0.05",
      resolved_at: later,
    });
    expect(await openIds(later)).toEqual([]);
  });

  it("tunes every open firing of a declared recurring condition together", async () => {
    const ids: number[] = [];
    for (const day of ["04", "10", "20"]) {
      ids.push(await storeAlert(await store(), {
        asset: "meals.example",
        firedAt: `2026-07-${day}T02:00:00.000Z`,
        severity: "warn",
        kind: "anomaly",
        metric: "signups",
        message: "below baseline",
        ruleId: "flow-poisson-low",
        ruleInputs: "{}",
      }));
    }
    await applyFlagAction(await store(), ids[2]!, "tune", NOW, null, TUNED);
    // The condition is what was tuned, so all three carry the record and stay open.
    for (const id of ids) {
      expect(await row(id)).toMatchObject({ disposition: "tune" });
    }
    expect(await openIds(NOW)).toEqual(ids);
  });
});

/** `flags.disposition` holds one decision and a tuned alert stays open, so a
 * later Mark read or Snooze must not erase the tune: it is carried in the
 * note, and the false-positive rate asks "was this ever tuned". */
describe("a decision landing on a tuned alert keeps the tune", () => {
  const TUNED = { setting: "alpha", from: 0.01, to: 0.05 };
  const TUNE_NOTE = "Anomaly sensitivity (alpha) 0.01 → 0.05";
  const IN_THREE_DAYS = "2026-08-01T22:00:00.000Z";

  const note = async (id: number): Promise<string | null> =>
    (await readAlert(await store(), id))!.disposition_note;

  const everTuned = async (): Promise<number[]> =>
    (await readAlerts(await store(), everTunedSql())).map((row) => row.id);

  it("inlines a mark that carries no quote, because two modules put it in SQL", () => {
    // `worker/flag-scope.ts` and `worker/flag-actions.ts` both write this
    // constant into statement text, so it may hold no quote or backslash.
    expect(TUNE_CARRIED_MARK).not.toMatch(/['"\\]/);
  });

  it("marks a tuned alert read without forgetting which setting moved", async () => {
    const id = await insertOpenFlag();
    await applyFlagAction(await store(), id, "tune", NOW, null, TUNED);
    await applyFlagAction(await store(), id, "acknowledge", NOW);

    // The disposition slot still holds the decision about the event; the rule
    // change rides behind the mark.
    expect(await columns(id, ["disposition"])).toEqual({ disposition: "ack" });
    expect(await note(id)).toBe(`Marked read by operator · rule tuned: ${TUNE_NOTE}`);
    expect(await everTuned()).toEqual([id]);
    expect(wasTuned({ disposition: "ack", dispositionNote: await note(id) })).toBe(true);
    expect(
      tunedSettingNote({ disposition: "ack", dispositionNote: await note(id) }),
    ).toBe(TUNE_NOTE);
    expect(decisionNoteOnly(await note(id))).toBe("Marked read by operator");
  });

  it("parks a tuned alert without forgetting it either", async () => {
    const id = await insertOpenFlag();
    await applyFlagAction(await store(), id, "tune", NOW, null, TUNED);
    await applyFlagAction(await store(), id, "snooze", NOW, IN_THREE_DAYS);
    expect(await note(id)).toBe(`Snoozed by operator · rule tuned: ${TUNE_NOTE}`);
    expect(await everTuned()).toEqual([id]);
  });

  it("keeps the tune through the end of a snooze, so unsnooze is not a second leak", async () => {
    const id = await insertOpenFlag();
    await applyFlagAction(await store(), id, "tune", NOW, null, TUNED);
    await applyFlagAction(await store(), id, "snooze", NOW, IN_THREE_DAYS);
    const back = "2026-07-30T09:00:00.000Z";
    await applyFlagAction(await store(), id, "unsnooze", back);
    expect(await note(id)).toBe(`Snooze ended by operator · rule tuned: ${TUNE_NOTE}`);
    expect(await everTuned()).toEqual([id]);
  });

  it("leaves an untouched alert's note exactly as it was", async () => {
    const id = await insertOpenFlag();
    await applyFlagAction(await store(), id, "acknowledge", NOW);
    expect(await note(id)).toBe("Marked read by operator");
    expect(await everTuned()).toEqual([]);
  });

  /** The note is composed in SQL per row: a recurring condition dispositions
   * every open firing at once, and a firing inserted after the tune was never
   * tuned, so stamping it would inflate the rate. */
  it("does not stamp an untuned sibling in the same recurring condition", async () => {
    const declared = async (firedAt: string): Promise<number> =>
      storeAlert(await store(), {
        asset: "meals.example",
        firedAt,
        severity: "warn",
        kind: "anomaly",
        metric: "apiRequests",
        message: "below baseline",
        ruleId: "asset-declared",
        ruleInputs: "{}",
      });
    const first = await declared("2026-07-04T02:00:00.000Z");
    const second = await declared("2026-07-10T02:00:00.000Z");
    await applyFlagAction(await store(), first, "tune", NOW, null, TUNED);
    const third = await declared("2026-07-29T02:00:00.000Z");

    await applyFlagAction(await store(), third, "acknowledge", NOW);
    expect(await note(first)).toBe(`Marked read by operator · rule tuned: ${TUNE_NOTE}`);
    expect(await note(second)).toBe(`Marked read by operator · rule tuned: ${TUNE_NOTE}`);
    expect(await note(third)).toBe("Marked read by operator");
    expect(await everTuned()).toEqual([first, second]);
  });
});
