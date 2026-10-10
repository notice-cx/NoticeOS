// The Wall's live feed column.
import { act, render, screen, within } from "./render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WallFeed, feedClock } from "@/components/wall/WallFeed";
import { WALL_FEED_ARRIVAL_GAP_MS, WALL_FEED_TINT_MS, WALL_FEED_TV_ROWS, type WallFeedItem, type WallFeedPayload } from "@shared/wall-feed";

/** 12:30 local time on Tuesday 22 September. */
const NOW = new Date(2026, 8, 22, 12, 30).getTime();
const MINUTE = 60_000;

function item(id: string, minutesAgo: number, extra: Partial<WallFeedItem> = {}): WallFeedItem {
  return {
    id,
    at: new Date(NOW - minutesAgo * MINUTE).toISOString(),
    kind: "task-done",
    label: "Task done",
    asset: "recipes.example.com",
    site: "Recipes",
    text: `Line ${id}`,
    count: 1,
    tone: "healthy",
    ...extra,
  };
}

function payload(items: WallFeedItem[]): WallFeedPayload {
  return { generatedAt: new Date(NOW).toISOString(), since: new Date(NOW - 18 * 60 * MINUTE).toISOString(), items, limit: 50 };
}

const rows = () => screen.getAllByRole("listitem").map((row) => within(row).getByText(/^Line /).textContent);

function reducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matches && query.includes("reduce"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  reducedMotion(false);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the feed column", () => {
  it("draws the rows newest first, one line each: kind, site, sentence, clock time", () => {
    render(<WallFeed feed={payload([item("a", 6), item("b", 20, { kind: "alert", label: "Alert", tone: "warn" })])} nowMs={NOW} />);
    expect(rows()).toEqual(["Line a", "Line b"]);
    const first = screen.getAllByRole("listitem")[0]!;
    expect(first).toHaveTextContent("Task done");
    expect(first).toHaveTextContent("· Recipes");
    expect(within(first).getByText("12:24")).toHaveAttribute("datetime", item("a", 6).at);
    expect(screen.getByText("since last night")).toBeInTheDocument();
    // The first payload is what the room walked in on: nothing arrives.
    expect(document.querySelectorAll("[data-feed-arrived]")).toHaveLength(0);
  });

  it("a new row slides in at the top with its tone's tint, which fades and is gone after two minutes", () => {
    const { rerender } = render(<WallFeed feed={payload([item("a", 6)])} nowMs={NOW} />);
    rerender(<WallFeed feed={payload([item("new", 0, { tone: "error", kind: "source-failed", label: "Source failed" }), item("a", 6)])} nowMs={NOW} />);
    expect(rows()).toEqual(["Line new", "Line a"]);
    const arrived = screen.getAllByRole("listitem")[0]!;
    expect(arrived).toHaveAttribute("data-feed-arrived");
    expect(arrived).toHaveClass("wall-feed-arrive");
    const tint = arrived.querySelector("[data-feed-tint]");
    expect(tint).toHaveClass("wall-feed-tint", "bg-error/10");
    act(() => vi.advanceTimersByTime(WALL_FEED_TINT_MS - 1_000));
    expect(arrived.querySelector("[data-feed-tint]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_000));
    expect(arrived.querySelector("[data-feed-tint]")).toBeNull();
    expect(arrived).not.toHaveAttribute("data-feed-arrived");
  });

  it("under reduced motion a new row is inserted without sliding, and still tinted", () => {
    reducedMotion(true);
    const { rerender } = render(<WallFeed feed={payload([item("a", 6)])} nowMs={NOW} />);
    rerender(<WallFeed feed={payload([item("new", 0), item("a", 6)])} nowMs={NOW} />);
    const arrived = screen.getAllByRole("listitem")[0]!;
    expect(arrived).toHaveAttribute("data-feed-arrived");
    expect(arrived).not.toHaveClass("wall-feed-arrive");
    expect(arrived.querySelector("[data-feed-tint]")).not.toBeNull();
  });

  it("a burst arrives one row every two seconds, oldest first, so the newest lands on top", () => {
    const { rerender } = render(<WallFeed feed={payload([item("a", 6)])} nowMs={NOW} />);
    rerender(<WallFeed feed={payload([item("c", 0), item("b", 1), item("a", 6)])} nowMs={NOW} />);
    expect(rows()).toEqual(["Line b", "Line a"]);
    act(() => vi.advanceTimersByTime(WALL_FEED_ARRIVAL_GAP_MS - 1));
    expect(rows()).toEqual(["Line b", "Line a"]);
    act(() => vi.advanceTimersByTime(1));
    expect(rows()).toEqual(["Line c", "Line b", "Line a"]);
  });

  it("drops a row older than twelve hours to muted ink, and reads yesterday's time with its half of the day", () => {
    render(<WallFeed feed={payload([item("fresh", 60), item("old", 13 * 60)])} nowMs={NOW} />);
    const [fresh, old] = screen.getAllByRole("listitem");
    expect(fresh).not.toHaveAttribute("data-feed-aged");
    expect(within(fresh!).getByText("Line fresh")).toHaveClass("text-foreground");
    expect(old).toHaveAttribute("data-feed-aged");
    expect(within(old!).getByText("Line old")).toHaveClass("text-muted-foreground");
    expect(within(old!).getByText("11:30p")).toBeInTheDocument();
  });

  it("a failed poll keeps the rows, dims the live dot and says Reconnecting", () => {
    const feed = payload([item("a", 6)]);
    const { rerender } = render(<WallFeed feed={feed} nowMs={NOW} />);
    expect(document.querySelector("[data-feed-live-dot]")).toHaveClass("bg-healthy");
    rerender(<WallFeed feed={feed} failed nowMs={NOW} />);
    expect(rows()).toEqual(["Line a"]);
    expect(screen.getByText("Reconnecting")).toBeInTheDocument();
    expect(document.querySelector("[data-feed-live-dot]")).toHaveClass("bg-muted-foreground");
    expect(document.querySelector("[data-wall-feed]")).toHaveAttribute("data-feed-state", "reconnecting");
  });

  it("an empty window says so, and a first read that failed never claims nothing happened", () => {
    const { rerender } = render(<WallFeed feed={payload([])} nowMs={NOW} />);
    expect(screen.getByText("Nothing new since last night")).toBeInTheDocument();
    rerender(<WallFeed feed={undefined} failed nowMs={NOW} />);
    expect(screen.queryByText("Nothing new since last night")).toBeNull();
    expect(screen.getByText("Reconnecting")).toBeInTheDocument();
  });

  it("never draws a partial row: a row the column would cut is hidden", () => {
    const rect = (bottom: number) => ({ bottom, top: bottom - 80, left: 0, right: 400, width: 400, height: 80, x: 0, y: bottom - 80, toJSON() {} }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "OL") return rect(300);
      const index = [...(this.parentElement?.children ?? [])].indexOf(this);
      return rect(100 * (index + 1) + (index === 2 ? 10 : 0));
    });
    render(<WallFeed feed={payload([item("a", 1), item("b", 2), item("c", 3), item("d", 4)])} nowMs={NOW} />);
    const all = screen.getAllByRole("listitem", { hidden: true });
    expect(all.map((row) => row.hasAttribute("data-feed-cut"))).toEqual([false, false, true, true]);
    expect(all[2]).toHaveClass("invisible");
    expect(all[2]).toHaveAttribute("aria-hidden", "true");
    spy.mockRestore();
  });

  // In one column (a portrait tablet, a phone) the feed lists the rows the TV
  // shows and no more, newest first. The TV's own column keeps fitting whole
  // rows by measure.
  it("in one column lists the TV's twelve newest rows and hides the rest", () => {
    const items = Array.from({ length: WALL_FEED_TV_ROWS + 5 }, (_, i) => item(`r${i}`, i + 1));
    render(<WallFeed feed={payload(items)} nowMs={NOW} />);
    const all = screen.getAllByRole("listitem", { hidden: true });
    expect(all).toHaveLength(WALL_FEED_TV_ROWS + 5);
    const past = all.filter((row) => row.hasAttribute("data-feed-past-tv"));
    expect(past.map((row) => within(row).getByText(/^Line /).textContent)).toEqual(items.slice(WALL_FEED_TV_ROWS).map((i) => `Line ${i.id}`));
    for (const row of past) expect(row).toHaveClass("stack:hidden");
    for (const row of all.slice(0, WALL_FEED_TV_ROWS)) expect(row).not.toHaveClass("stack:hidden");
  });
});

describe("feedClock", () => {
  it("reads today as a clock time and yesterday with its half of the day", () => {
    expect(feedClock(new Date(2026, 8, 22, 12, 24).getTime(), NOW)).toBe("12:24");
    expect(feedClock(new Date(2026, 8, 22, 9, 5).getTime(), NOW)).toBe("9:05");
    expect(feedClock(new Date(2026, 8, 21, 19, 40).getTime(), NOW)).toBe("7:40p");
    expect(feedClock(new Date(2026, 8, 21, 6, 40).getTime(), NOW)).toBe("6:40a");
  });
});
