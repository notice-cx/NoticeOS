import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertRuleStatsPayload } from "@shared/alert-rules";
import type { IntegrationsMatrix } from "@shared/integrations";
import type { SettingsPayload } from "@shared/settings";
import { configSaveReply } from "./config-save-reply";
import * as configDeclarations from "@shared/config-registers";
import type { AssetCard, WallPayload } from "@shared/wall";
import { emptyWorkHistory, type WorkItem, type WorkPayload } from "@shared/work";
import type { RuleBacktest } from "@noticeos/contract";

// /settings — the one page an operator opens to change something (bead
// `ro-pbzu.2`).
//
// What is asserted here is the promise the page makes: every section is
// present and reachable by its anchor, a Save writes the exact op the write
// lane expects (D18), a build that cannot write says so once and disables the
// fields, and every cap shows spend against a meter — a cap nothing could
// measure was withdrawn rather than rendered beside an empty bar (D6,
// bead `ro-uj7x`).
//
// Sonner is mocked because the toast is not the subject: the request the Save
// makes is.
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const state = vi.hoisted(() => ({
  settings: null as SettingsPayload | null,
  integrations: null as IntegrationsMatrix | null,
  writable: { writable: true, reason: null as string | null },
  /** The portfolio the alert-rule replay picks its asset from (bead `ro-w35m`).
   * Null is a page that has not read the Wall yet, which is what every test
   * that is not about the preview wants. */
  wall: null as WallPayload | null,
  /** What each rule has cost (bead `ro-ayxy`). Null is a read that has not
   * answered, and the record block then renders nothing at all — which is what
   * every test that is not about it wants. */
  ruleStats: null as AlertRuleStatsPayload | null,
  ruleStatsError: false,
  /** The task board, which is where the hourly reconciliation's finding reaches
   * this page (bead `ro-eb7z`). Null is a board that has not answered, and the
   * page then marks nothing — which is what every test that is not about it
   * wants. */
  work: null as WorkPayload | null,
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    data: state.settings,
    isPending: state.settings === null,
    isError: false,
  }),
}));

vi.mock("@/hooks/useIntegrations", () => ({
  useIntegrations: () => ({ data: state.integrations }),
}));

vi.mock("@/hooks/useConfigWritable", () => ({
  useConfigWritable: () => state.writable,
}));

vi.mock("@/hooks/useNow", () => ({
  useNow: () => Date.parse("2026-09-04T12:00:00.000Z"),
}));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({ data: state.wall }),
}));

vi.mock("@/hooks/useWork", () => ({
  useWork: () => ({ data: state.work ?? undefined }),
}));

vi.mock("@/hooks/useAlertRuleStats", () => ({
  useAlertRuleStats: () => ({
    data: state.ruleStats,
    isError: state.ruleStatsError,
  }),
}));

import { SettingsRoute } from "@/routes/SettingsRoute";
import { resetTaskSourceMock, taskSourceMock } from "./task-source-mock";

// A task source connected, as this installation's is (D32, bead
// ro-ujb9.143): the task screens here render exactly as before it existed.
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

const READ_ONLY_REASON =
  "This deployment has no filesystem: file-owned settings are read-only here. " +
  "Run the Tower with os:up to edit them, or edit the file and redeploy.";

function payload(overrides: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    generatedAt: "2026-09-04T12:00:00.000Z",
    clock: {
      owner: "config/constants.json",
      timeZone: "America/Los_Angeles",
      chosen: true,
    },
    dashboard: {
      countdown: {
        emoji: "🚀",
        label: "Launch day",
        targetAt: "2027-01-01T00:00:00.000Z",
      },
    },
    budget: {
      owner: "config/constants.json",
      knobs: [
        {
          key: "monthly_caps.data_usd",
          pointer: "/monthly_caps/data_usd",
          label: "Monthly data cap",
          jargon: "monthly_caps.data_usd",
          value: 25,
          unit: "usd",
        },
        {
          key: "operator_rate_usd_per_min",
          pointer: "/operator_rate_usd_per_min",
          label: "Value of your time",
          jargon: "operator_rate_usd_per_min",
          value: 2,
          unit: "usd_per_min",
        },
      ],
    },
    alertRules: {
      owner: "config/constants.json",
      knobs: [
        {
          key: "alpha",
          label: "Anomaly sensitivity",
          jargon: "alpha",
          value: "0.01",
          explain: "How unlikely a drop must be before an alert fires.",
          owner: "config/constants.json",
          pointer: "/flag_defaults/alpha",
          raw: 0.01,
        },
        {
          key: "min_baseline_per_day",
          label: "Minimum daily volume to test",
          jargon: "min_baseline_per_day",
          value: "3",
          explain: "Below this average a single day is too noisy to test.",
          owner: "config/constants.json",
          pointer: "/flag_defaults/min_baseline_per_day",
          raw: 3,
        },
        {
          key: "low_volume_window_hours",
          label: "Low-volume window",
          jargon: "low_volume_window_hours",
          value: "72",
          explain: "How much prior history the low-volume test needs on hand.",
          owner: "config/constants.json",
          pointer: "/flag_defaults/low_volume_window_hours",
          raw: 72,
        },
      ],
    },
    collection: {
      knobs: [
        { key: "panel-refresh-window", value: 35 },
        { key: "panel-freshness-bar", value: 7 },
      ],
      pullOwner: "config/pull.json",
      schedules: null,
      pullAssets: [
        { asset: "meals.example", url: "https://meals.example/api/internal/metrics", enabled: true },
        { asset: "nosh.example", url: "https://nosh.example/api/admin/overview", enabled: false },
      ],
    },
    sources: {
      owner: "config/integrations.json",
      rows: [
        { id: "ga4", label: "Google Analytics 4", scope: "property", layer: "provider", credential: "shared" },
        {
          id: "operator-notify",
          label: "Operator notifications",
          scope: "portfolio",
          layer: "os",
          credential: "per-property",
        },
      ],
    },
    entities: {
      owner: "config/entities.json",
      rows: [
        {
          slug: "reindex-ventures",
          name: "Reindex Ventures LLC",
          form: "LLC",
          jurisdiction: "US-DE",
          assets: ["meals.example"],
        },
      ],
    },
    taskHub: {
      owner: "config/beads.json",
      spokes: [
        { asset: "root-os", prefix: "ro", database: "ro", repo: "." },
        { asset: "meals.example", prefix: "mp", database: "mp", repo: "../meals.example" },
      ],
      hub: { host: "127.0.0.1", port: 3308, user: "root", dataDir: ".local/beads-dolt" },
    },
    ...overrides,
  };
}

/** The assets the OS knows, as the integrations matrix reports them — the only
 * source of "which asset ids exist" this page has. */
function assetRefs(...ids: string[]) {
  return ids.map((id) => ({ id, displayName: id, isOs: false }));
}

