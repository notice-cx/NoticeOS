import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { beforeEach, describe, expect, it } from "vitest";
import { findRuleStat } from "../shared/alert-rules";
import { applyFlagAction } from "../worker/flag-actions";
import { buildAlertRuleStatsPayload } from "../worker/alert-rules";
import { storeAlert } from "./alert-rows";
import { type TestStore, createTestStore } from "./postgres-store";
import { addSites } from "./sites";

// A ROW PER TUNE (bead `ro-6d1t`).
//
// The store recorded THAT an alert was tuned and WHICH setting last moved
// (bead `ro-bkcl`, in `flags.disposition_note`); a second tune on the same row
// overwrote the first note, so "the operator has tuned this rule five times
// this quarter" had no answer. `flag_tunes` is one row per tune.
//
// On Postgres (bead ro-ujb9.76.5.2) every store has the table from its first
// migration, so the D1 store without db/0030 — which tuned as before and
// answered "cannot say" — is a state no store reaches.

const NOW = "2026-09-04T12:00:00.000Z";
const DAY = 86_400_000;

function at(daysAgo: number): string {
  return new Date(Date.parse(NOW) - daysAgo * DAY).toISOString();
}

async function insertFlag(
  store: WorkspaceStore,
  spec: { ruleId: string; firedAt: string; asset?: string },
): Promise<number> {
  return storeAlert(store, {
    asset: spec.asset ?? "nosh.example",
    firedAt: spec.firedAt,
    severity: "warn",
    kind: "anomaly",
    metric: null,
    message: "something moved",
    ruleId: spec.ruleId,
  });
}

/** Every recorded tune, oldest first, naming its alert by number. */
async function tuneRows(store: WorkspaceStore): Promise<Array<Record<string, unknown>>> {
  const rows = await store.read((tx) =>
    tx.query<{ flag_id: number; rule_id: string; setting: string; value_from: number; value_to: number; tuned_at: string; actor: string }>(
      `SELECT f.flag_number::int AS flag_id, t.rule_id, t.setting, t.value_from, t.value_to, t.tuned_at, t.actor
         FROM noticeos.flag_tunes t
         JOIN noticeos.flags f ON f.workspace_id = t.workspace_id AND f.flag_id = t.flag_id
        ORDER BY t.tune_id`,
    ),
  );
  return rows.map((row) => ({ ...row, tuned_at: javascriptInstant(row.tuned_at) }));
}

let test: TestStore;
let store: WorkspaceStore;

beforeEach(async () => {
  test = await createTestStore();
  await addSites(test, [{ id: "nosh.example", displayName: "Nosh", status: "live", senseOnly: 0 }]);
  store = test.call;
});

describe("the record per tune", () => {
  it("records one row per tune, so twice is two", async () => {
    const id = await insertFlag(store, { ruleId: "flow-poisson-low", firedAt: at(5) });

    await applyFlagAction(store, id, "tune", at(4), null, {
      setting: "alpha",
      from: 0.01,
      to: 0.05,
    });
    // The same row, tuned again on a DIFFERENT setting. Before this table the
    // second note overwrote the first and the pair counted once.
    await applyFlagAction(store, id, "tune", at(2), null, {
      setting: "min_baseline_per_day",
      from: 3,
      to: 5,
    });

    const rows = await tuneRows(store);
    expect(rows).toEqual([
      {
        flag_id: id,
        rule_id: "flow-poisson-low",
        setting: "alpha",
        value_from: 0.01,
        value_to: 0.05,
        tuned_at: at(4),
        actor: "operator",
      },
      {
        flag_id: id,
        rule_id: "flow-poisson-low",
        setting: "min_baseline_per_day",
        value_from: 3,
        value_to: 5,
        tuned_at: at(2),
        actor: "operator",
      },
    ]);

    // And the note still carries the LAST setting, unchanged: this is an
    // addition beside the old record, never a replacement of it.
    const [flag] = await store.read((tx) =>
      tx.query<{ disposition_note: string }>(`SELECT disposition_note FROM noticeos.flags WHERE flag_number = $1`, [id]),
    );
    expect(flag!.disposition_note).toBe("Minimum daily volume to test (min_baseline_per_day) 3 → 5");
  });

  it("makes 'tuned five times this quarter' answerable", async () => {
    const id = await insertFlag(store, { ruleId: "flow-poisson-low", firedAt: at(30) });
    for (const [days, from, to] of [
      [25, 0.01, 0.02],
      [20, 0.02, 0.03],
      [15, 0.03, 0.04],
      [10, 0.04, 0.05],
      [5, 0.05, 0.06],
    ] as const) {
      await applyFlagAction(store, id, "tune", at(days), null, {
        setting: "alpha",
        from,
        to,
      });
    }

    const payload = await buildAlertRuleStatsPayload(store, { now: new Date(NOW) });
    const stat = findRuleStat(payload, "flow-poisson-low");
    expect(stat?.tunes).toBe(5);
    // One ALERT, tuned five times: the old count is unchanged and still counts
    // alerts. The two numbers answer different questions and neither replaces
    // the other.
    expect(stat?.tunedOpen).toBe(1);
    expect(stat?.tuned).toBe(0);
  });

  it("counts a rule that has never been tuned as a measured zero", async () => {
    await insertFlag(store, { ruleId: "ingest-freshness", firedAt: at(4) });

    const payload = await buildAlertRuleStatsPayload(store, { now: new Date(NOW) });
    expect(findRuleStat(payload, "ingest-freshness")?.tunes).toBe(0);
  });

  it("leaves a tune older than the window out of the count", async () => {
    const id = await insertFlag(store, { ruleId: "flow-poisson-low", firedAt: at(10) });
    // Tuned before the quarter began (a tune is never rewritten, so it is
    // recorded then). The window is on when the TUNE happened.
    await applyFlagAction(store, id, "tune", at(200), null, {
      setting: "alpha",
      from: 0.01,
      to: 0.05,
    });

    const payload = await buildAlertRuleStatsPayload(store, { now: new Date(NOW) });
    expect(findRuleStat(payload, "flow-poisson-low")?.tunes).toBe(0);
  });

  it("files one row per DECISION, not one per alert a grouped rule touched", async () => {
    // `ingest-freshness` is a recurring condition: one disposition lands on
    // every open firing at once, which is why the alert counts are a floor. A
    // count of TUNES has to be a count of what the operator did, and they did
    // one thing.
    const first = await insertFlag(store, { ruleId: "ingest-freshness", firedAt: at(6) });
    await insertFlag(store, { ruleId: "ingest-freshness", firedAt: at(4) });

    await applyFlagAction(store, first, "tune", NOW, null, {
      setting: "alpha",
      from: 0.01,
      to: 0.05,
    });

    const rows = (await tuneRows(store)).map((row) => ({ flag_id: row.flag_id }));
    expect(rows).toEqual([{ flag_id: first }]);
  });
});
