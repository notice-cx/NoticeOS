import { render, screen, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { WorkflowRun, WorkflowsPayload } from "@shared/workflows";
import { jobRunWeek, localDate, runWeekTally } from "@/lib/health-job-runs";
import { JobRunGrid } from "@/routes/health/JobRunGrid";

// A week of System jobs, one cell per day on the reader's own clock. Every
// time here is local, so the days are the same in any test timezone.

const NOW = new Date(2026, 8, 22, 12, 30).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();

function run(job: string, startedAt: string, state: WorkflowRun["state"] = "succeeded"): WorkflowRun {
  return { id: `${job}@${startedAt}`, workflowId: job, definitionVersion: 1, startedAt, finishedAt: startedAt, state, steps: null };
}

/** Newest first, as the read hands them over. */
const newestFirst = (runs: WorkflowRun[]) => [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

function payload(runs: Record<string, WorkflowRun[]>, jobs: { id: string; cron: string; enabled?: boolean }[] = []): WorkflowsPayload {
  return {
    generatedAt: new Date(NOW).toISOString(), overrides: null, runtimeFresh: true, historyAvailable: true, observationsFresh: true, selectedRun: null,
    runtime: { updatedAt: new Date(NOW).toISOString(), error: null, jobs: jobs.map((job) => ({ id: job.id, cron: job.cron, enabled: job.enabled ?? true, nextRun: null })) },
    workflows: Object.entries(runs).map(([id, own]) => ({ id, active: null, history: [], runs: newestFirst(own), latest: newestFirst(own)[0] ?? null })),
  };
}

/** A daily backup at 04:00 for the thirty days to today: it failed on the
 * 20th and did not run on the 18th. */
function backups(): WorkflowRun[] {
  const runs: WorkflowRun[] = [];
  for (let day = 22; day > 22 - 30; day -= 1) {
    if (day === 18) continue;
    runs.push(run("backup", at(day, 4), day === 20 ? "failed" : "succeeded"));
  }
  return runs.slice(0, 29);
}

/** Counters every fifteen minutes: the read keeps its newest thirty, the
 * last seven and a half hours. */
function counters(): WorkflowRun[] {
  return Array.from({ length: 30 }, (_, index) => run("counters", new Date(NOW - (index + 1) * 15 * 60_000).toISOString()));
}

const row = (week: ReturnType<typeof jobRunWeek>, id: string) => week.rows.find((candidate) => candidate.id === id)!;
const states = (week: ReturnType<typeof jobRunWeek>, id: string) => row(week, id).days.map((day) => day.state);

describe("a week of scheduled runs", () => {
  it("draws the seven days ending today, one row per System job and none for a Workflows job", () => {
    const week = jobRunWeek(payload({ backup: backups() }), NOW);
    expect(week.days).toEqual(["2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"]);
    expect(week.rows.map((candidate) => candidate.id)).toContain("backup");
    expect(week.rows.map((candidate) => candidate.id)).not.toContain("notifications");
  });

  it("marks a failed day, and a whole past day a daily job did not run, as missed", () => {
    const week = jobRunWeek(payload({ backup: backups() }, [{ id: "backup", cron: "0 4 * * *" }]), NOW);
    expect(states(week, "backup")).toEqual(["ran", "ran", "missed", "ran", "failed", "ran", "ran"]);
    const failed = row(week, "backup").days[4]!;
    expect(failed.runId).toBe(`backup@${at(20, 4)}`);
    expect(failed).toMatchObject({ failed: 1, ran: 0 });
  });

  it("says a frequent job's older days were not kept, never that it did not run", () => {
    const week = jobRunWeek(payload({ counters: counters() }), NOW);
    const own = row(week, "counters");
    expect(own.truncated).toBe(true);
    expect(own.days.slice(0, 6).every((day) => day.state === "not-kept")).toBe(true);
    expect(own.days[6]).toMatchObject({ state: "ran", ran: 30, partial: true, today: true });
  });

  it("owes a weekly job nothing on its days off, and a paused job nothing at all", () => {
    const mondays = [run("dataforseo", at(21, 12, 45)), run("dataforseo", at(14, 12, 45)), run("dataforseo", at(7, 12, 45))];
    const week = jobRunWeek(payload({ dataforseo: mondays, backup: backups().filter((entry) => !entry.startedAt.startsWith(at(21, 4).slice(0, 10))) }, [
      { id: "dataforseo", cron: "45 12 * * 1" },
      { id: "backup", cron: "0 4 * * *", enabled: false },
    ]), NOW);
    expect(states(week, "dataforseo")).toEqual(["none", "none", "none", "none", "none", "ran", "none"]);
    expect(row(week, "backup").paused).toBe(true);
    expect(states(week, "backup")).not.toContain("missed");
  });

  it("owes nothing before a job's first run, and nothing for the rest of today", () => {
    const fresh = [run("hygiene", at(20, 4)), run("hygiene", at(21, 4))];
    const week = jobRunWeek(payload({ hygiene: fresh }, [{ id: "hygiene", cron: "0 23 * * *" }]), NOW);
    expect(states(week, "hygiene")).toEqual(["none", "none", "none", "none", "ran", "ran", "none"]);
  });

  it("counts the week's runs, failures and missed days, and names the newest failure", () => {
    const tally = runWeekTally(jobRunWeek(payload({ backup: backups(), counters: counters() }, [{ id: "backup", cron: "0 4 * * *" }]), NOW));
    expect(tally).toMatchObject({ runs: 6 + 30, failed: 1, failedDays: 1, missed: 1 });
    expect(tally.latestFailure?.row.id).toBe("backup");
    expect(tally.latestFailure?.day.date).toBe("2026-09-20");
  });

  it("reads days on the reader's clock", () => {
    expect(localDate(new Date(2026, 8, 22, 0, 5).getTime())).toBe("2026-09-22");
    expect(localDate(new Date(2026, 8, 21, 23, 55).getTime())).toBe("2026-09-21");
  });
});

describe("the run grid", () => {
  const mount = (data: WorkflowsPayload | null, state: "ready" | "loading" | "unavailable" = "ready") =>
    render(
      <MemoryRouter>
        <JobRunGrid week={data ? jobRunWeek(data, NOW) : null} nowMs={NOW} state={state} />
      </MemoryRouter>,
    );

  it("names the newest failure over the grid and opens that run", () => {
    const { container } = mount(payload({ backup: backups(), counters: counters() }, [{ id: "backup", cron: "0 4 * * *" }]));
    const headline = container.querySelector("[data-job-runs-headline]")!;
    expect(headline).toHaveAttribute("data-job-runs-headline", "failed");
    expect(headline).toHaveTextContent("Backups failed Sep 20");
    expect(within(headline as HTMLElement).getByRole("link")).toHaveAttribute("href", `/health/operations/backup?run=${encodeURIComponent(`backup@${at(20, 4)}`)}`);
    expect(container.querySelector("[data-job-runs-tally]")).toHaveTextContent("36 runs · 1 failed · 1 missed day");
    // The week is named in words and printed under the last row.
    expect(screen.getByRole("table", { name: "Scheduled jobs, Sep 16 to Sep 22" })).toBeInTheDocument();
    expect(container.querySelector("[data-job-runs-dates]")).toHaveTextContent("Sep 16Sep 22");
  });

  it("lights the failed day in its job's row and says each day in words", () => {
    const { container } = mount(payload({ backup: backups() }, [{ id: "backup", cron: "0 4 * * *" }]));
    const failed = container.querySelector('[data-job-day="backup:2026-09-20"]')!;
    expect(failed).toHaveAttribute("data-state", "failed");
    expect(within(failed as HTMLElement).getByRole("link")).toHaveAccessibleName("Backups · Sep 20 · 1 failed");
    expect(screen.getByRole("img", { name: "Backups · Sep 18 · no run, one was due" })).toBeInTheDocument();
    expect(within(container.querySelector('[data-job-row="backup"]') as HTMLElement).getByRole("link", { name: "Backups" })).toHaveAttribute("href", "/health/operations/backup");
  });

  it("keys the hatching only when some job's older runs were not kept", () => {
    const kept = mount(payload({ backup: backups() }));
    expect(kept.container).not.toHaveTextContent("older runs not kept");
    kept.unmount();
    const cut = mount(payload({ counters: counters() }));
    expect(cut.container).toHaveTextContent("older runs not kept");
    expect(screen.getByRole("link", { name: /Live traffic and counters · today · 30 ran · earlier runs that day not kept/ })).toBeInTheDocument();
  });

  it("says plainly when nothing failed or was missed", () => {
    const { container } = mount(payload({ counters: counters() }));
    expect(container.querySelector("[data-job-runs-headline]")).toHaveTextContent("Nothing failed or missed");
  });

  it("names a run history it could not read, never an empty week", () => {
    const { container } = mount(null, "unavailable");
    expect(container.querySelector("[data-job-runs-empty]")).toHaveTextContent("Run history could not be read");
    expect(container.querySelector("[data-job-row]")).toBeNull();
  });
});
