// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NO_READS } from "@shared/connection-status";
import type { WallAttentionTasks } from "@shared/wall";
import { attentionTickerItems, portfolioIssues } from "@/lib/attention-ticker";
import { wallIssues, type WallIssue } from "@/lib/wall-issues";
import { withSystemIssues } from "@/lib/wall-system-state";
import { wallOnTv } from "@/lib/wall-widgets";
import { wallFixturePayload, WALL_FIXTURE_NOW } from "../e2e/wall-fixture";

const nowMs = Date.parse(WALL_FIXTURE_NOW);
const fixture = wallFixturePayload("four");
const task = (id: string, over: Partial<WallAttentionTasks['items'][number]> = {}): WallAttentionTasks['items'][number] => ({ id, title: `Task ${id}`, asset: fixture.assets[0]!.id, priority: 1, ask: null, updatedAt: WALL_FIXTURE_NOW, ...over });
const tasks = (items: WallAttentionTasks['items'] = []): WallAttentionTasks => ({ items, capturedAt: WALL_FIXTURE_NOW, measuredProjects: 1, projectCount: 1 });
const issue = (index: number, over: Partial<WallIssue> = {}): WallIssue => ({ key: `test-${index}`, severity: "warn", assets: [fixture.assets[0]!.id], site: fixture.assets[0]!.displayName, line: `Problem ${index}`, mark: "Problem", since: WALL_FIXTURE_NOW, conditions: ["open-flags"], ...over });

describe("portfolio attention shared by Home and the Wall", () => {
  it("keeps the exact canonical Home problems including a TV-hidden asset", () => {
    const assets = fixture.assets;
    const hidden = assets[0]!;
    const tvPayload = { ...fixture, dashboard: { ...fixture.dashboard, sites: { [hidden.id]: { tv: false } } } };
    expect(wallOnTv(tvPayload).data.assets.some(asset => asset.id === hidden.id)).toBe(false);
    const input = { assets, attention: fixture.attention, connections: NO_READS, nowMs };
    const expected = withSystemIssues(wallIssues(input), fixture.system, nowMs);
    const actual = portfolioIssues({ ...input, system: fixture.system });
    expect(actual).toEqual(expected);
    expect(actual.some(row => row.assets.includes(hidden.id))).toBe(true);
    const rows = attentionTickerItems({ issues: actual, assets, nowMs });
    expect(rows.items.filter(row => row.kind === "problem").map(row => row.id)).toEqual(expected.map(row => `problem:${row.key}`));
  });

  it("includes every problem and task beyond previous caps with stable deduplication", () => {
    const problems = Array.from({ length: 15 }, (_, index) => issue(index));
    const inputTasks = Array.from({ length: 30 }, (_, index) => task(`task-${index}`));
    const result = attentionTickerItems({ issues: [...problems, problems[0]!], tasks: tasks([...inputTasks, inputTasks[0]!]), assets: fixture.assets, nowMs });
    expect(result.items).toHaveLength(45);
    expect(result.items.some(row => row.id === "task:task-29")).toBe(true);
    expect(result.items.some(row => row.id === "problem:test-14")).toBe(true);
    expect(result.taskStatus).toBe("ready");
  });

  it("suppresses a task represented by a problem and preserves severity, destinations and asset names", () => {
    const result = attentionTickerItems({ issues: [issue(1, { task: "review-1", severity: "error" })], tasks: tasks([task("review-1"), task("urgent-0", { priority: 0 }), task("approval", { priority: 4, ask: "approve", asset: "unknown.example" }), task("ordinary", { priority: 2 })]), assets: fixture.assets, nowMs });
    expect(result.items.map(row => row.id)).toEqual(["problem:test-1", "task:urgent-0", "task:approval"]);
    expect(result.items[0]).toMatchObject({ href: `/tasks/review-1?project=${encodeURIComponent(fixture.assets[0]!.id)}`, severity: "error", title: "Problem 1" });
    expect(result.items[1]).toMatchObject({ severity: "error", assetName: fixture.assets[0]!.displayName });
    expect(result.items[2]).toMatchObject({ title: "Approve: Task approval", assetName: "unknown.example", severity: "warn", conditions: ["human-gates"], href: "/tasks/approval?project=unknown.example" });
  });

  it("keeps stale and partial rows visible while marking unknown coverage honestly", () => {
    const build = (value?: WallAttentionTasks | null) => attentionTickerItems({ issues: [], tasks: value, assets: fixture.assets, nowMs });
    expect(build().taskStatus).toBe("unavailable");
    expect(build({ ...tasks(), capturedAt: null }).taskStatus).toBe("unavailable");
    expect(build({ ...tasks(), capturedAt: "invalid" }).taskStatus).toBe("unavailable");
    expect(build({ ...tasks([task("known")]), measuredProjects: 0 }).taskStatus).toBe("partial");
    const old = build({ ...tasks([task("old")]), capturedAt: new Date(nowMs - 10 * 60_000).toISOString() });
    expect(old.taskStatus).toBe("stale");
    expect(old.items.map(row => row.id)).toEqual(["task:old"]);
    expect(build({ ...tasks(), measuredProjects: 0, projectCount: 2 }).taskStatus).toBe("partial");
  });

  it("omits archived assets' tasks while retaining system and TV-hidden tasks", () => {
    const archived = { ...fixture.assets[0]!, status: "retired" };
    const result = attentionTickerItems({ issues: [], tasks: tasks([task("archived"), task("system", { asset: "root-os" }), task("hidden", { asset: fixture.assets[1]!.id })]), assets: [archived, fixture.assets[1]!], nowMs });
    expect(result.items.map(item => item.id)).toEqual(["task:hidden", "task:system"]);
  });
});
