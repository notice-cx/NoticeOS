import { beforeEach, describe, expect, it } from "vitest";
import {
  ALERT_RULE_WINDOW_DAYS,
  TUNE_PROPOSAL_MIN_SETTLED,
  TUNE_PROPOSAL_SHARE,
  type AlertRuleStat,
  findRuleStat,
  ruleLabel,
  tuneProposal,
  tuneShare,
} from "../shared/alert-rules";
import {
  buildAlertRuleStatsPayload,
  handleAlertRuleStatsRequest,
} from "../worker/alert-rules";
import { storeAlert, storeReports } from "./alert-rows";
import { type TestStore, createTestStore } from "./postgres-store";
import { addSites } from "./sites";

// GET /api/alerts/rules — what each rule has COST (bead `ro-ayxy`).
//
// Asserted against the REAL schema on a Postgres copy (bead ro-ujb9.76.5.2), so
// the grouping, the settled predicate and the window all run the SQL the Tower
// runs. What
// these tests really guard is that the false-positive rate is HONEST: the
// denominator is what the operator has finished with rather than everything the
// rule ever produced, a tune that is still open is never quietly counted as
// though it had settled, and a rule the store has nothing to say about is absent
// rather than a row of zeros that would read as "never a problem".

const NOW = new Date("2026-09-04T12:00:00.000Z");
const DAY = 86_400_000;

function at(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY).toISOString();
}

interface FlagSpec {
  ruleId: string;
  firedAt: string;
  asset?: string;
  disposition?: "ack" | "snooze" | "tune" | "incident" | "hypothesis" | null;
  /** The reason field. It carries a tune the operator later answered another
   * way (bead `ro-bkcl`), so the numerator has to read it. */
  dispositionNote?: string | null;
  snoozeUntil?: string | null;
  resolvedAt?: string | null;
}

async function insertFlag(spec: FlagSpec): Promise<number> {
  return storeAlert(test.call, {
    asset: spec.asset ?? "nosh.example",
    firedAt: spec.firedAt,
    severity: "warn",
    kind: "anomaly",
    metric: null,
    message: "something moved",
    ruleId: spec.ruleId,
    ruleInputs: null,
    disposition: spec.disposition ?? null,
    dispositionAt: spec.disposition ? spec.firedAt : null,
    dispositionNote: spec.dispositionNote ?? null,
    snoozeUntil: spec.snoozeUntil ?? null,
    resolvedAt: spec.resolvedAt ?? null,
  });
}

let test: TestStore;

beforeEach(async () => {
  test = await createTestStore();
  await addSites(test, [{ id: "nosh.example", displayName: "Nosh", status: "live", senseOnly: 0 }]);
});

const build = async () => buildAlertRuleStatsPayload(test.call, { now: NOW });

