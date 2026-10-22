// @vitest-environment node
import { describe, expect, it } from "vitest";
import { blockerImpact } from "@/lib/blocker-impact";
import { blockerProject as project, blockerTask as task } from "./blocker-impact-fixture";

function impact(tasks: ReturnType<typeof task>[]) {
  return blockerImpact([project(tasks)]);
}

const counts = (result: ReturnType<typeof blockerImpact>) => result.rows.map(row => [row.task.id, row.downstream, row.couldReady]);

describe("blocker impact", () => {
  it("counts chains and fan-out separately from immediately releasable work", () => {
    expect(counts(impact([task("ex-a"), task("ex-b", ["ex-a"]), task("ex-c", ["ex-b"]), task("ex-d", ["ex-a"])])))
      .toEqual([["ex-a", 3, 2], ["ex-b", 1, 1]]);
  });

  it("deduplicates diamonds and repeated edges, and requires every other blocker to close", () => {
    expect(counts(impact([task("ex-a"), task("ex-b", ["ex-a", "ex-a"]), task("ex-c", ["ex-a"]), task("ex-d", ["ex-b", "ex-c"])])))
      .toEqual([["ex-a", 3, 2], ["ex-b", 1, 0], ["ex-c", 1, 0]]);
    expect(counts(impact([task("ex-a"), task("ex-b"), task("ex-c", ["ex-a", "ex-b"])])))
      .toEqual([["ex-a", 1, 0], ["ex-b", 1, 0]]);
  });

  it("terminates cycles, excludes the root itself, and ignores self-only loops", () => {
    expect(counts(impact([task("ex-a", ["ex-b"]), task("ex-b", ["ex-a"]), task("ex-c", ["ex-b"]), task("ex-self", ["ex-self"])])))
      .toEqual([["ex-b", 2, 2], ["ex-a", 2, 1]]);
  });

  it("stops at closed work and counts parked work without treating it as ready", () => {
    const result = impact([task("ex-a", [], { status: "deferred" }), task("ex-parked", ["ex-a"], { status: "deferred" }),
      task("ex-done", ["ex-a"], { status: "closed" }), task("ex-after", ["ex-done"]),
      task("ex-active", ["ex-a"], { status: "in_progress" }), task("ex-open", ["ex-a"])]);
    expect(counts(result)).toEqual([["ex-a", 3, 1]]);
  });

  it("keeps human, choice, gate and deferred-time holds out of the readiness estimate", () => {
    const rows = [task("ex-a"), task("ex-gate", [], { issueType: "gate", awaitType: "human" }),
      task("ex-approval", ["ex-a", "ex-gate"]), task("ex-human", ["ex-a"], { labels: ["human"] }),
      task("ex-choice", ["ex-a"], { choices: { question: "Continue?", options: [{ key: "a", label: "Yes", recommended: true }, { key: "b", label: "No" }] }, choice: null }),
      task("ex-timed", ["ex-a"], { deferUntil: "2099-01-01T00:00:00Z" }),
      task("ex-ready", ["ex-a"], { ready: true }), task("ex-clear", ["ex-a"], { status: "blocked" })];
    expect(counts(impact(rows))).toEqual([["ex-a", 6, 1], ["ex-gate", 1, 0]]);
    expect(counts(impact([task("ex-gate", [], { issueType: "gate", awaitType: "human" }), task("ex-child", ["ex-gate"])])))
      .toEqual([["ex-gate", 1, 1]]);
  });

  it("traverses gates without counting approvals as downstream work", () => {
    expect(counts(impact([task("ex-a"), task("ex-gate", ["ex-a"], { issueType: "gate", awaitType: "human" }), task("ex-b", ["ex-gate"])])))
      .toEqual([["ex-gate", 1, 1], ["ex-a", 1, 0]]);
  });

  it("uses all blocking relationship types and ignores parents and unrelated links", () => {
    const edges = ["blocks", "waits-for", "conditional-blocks", "parent-child", "discovered-from", "relates-to"];
    const rows = [task("ex-a"), ...edges.map((type, index) => task(`ex-${index}`, [], {
      dependencies: [{ id: "ex-a", type, title: null, status: null }],
    })), task("ex-parent", [], { parent: "ex-a" }), task("ex-epic", ["ex-a"], { issueType: "epic" })];
    expect(counts(impact(rows))).toEqual([["ex-a", 3, 3]]);
  });

  it("retains unknown targets as blockers and honors embedded closed status only without a row", () => {
    const missing = task("ex-b", ["ex-a", "ex-missing"]);
    expect(counts(impact([task("ex-a"), missing]))).toEqual([["ex-a", 1, 0]]);
    expect(impact([task("ex-a"), missing]).partial).toBe(true);
    missing.dependencies![1]!.status = "closed";
    expect(counts(impact([task("ex-a"), missing]))).toEqual([["ex-a", 1, 1]]);
    expect(impact([task("ex-a"), missing]).partial).toBe(false);
    expect(counts(impact([task("ex-a"), task("ex-missing"), missing]))).toEqual([["ex-a", 1, 0], ["ex-missing", 1, 0]]);
  });

  it("never joins identical ids across projects and orders ties deterministically", () => {
    const a = project([task("ex-a"), task("ex-b", ["ex-a"])], { asset: "a" });
    const b = project([task("ex-a"), task("ex-b", ["ex-a"]), task("ex-c", ["ex-b"])], { asset: "b" });
    expect(blockerImpact([a, b]).rows.map(row => [row.project.asset, row.task.id, row.downstream]))
      .toEqual([["b", "ex-a", 2], ["a", "ex-a", 1], ["b", "ex-b", 1]]);
    expect(blockerImpact([project([task("ex-b", ["ex-a"])], { asset: "a" }), project([task("ex-a")], { asset: "b" })]).rows).toEqual([]);
    expect(blockerImpact([b, a])).toEqual(blockerImpact([a, b]));
  });

  it("qualifies saved, failed, unavailable and legacy reads without guessing human readiness", () => {
    const tasks = [task("ex-a"), task("ex-b", ["ex-a"])];
    for (const overrides of [{ source: "snapshot" as const }, { source: "unavailable" as const, tasks: [] }, { laneError: "Refresh failed" }]) {
      const result = blockerImpact([project(tasks, overrides)]);
      expect(result.partial).toBe(true);
      for (const row of result.rows) expect(row.couldReady).toBeNull();
    }
    expect(impact([task("ex-old", [], { dependencies: undefined })]).partial).toBe(true);
    expect(blockerImpact([])).toEqual({ rows: [], partial: true });
    expect(blockerImpact([project([])])).toEqual({ rows: [], partial: false });
  });

  it("handles a 1,000-node chain with a cycle without recursive or repeated-node traversal", () => {
    const nodes = Array.from({ length: 1000 }, (_, index) => task(`ex-${index}`, index ? [`ex-${index - 1}`] : []));
    nodes[0]!.dependencies = [{ id: "ex-999", type: "blocks", title: null, status: null }];
    const started = performance.now();
    const result = impact(nodes);
    expect(result.rows).toHaveLength(1000);
    expect(result.rows.every(row => row.downstream === 999 && row.couldReady === 1)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
