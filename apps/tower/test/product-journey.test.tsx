import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ProductSnapshot } from "@shared/asset-detail";
import {
  dailyMean,
  dailyTotal,
  funnelDropMovement,
  productConnection,
  productIssueGroups,
  productIssues,
  segmentHeadline,
  segmentRating,
} from "@shared/product";
import { parseProductSnapshot } from "@shared/product-snapshot";
import { ProductJourney } from "@/components/ProductJourney";
import posthogProductJson from "@/routes/kitchen-sink/posthog-product.json";

// The Growth tab's Product section, rendered from the block
// `scripts/signal-insights.mjs` really emits for the PostHog acceptance read.

const PRODUCT: ProductSnapshot = parseProductSnapshot(posthogProductJson)!;

function renderJourney(product: ProductSnapshot | null, connection: "connected" | "not-connected" | "off" = "connected") {
  return render(
    <MemoryRouter>
      <ProductJourney product={product} connection={connection} />
    </MemoryRouter>,
  );
}

describe("shared/product — the section's arithmetic", () => {
  it("reads the connection off the asset's integration rows", () => {
    const lane = (effective: "live" | "degraded" | "needs-setup" | "skipped" | "not-applicable") => [
      { catalog: { id: "posthog" }, cell: { effective } },
    ];
    expect(productConnection([])).toBe("not-connected");
    expect(productConnection([{ catalog: { id: "clarity" }, cell: { effective: "live" as const } }])).toBe("not-connected");
    expect(productConnection(lane("live"))).toBe("connected");
    expect(productConnection(lane("degraded"))).toBe("connected");
    expect(productConnection(lane("needs-setup"))).toBe("not-connected");
    expect(productConnection(lane("skipped"))).toBe("off");
    expect(productConnection(lane("not-applicable"))).toBe("off");
  });

  it("interleaves the kinds so the first three rows are three different places, noise last", () => {
    const issues = productIssues(PRODUCT);
    expect(issues.slice(0, 4).map((issue) => issue.kind)).toEqual(["speed", "rage", "error", "once"]);
    expect(issues.at(-1)?.kind).toBe("noise");
    const speed = issues.filter((issue) => issue.kind === "speed");
    expect(speed.map((issue) => issue.severity)).toEqual(["error", "warn", "warn"]);
    expect(speed).toHaveLength(3);
  });

  it("groups findings by page, worst group first, an unplaced error under the whole site and noise last", () => {
    const groups = productIssueGroups(PRODUCT);
    expect(groups.map((group) => group.key)).toEqual(["page:/calculator", "page:/", "site", "page:/my", "third-party"]);
    expect(groups[0]!.severity).toBe("error");
    expect(groups[0]!.issues[0]!.severity).toBe("error");
    expect(groups.flatMap((group) => group.issues)).toHaveLength(productIssues(PRODUCT).length);
    const unplaced = productIssueGroups({
      ...PRODUCT,
      exceptions: { ...PRODUCT.exceptions!, top: PRODUCT.exceptions!.top.map((row) => ({ ...row, topPath: null })) },
    });
    const site = unplaced.find((group) => group.key === "site")!;
    expect(site.issues.map((issue) => issue.kind)).toEqual(["error", "once", "error", "error"]);
    expect(unplaced.at(-1)!.key).toBe("third-party");
  });

  it("rates a segment by the worse of LCP and INP, and headlines the metric furthest past its line", () => {
    const [chromeOs] = PRODUCT.vitals!.segments;
    expect(segmentRating(chromeOs!)).toBe("poor");
    expect(segmentHeadline(chromeOs!, PRODUCT.vitals!.lines)).toEqual({ metric: "INP", value: 744 });
  });

  it("never averages or totals fewer than three reported days, and skips the gaps", () => {
    expect(dailyMean([10, null, 20])).toBeNull();
    expect(dailyMean([10, null, 20, 30])).toBe(20);
    expect(dailyTotal([1, 2])).toBeNull();
    expect(dailyTotal([1, 2, null, 3])).toBe(6);
  });

  it("states the largest drop's movement in points only when the earlier read exists", () => {
    const [calculator] = PRODUCT.funnels;
    expect(funnelDropMovement(calculator!)).toBeCloseTo((1_232 / 15_394 - 1_470 / 14_700) * 100, 6);
    expect(funnelDropMovement({ ...calculator!, prior: null })).toBeNull();
  });
});