describe("the per-rule tune counts", () => {
  it("reads docs/15 flow E's arithmetic: 3 fired, 1 of them answered by tuning, 33%", async () => {
    // The shape the doc describes, at the smallest size that has a rate at all:
    // three settled alerts from one rule, one of which the operator answered by
    // making the rule quieter. Tuning does not close a firing, so the tuned one
    // also carries the `resolved_at` that settled it.
    await insertFlag({
      ruleId: "flow-poisson-low",
      firedAt: at(20),
      disposition: "tune",
      resolvedAt: at(18),
    });
    await insertFlag({ ruleId: "flow-poisson-low", firedAt: at(15), disposition: "ack" });
    await insertFlag({ ruleId: "flow-poisson-low", firedAt: at(10), resolvedAt: at(9) });

    const payload = await build();
    const stat = findRuleStat(payload, "flow-poisson-low");

    expect(stat).toMatchObject({
      ruleId: "flow-poisson-low",
      fired: 3,
      settled: 3,
      tuned: 1,
      tunedOpen: 0,
      acknowledged: 1,
      resolved: 1,
    });
    expect(Math.round(tuneShare(stat!)! * 100)).toBe(33);
  });

  /**
   * `ro-bkcl`. Before the fix this rule read 0% — the diligent operator's two
   * tunes had both been overwritten by the Mark read that cleared the alert,
   * and the store said nobody had ever complained about it.
   */
  it("counts a tune the operator later answered another way", async () => {
    const carried = (note: string) =>
      `${note} · rule tuned: Anomaly sensitivity (alpha) 0.01 → 0.05`;
    // Tuned, then marked read — the disposition slot says `ack`.
    await insertFlag({
      ruleId: "flow-poisson-low",
      firedAt: at(20),
      disposition: "ack",
      dispositionNote: carried("Marked read by operator"),
    });
    // Tuned, then parked, and still quiet: still tuned, but NOT settled — a
    // snooze is put off, not answered (bead `ro-ujb9.194`), so it waits beside
    // the rate as a tune not settled yet.
    await insertFlag({
      ruleId: "flow-poisson-low",
      firedAt: at(15),
      disposition: "snooze",
      dispositionNote: carried("Snoozed by operator"),
      snoozeUntil: at(-5),
    });
    // Marked read and never tuned — the row that must NOT move the numerator.
    await insertFlag({
      ruleId: "flow-poisson-low",
      firedAt: at(10),
      disposition: "ack",
      dispositionNote: "Marked read by operator",
    });

    const stat = findRuleStat(await build(), "flow-poisson-low");
    expect(stat).toMatchObject({ fired: 3, settled: 2, tuned: 1, tunedOpen: 1 });
    // Both true of one alert, and both counted: an alert that was tuned AND
    // marked read is in `tuned` and in `acknowledged`, so the four counts no
    // longer partition `settled` and nothing may sum them.
    expect(stat!.acknowledged).toBe(2);
    expect(Math.round(tuneShare(stat!)! * 100)).toBe(50);
  });

  it("keeps the denominator to what the operator has FINISHED with", async () => {
    // Two open firings and one settled. Counting the open ones would read every
    // fresh alert as evidence the rule is fine, and the one tune the operator
    // did record would drop from a half to a sixth.
    await insertFlag({
      ruleId: "flow-poisson-low",
      firedAt: at(20),
      disposition: "tune",
      resolvedAt: at(19),
    });
    await insertFlag({ ruleId: "flow-poisson-low", firedAt: at(12), resolvedAt: at(11) });
    await insertFlag({ ruleId: "flow-poisson-low", firedAt: at(2) });
    await insertFlag({ ruleId: "flow-poisson-low", firedAt: at(1) });

    const stat = findRuleStat(await build(), "flow-poisson-low")!;

    expect(stat.fired).toBe(4);
    expect(stat.settled).toBe(2);
    expect(tuneShare(stat)).toBe(0.5);
  });

  it("counts a tune that is still open separately, never inside the rate", async () => {
    // A tune leaves the row OPEN by design (`worker/flag-scope.ts`): the drop is
    // still there and only what would produce it next time changed. So the
    // answer the operator already gave sits outside the rate until the alert
    // settles — and the surface says so rather than reading 0%.
    await insertFlag({ ruleId: "flow-poisson-low", firedAt: at(3), disposition: "tune" });
    await insertFlag({ ruleId: "flow-poisson-low", firedAt: at(2), disposition: "tune" });
    await insertFlag({ ruleId: "flow-poisson-low", firedAt: at(1), disposition: "ack",
    });

    const stat = findRuleStat(await build(), "flow-poisson-low")!;

    expect(stat).toMatchObject({ fired: 3, settled: 1, tuned: 0, tunedOpen: 2 });
    expect(tuneShare(stat)).toBe(0);
  });

  it("counts neither an ACTIVE nor an EXPIRED snooze as settled", async () => {
    // Bead `ro-ujb9.194` replaced "treats an ACTIVE snooze as settled": a snooze
    // with time on the clock is put off, not answered, and one whose date has
    // passed is the same condition back in the queue. Neither tells the rate
    // anything about the rule yet.
    await insertFlag({
      ruleId: "asset-declared",
      firedAt: at(9),
      disposition: "snooze",
      snoozeUntil: at(-3),
    });
    await insertFlag({
      ruleId: "asset-declared",
      firedAt: at(8),
      disposition: "snooze",
      snoozeUntil: at(1),
    });

    const stat = findRuleStat(await build(), "asset-declared")!;

    expect(stat).toMatchObject({ fired: 2, settled: 0, tuned: 0, acknowledged: 0, resolved: 0 });
  });

  it("groups by rule and orders noisiest first", async () => {
    await insertFlag({ ruleId: "ingest-freshness", firedAt: at(5), disposition: "ack" });
    for (let i = 0; i < 3; i += 1) {
      await insertFlag({
        ruleId: "flow-poisson-low",
        firedAt: at(5 + i),
        disposition: "tune",
        resolvedAt: at(4 + i),
      });
    }

    const payload = await build();

    expect(payload.rules.map((rule) => rule.ruleId)).toEqual([
      "flow-poisson-low",
      "ingest-freshness",
    ]);
    expect(payload.rules[0]!.tuned).toBe(3);
    expect(payload.rules[1]!.tuned).toBe(0);
  });

  it("windows on WHEN THE RULE FIRED, not on when the alert closed", async () => {
    // A firing from before the window is out even though it was dispositioned
    // yesterday: the question is what this rule produced this quarter.
    await insertFlag({
      ruleId: "flow-poisson-low",
      firedAt: at(ALERT_RULE_WINDOW_DAYS + 2),
      disposition: "tune",
      resolvedAt: at(1),
    });
    await insertFlag({
      ruleId: "flow-poisson-low",
      firedAt: at(ALERT_RULE_WINDOW_DAYS - 2),
      disposition: "ack",
    });

    const payload = await build();

    expect(payload.windowDays).toBe(ALERT_RULE_WINDOW_DAYS);
    expect(payload.since).toBe(new Date(NOW.getTime() - ALERT_RULE_WINDOW_DAYS * DAY).toISOString());
    expect(findRuleStat(payload, "flow-poisson-low")).toMatchObject({ fired: 1, tuned: 0 });
  });

  it("counts a report re-sent the same day once: the alert it replaced fired for no rule", async () => {
    // A same-day retry keeps the alerts it re-derived in place of the earlier
    // revision's, which stay in the store, replaced (bead ro-ujb9.76.5.2); D1
    // deleted them. Either way the rule fired once that day.
    const store = test.call;
    const [first, second] = await storeReports(store, [
      { asset: "nosh.example", date: at(3).slice(0, 10), receivedAt: at(3), envelope: {} },
      { asset: "nosh.example", date: at(3).slice(0, 10), receivedAt: at(3), envelope: {} },
    ]);
    await storeAlert(store, {
      asset: "nosh.example", firedAt: at(3), severity: "warn", kind: "anomaly", ruleId: "flow-poisson-low",
      pulseId: first!.pulseId, replacedByPulseId: second!.pulseId,
    });
    await storeAlert(store, {
      asset: "nosh.example", firedAt: at(3), severity: "warn", kind: "anomaly", ruleId: "flow-poisson-low",
      pulseId: second!.pulseId,
    });

    expect(findRuleStat(await build(), "flow-poisson-low")).toMatchObject({ fired: 1, settled: 0 });
  });

  it("says nothing at all about a rule that has not fired", async () => {
    const payload = await build();

    expect(payload.rules).toEqual([]);
    // A rule the read has nothing for is null on both surfaces, so neither can
    // decide on its own that silence means zero.
    expect(findRuleStat(payload, "flow-poisson-low")).toBeNull();
  });
});