function matrix(
  spentUsd: number,
  period = "2026-09",
  assets: ReturnType<typeof assetRefs> = [],
  /** Data sources some asset has no entry for (bead `ro-qodp`). Empty is the
   * healthy state and what every test that is not about it wants. */
  undeclared: { laneId: string; label: string; assets: string[] }[] = [],
): IntegrationsMatrix {
  return {
    generatedAt: "2026-09-04T12:00:00.000Z",
    owner: "config/integrations.json",
    catalog: [],
    derivedLanes: [],
    assets,
    undeclared,
    cells: {},
    summary: {
      counts: { live: 0, degraded: 0, "needs-setup": 0, skipped: 0, "not-applicable": 0 },
      total: 0,
      needsAttention: 0,
    },
    sharedCredential: { lanes: 0, propertySetups: 0 },
    dataSpend: { period, spentUsd, capUsd: 25, byAsset: [] },
  } as unknown as IntegrationsMatrix;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** The write lane returns the same acknowledgement as the store-backed route. */
function stubFetch(reply?: { status: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url: String(input),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify(reply ? reply.body : configSaveReply(init)), {
        status: reply?.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

let initialSection = "clock";

function LocationState() {
  const { pathname, hash } = useLocation();
  return <output data-testid="settings-location">{pathname}{hash}</output>;
}

function pickSection(id: string) {
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  const link = within(nav).getAllByRole("link").find((link) => link.getAttribute("href") === `/settings#${id}`);
  expect(link).toBeDefined();
  fireEvent.click(link!);
}

function renderPage(section = initialSection) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[`/settings#${section}`]}>
        <SettingsRoute />
        <LocationState />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  initialSection = "clock";
  state.settings = payload();
  state.integrations = matrix(11.4);
  state.writable = { writable: true, reason: null };
  state.wall = null;
  state.ruleStats = null;
  state.ruleStatsError = false;
  state.work = null;
  toasts.success.mockReset();
  toasts.error.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/settings", () => {
  it("needs no section help: every section is a title, its fields and their state (ro-ujb9.96.6.3)", () => {
    const calls = stubFetch();
    const { container } = renderPage();
    for (const [section, title] of [
      ["general", "general"],
      ["alert-rules", "alert rules"],
      ["data-collection", "data collection"],
      ["tv-dashboard", "tv dashboard"],
      ["entities", "ownership"],
      ["task-hub", "task projects"],
    ]) {
      pickSection(section!);
      // No "About <section>" tooltip and no description paragraph under the
      // title: what used to be explained there is state now.
      expect(screen.queryByRole("button", { name: `About ${title}` })).toBeNull();
      const header = container.querySelector(`#${section} > *`) as HTMLElement;
      expect(header.querySelector("p")).toBeNull();
    }
    // What the explanations carried, kept as label-length units, effects and
    // actions beside the fields they qualify.
    pickSection("general");
    expect(screen.getByText("USD per month · all sites")).toBeVisible();
    expect(screen.getByText("USD per minute · prices review time in ROI")).toBeVisible();
    // What happens at the cap is a state beside the meter, not a sentence
    // under it (bead ro-ujb9.18).
    expect(within(container.querySelector("[data-budget-meter='data']") as HTMLElement).getByText("Stops at the budget")).toBeVisible();
    expect(screen.queryByText(/Collection that would exceed the cap/)).toBeNull();
    expect(screen.queryByRole("button", { name: "About monthly data cap" })).toBeNull();
    pickSection("alert-rules");
    expect(within(container.querySelector("#alert-rules") as HTMLElement).getByText("All sites")).toBeVisible();
    pickSection("data-collection");
    // A collection no connection feeds has its schedule as a row here (beads
    // ro-ujb9.96.7.12, ro-ujb9.96.7.28); one a connection feeds is changed on
    // that connection's Manage panel.
    expect(container.querySelector('[data-schedule-row="pull"]')).not.toBeNull();
    expect(container.querySelector('[data-schedule-row="signal-dumps"]')).toBeNull();
    expect(screen.queryByText(/View background operations/)).toBeNull();
    expect(container.querySelector("[data-knob-consequence]")).toBeNull();
    expect(container.querySelector('[data-collection-scale="panel-freshness-bar"]')).toHaveTextContent("Fits the window");
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("opens one focused section at a time and preserves its hash link", () => {
    stubFetch();
    const { container } = renderPage();

    for (const [id, title] of [
      ["general", "General"],
      ["alert-rules", "Alert rules"],
      ["data-collection", "Data collection"],
      ["tv-dashboard", "TV dashboard"],
      ["entities", "Ownership"],
      ["task-hub", "Task projects"],
    ] as const) {
      pickSection(id);
      const section = container.querySelector(`#${id}`);
      expect(section, `section #${id} is missing`).not.toBeNull();
      expect(within(section as HTMLElement).getAllByText(title).length).toBeGreaterThan(0);
      expect(container.querySelectorAll("#general, #tv-dashboard, #alert-rules, #data-collection, #entities, #task-hub")).toHaveLength(1);
      expect(screen.getByTestId("settings-location")).toHaveTextContent(`/settings#${id}`);
      expect(screen.getByRole("navigation", { name: "Settings sections" }).querySelector('[aria-current="page"]')).toHaveAttribute("href", `/settings#${id}`);
    }

    // The section list IS the outline: one anchor per section, in DOM order.
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      "/settings#general",
      "/settings#alert-rules",
      "/settings#data-collection",
      "/settings#tv-dashboard",
      "/settings#entities",
      "/settings#task-hub",
    ]);
  });

  // Bead ro-ujb9.18: General holds the clock and the budget, and their old
  // addresses (Integrations' DataForSEO card links #budget) land on it.
  it("opens on General, with the time zone and the budget as its rows", () => {
    stubFetch();
    for (const hash of ["", "clock", "budget"]) {
      const view = renderPage(hash);
      const general = view.container.querySelector("#general") as HTMLElement;
      expect(general, `#${hash}`).not.toBeNull();
      expect(general.querySelector("#clock")).not.toBeNull();
      expect(general.querySelector("#budget")).not.toBeNull();
      expect(within(general).getByRole("combobox", { name: /^Time zone/u })).toBeTruthy();
      expect(within(general).getByRole("spinbutton", { name: /Monthly data cap/u })).toBeTruthy();
      expect(within(general).getByRole("spinbutton", { name: /Value of your time/u })).toBeTruthy();
      expect(screen.getByRole("navigation", { name: "Settings sections" }).querySelector('[aria-current="page"]')).toHaveAttribute("href", "/settings#general");
      view.unmount();
    }
  });

  // D32: core task project settings remain reachable at every hub state.
  it("always lists core Task projects, including an unconfigured hub", () => {
    stubFetch();
    const links = () => within(screen.getByRole("navigation", { name: "Settings sections" })).getAllByRole("link").map((a) => a.getAttribute("href"));
    try {
      taskSourceMock.connected = null;
      state.settings = payload({ taskHub: { owner: "config/beads.json", spokes: [], hub: null } });
      const fresh = renderPage("general");
      expect(links()).toEqual(["/settings#general", "/settings#alert-rules", "/settings#data-collection", "/settings#tv-dashboard", "/settings#entities", "/settings#task-hub"]);
      fresh.unmount();
      // A direct link opens the same existing project-management section.
      const connecting = renderPage("task-hub");
      expect(connecting.container.querySelector("#task-hub")).not.toBeNull();
      expect(links()).toContain("/settings#task-hub");
      connecting.unmount();
      // A saved project lists it, connected or not.
      state.settings = payload();
      renderPage("general");
      expect(links()).toContain("/settings#task-hub");
    } finally {
      resetTaskSourceMock();
    }
  });

  // The zone a person most likely means is the one this device runs in: it is
  // the first option, named as such (bead ro-ujb9.18).
  it("offers this device's zone first in the time zone list", () => {
    stubFetch();
    const zone = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      ...new Intl.DateTimeFormat("en-US").resolvedOptions(), timeZone: "Europe/Warsaw",
    });
    // The device zone is re-read at most once a minute: step past the read an
    // earlier case left behind.
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 3_600_000);
    try {
      renderPage("general");
      const select = screen.getByRole("combobox", { name: /^Time zone/u }) as HTMLSelectElement;
      expect(select.options[0]!.value).toBe("Europe/Warsaw");
      expect(select.options[0]!.textContent).toMatch(/this device$/u);
      expect([...select.options].filter((option) => option.value === "Europe/Warsaw")).toHaveLength(1);
      expect(select).toHaveValue("America/Los_Angeles");
    } finally {
      zone.mockRestore();
      clock.mockRestore();
    }
  });

  it("opens a bookmarked section directly and falls back safely for an unknown hash", () => {
    stubFetch();
    const first = renderPage("task-hub");
    expect(first.container.querySelector("#task-hub")).not.toBeNull();
    expect(first.container.querySelector("#general")).toBeNull();
    first.unmount();
    const unknown = renderPage("retired-section");
    expect(unknown.container.querySelector("#general")).not.toBeNull();
  });

  it("shows the clock without internal keys or file paths", () => {
    stubFetch();
    const { container } = renderPage();

    const clock = container.querySelector("#clock") as HTMLElement;
    const field = within(clock).getByLabelText(/^Time zone/u);
    expect(field).toHaveValue("America/Los_Angeles");
    expect(clock.textContent).not.toContain("config/constants.json");
    expect(clock.textContent).not.toContain("os_time_zone");
    expect(clock.textContent).not.toContain("Technical details");
    // A zone name is not legible on its own: the visual is what time it is
    // there right now (doc 14 — a state carries the visual that shows it).
    expect(clock.querySelector("[data-zone-clock='America/Los_Angeles']")).not.toBeNull();
  });

  it("shows what the timezone decides — yesterday's revenue date and the current month — as values (ro-ujb9.88)", async () => {
    const calls = stubFetch();
    const { container } = renderPage();
    const value = (label: string) =>
      container.querySelector(`[data-zone-value="${label}"]`)?.textContent;

    // 2026-09-04 12:00 UTC is 5 AM on the 4th in Los Angeles.
    expect(value("Yesterday's revenue")).toBe("Sep 3, 2026");
    expect(value("Current month")).toBe("September 2026");
    expect(value("Now")).toMatch(/PT$/u);
    // ...and 2 AM on the 5th at UTC+14: the revenue day moves with the zone.
    fireEvent.change(screen.getByRole("combobox", { name: /^Time zone/u }), {
      target: { value: "Pacific/Kiritimati" },
    });
    await waitFor(() => expect(value("Yesterday's revenue")).toBe("Sep 4, 2026"));
    // Finish this pick's save before the next test replaces its transport.
    await waitFor(() => expect(within(container.querySelector("#clock") as HTMLElement).getByRole("status")).toHaveTextContent("Saved"));
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(calls.find((call) => call.method === "PUT")!.body).toMatchObject({
      ops: [{ pointer: "/os_time_zone", expect: "America/Los_Angeles", value: "Pacific/Kiritimati" }],
    });
    // No paragraph explains it any more (bead ro-ujb9.96.6.3).
    expect(screen.queryByRole("button", { name: "About time & timezone" })).toBeNull();
  });

  it("saves the timezone the moment it is picked, with Saved and Undo beside it", async () => {
    const calls = stubFetch();
    renderPage();
    const clock = document.querySelector("#clock") as HTMLElement;
    // Pick-to-save: the timezone is one low-risk choice, so there is no Save.
    expect(within(clock).queryByRole("button", { name: "Save" })).toBeNull();

    fireEvent.change(within(clock).getByLabelText(/^Time zone/u), {
      target: { value: "Europe/Warsaw" },
    });

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const puts = () => calls.filter((c) => c.method === "PUT");
    expect(puts()[0]!.url).toBe("/api/config");
    expect(puts()[0]!.body).toMatchObject({
      ops: [
        {
          kind: "file-json-set",
          file: "config/constants.json",
          pointer: "/os_time_zone",
          // The concurrency guard is the value the field was rendered from.
          expect: "America/Los_Angeles",
          value: "Europe/Warsaw",
        },
      ],
    });
    // Confirmed where the change was made, not in a corner toast.
    await waitFor(() => expect(within(clock).getByRole("status")).toHaveTextContent("Saved"));
    const status = within(clock).getByRole("status");
    expect(toasts.success).not.toHaveBeenCalled();

    // Undo is the same write reversed, guarded on the value just written.
    fireEvent.click(within(status).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]!.body).toMatchObject({
      ops: [{ pointer: "/os_time_zone", expect: "Europe/Warsaw", value: "America/Los_Angeles" }],
    });
    await waitFor(() =>
      expect(within(clock).getByLabelText(/^Time zone/u)).toHaveValue("America/Los_Angeles"),
    );
    expect(within(clock).queryByRole("status")).toBeNull();
  });

  it("offers only known timezones instead of inviting a spelling error", () => {
    const calls = stubFetch();
    renderPage();

    const field = screen.getByRole("combobox", { name: /^Time zone/u });
    expect(within(field).queryByRole("option", { name: /Atlantis/ })).toBeNull();
    expect(within(field).getByRole("option", { name: "Europe / Warsaw" })).toHaveValue("Europe/Warsaw");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("puts a refused pick back on the saved timezone, preview included", async () => {
    const calls = stubFetch({ status: 409, body: { error: "expect_mismatch" } });
    const { container } = renderPage();
    fireEvent.change(screen.getByRole("combobox", { name: /^Time zone/u }), {
      target: { value: "Europe/Warsaw" },
    });
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /^Time zone/u })).toHaveValue("America/Los_Angeles"),
    );
    expect(container.querySelector("[data-zone-clock='America/Los_Angeles']")).not.toBeNull();
    // Said beside the picker as a short state, not in a corner toast
    // (bead ro-ujb9.96.7.12).
    const refused = within(container.querySelector("#clock") as HTMLElement).getByRole("alert");
    expect(refused).toHaveTextContent("Not saved");
    expect(refused).toHaveTextContent("Changed elsewhere");
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("names a zone the runtime cannot resolve and shows the UTC fallback", () => {
    state.settings = payload({
      clock: { owner: "config/constants.json", timeZone: "Atlantis/Lost_City", chosen: true },
    });
    stubFetch();
    const { container } = renderPage();
    const preview = container.querySelector("[data-zone-clock='unresolved']") as HTMLElement;
    expect(preview).toHaveTextContent("Unknown zone · UTC used");
    expect(preview.querySelector('[data-zone-value="Now"]')?.textContent).toMatch(/UTC$/u);
  });

  it("keeps the TV section for the layout when no countdown is configured", () => {
    // Bead ro-py40 said a fresh install gets no empty countdown card and no
    // "set a countdown" placeholder, and that half is unchanged. The section
    // itself now stays (bead ro-lzmq.2): every install has a TV LAYOUT whether
    // or not it counts down to anything, and this is the door to arranging it.
    state.settings = payload({ dashboard: {} });
    stubFetch();
    const { container } = renderPage("tv-dashboard");

    expect(container.querySelector("#tv-dashboard")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Edit layout" }).getAttribute("href")).toBe(
      "/wall/edit",
    );
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toContain("/settings#tv-dashboard");

    // No countdown card and no invented event — the form is behind a button,
    // not sitting open (bead `ro-fqag`).
    expect(screen.queryByText("Launch day")).toBeNull();
    expect(screen.queryByLabelText("Countdown emoji")).toBeNull();
    expect(container.querySelector("[data-countdown-layout]")).toBeNull();
    expect(screen.getByRole("button", { name: "Set a countdown" })).toBeTruthy();

    // Other sections remain reachable without mounting their editors here.
    expect(container.querySelector("#budget")).toBeNull();
    expect(container.querySelector("#clock")).toBeNull();
  });

  it("makes the first countdown here, as ONE insert of the whole landmark", async () => {
    // The gap bead ro-fqag closed: /settings could EDIT the three fields and
    // never create them, because a set never creates a key — so the only path to
    // a first countdown was hand-editing config/tower.json, the terminal step
    // D18 retired everywhere else. It is one op because the emoji, the words and
    // the moment are one landmark (ro-py40): a countdown with a label and no
    // moment is not half a countdown.
    state.settings = payload({ dashboard: {} });
    const calls = stubFetch();
    renderPage("tv-dashboard");

    fireEvent.click(screen.getByRole("button", { name: "Set a countdown" }));
    fireEvent.change(screen.getByLabelText("Countdown emoji"), { target: { value: "🌁" } });
    fireEvent.change(screen.getByLabelText("Countdown label"), { target: { value: "SF MOVE" } });
    fireEvent.change(screen.getByLabelText("Target date and time"), {
      target: { value: "2027-03-01T09:00" },
    });
    fireEvent.click(
      within(document.querySelector("#tv-dashboard") as HTMLElement).getByRole("button", {
        name: "Save",
      }),
    );

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/config");
    expect(put.body).toMatchObject({
      slug: "countdown",
      ops: [
        {
          kind: "file-json-insert",
          file: "config/tower.json",
          pointer: "/countdown",
          value: {
            emoji: "🌁",
            label: "SF MOVE",
            targetAt: new Date("2027-03-01T09:00").toISOString(),
          },
        },
      ],
    });
    // ONE op, and no per-field sets alongside it.
    expect((put.body as { ops: unknown[] }).ops).toHaveLength(1);
  });

  // Bead ro-trai.45: a saved countdown the Tower refused is not "No countdown
  // set" — the store holds one, so the first-countdown insert would be refused
  // because the key exists. The section names it and the form saves over the
  // value as stored.
  it("names a saved countdown the Tower refused and saves over it, guarded by the value as stored", async () => {
    const stored = { emoji: "", label: "Launch day", targetAt: "2027-01-01T00:00:00.000Z" };
    state.settings = payload({
      dashboard: { refused: { countdown: { saved: stored, reason: "config/tower.json countdown.emoji must contain one emoji" } } },
    });
    const calls = stubFetch();
    const { container } = renderPage("tv-dashboard");

    expect(screen.queryByRole("button", { name: "Set a countdown" })).toBeNull();
    const chip = container.querySelector('[data-settings-countdown-refused] [data-status-for="wall:countdown"]');
    expect(chip?.textContent).toBe("Saved countdown refused");
    expect((screen.getByLabelText("Countdown label") as HTMLInputElement).value).toBe("Launch day");
    fireEvent.change(screen.getByLabelText("Countdown emoji"), { target: { value: "🚀" } });
    fireEvent.click(
      within(document.querySelector("#tv-dashboard") as HTMLElement).getByRole("button", { name: "Save" }),
    );

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({
      slug: "countdown",
      ops: [{
        kind: "file-json-set",
        file: "config/tower.json",
        pointer: "/countdown",
        expect: stored,
        value: { emoji: "🚀", label: "Launch day", targetAt: stored.targetAt },
      }],
    });
  });

  it("takes the countdown away again, guarded by the three values on screen", async () => {
    const calls = stubFetch();
    renderPage("tv-dashboard");

    fireEvent.click(
      within(document.querySelector("#tv-dashboard") as HTMLElement).getByRole("button", {
        name: /Configure|Edit/u,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove countdown" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({
      slug: "countdown",
      ops: [
        {
          kind: "file-json-delete",
          file: "config/tower.json",
          pointer: "/countdown",
          // The whole landmark as it was rendered — the guard that refuses if
          // somebody moved it in between.
          expect: {
            emoji: "🚀",
            label: "Launch day",
            targetAt: "2027-01-01T00:00:00.000Z",
          },
        },
      ],
    });
  });

  it("shows each section's contents: countdown, rules, cadence, sources, spokes", () => {
    stubFetch();
    renderPage("tv-dashboard");

    // The TV countdown renders itself, editor and all.
    expect(screen.getByText("Launch day")).toBeTruthy();
    pickSection("alert-rules");
    // Field meaning is on demand; scope stays visible.
    expect(screen.getByText("Anomaly sensitivity")).toBeTruthy();
    expect(screen.queryByText("How unlikely a drop must be before an alert fires.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "About anomaly sensitivity" }));
    expect(
      screen.getByText("How unlikely a drop must be before an alert fires."),
    ).toBeVisible();
    // Collection: every declared cadence knob as a field, and a state chip per
    // pull lane. The pull registry is the half that stays read-only.
    pickSection("data-collection");
    expect(screen.queryByRole("spinbutton", { name: /Counter read interval/ })).toBeNull();
    // Each collection no connection feeds is a row with its own pick
    // (ro-ujb9.96.7.12, ro-ujb9.96.7.28).
    expect(screen.getByRole("combobox", { name: "Nightly reports · how often" })).toHaveValue("daily");
    expect(screen.getByRole("spinbutton", { name: /Panel history window/ })).toHaveValue(35);
    expect(within(document.querySelector('[data-pull-asset="meals.example"]') as HTMLElement).getByText("Enabled")).toBeTruthy();
    expect(within(document.querySelector('[data-pull-asset="nosh.example"]') as HTMLElement).getByText("Paused")).toBeTruthy();
    // Task hub: a project's prefix and repo, now as the fields they are.
    pickSection("task-hub");
    const project = document.querySelector('[data-collection-row="meals.example"]') as HTMLElement;
    expect(within(project).getByLabelText("Task prefix")).toHaveValue("mp");
    expect(within(project).queryByLabelText("Repo")).toBeNull();
  });

  it("saves a budget change as the exact file op the write lane expects", async () => {
    const calls = stubFetch();
    renderPage("budget");

    const field = screen.getByRole("spinbutton", { name: /Monthly data cap/ });
    fireEvent.change(field, { target: { value: "40" } });
    // The Save that belongs to THIS field, not the first one on the page.
    fireEvent.click(
      within(field.parentElement as HTMLElement).getByRole("button", { name: "Save" }),
    );

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/config");
    expect(put.body).toMatchObject({
      ops: [
        {
          kind: "file-json-set",
          file: "config/constants.json",
          pointer: "/monthly_caps/data_usd",
          // `expect` is the value the field was RENDERED from — the guard that
          // makes a concurrent edit a refusal rather than a silent overwrite.
          expect: 25,
          value: 40,
        },
      ],
    });
    // Confirmed beside the field, with its Undo there too — not in a toast.
    const status = await within(field.parentElement as HTMLElement).findByRole("status");
    expect(status).toHaveTextContent("Saved");
    expect(within(status).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("draws data spend against the cap, and shows no cap it cannot meter", () => {
    stubFetch();
    renderPage("budget");

    const dataMeter = document.querySelector('[data-budget-meter="data"]')!;
    expect(within(dataMeter as HTMLElement).getByText("$11.40 of $25")).toBeTruthy();
    const bar = within(dataMeter as HTMLElement).getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("11");
    expect(bar.getAttribute("aria-valuemax")).toBe("25");

    // The monthly inference cap was withdrawn with D6 (bead `ro-uj7x`) rather
    // than keep an empty bar reading "not instrumented" beside a ceiling
    // nothing measures. Budget now holds only caps that have a meter.
    expect(document.querySelector('[data-budget-meter="inference"]')).toBeNull();
    expect(screen.queryByText("not instrumented")).toBeNull();
    expect(screen.queryByText("Monthly inference cap")).toBeNull();
  });

  it("says the spend is unread rather than zero when the matrix has not answered", () => {
    state.integrations = null;
    stubFetch();
    renderPage("budget");

    const dataMeter = document.querySelector('[data-budget-meter="data"]')!;
    expect(within(dataMeter as HTMLElement).getByText("not read yet")).toBeTruthy();
    expect(dataMeter.textContent).not.toContain("$0.00 of");
  });

  it("disables every editable field with the reason on a build that cannot write", () => {
    state.writable = { writable: false, reason: READ_ONLY_REASON };
    stubFetch();
    renderPage("budget");

    // Said ONCE for the whole page (bead ro-p8qq), above whichever section is
    // open, and never again under a field: each field shows only its lock.
    const paused = document.querySelector("[data-saves-paused]") as HTMLElement;
    expect(paused).toHaveTextContent("Saves paused");
    expect(paused).toHaveTextContent(READ_ONLY_REASON);
    expect(
      (screen.getByRole("spinbutton", { name: /Monthly data cap/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    for (const section of ["general", "alert-rules", "data-collection", "tv-dashboard", "entities", "task-hub"]) {
      pickSection(section);
      expect(pausedStatements(), `#${section} says it once`).toBe(1);
    }
    pickSection("alert-rules");
    expect(
      (screen.getByRole("spinbutton", { name: /Anomaly sensitivity/ }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    for (const save of screen.getAllByRole("button", { name: "Save" })) {
      expect((save as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("says so plainly when a project map or a pull registry is empty", () => {
    state.settings = payload({
      collection: {
        knobs: [],
        pullOwner: "config/pull.json",
        schedules: null,
        pullAssets: [],
      },
      taskHub: { owner: "config/beads.json", spokes: [], hub: null },
    });
    stubFetch();
    renderPage("data-collection");

    expect(document.querySelector("[data-pull-none]")).toHaveTextContent("None · sites send their own");
    pickSection("task-hub");
    expect(screen.getByText("No task projects configured.")).toBeTruthy();
    // A hosted map needs the local service for project setup: a chip says so,
    // and there is no Add that would be refused.
    expect(within(taskHub()).getByText("Read-only here")).toBeTruthy();
    expect(within(taskHub()).queryByRole("button", { name: "Add" })).toBeNull();
    // A build with no connection details does not invent them.
    expect(document.querySelector("[data-task-hub-connection]")).toBeNull();
  });
});

// --- the task-hub project map (bead ro-x5gu.5) -------------------------------
//
// What is asserted here is the thing this section had to earn to stop being a
// list you could only look at: a project can be MAPPED from the page, the rules
// that make a map usable are refused before a request is made, and — because a
// row in a file is not a working project — the steps left over are named with
// the exact text to paste.

function taskHub(): HTMLElement {
  return document.querySelector("#task-hub") as HTMLElement;
}

function projectRow(asset: string): HTMLElement {
  return document.querySelector(`[data-collection-row="${asset}"]`) as HTMLElement;
}

function addForm(): HTMLElement {
  return document.querySelector("[data-collection-add]") as HTMLElement;
}

/** The steps that outlive the write, once they have rendered. */
async function findChecklist(asset = "nosh.example"): Promise<HTMLElement> {
  const at = () => document.querySelector(`[data-project-checklist='${asset}']`);
  await waitFor(() => expect(at()).not.toBeNull());
  return at() as HTMLElement;
}

/** The task the runner files for a project whose declared database the server
 * does not hold. Its title is the join — pinned from the writing side in
 * `scripts/os-up.test.mjs`, so the two spellings cannot drift apart quietly. */
function driftTask(asset: string): WorkItem {
  return {
    id: `ro-${asset.length}`,
    title: `Point ${asset}'s task database at one the hub holds`,
    status: "open",
    priority: 1,
    issueType: "bug",
    assignee: null,
    updatedAt: "2026-09-05T09:00:00.000Z",
    closedAt: null,
    parent: null,
    deferUntil: null,
  };
}

/** A board carrying exactly the given inbox, filed against this repo's own
 * project — which is where the reconciliation files every one of them. */
function workBoard(...waiting: WorkItem[]): WorkPayload {
  return {
    generatedAt: "2026-09-05T12:00:00.000Z",
    capturedAt: "2026-09-05T11:59:00.000Z",
    pollCadenceHours: 1,
    owner: "config/beads.json",
    projects: [
      {
        asset: "root-os",
        prefix: "ro",
        name: "NoticeOS",
        ok: true,
        error: null,
        counts: {
          open: waiting.length,
          highPriority: waiting.length,
          ready: 0,
          inProgress: 0,
          blocked: 0,
          closedRecent: 0,
          deferred: 0,
          waiting: waiting.length,
        },
        history: emptyWorkHistory(),
        priorities: null,
        epics: null,
        ready: [],
        inProgress: [],
        recentlyClosed: [],
        deferred: [],
        waiting,
      },
    ],
    historyDays: 0,
  };
}

/** Fill the Add form with a whole project. `database` is left alone: it follows
 * the prefix by declaration until somebody types into it. */
function fillProject(fields: { asset: string; prefix: string }) {
  fireEvent.change(within(addForm()).getByLabelText("Site"), { target: { value: fields.asset } });
  fireEvent.change(within(addForm()).getByLabelText("Task prefix"), {
    target: { value: fields.prefix },
  });
}

describe("/settings — the task-hub project map", () => {
  beforeEach(() => { initialSection = "task-hub"; });
  it("adds a project as one insert, and the Undo takes it out again", async () => {
    state.integrations = matrix(11.4, "2026-09", assetRefs("nosh.example", "meals.example"));
    const calls = stubFetch();
    renderPage();

    fireEvent.click(within(taskHub()).getByRole("button", { name: "Add" }));
    expect(within(addForm()).queryByLabelText("Repository")).toBeNull();
    fillProject({ asset: "nosh.example", prefix: "nom" });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const added = { asset: "nosh.example", prefix: "nom", database: "nom" };
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({
      ops: [{ kind: "file-json-insert", file: "config/beads.json", pointer: "/spokes/-", value: added }],
    });

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const undo = toasts.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    undo.action.onClick();
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PUT")[1]!.body).toMatchObject({
      ops: [
        {
          kind: "file-json-delete",
          file: "config/beads.json",
          pointer: "/spokes/2",
          expect: added,
        },
      ],
    });
  });

  it("edits a logical database mapping while hiding the legacy repository field", async () => {
    const calls = stubFetch();
    renderPage();

    expect(within(projectRow("meals.example")).queryByLabelText("Repo")).toBeNull();
    // No Save in any cell: a cell saves when it is left (bead ro-ujb9.96.7.12).
    expect(within(taskHub()).queryByRole("button", { name: "Save" })).toBeNull();
    const field = within(projectRow("meals.example")).getByLabelText("Database");
    fireEvent.change(field, { target: { value: "meals" } });
    fireEvent.blur(field);

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({
      ops: [
        {
          kind: "file-json-set",
          file: "config/beads.json",
          pointer: "/spokes/1/database",
          expect: "mp",
          value: "meals",
        },
      ],
    });
    // Saved beside the cell with its Undo — not in a toast.
    const saved = await waitFor(() => {
      const found = projectRow("meals.example").querySelector('[data-save-state="saved"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(saved).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("removes a project behind a confirm, and the Undo puts the row back", async () => {
    const calls = stubFetch();
    renderPage();

    fireEvent.click(
      within(projectRow("meals.example")).getByRole("button", { name: "Remove meals.example…" }),
    );
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    fireEvent.click(
      within(projectRow("meals.example")).getByRole("button", { name: "Remove meals.example" }),
    );

    const gone = { asset: "meals.example", prefix: "mp", database: "mp", repo: "../meals.example" };
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({
      ops: [
        { kind: "file-json-delete", file: "config/beads.json", pointer: "/spokes/1", expect: gone },
      ],
    });

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const undo = toasts.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    undo.action.onClick();
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PUT")[1]!.body).toMatchObject({
      // Back at its own index rather than onto the end (bead `ro-asj9`).
      ops: [{ kind: "file-json-insert", file: "config/beads.json", pointer: "/spokes/1", value: gone }],
    });
  });

  it("refuses a prefix another project already uses, naming the field", async () => {
    state.integrations = matrix(11.4, "2026-09", assetRefs("nosh.example", "meals.example"));
    const calls = stubFetch();
    renderPage();

    // A second project on `mp-` would make every task id ambiguous — and the
    // asset is free, so the key field cannot catch this one.
    fireEvent.click(within(taskHub()).getByRole("button", { name: "Add" }));
    fillProject({ asset: "nosh.example", prefix: "mp" });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add" }));

    expect(await within(addForm()).findByRole("alert")).toHaveTextContent(
      'Task prefix "mp" is already in this list',
    );
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("refuses an asset this OS does not have, and offers the ones no project has claimed", async () => {
    state.integrations = matrix(11.4, "2026-09", assetRefs("nosh.example", "meals.example", "fees.example"));
    const calls = stubFetch();
    renderPage();

    fireEvent.click(within(taskHub()).getByRole("button", { name: "Add" }));
    // The picker offers exactly the unclaimed assets — meals.example is mapped.
    const list = addForm().querySelector("datalist") as HTMLDataListElement;
    expect([...list.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual([
      "nosh.example",
      "fees.example",
    ]);

    fillProject({ asset: "typo.example", prefix: "typo" });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add" }));

    expect(await within(addForm()).findByRole("alert")).toHaveTextContent(/^asset "typo.example"/u);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("answers an Add with the steps the file cannot do, as text to paste", async () => {
    state.integrations = matrix(11.4, "2026-09", assetRefs("nosh.example"));
    stubFetch();
    renderPage();

    expect(document.querySelector("[data-project-checklist]")).toBeNull();

    fireEvent.click(within(taskHub()).getByRole("button", { name: "Add" }));
    fillProject({ asset: "nosh.example", prefix: "nom" });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add" }));

    const checklist = await findChecklist();
    // The command carries the hub's real host and port — a fourth typed copy of
    // those is exactly what the three-file invariant exists to prevent.
    expect(checklist.textContent).toContain(
      "bd init --server --external --server-host 127.0.0.1 --server-port 3308 " +
        "--server-user root --prefix nom --non-interactive --skip-agents --skip-hooks",
    );
    // The config edit, drawn as the diff it is: the line to remove struck, the
    // two keys to add marked — and Copy takes only what is added.
    const yaml = within(checklist)
      .getByText("File · the project checkout/.beads/config.yaml")
      .closest("[data-command-block]") as HTMLElement;
    expect(yaml.querySelector("[data-command-removed] del")).toHaveTextContent("sync.remote");
    expect(yaml.textContent).toContain("+ no-git-ops: true");
    expect(yaml.textContent).toContain("+ import.auto: false");
    expect(within(checklist).getByText("File · installation/task-host.json · repositories")).toBeTruthy();
    expect(checklist.textContent).toContain("three steps left");
    // Titles and text to paste, no paragraph per step (bead ro-ujb9.96.6.3).
    expect(checklist.textContent).not.toMatch(/within a minute|quietly starts|not onboarded until/u);

    fireEvent.click(within(checklist).getByRole("button", { name: "Done" }));
    expect(document.querySelector("[data-project-checklist]")).toBeNull();
  });

  it("names the database in the command only when it differs from the prefix", async () => {
    state.integrations = matrix(11.4, "2026-09", assetRefs("nosh.example"));
    stubFetch();
    renderPage();

    fireEvent.click(within(taskHub()).getByRole("button", { name: "Add" }));
    fillProject({ asset: "nosh.example", prefix: "nom" });
    fireEvent.change(within(addForm()).getByLabelText("Database"), { target: { value: "nomnow" } });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add" }));

    const checklist = await findChecklist();
    expect(checklist.textContent).toContain("--prefix nom --database nomnow");
  });

  it("shows the connection as the fixed fact it is, never as a field", () => {
    stubFetch();
    renderPage();

    const connection = document.querySelector("[data-task-hub-connection]") as HTMLElement;
    expect(connection.textContent).toContain("127.0.0.1:3308");
    expect(connection.textContent).toContain(".local/beads-dolt");
    // A label and the value — read-only by construction (no field, no Save),
    // with no tooltip explaining what the label already names.
    expect(connection.textContent).toContain("Task database server");
    expect(within(connection).queryByRole("textbox")).toBeNull();
    expect(within(connection).queryByRole("button")).toBeNull();
  });

  // WHAT THE HOURLY CHECK FOUND, ON THE FIELD THAT CAUSED IT (bead `ro-eb7z`).
  //
  // The runner reconciles each project's declared database against what the
  // server actually holds and files an operator task about the ones that
  // disagree. Before this the operator met that task in his inbox, which is a
  // slower loop than a mark on the value he typed — and this is the one page
  // where the fix is a single edit. The page probes nothing: it reads the filed
  // task off the board, which is why both states below are staged by moving one
  // item in and out of the work payload.
  it("marks the project whose database does not exist, and names both fixes", () => {
    state.work = workBoard(driftTask("meals.example"));
    stubFetch();
    renderPage();

    expect(
      within(projectRow("meals.example")).getByRole("img", {
        name: "No database named mp where the tasks live",
      }),
    ).toBeTruthy();
    // The agreeing project carries no mark at all — never an all-clear, because
    // the board only ever carries a bounded head of each list.
    expect(
      within(projectRow("root-os")).queryByRole("img", { name: /No database/u }),
    ).toBeNull();

    // What happened, as its consequence, then the two fixes as two options —
    // no paragraph between them (bead ro-ujb9.96.6.3).
    const note = document.querySelector("[data-database-not-found]") as HTMLElement;
    expect(note.textContent).toContain("meals.example is not being backed up");
    expect(note.textContent).toContain("No database named mp");
    expect(note.textContent).not.toMatch(/Tasks board keeps working/u);
    // Fix one: rename it here — the button puts the cursor in the Database cell.
    fireEvent.click(within(note).getByRole("button", { name: "Edit name" }));
    expect(document.activeElement).toBe(within(projectRow("meals.example")).getByLabelText("Database"));
    // Fix two: keep the name and move the repo onto it.
    expect(within(note).getByText("Keep mp")).toBeTruthy();
    expect(note.textContent).toContain("--prefix mp --database mp");
  });

  it("takes the mark off once the task is gone, and offers nothing when nothing answered", () => {
    state.work = workBoard();
    stubFetch();
    const { unmount } = renderPage();

    expect(document.querySelector("[data-database-not-found]")).toBeNull();
    expect(
      within(projectRow("meals.example")).queryByRole("img", { name: /No database/u }),
    ).toBeNull();
    // The column is still offered, because the board DID answer.
    expect(within(taskHub()).getByText("Found")).toBeTruthy();
    unmount();

    // A board that never answered is not an all-clear: no column at all.
    state.work = null;
    renderPage();
    expect(within(taskHub()).queryByText("Found")).toBeNull();
    expect(document.querySelector("[data-database-not-found]")).toBeNull();
  });

  // THE SERVER THAT DID NOT ANSWER (bead `ro-ujb9.208`). Every project read
  // failing is the task server down: the address carries the state and the
  // read's own error, once each, and the Found column says it does not know.
  it("says the task server is not answering beside its address when every project read failed", () => {
    const refused = "bd list exited 1: dial tcp 127.0.0.1:3308: connect: connection refused";
    const board = workBoard();
    const failed = { ...board.projects[0]!, ok: false, error: refused };
    state.work = { ...board, projects: [failed, { ...failed, asset: "meals.example", prefix: "mp", name: "Meal Planner" }] };
    stubFetch();
    renderPage();

    const connection = document.querySelector("[data-task-hub-connection]") as HTMLElement;
    expect(connection).toHaveAttribute("data-task-server", "not-answering");
    expect(connection.querySelectorAll('[data-status-for="tasks:server"]')).toHaveLength(1);
    expect(connection.querySelector('[data-status-for="tasks:server"]')).toHaveTextContent("Not answering");
    // The same error from two projects is said once.
    expect(connection.textContent!.split(refused)).toHaveLength(2);
    expect(connection.textContent).toContain("127.0.0.1:3308");

    // Found stays, and says it does not know on every row.
    expect(within(taskHub()).getByText("Found")).toBeTruthy();
    expect(projectRow("meals.example").querySelector("[data-found-unknown]")).toHaveTextContent("Unknown");
    expect(projectRow("root-os").querySelector("[data-found-unknown]")).toHaveTextContent("Unknown");
  });

  it("draws no server state while any project reads", () => {
    const board = workBoard();
    state.work = { ...board, projects: [...board.projects, { ...board.projects[0]!, asset: "meals.example", ok: false, error: "no repo" }] };
    stubFetch();
    renderPage();
    const connection = document.querySelector("[data-task-hub-connection]") as HTMLElement;
    expect(connection).not.toHaveAttribute("data-task-server");
    expect(connection.querySelector('[data-status-for="tasks:server"]')).toBeNull();
    expect(document.querySelector("[data-found-unknown]")).toBeNull();
  });

  it("keeps deployed task projects readable without offering local setup controls", () => {
    state.settings!.taskHub.hub = null;
    stubFetch();
    renderPage();
    const section = taskHub();
    expect(section.querySelector("[data-task-projects-read-only]")).toBeTruthy();
    expect(within(section).getByText("meals.example")).toBeTruthy();
    expect(within(section).queryByRole("button", { name: "Add" })).toBeNull();
    expect(within(section).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(within(section).queryByRole("textbox")).toBeNull();
    expect(section.textContent).not.toContain("../meals.example");
    expect(section.textContent).not.toContain(".local/beads-dolt");
  });

  it("a build that cannot write shows the map without controls, and says why", async () => {
    state.writable = { writable: false, reason: READ_ONLY_REASON };
    stubFetch();
    renderPage();

    // Why is said once for the screen (bead ro-p8qq); the map shows its lock.
    await waitFor(() => expect(document.querySelector("[data-saves-paused]")).toHaveTextContent(READ_ONLY_REASON));
    expect(pausedStatements()).toBe(1);
    expect(taskHub().querySelector("[data-collection-locked]")).not.toBeNull();
    expect(within(taskHub()).queryByRole("button", { name: "Add" })).toBeNull();
    expect(within(taskHub()).queryByLabelText("Repo")).toBeNull();
    // The facts are still there to read.
    expect(within(taskHub()).getAllByText("mp").length).toBeGreaterThan(0);
    expect(within(taskHub()).queryByText("../meals.example")).toBeNull();
  });
});

/**
 * `/settings#alert-rules` shows what a change would do (bead `ro-w35m`).
 *
 * The same three settings typed on an alert row have shown their 30-day replay
 * since `ro-u072`; typed here they saved blind, which is docs/15 principle 1
 * holding on one surface and not the other for the same edit. What is pinned
 * below is that the evidence is REAL and SCOPED: the strip is the shipped one
 * fed by the shipped RPC, the asset it replays against is the operator's choice
 * and is named on the page, and a deployment that cannot save still shows it.
 */
function assetCard(overrides: Partial<AssetCard>): AssetCard {
  return {
    id: "meals.example",
    displayName: "Meal Planner",
    openError: 0,
    openWarn: 0,
    pulseReceivedAt: "2026-09-04T02:00:00.000Z",
    ...overrides,
  } as AssetCard;
}

function wall(assets: AssetCard[]): WallPayload {
  return { assets } as WallPayload;
}

function backtestBody(asset: string): RuleBacktest {
  const days = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 7, 6) + index * 86_400_000).toISOString().slice(0, 10),
    state: (index === 4 ? "fired" : "quiet") as "fired" | "quiet",
    firings: index === 4 ? [{ metric: "signups", severity: "warn" as const }] : [],
    stored: false,
  }));
  return {
    asset,
    ruleId: "flow-poisson-low",
    metric: null,
    config: { alpha: 0.01, minBaselinePerDay: 3, lowVolumeWindowHours: 72 },
    windowDays: 30,
    firstDay: days[0]!.date,
    lastDay: days[29]!.date,
    days,
    wouldFire: 1,
    judged: 30,
    reported: 30,
    firedInStore: 0,
  };
}

/** The replay lane, plus the write lane the fields already use. Returns the
 * replay requests, which is what these tests read. */
function stubReplay(): { asset: string; ruleId: string; config: unknown }[] {
  const asked: { asset: string; ruleId: string; config: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/alerts/backtest") {
        const body = JSON.parse(String(init?.body)) as {
          asset: string;
          ruleId: string;
          config: unknown;
        };
        asked.push(body);
        return new Response(JSON.stringify(backtestBody(body.asset)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(configSaveReply(init)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return asked;
}

describe("/settings#alert-rules — the replay the fields are edited against", () => {
  beforeEach(() => { initialSection = "alert-rules"; });
  it("draws the strip in the section, against the asset with the most open alerts", async () => {
    state.wall = wall([
      assetCard({ id: "meals.example", displayName: "Meal Planner", openWarn: 1 }),
      assetCard({ id: "nosh.example", displayName: "Nosh", openWarn: 2, openError: 1 }),
    ]);
    const asked = stubReplay();
    const { container } = renderPage();

    await waitFor(() => expect(asked).toHaveLength(1));
    // Nosh is the noisiest, so it is what the operator is shown first — not the
    // payload's first row.
    expect(asked[0]).toMatchObject({ asset: "nosh.example", ruleId: "flow-poisson-low" });
    await waitFor(() => {
      expect(screen.getByText(/Would have fired/)).toHaveTextContent(
        "Would have fired 1 time in the last 30 days",
      );
    });
    const section = container.querySelector("#alert-rules") as HTMLElement;
    expect(section.querySelector("[data-alert-rule-preview]")).not.toBeNull();
    expect(section.querySelectorAll("[data-backtest-day]")).toHaveLength(30);
  });

  it("replays against the asset the picker names, and says which one it is", async () => {
    state.wall = wall([
      assetCard({ id: "nosh.example", displayName: "Nosh", openWarn: 2 }),
      assetCard({ id: "meals.example", displayName: "Meal Planner" }),
    ]);
    const asked = stubReplay();
    const { container } = renderPage();

    await waitFor(() => expect(asked).toHaveLength(1));
    expect(container.querySelector("[data-replay-caption]")).toHaveTextContent(/^Nosh · last 30 days/);

    fireEvent.click(
      container.querySelector('[data-replay-asset="meals.example"]') as HTMLElement,
    );

    await waitFor(() => {
      expect(asked[asked.length - 1]).toMatchObject({ asset: "meals.example" });
    });
    // The caption follows the choice: a strip whose asset is only in a pressed
    // button is a number the reader has to remember the scope of.
    expect(container.querySelector("[data-replay-caption]")).toHaveTextContent(
      /^Meal Planner · last 30 days/,
    );
  });

  it("names the values it replayed, and follows the field as it is typed into", async () => {
    state.wall = wall([assetCard({ id: "nosh.example", displayName: "Nosh" })]);
    const asked = stubReplay();
    const { container } = renderPage();

    await waitFor(() => expect(asked).toHaveLength(1));
    expect(container.querySelector("[data-replay-caption]")).toHaveTextContent(
      "anomaly sensitivity 0.01",
    );

    fireEvent.change(
      screen.getByRole("spinbutton", { name: /Anomaly sensitivity/ }),
      { target: { value: "0.05" } },
    );

    // Show, then ask: the number moves before the Save, not after it.
    await waitFor(() => {
      expect(asked[asked.length - 1]).toMatchObject({
        config: { alpha: 0.05, minBaselinePerDay: 3, lowVolumeWindowHours: 72 },
      });
    });
    expect(container.querySelector("[data-replay-caption]")).toHaveTextContent(
      "anomaly sensitivity 0.05",
    );
  });

  it("replays the other rule when the operator picks it", async () => {
    state.wall = wall([assetCard({ id: "nosh.example", displayName: "Nosh" })]);
    const asked = stubReplay();
    const { container } = renderPage();

    await waitFor(() => expect(asked).toHaveLength(1));
    fireEvent.click(
      container.querySelector('[data-replay-rule="flow-lowvol-window"]') as HTMLElement,
    );
    await waitFor(() => {
      expect(asked[asked.length - 1]).toMatchObject({ ruleId: "flow-lowvol-window" });
    });
  });

  /**
   * THE TWO PICKERS ARE THUMB TARGETS (bead `ro-zmyq`). They are hand-rolled
   * buttons rather than `<Button>`, which is how a pair of 26px controls
   * survived `ro-md80`'s sweep and `ro-9smi`'s. jsdom has no layout, so what is
   * asserted is the class that carries the floor — and that it is `max-sm:`,
   * because the desk's density is not what this fixes.
   */
  it("gives both replay pickers the phone's thumb floor and leaves the desk alone", async () => {
    state.wall = wall([
      assetCard({ id: "nosh.example", displayName: "Nosh" }),
      assetCard({ id: "meals.example", displayName: "Meal Planner" }),
    ]);
    stubReplay();
    const { container } = renderPage();

    await waitFor(() => {
      expect(container.querySelectorAll("[data-replay-asset]").length).toBeGreaterThan(0);
    });
    const pickers = [
      ...container.querySelectorAll("[data-replay-asset]"),
      ...container.querySelectorAll("[data-replay-rule]"),
    ];
    expect(pickers.length).toBeGreaterThanOrEqual(3);
    for (const picker of pickers) {
      expect(picker.className).toContain("max-sm:min-h-11");
      // The label rides the middle of the taller box, not its top edge.
      expect(picker.className).toContain("items-center");
      expect(picker.className).not.toContain(" min-h-11");
    }
  });

  it("still shows the preview where nothing can be saved", async () => {
    state.writable = { writable: false, reason: READ_ONLY_REASON };
    state.wall = wall([assetCard({ id: "nosh.example", displayName: "Nosh" })]);
    const asked = stubReplay();
    const { container } = renderPage();

    await waitFor(() => expect(asked).toHaveLength(1));
    // The strip is a READ. A deployment with no write lane can still answer
    // "what would this do", and the answer is most of the value.
    const section = container.querySelector("#alert-rules") as HTMLElement;
    await waitFor(() => {
      expect(section.querySelectorAll("[data-backtest-day]")).toHaveLength(30);
    });
    for (const save of within(section).getAllByRole("button", { name: "Save" })) {
      expect(save).toBeDisabled();
    }
  });

  it("says there is nothing to replay against rather than drawing an empty strip", () => {
    // An asset that has never filed a report cannot be replayed, so it is not
    // offered — and a portfolio of only those says so.
    state.wall = wall([assetCard({ id: "nosh.example", pulseReceivedAt: null })]);
    stubReplay();
    const { container } = renderPage();

    const section = container.querySelector("#alert-rules") as HTMLElement;
    expect(section.querySelector("[data-alert-rule-preview]")).toBeNull();
    expect(section.querySelector("[data-backtest-day]")).toBeNull();
    // One calm line with its glyph, not a paragraph (doc 14 empty states).
    expect(section.querySelector("[data-alert-rule-preview-empty]")).toHaveTextContent(
      "No reports to replay yet",
    );
  });
});

// ---------------------------------------------------------------------------
// The two sections that stopped being read-only (bead `ro-x5gu.6`)
// ---------------------------------------------------------------------------
// Both are edited through a DECLARATION rather than through anything this page
// knows: the cadence numbers are the knobs in `CONFIG_KNOBS`, the catalog is the
// `data-source-catalog` register. So what is asserted here is that the page
// sends the pointer the declaration names, refuses with the sentence the
// declaration writes, and offers the way back the lane's own contract promises.

/** How many times this screen says saves are paused: the page's one state plus
 * any editor still saying it under itself (bead ro-p8qq wants exactly 1). */
function pausedStatements(): number {
  return (
    document.querySelectorAll("[data-saves-paused]").length +
    document.querySelectorAll("[data-knob-read-only]").length +
    document.querySelectorAll("[data-collection-read-only]").length +
    document.querySelectorAll("[data-settings-read-only]").length
  );
}

/** The last PUT the page made, once it has made one. */
async function lastPut(calls: Call[]) {
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  return calls.filter((c) => c.method === "PUT").at(-1)!;
}

/** The Save that belongs to one field, rather than the first one on the page. */
function saveBeside(field: HTMLElement) {
  return within(field.parentElement as HTMLElement).getByRole("button", { name: "Save" });
}

describe("/settings — the collection cadence", () => {
  beforeEach(() => { initialSection = "data-collection"; });
  it("takes each knob unit from its declaration without changing saved values", () => {
    const original = configDeclarations.configKnob;
    const declaration = vi.spyOn(configDeclarations, "configKnob").mockImplementation((key) => {
      const knob = original(key);
      return key === "panel-refresh-window" ? { ...knob, unit: "Periods" } : knob;
    });
    try {
      const calls = stubFetch();
      renderPage();
      const history = screen.getByRole("spinbutton", { name: "Panel history window" });
      const freshness = screen.getByRole("spinbutton", { name: "Panel freshness bar" });
      expect(history).toHaveValue(35);
      expect(freshness).toHaveValue(7);
      const historyHeading = document.querySelector(`label[for="${history.id}"]`)!.parentElement!.parentElement!;
      const freshnessHeading = document.querySelector(`label[for="${freshness.id}"]`)!.parentElement!.parentElement!;
      expect(within(historyHeading).getByText("Periods")).toBeTruthy();
      expect(within(freshnessHeading).getByText("Days")).toBeTruthy();
      expect(calls.some((call) => call.method === "PUT")).toBe(false);
    } finally {
      declaration.mockRestore();
    }
  });

  it("shows the actual schedule without offering a control that only changes freshness", () => {
    // The counters read interval is retired (bead ro-ujb9.222): the counters
    // row's schedule is the one control, and the cards age against it.
    state.settings = payload({
      collection: {
        knobs: [],
        pullOwner: "config/pull.json",
        schedules: null,
        pullAssets: [],
      },
    });
    const calls = stubFetch();
    renderPage();

    const schedules = document.querySelector("[data-collection-schedules]") as HTMLElement;
    expect(schedules.textContent).not.toContain("Counter freshness reference");
    expect(within(schedules).queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: /Counter read interval/ })).toBeNull();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  // ── the schedules no connection feeds, edited here (beads ro-ujb9.96.7.12,
  // ro-ujb9.96.7.28) ──────────────────────────────────────────────────────────

  it("shows each collection no connection feeds as its own row, and no other job", () => {
    stubFetch();
    renderPage();

    const rows = [...document.querySelectorAll("[data-schedule-row]")].map((row) => row.getAttribute("data-schedule-row"));
    expect(rows).toEqual(["pull", "counters", "panel-refresh"]);
    // A collection a connection feeds is changed on that connection's Manage
    // panel on Integrations, so it has no second row here.
    for (const job of ["mediavine", "clarity", "signal-dumps", "posthog", "dataforseo"]) {
      expect(document.querySelector(`[data-schedule-row="${job}"]`)).toBeNull();
    }
    // A backup or a freshness check keeps its one editor where it runs.
    expect(document.querySelector('[data-schedule-row="backup"]')).toBeNull();
    expect(document.querySelector('[data-schedule-row="freshness"]')).toBeNull();
    // The value each row shows is the saved schedule, read as the operator's picks.
    expect(screen.getByRole("combobox", { name: "Nightly reports · how often" })).toHaveValue("daily");
    expect(screen.getByRole("combobox", { name: "Live traffic and counters · how often" })).toHaveValue("minutes");
  });

  it("saves a picked time as the one guarded schedules write, with Saved · Undo beside the row", async () => {
    const calls = stubFetch();
    renderPage();

    fireEvent.change(screen.getByRole("combobox", { name: "Nightly reports · time" }), {
      target: { value: "09:15" },
    });

    const put = await lastPut(calls);
    expect(put.url).toBe("/api/config");
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(put.body).toMatchObject({
      slug: "schedule-pull",
      ops: [
        {
          kind: "file-json-set",
          file: "config/constants.json",
          pointer: "/schedules",
          // Nothing saved yet, so the first write says so as its guard.
          expectAbsent: true,
          value: { pull: { enabled: true, cron: "15 9 * * *", timezone: zone } },
        },
      ],
    });
    const row = document.querySelector('[data-schedule-row="pull"]') as HTMLElement;
    const saved = await waitFor(() => {
      const found = row.querySelector('[data-save-state="saved"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    // Undo is the same write reversed: a first write undoes into a delete of
    // exactly what it wrote.
    fireEvent.click(within(saved).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect((await lastPut(calls)).body).toMatchObject({
      ops: [
        {
          kind: "file-json-delete",
          file: "config/constants.json",
          pointer: "/schedules",
          expect: { pull: { enabled: true, cron: "15 9 * * *", timezone: zone } },
        },
      ],
    });
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("guards a second row's pick by what the first just wrote, before the page's read catches up", async () => {
    const saved = { clarity: { enabled: true, cron: "30 4 * * *" } };
    state.settings = payload({
      collection: { ...payload().collection, schedules: saved },
    });
    const calls = stubFetch();
    renderPage();

    fireEvent.change(screen.getByRole("combobox", { name: "Local research summaries · how often" }), {
      target: { value: "paused" },
    });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    const first = { ...saved, "panel-refresh": { enabled: false, cron: "10 13 * * *" } };
    expect((await lastPut(calls)).body).toMatchObject({
      ops: [{ kind: "file-json-set", pointer: "/schedules", expect: saved, value: first }],
    });
    await waitFor(() =>
      expect(document.querySelector('[data-schedule-row="panel-refresh"] [data-save-state="saved"]')).not.toBeNull(),
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Nightly reports · how often" }), {
      target: { value: "paused" },
    });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect((await lastPut(calls)).body).toMatchObject({
      ops: [{ kind: "file-json-set", pointer: "/schedules", expect: first, value: { ...first, pull: { enabled: false, cron: "30 2 * * *" } } }],
    });
  });

  it("says a refused schedule save beside its row", async () => {
    stubFetch({ status: 409, body: { error: "expect_mismatch" } });
    renderPage();

    fireEvent.change(screen.getByRole("combobox", { name: "Live traffic and counters · how often" }), {
      target: { value: "paused" },
    });

    const row = document.querySelector('[data-schedule-row="counters"]') as HTMLElement;
    expect(await within(row).findByRole("alert")).toHaveTextContent("Not saved");
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("saves the panel window at its own pointer inside the refresh block", async () => {
    const calls = stubFetch();
    renderPage();

    const field = screen.getByRole("spinbutton", { name: /Panel history window/ });
    fireEvent.change(field, { target: { value: "60" } });
    fireEvent.click(saveBeside(field));

    expect((await lastPut(calls)).body).toMatchObject({
      ops: [
        {
          kind: "file-json-set",
          file: "config/signal-panels.json",
          pointer: "/refresh/windowDays",
          expect: 35,
          value: 60,
        },
      ],
    });
  });

  it("refuses a value the declaration refuses, naming the field, without calling the lane", () => {
    const calls = stubFetch();
    renderPage();

    const field = screen.getByRole("spinbutton", { name: /Panel history window/ });
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.click(saveBeside(field));

    // The declaration's own sentence — the same one a 422 would have carried,
    // naming the field by the label beside the input (bead ro-ujb9.154).
    expect(screen.getByText("Panel history window must be at least 1")).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("states what changing each cadence costs, beside the field", () => {
    stubFetch();
    renderPage();

    // The cost is a value beside the field, not a consequence paragraph under
    // it (bead ro-ujb9.96.6.3).
    expect(document.querySelector("[data-knob-consequence]")).toBeNull();
    const historyWindow = document.querySelector('[data-collection-scale="panel-refresh-window"]')!;
    expect(historyWindow.querySelector("[data-collection-cost]")).toHaveTextContent("$0.00");
    expect(historyWindow).toHaveTextContent("5 weeks");
    // The freshness bar has to fit inside the window, which is the one thing the
    // number cannot say on its own — so it is the meter, and a ✓/✕ chip.
    const bar = document.querySelector('[data-collection-scale="panel-freshness-bar"]')!;
    const meter = within(bar as HTMLElement).getByRole("progressbar");
    expect(meter.getAttribute("aria-valuenow")).toBe("7");
    expect(meter.getAttribute("aria-valuemax")).toBe("35");
    expect(bar).toHaveTextContent("Fits the window");
  });

  it("marks a freshness bar that falls outside the window", () => {
    state.settings = payload({
      collection: {
        knobs: [
          { key: "panel-refresh-window", value: 5 },
          { key: "panel-freshness-bar", value: 7 },
        ],
        pullOwner: "config/pull.json",
        schedules: null,
        pullAssets: [],
      },
    });
    stubFetch();
    renderPage();
    const bar = document.querySelector('[data-collection-scale="panel-freshness-bar"]')!;
    expect(bar).toHaveTextContent("Outside the window");
  });

  it("renders no row for a knob the payload does not carry", () => {
    state.settings = payload({
      collection: {
        knobs: [],
        pullOwner: "config/pull.json",
        schedules: null,
        pullAssets: [],
      },
    });
    stubFetch();
    renderPage();

    expect(screen.queryByRole("spinbutton", { name: /Counter read interval/ })).toBeNull();
    // Absent, never a zero: nothing configured a window of nothing.
    expect(screen.queryByRole("spinbutton", { name: /Panel history window/ })).toBeNull();
    expect(document.querySelector('[data-collection-scale="panel-refresh-window"]')).toBeNull();
  });

  it("disables the cadence fields with the deployment's own sentence", () => {
    state.writable = { writable: false, reason: READ_ONLY_REASON };
    stubFetch();
    renderPage();

    const field = screen.getByRole("spinbutton", { name: /Panel history window/ });
    expect((field as HTMLInputElement).disabled).toBe(true);
    // Said ONCE for the screen (bead ro-p8qq); each field shows only its lock,
    // and every schedule pick is dark too.
    expect(pausedStatements()).toBe(1);
    expect(document.querySelector("[data-saves-paused]")).toHaveTextContent(READ_ONLY_REASON);
    const section = document.querySelector("#data-collection") as HTMLElement;
    expect(section.querySelectorAll("[data-knob-locked]")).toHaveLength(2);
    for (const pick of within(section.querySelector("[data-collection-schedules]") as HTMLElement).getAllByRole("combobox")) {
      expect(pick).toBeDisabled();
    }
  });
});

describe("/settings — the data-source catalog is not a setting (ro-ujb9.96.14)", () => {
  it("offers no catalog table, no Add and no section for it", () => {
    stubFetch();
    const { container } = renderPage();
    expect(container.querySelector("#data-sources")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Settings sections" }).querySelector('a[href="/settings#data-sources"]')).toBeNull();
    for (const section of ["general", "alert-rules", "data-collection", "tv-dashboard", "entities", "task-hub"]) {
      pickSection(section);
      expect(container.querySelector("[data-collection-row='ga4']"), `#${section}`).toBeNull();
      expect(screen.queryByText("Source catalog")).toBeNull();
    }
  });

  it("sends the catalog's old address to Integrations", () => {
    stubFetch();
    renderPage("data-sources");
    expect(screen.getByTestId("settings-location")).toHaveTextContent("/integrations");
  });
});

/**
 * /settings#alert-rules — what each rule has ALREADY cost (bead `ro-ayxy`).
 *
 * docs/15 flow E has promised a visible false-positive rate per rule since the
 * beginning; `ro-van6` shipped the write half (a save from the Tune panel
 * dispositions the alert `tune`) and nothing read it back. What is pinned here
 * is that the number on the page is the doc's arithmetic, that the two limits
 * the store imposes are STATED rather than hidden, and that a rule the store has
 * nothing to say about never gets a zero it did not measure.
 */
function ruleStats(
  rules: AlertRuleStatsPayload["rules"],
  windowDays = 90,
): AlertRuleStatsPayload {
  return {
    generatedAt: "2026-09-04T12:00:00.000Z",
    windowDays,
    since: "2026-06-06T12:00:00.000Z",
    rules,
  };
}

const RULE_ROW = {
  ruleId: "flow-poisson-low",
  fired: 5,
  settled: 3,
  tuned: 1,
  tunedOpen: 0,
  acknowledged: 1,
  resolved: 1,
  tunes: 0,
};

describe("/settings#alert-rules — how often each rule was answered by tuning", () => {
  beforeEach(() => { initialSection = "alert-rules"; });
  it("shows the rule, the share as a bar, and the counts the share is read from", () => {
    state.ruleStats = ruleStats([RULE_ROW]);
    stubFetch();
    const { container } = renderPage();

    const row = container.querySelector(
      "[data-alert-rule-row='flow-poisson-low']",
    ) as HTMLElement;
    // The operator's name for the rule leads; the id is evidence and rides in
    // the hover (docs/17 rule 4).
    expect(within(row).getByText("Drop at normal volume")).toBeTruthy();
    expect(within(row).getByTitle("flow-poisson-low")).toBeTruthy();

    // docs/15 flow E: of the three this rule produced that are finished with,
    // the operator answered one by making the rule quieter.
    expect(within(row).getByText("33%")).toBeTruthy();
    expect(within(row).getByText("1 of 3 settled")).toBeTruthy();
    expect(within(row).getByText(/5 fired in 90 days/)).toBeTruthy();

    // The figure carries its visual (doc 14): the share is a bar, and the bar
    // says the whole sentence to a screen reader.
    const bar = row.querySelector("[data-segment-bar]") as HTMLElement;
    expect(bar.getAttribute("aria-label")).toBe(
      "1 of 3 settled alerts from this rule were answered by tuning it",
    );
    expect(bar.querySelector("[data-segment='tuned']")).not.toBeNull();
  });

  /**
   * `ro-bgny`. docs/15 flow E's "rules above ~40% FP get auto-proposed for
   * tuning" was prose for as long as the doc has existed: the rate was measured
   * and rendered, and the operator was left to remember the threshold.
   */
  it("proposes quietening a rule that crosses the line, and never applies it", () => {
    state.ruleStats = ruleStats([
      // 5 of 8 settled — over 40%, and past the 5 settled alerts it waits for.
      { ...RULE_ROW, fired: 22, settled: 8, tuned: 5, acknowledged: 2, resolved: 1 },
    ]);
    stubFetch();
    const { container } = renderPage();

    const proposal = container.querySelector(
      "[data-tune-proposal='flow-poisson-low']",
    ) as HTMLElement;
    expect(within(proposal).getByText(/make this rule quieter/)).toBeTruthy();
    // The line it crossed is stated, not implied — a proposal nobody can argue
    // with is a proposal nobody can check. It is said once in the proposal and
    // DRAWN on the bar as a tick at 40%, beside the counts it was read from
    // (bead `ro-ujb9.96.6.7`: the paragraph that described it is the tick).
    expect(proposal.textContent).toMatch(/over 40%/);
    const row = container.querySelector("[data-alert-rule-row='flow-poisson-low']") as HTMLElement;
    const line = row.querySelector("[data-tune-rate-line]") as HTMLElement;
    expect(line.style.left).toBe("40%");
    expect(row.querySelector("[data-tune-rate-counts]")?.textContent).toBe("5 of 8 settled");

    // Guardrail settings are operator-only forever (AGENTS.md), so the
    // proposal's only controls are two answers — neither of them a setting.
    const answers = within(proposal).getAllByRole("button");
    expect(answers).toHaveLength(2);
    expect(within(proposal).getByRole("button", { name: /File task/ })).toBeTruthy();
    expect(
      within(proposal).getByRole("button", { name: "Keep it as it is" }),
    ).toBeTruthy();
    expect(proposal.querySelector("input")).toBeNull();
  });

  /**
   * The decline is deliberately the weaker of the two answers: it is a note
   * against THIS evidence, not a record, so the eleventh alert asks again. The
   * durable answers are the task and the tune itself — muting without a reason
   * does not exist here (docs/15 flow E).
   */
  it("takes 'keep it as it is' against the evidence it was shown for, not forever", () => {
    window.localStorage.clear();
    const crossing = {
      ...RULE_ROW,
      fired: 22,
      settled: 8,
      tuned: 5,
      acknowledged: 2,
      resolved: 1,
    };
    state.ruleStats = ruleStats([crossing]);
    stubFetch();
    const first = renderPage();

    fireEvent.click(
      within(
        first.container.querySelector("[data-tune-proposal]") as HTMLElement,
      ).getByRole("button", { name: "Keep it as it is" }),
    );
    expect(first.container.querySelector("[data-tune-proposal]")).toBeNull();
    first.unmount();

    // Same evidence on the next visit: still declined.
    state.ruleStats = ruleStats([crossing]);
    stubFetch();
    const again = renderPage();
    expect(again.container.querySelector("[data-tune-proposal]")).toBeNull();
    again.unmount();

    // One more tune and one more settled alert is a different question, and
    // the OS is entitled to ask it again.
    state.ruleStats = ruleStats([{ ...crossing, settled: 9, tuned: 6 }]);
    stubFetch();
    const later = renderPage();
    expect(later.container.querySelector("[data-tune-proposal]")).not.toBeNull();
    window.localStorage.clear();
  });

  it("says nothing about a rule whose share is over the line on too little evidence", () => {
    // 3 of 4 is 75% and the OS stays quiet: one more click either way moves
    // that share 25 points, which is not a rule's record, it is a coin.
    state.ruleStats = ruleStats([
      { ...RULE_ROW, fired: 6, settled: 4, tuned: 3, acknowledged: 1, resolved: 0 },
    ]);
    stubFetch();
    const { container } = renderPage();

    expect(within(
      container.querySelector("[data-alert-rule-row='flow-poisson-low']") as HTMLElement,
    ).getByText("75%")).toBeTruthy();
    expect(container.querySelector("[data-tune-proposal]")).toBeNull();
  });

  it("prints no methodology caveat under the rules — the counts say what they count", () => {
    // Bead `ro-ujb9.96.6.7`. A once-per-surface caveat paragraph ("Still a
    // floor: one decision covers every open firing…", plus a task link about a
    // migration) sat under the list. It was methodology, not something the
    // operator acts on; each row's counts already say "N of M settled".
    state.ruleStats = ruleStats([
      RULE_ROW,
      { ...RULE_ROW, ruleId: "ingest-freshness", tuned: 0, acknowledged: 2 },
    ]);
    stubFetch();
    const { container } = renderPage();

    const section = container.querySelector("#alert-rules") as HTMLElement;
    expect(section.querySelector("[data-tune-rate-caveat]")).toBeNull();
    expect(within(section).queryByRole("link", { name: "ro-6d1t" })).toBeNull();
    expect(section.textContent).not.toMatch(/Still a floor|tuned twice counts once/);
  });

  it("says how many times a rule was tuned", () => {
    state.ruleStats = ruleStats([{ ...RULE_ROW, tunes: 6 }], 90);
    stubFetch();
    const { container } = renderPage();

    const row = container.querySelector(
      "[data-alert-rule-row='flow-poisson-low']",
    ) as HTMLElement;
    expect(within(row).getByText(/Tuned 6 times in 90 days/)).toBeTruthy();
  });

  it("prints no tune count when no decision was recorded", () => {
    state.ruleStats = ruleStats([RULE_ROW]);
    stubFetch();
    const { container } = renderPage();

    const row = container.querySelector(
      "[data-alert-rule-row='flow-poisson-low']",
    ) as HTMLElement;
    expect(row.querySelector("[data-tune-rate-tunes]")).toBeNull();
    expect(row.textContent).not.toMatch(/Tuned 0 times/);
  });

  it("names tunes that are not settled yet instead of counting them as 0%", () => {
    // A tune leaves its alert OPEN by design, and a tuned alert then snoozed is
    // parked, so an answer the operator has already given sits outside the rate
    // until the alert settles (bead ro-ujb9.194: a snooze is not settled).
    state.ruleStats = ruleStats([
      { ...RULE_ROW, fired: 4, settled: 1, tuned: 0, tunedOpen: 2, acknowledged: 1, resolved: 0 },
    ]);
    stubFetch();
    const { container } = renderPage();

    const row = container.querySelector(
      "[data-alert-rule-row='flow-poisson-low']",
    ) as HTMLElement;
    expect(within(row).getByText("+2 tuned, not settled")).toBeTruthy();
  });

  it("says a rule with alerts but nothing settled has no rate YET, and draws no bar", () => {
    state.ruleStats = ruleStats([
      { ...RULE_ROW, fired: 3, settled: 0, tuned: 0, tunedOpen: 0, acknowledged: 0, resolved: 0 },
    ]);
    stubFetch();
    const { container } = renderPage();

    const row = container.querySelector(
      "[data-alert-rule-row='flow-poisson-low']",
    ) as HTMLElement;
    expect(within(row).getByText(/none settled yet/)).toBeTruthy();
    // An empty track would read as a measured zero — the one thing the store
    // cannot say yet.
    expect(row.querySelector("[data-segment-bar]")).toBeNull();
  });

  it("designs the empty state: no rule has fired, so no rule has a record", () => {
    state.ruleStats = ruleStats([]);
    stubFetch();
    const { container } = renderPage();

    const section = container.querySelector("#alert-rules") as HTMLElement;
    // One calm line under the block's "last 90 days" header, which already
    // names the window.
    const record = section.querySelector("[data-alert-rule-record]") as HTMLElement;
    expect(record).toHaveTextContent("last 90 days");
    expect(within(record).getByText("No rule has fired")).toBeTruthy();
    expect(section.querySelector("[data-alert-rule-row]")).toBeNull();
    // The fields the section exists for are untouched by an empty store.
    expect(within(section).getAllByLabelText(/Anomaly sensitivity/).length).toBeGreaterThan(0);
  });

  it("says the record is unknown when the store did not answer, and keeps the fields", () => {
    state.ruleStatsError = true;
    stubFetch();
    const { container } = renderPage();

    const section = container.querySelector("#alert-rules") as HTMLElement;
    expect(section.querySelector('[data-alert-rule-record="unavailable"]')).toHaveTextContent(
      "Tuning history unavailable",
    );
    // The settings payload is built from config alone precisely so this is true.
    expect(within(section).getAllByLabelText(/Anomaly sensitivity/).length).toBeGreaterThan(0);
  });
});

// --- Entities (bead `ro-aodz`) ----------------------------------------------
//
// The section owns the entity; the ASSET's own page owns which entity owns it.
// That split is the design and not a gap: an asset belongs to exactly one
// entity, no field of one row can see another, and a list typed into two rows
// would claim the same asset twice with nothing to catch it. So the assets
// column is not offered here, and what this section owes instead is the READ —
// who owns what, and which assets nobody has claimed.

function entities(): HTMLElement {
  return document.querySelector("#entities") as HTMLElement;
}

describe("/settings — who owns what", () => {
  beforeEach(() => { initialSection = "entities"; });
  it("edits the entity and never its asset list", () => {
    stubFetch();
    renderPage();

    const table = entities().querySelector("[data-collection-editor='entities']") as HTMLElement;
    for (const column of ["Id", "Name", "Legal form", "Registered in"]) {
      expect(within(table).getAllByText(column).length).toBeGreaterThan(0);
    }
    // The declared column this surface deliberately does not offer.
    expect(within(table).queryByText("Sites")).toBeNull();
  });

  it("draws the ownership map, and says which assets nobody has claimed", () => {
    state.integrations = matrix(
      11.4,
      "2026-09",
      assetRefs("meals.example", "nosh.example", "areas.example"),
    );
    stubFetch();
    renderPage();

    const map = entities().querySelector("[data-entity-ownership]") as HTMLElement;
    expect(within(map).getByText("Reindex Ventures LLC")).toBeTruthy();
    expect(within(map).getByText("meals.example")).toBeTruthy();

    // The two assets the fixture's one entity does not own.
    const unclaimed = map.querySelector("[data-entity-unowned]") as HTMLElement;
    expect(unclaimed.getAttribute("data-entity-unowned")).toBe("2");
    // Each asset points at the card that changes it — this page never does.
    expect(within(unclaimed).getByText("nosh.example").closest("a")?.getAttribute("href")).toBe(
      "/assets/nosh.example/settings",
    );
  });

  it("says nothing about unclaimed assets until the asset list has answered", () => {
    // An empty list is "nothing answered", and a page that drew it as an
    // all-clear would be claiming every asset is owned on the strength of a
    // read that never landed.
    state.integrations = matrix(11.4, "2026-09", []);
    stubFetch();
    renderPage();

    expect(entities().querySelector("[data-entity-unowned]")).toBeNull();
  });

  it("adds an entity as one insert, and the Undo takes it out again", async () => {
    const calls = stubFetch();
    renderPage();

    fireEvent.click(within(entities()).getByRole("button", { name: "Add" }));
    fireEvent.change(within(addForm()).getByLabelText("Id"), { target: { value: "second-co" } });
    fireEvent.change(within(addForm()).getByLabelText("Name"), { target: { value: "Second Co" } });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    // No `assets` key: an entity that owns nothing yet is a real state, and an
    // empty list would be a claim nobody has made.
    const added = { slug: "second-co", name: "Second Co" };
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({
      ops: [
        {
          kind: "file-json-insert",
          file: "config/entities.json",
          pointer: "/entities/-",
          value: added,
        },
      ],
    });

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const undo = toasts.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    undo.action.onClick();
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PUT")[1]!.body).toMatchObject({
      ops: [
        {
          kind: "file-json-delete",
          file: "config/entities.json",
          pointer: "/entities/1",
          expect: added,
        },
      ],
    });
  });

  it("does not offer to rename the id an entity is filed under", () => {
    stubFetch();
    renderPage();

    const row = document.querySelector("[data-collection-row='reindex-ventures']") as HTMLElement;
    // The name is editable; the id it is filed under is not, and wears the
    // lock and its state rather than a sentence (bead `ro-ujb9.96.6.17`).
    expect(within(row).getByLabelText("Name")).toBeTruthy();
    expect(within(row).queryByLabelText("Id")).toBeNull();
    expect(row.querySelector("[data-collection-fixed='slug']")).toHaveAttribute("title", "Fixed once added");
    expect(within(entities()).queryByText(/a rename re-labels history/)).toBeNull();
  });
});