describe("ProductJourney", () => {
  it("answers the question in one strip, one funnel and three rows", () => {
    const { container } = renderJourney(PRODUCT);
    const section = container.querySelector("[data-product-journey]")!;
    expect(within(section as HTMLElement).getByRole("heading", { name: "Product" })).toBeInTheDocument();
    expect(section.textContent).toContain("PostHog · daily Aug 26–Sep 22, 2026");

    expect(section.textContent).toContain("People a day");
    expect(section.textContent).toContain("daily average, 28 days");
    expect(section.textContent.match(/Aug 26–Sep 22, 2026/g)).toHaveLength(1);
    for (const name of ["People a day trend", "Page views trend", "Sessions trend"]) {
      expect(within(section as HTMLElement).getByRole("img", { name })).toBeInTheDocument();
    }

    const funnel = container.querySelector('[data-product-funnel="calculator"]')!;
    expect(funnel.querySelectorAll("[data-funnel-step]")).toHaveLength(4);
    expect(funnel.querySelectorAll('[role="progressbar"]')).toHaveLength(4);
    expect(funnel.querySelector("[data-funnel-conversion]")!.textContent).toBe("6.5% finish · 8.2% the week before");
    const drop = funnel.querySelector("[data-largest-drop]")!;
    // The marker rides the step's name; its percentage stays a plain share,
    // so "▼ 8%" can never read as "down 8%".
    expect(drop.textContent).toContain("▼ plan_saved");
    expect(drop.textContent).toContain("8%");
    expect(drop.textContent).not.toContain("▼ 8%");
    expect(funnel.textContent).toContain("Largest drop: 14,162 people stop before plan_saved");
    expect(funnel.textContent).toContain("vs the week before");

    // Where it breaks, grouped by page: closed, the worst finding of each of
    // the three worst places.
    const list = screen.getByRole("region", { name: "Where it breaks" });
    const groupsOf = () =>
      Array.from(list.querySelectorAll("[data-list-group]")).map((group) => ({
        place: group.getAttribute("data-product-group"),
        heading: group.querySelector("h3")!.textContent,
        rows: Array.from(group.querySelectorAll("[data-product-issue]")).map((row) => row.getAttribute("data-product-issue")),
      }));
    expect(groupsOf()).toEqual([
      { place: "/calculator", heading: "/calculator 6 found", rows: ["speed"] },
      { place: "/", heading: "/ 2 found", rows: ["error"] },
      { place: "site", heading: "Whole site 1 found", rows: ["once"] },
    ]);
    expect(list.textContent).toContain("Chrome OS Desktop");
    expect(list.textContent).not.toContain("/calculator · Chrome OS Desktop");
    expect(list.textContent).toContain("744 ms");
    expect(list.textContent).toContain("Error: Script error.");
    const issues = productIssues(PRODUCT).length;
    expect(list.textContent).toContain(`${issues} found · Sep 8–22, 2026`);
    fireEvent.click(within(list).getByRole("button", { name: `Show ${issues - 3} more` }));
    expect(list.querySelectorAll("[data-product-issue]")).toHaveLength(issues);
    expect(groupsOf()).toEqual([
      { place: "/calculator", heading: "/calculator 6 found", rows: ["speed", "rage", "speed", "rage", "error", "rage"] },
      { place: "/", heading: "/ 2 found", rows: ["error", "speed"] },
      { place: "site", heading: "Whole site 1 found", rows: ["once"] },
      { place: "/my", heading: "/my 1 found", rows: ["error"] },
      { place: "third-party", heading: "Probably third-party 1 found", rows: ["noise"] },
    ]);
    expect(list.textContent).toContain("heightFeet input");
    expect(list.textContent).not.toContain("/calculator · heightFeet input");
    expect(list.textContent).toContain("40,975 of 48,640 errors");
    expect(list.textContent).toContain("first_meal_logged fires 3.0× per person");

    expect(container.querySelector("[data-product-checks]")).toBeNull();
    expect(section.querySelectorAll(".tabular-nums").length).toBeGreaterThan(10);
  });

  it("wraps a row's caption instead of cutting off the figure it carries", () => {
    renderJourney(PRODUCT);
    const list = screen.getByRole("region", { name: "Where it breaks" });
    fireEvent.click(within(list).getByRole("button", { name: /^Show \d+ more$/ }));
    const caption = within(list).getByText("Rage clicks · 1,493 of 18,826 visitors");
    expect(caption.className).toContain("whitespace-normal");
    expect(caption.className).not.toContain("truncate");
  });

  it("shows a speed row's ratings in words and a glyph, never colour alone", () => {
    renderJourney(PRODUCT);
    const list = screen.getByRole("region", { name: "Where it breaks" });
    fireEvent.click(within(list).getByRole("button", { name: /Chrome OS Desktop/ }));
    expect(list.textContent).toContain("LCP 3,844 ms · Needs improvement");
    expect(list.textContent).toContain("INP 744 ms · Poor");
    expect(list.textContent).toContain("CLS 0.02 · Good");
    expect(within(list).getByText(/INP 744 ms/).closest("[title]")!.getAttribute("title")).toBe(
      "INP p75 · good ≤ 200 ms · poor > 500 ms",
    );
    expect(list.textContent!.match(/22,298 measurements/g)).toHaveLength(1);
  });

  it("opens a row onto labelled facts and a state, never a paragraph", () => {
    renderJourney(PRODUCT);
    const list = screen.getByRole("region", { name: "Where it breaks" });
    fireEvent.click(within(list).getByRole("button", { name: "Show 8 more" }));
    fireEvent.click(within(list).getByRole("button", { name: /heightFeet input/ }));
    const rage = list.querySelector('[data-product-issue="rage"] [data-product-facts]')!;
    expect(within(rage as HTMLElement).getByText("Repeat clicks")).toBeInTheDocument();
    expect(within(rage as HTMLElement).getByText("Flag line")).toBeInTheDocument();
    expect(rage.textContent).toContain("5% of visitors");

    fireEvent.click(within(list).getByRole("button", { name: /Script error/ }));
    const error = within(list).getByRole("button", { name: /Script error/ }).closest("[data-product-issue]")!;
    expect(error.querySelector("[data-error-origin]")).not.toBeNull();
    expect(within(error as HTMLElement).getByText("Most in one session")).toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: /first_meal_logged/ }));
    const once = list.querySelector('[data-product-issue="once"]')!;
    expect(once.textContent).toContain("3.0× too high");
    expect(once.querySelector("[data-product-next-step]")!.textContent).toBe("Check where the site sends it");

    fireEvent.click(within(list).getByRole("button", { name: /Load failed/ }));
    const noise = list.querySelector('[data-product-issue="noise"]')!;
    expect(noise.querySelector("[data-error-origin]")!.getAttribute("data-error-origin")).toBe("none");
    for (const node of list.querySelectorAll("[data-list-row-body] *")) {
      const own = [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent).join("");
      expect(own.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(12);
    }
  });

  it("names every rule that found nothing, and why, instead of reading as healthy", () => {
    const thin: ProductSnapshot = {
      ...PRODUCT,
      vitals: { ...PRODUCT.vitals!, segments: [], unmeasuredSegments: 6 },
      rageClicks: { ...PRODUCT.rageClicks!, clusters: [] },
      exceptions: null,
      onceEvents: [],
      checks: [
        { key: "posthog-slow-segment", label: "Real-visitor speed", state: "not-enough-data", detail: "No device and system segment on a top page reached 500 measurements." },
        { key: "posthog-rage-click-cluster", label: "Rage clicks", state: "clear", detail: "No element drew rage clicks from more than 5% of its page’s visitors." },
        { key: "posthog-error-concentration", label: "Errors", state: "not-collected", detail: "No PostHog exceptions read has been collected yet." },
      ],
    };
    const { container } = renderJourney(thin);
    const checks = container.querySelector("[data-product-checks]")!;
    expect(checks.textContent).toContain("Real-visitor speed: not enough data");
    expect(checks.textContent).toContain("Rage clicks: clear");
    expect(checks.textContent).toContain("Errors: not collected");
    expect(screen.getByRole("region", { name: "Where it breaks" }).textContent).toContain("Nothing broke in what could be checked — see below.");
  });

  it("draws a dash, never a zero, for a part PostHog did not send", () => {
    const { container } = renderJourney({ ...PRODUCT, webDaily: null, funnels: [] });
    const section = container.querySelector("[data-product-journey]")!;
    expect(section.textContent).toContain("not collected");
    expect(section.textContent).toContain("No funnel has been collected yet.");
    expect(section.textContent).not.toMatch(/People a day0/);
    expect(section.textContent).toContain("—");
  });

  it("says quietly why there is no product section, per connection state", () => {
    const say = (connection: "connected" | "not-connected" | "off") => {
      const { container, unmount } = renderJourney(null, connection);
      const text = container.querySelector("[data-product-empty]")?.textContent ?? "";
      unmount();
      return text;
    };
    expect(say("connected")).toContain("Connected · the first product read has not been collected yet.");
    expect(say("not-connected")).toContain("Product data is not connected for this site.");
    expect(say("off")).toContain("Product data is not collected for this site.");
  });

  it("needs no explainer: no About and no header tooltip", () => {
    const { container } = renderJourney(PRODUCT);
    const section = container.querySelector("[data-product-journey]")!;
    expect(section.querySelector("[data-about]")).toBeNull();
    const header = within(section as HTMLElement).getByRole("heading", { name: "Product" }).parentElement!;
    expect(header.querySelector("[data-info-tooltip-trigger]")).toBeNull();
    expect(section.textContent).not.toContain("read Sep 22");
    const { container: later } = renderJourney({ ...PRODUCT, observedAt: "2026-09-23" });
    expect(later.textContent).toContain("PostHog · daily Aug 26–Sep 22, 2026 · read Sep 23, 2026");
  });
});