describe("the route", () => {
  it("answers a GET with the payload", async () => {
    await insertFlag({
      ruleId: "flow-poisson-low",
      firedAt: at(4),
      disposition: "tune",
      resolvedAt: at(3),
    });

    const res = await handleAlertRuleStatsRequest(
      new Request("http://tower/api/alerts/rules"),
      test.call,
      { now: NOW },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: { ruleId: string; tuned: number }[] };
    expect(body.rules).toEqual([
      expect.objectContaining({ ruleId: "flow-poisson-low", tuned: 1 }),
    ]);
  });

  it("refuses anything but a GET — dispositions are written on the flag lane", async () => {
    const res = await handleAlertRuleStatsRequest(
      new Request("http://tower/api/alerts/rules", { method: "POST" }),
      test.call,
      { now: NOW },
    );

    expect(res.status).toBe(405);
  });
});

describe("the rule vocabulary", () => {
  it("names the rules the operator has words for and falls back to the id", () => {
    expect(ruleLabel("flow-poisson-low")).toBe("Drop at normal volume");
    // A rule shipped from the ingest lane that nothing here has heard of keeps
    // the identity the store holds, rather than rendering blank.
    expect(ruleLabel("some-new-rule")).toBe("some-new-rule");
  });
});

/**
 * `ro-bgny`. docs/15 flow E has promised since it was written that rules above
 * ~40% get auto-proposed for tuning, and until now nothing read the rate. What
 * crossing the line produces is a sentence with two answers — never a saved
 * threshold, which is operator-only forever (AGENTS.md).
 */
describe("when the OS proposes quietening a rule", () => {
  const stat = (over: Partial<AlertRuleStat> = {}): AlertRuleStat => ({
    ruleId: "flow-poisson-low",
    fired: 20,
    settled: 10,
    tuned: 5,
    tunedOpen: 0,
    acknowledged: 3,
    resolved: 2,
    tunes: 0,
    ...over,
  });

  it("declares the threshold once, and it is the doc's ~40%", () => {
    // docs/15 flow E's sentence is prose ABOUT this constant. If they ever
    // disagree, the doc is describing a number nothing uses.
    expect(TUNE_PROPOSAL_SHARE).toBe(0.4);
  });

  it("proposes when the share crosses the line, carrying what it read", () => {
    expect(tuneProposal(stat())).toEqual({
      ruleId: "flow-poisson-low",
      share: 0.5,
      tuned: 5,
      settled: 10,
    });
  });

  it("says nothing about a rule the operator mostly answers some other way", () => {
    expect(tuneProposal(stat({ tuned: 3, settled: 10 }))).toBeNull();
  });

  /**
   * The minimum is what stops one click becoming a policy: at two settled
   * alerts a single tune reads as 50%, and the OS would be proposing a
   * threshold change off one decision.
   */
  it("waits for enough settled alerts before it has an opinion at all", () => {
    const thin = stat({ settled: TUNE_PROPOSAL_MIN_SETTLED - 1, tuned: 3 });
    expect(tuneShare(thin)).toBeGreaterThan(TUNE_PROPOSAL_SHARE);
    expect(tuneProposal(thin)).toBeNull();

    // One more settled alert, still over the line, and now it speaks.
    expect(
      tuneProposal(stat({ settled: TUNE_PROPOSAL_MIN_SETTLED, tuned: 3 })),
    ).not.toBeNull();
  });

  it("has nothing to say about a rule with no settled alerts, or no row at all", () => {
    expect(tuneProposal(stat({ fired: 4, settled: 0, tuned: 0 }))).toBeNull();
    expect(tuneProposal(null)).toBeNull();
    expect(tuneProposal(undefined)).toBeNull();
  });

  /**
   * The measured share is a FLOOR — one decision still covers every open firing
   * of a repeating condition — so a threshold on it UNDER-fires. That is the
   * direction to err in for a proposal that cannot apply itself: this rule has
   * two tunes the operator has already made sitting outside the denominator,
   * and the OS stays quiet rather than counting an answer twice.
   */
  it("reads the settled share only, never the tunes still open", () => {
    expect(tuneProposal(stat({ settled: 10, tuned: 3, tunedOpen: 4 }))).toBeNull();
  });
});
