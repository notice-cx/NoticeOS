// The connect panel's site list and Start collecting: a domain match is a
// suggestion, ticked, never written before Start; nothing is dropped; Start
// writes exactly the operations the asset's Data sources tab writes
// (`laneFieldOp`, shared/lane-mapping-ops.ts), and nothing already saved.

import { act, fireEvent, render, screen, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { CollectNowResult, DiscoveredSite, SiteDiscovery } from "@noticeos/contract";
import { integrationProvider } from "@noticeos/contract";
import { laneFieldOp } from "@shared/lane-mapping-ops";
import { declineOps } from "@shared/lane-decline";
import {
  initialSelection,
  planSites,
  rowDecision,
  spendFor,
  startPlan,
  unclaimedSites,
  type SitesAsset,
  type SitesPayload,
} from "@shared/site-discovery";
import { marketLabel } from "@shared/site-markets";
import { SitePicker } from "@/components/SitePicker";
import { handleSitesRequest, loadSitesAssets } from "../worker/site-discovery-route";
import { loadSpendPreview } from "../worker/metered-spend";
import { createTestStore } from "./postgres-store";
import { writeArchiveRuns, type TestArchiveRun } from "./provider-reports";
import { addSites } from "./sites";

const BING = integrationProvider("bing-webmaster")!;
const DATAFORSEO = integrationProvider("dataforseo")!;
const AT = "2026-09-23T15:00:00.000Z";

const bingSite = (url: string, ready = true): DiscoveredSite => ({
  lane: "bing-webmaster", ref: url, label: url, host: new URL(url).hostname.replace(/^www\./, ""), mapping: { siteUrl: url }, ready,
});
const asset = (id: string, over: Partial<SitesAsset> = {}): SitesAsset => ({
  id, label: id.split(".")[0]!.replace(/^./, (c) => c.toUpperCase()), domain: id, status: "live",
  cells: { "bing-webmaster": { status: "needs-setup", mapping: {} } }, ...over,
});
const account = (sites: DiscoveredSite[]): SiteDiscovery => ({ ok: true, provider: "bing-webmaster", kind: "account", checkedAt: AT, sites });

const PAYLOAD: SitesPayload = {
  discovery: account([
    bingSite("https://journey.example/"),
    bingSite("https://blog.journey.example/", false),
    bingSite("https://shop.example/"),
    bingSite("https://mapped.example/"),
  ]),
  assets: [
    asset("second.example"),
    asset("journey.example"),
    asset("mapped.example", { cells: { "bing-webmaster": { status: "needs-setup", mapping: { siteUrl: "https://mapped.example/" } } } }),
    asset("declined.example", { cells: { "bing-webmaster": { status: "skipped", mapping: {} } } }),
  ],
  spend: null,
  // Bing's job collects an unmapped asset by its own domain.
  domainMatch: ["bing-webmaster"],
};

/** Mediavine: the account's sites, each mapped by its id. */
const mediavineSite = (id: string, domain: string): DiscoveredSite => ({
  lane: "ad-network", ref: id, label: domain, host: domain, mapping: { mediavineSiteId: id }, ready: true,
});
const MEDIAVINE_PAYLOAD: SitesPayload = {
  discovery: { ok: true, provider: "mediavine", kind: "account", checkedAt: AT, sites: [mediavineSite("mv-journey", "journey.example"), mediavineSite("mv-mapped", "mapped.example")] },
  assets: [
    asset("journey.example", { cells: { "ad-network": { status: "needs-setup", note: "", mapping: {} } } }),
    asset("mapped.example", { cells: { "ad-network": { status: "needs-setup", note: "", mapping: { mediavineSiteId: "mv-mapped" } } } }),
  ],
  spend: null,
  domainMatch: [],
};

describe("matching an account's sites to the portfolio", () => {
  it("ticks the domain matches and the already-mapped site, and lists everything else", () => {
    const plan = planSites(PAYLOAD);
    const byId = Object.fromEntries(plan.rows.map((row) => [row.asset.id, row]));
    expect(byId["journey.example"]).toMatchObject({ checked: true, excluded: null, lanes: [{ state: "matched", site: { ref: "https://journey.example/" } }] });
    expect(byId["mapped.example"]).toMatchObject({ checked: true, lanes: [{ state: "mapped" }] });
    expect(byId["second.example"]).toMatchObject({ checked: false, excluded: null, lanes: [{ state: "unlisted", site: null }] });
    expect(byId["second.example"]!.lanes[0]!.choices.map((site) => site.ref)).toEqual(["https://shop.example/"]);
    expect(byId["declined.example"]).toMatchObject({ checked: false, excluded: "not-using" });
    expect(plan.others.map((site) => site.ref)).toEqual(["https://blog.journey.example/", "https://shop.example/"]);
    expect(plan.rows.map((row) => row.asset.id)).toEqual(["journey.example", "mapped.example", "second.example", "declined.example"]);
  });

  it("leads with the asset the panel was opened for, ticked when it can be collected", () => {
    const plan = planSites(PAYLOAD, "journey.example");
    expect(plan.rows[0]).toMatchObject({ asset: { id: "journey.example" }, preselected: true, checked: true });
    const unlisted = planSites(PAYLOAD, "second.example");
    expect(unlisted.rows[0]).toMatchObject({ asset: { id: "second.example" }, preselected: true, checked: false });
  });

  it("never ticks a site the provider will not serve yet", () => {
    const plan = planSites({ ...PAYLOAD, discovery: account([bingSite("https://journey.example/", false)]), assets: [asset("journey.example")] });
    expect(plan.rows[0]).toMatchObject({ checked: false, lanes: [{ state: "not-ready" }] });
    expect(startPlan(plan, initialSelection(plan))).toEqual({ ops: [], assets: [], declined: [] });
  });

  it("lists a portfolio provider's own candidates with their market, and says why an asset is left out", () => {
    const plan = planSites({
      discovery: { ok: true, provider: "dataforseo", kind: "portfolio", checkedAt: AT, sites: [
        { lane: "dataforseo", ref: "journey.example", label: "journey.example", host: "journey.example", mapping: {}, asset: "journey.example", ready: true },
      ] },
      assets: [
        asset("journey.example", { cells: { dataforseo: { status: "needs-setup", mapping: { locationCode: 2826 } } } }),
        asset("fees.example", { status: "pre-launch", cells: { dataforseo: { status: "needs-setup", mapping: {} } } }),
      ],
      spend: null,
    });
    expect(plan.rows.map((row) => [row.asset.id, row.checked, row.excluded])).toEqual([["journey.example", true, null], ["fees.example", false, "pre-launch"]]);
    expect(marketLabel({ locationCode: 2826, languageCode: "en" })).toBe("United Kingdom · English");
    expect(plan.others).toEqual([]);
  });
});

describe("Start writes what the Data sources tab writes", () => {
  it("builds the tab's own op for each confirmed site and skips what is already saved", () => {
    const plan = planSites(PAYLOAD);
    const { ops, assets } = startPlan(plan, initialSelection(plan));
    expect(assets).toEqual(["journey.example", "mapped.example"]);
    expect(ops).toEqual([laneFieldOp("journey.example", "bing-webmaster", "siteUrl", null, "https://journey.example/")]);
    expect(ops[0]).toEqual({
      kind: "file-json-set", file: "config/integrations.json", pointer: "/assets/journey.example/bing-webmaster/siteUrl",
      expectAbsent: true, value: "https://journey.example/",
    });
  });

  it("writes the site the operator picked for an asset the account lists nothing for", () => {
    const plan = planSites(PAYLOAD);
    const selection = initialSelection(plan);
    const picked = { checked: new Set([...selection.checked, "second.example"]), picks: { "second.example": { "bing-webmaster": "https://shop.example/" } } };
    const { ops, assets } = startPlan(plan, picked);
    expect(assets).toContain("second.example");
    expect(ops).toContainEqual(laneFieldOp("second.example", "bing-webmaster", "siteUrl", null, "https://shop.example/"));
    expect(unclaimedSites(plan, picked).map((site) => site.ref)).toEqual(["https://blog.journey.example/"]);
  });

  it("writes nothing for a row the operator unticked and gave no reason — it stays on the schedule", () => {
    const plan = planSites(PAYLOAD);
    const unticked = { checked: new Set<string>(), picks: {} };
    expect(startPlan(plan, unticked)).toEqual({ ops: [], assets: [], declined: [] });
    // Both rows the scheduled job collects anyway say so.
    const byId = Object.fromEntries(plan.rows.map((row) => [row.asset.id, rowDecision(row, unticked)]));
    expect(byId).toEqual({ "journey.example": "undecided", "mapped.example": "undecided", "second.example": null, "declined.example": null });
  });

  // Unticked is not declined: a matched row the operator unticks and gives a
  // reason is saved as the Data sources row's own Not using, in the same press.
  it("saves an unticked matched row given a reason as Not using, in the same press", () => {
    const withNote: SitesPayload = {
      ...PAYLOAD,
      assets: PAYLOAD.assets.map((entry) => entry.id === "journey.example"
        ? { ...entry, cells: { "bing-webmaster": { status: "needs-setup", note: "", mapping: {} } } }
        : entry),
    };
    const plan = planSites(withNote);
    const selection = initialSelection(plan);
    const chosen = {
      ...selection,
      checked: new Set([...selection.checked].filter((id) => id !== "journey.example")),
      declined: { "journey.example": "Replaced by another tool" },
    };
    expect(plan.rows.map((row) => rowDecision(row, chosen))).toEqual(["not-using", "collect", null, null]);
    const { ops, assets, declined } = startPlan(plan, chosen);
    expect(assets).toEqual(["mapped.example"]);
    expect(declined).toEqual(["journey.example"]);
    expect(ops).toEqual(declineOps("journey.example", "bing-webmaster", { status: "needs-setup", note: "" }, "Replaced by another tool"));
    expect(ops).toEqual([
      { kind: "file-json-set", file: "config/integrations.json", pointer: "/assets/journey.example/bing-webmaster/note", expect: "", value: "REASON: Replaced by another tool" },
      { kind: "file-json-set", file: "config/integrations.json", pointer: "/assets/journey.example/bing-webmaster/status", expect: "needs-setup", value: "skipped" },
    ]);
    expect(rowDecision(plan.rows[0]!, { ...chosen, checked: new Set([...chosen.checked, "journey.example"]) })).toBe("collect");
  });
});

describe("Mediavine's sites", () => {
  it("ticks the site on the asset's domain and the one already mapped, and Start writes only the new site id", () => {
    const plan = planSites(MEDIAVINE_PAYLOAD);
    expect(plan.rows.map((row) => [row.asset.id, row.checked, row.lanes[0]!.state])).toEqual([
      ["journey.example", true, "matched"], ["mapped.example", true, "mapped"],
    ]);
    const { ops, assets } = startPlan(plan, initialSelection(plan));
    expect(assets).toEqual(["journey.example", "mapped.example"]);
    expect(ops).toEqual([laneFieldOp("journey.example", "ad-network", "mediavineSiteId", null, "mv-journey")]);
  });

  it("treats a domain match as a suggestion: unticked, it is simply not collected and asks for no reason", () => {
    const plan = planSites(MEDIAVINE_PAYLOAD);
    const unticked = { checked: new Set<string>(), picks: {} };
    expect(plan.rows.map((row) => [row.asset.id, row.scheduled, rowDecision(row, unticked)])).toEqual([
      ["journey.example", false, null], ["mapped.example", true, "undecided"],
    ]);
    expect(startPlan(plan, unticked)).toEqual({ ops: [], assets: [], declined: [] });
  });

  it("reads the saved site id into the row, though no card field declares it, and says no lane falls back to a domain", async () => {
    const binding = { discoverSites: vi.fn(async () => MEDIAVINE_PAYLOAD.discovery), collectNow: vi.fn() };
    const ctx = await createTestStore();
    await addSites(ctx, [{ id: "mapped.example", displayName: "Mapped", status: "live" }]);
    const res = await handleSitesRequest(new Request("http://t/x"), new URL("http://t/x"), {
      ingest: binding, store: ctx.call, spend: vi.fn(),
      config: async () => ({ integrations: { catalog: [], assets: { "mapped.example": { "ad-network": { status: "needs-setup" as const, note: "", since: "2026-09-23", mediavineSiteId: "mv-mapped" } } } }, capUsd: 25 }),
    }, "mediavine", "sites");
    const body = (await res.json()) as SitesPayload;
    expect(body.assets[0]!.cells["ad-network"]).toMatchObject({ mapping: { mediavineSiteId: "mv-mapped" } });
    expect(body.domainMatch).toEqual([]);
    expect(planSites(body).rows[0]!.lanes[0]!.state).toBe("mapped");
  });
});

describe("the spend a metered provider states before its first collection", () => {
  it("averages one site's recorded week from the cost records and bounds a first run by the reserve", async () => {
    const ctx = await createTestStore();
    await addSites(ctx, ["a.test", "b.test"].map((id) => ({ id, displayName: id, status: "live" })));
    const runs: TestArchiveRun[] = [];
    for (const [site, date, cost] of [["a.test", "2026-09-14", 0.4], ["a.test", "2026-09-21", 0.6], ["b.test", "2026-09-21", 0.5]] as const) {
      for (const share of [0.5, 0.5]) {
        const n = runs.length + 1;
        runs.push({
          id: `r${n}`, asset: site, integration: "dataforseo", report: `report-${n}`, credential_ref: "cred",
          report_date: date, requested_at: `${date}T12:45:00.000Z`, finished_at: `${date}T12:46:00.000Z`,
          data_state: "provider-final", provider_rows: 1, request_count: 1, object_key: `dumps/${n}.json.gz`,
          content_sha256: "a".repeat(64), object_bytes: 1024, provider_cost_usd: cost * share,
        });
      }
    }
    const store = ctx.call;
    await writeArchiveRuns(store, runs);
    const spend = await loadSpendPreview(store, new Date(AT), 25);
    expect(spend.period).toBe("2026-09");
    expect(spend.spentUsd).toBeCloseTo(1.5);
    expect(spend.perSiteWeekUsd).toBeCloseTo(0.5);
    expect(spend.perSiteCeilingUsd).toBe(2.5);
    expect(spendFor(spend, 3)).toMatchObject({ ceilingUsd: 7.5 });
    expect(spendFor(spend, 3).weekUsd).toBeCloseTo(1.5);
    const empty = await loadSpendPreview((await createTestStore()).call, new Date(AT), 25);
    expect(empty.perSiteWeekUsd).toBeNull();
  });
});

describe("the sites and collect routes", () => {
  const ingest = (discovery: SiteDiscovery, collected?: CollectNowResult) => ({
    discoverSites: vi.fn(async () => discovery),
    collectNow: vi.fn(async () => collected ?? ({ ok: false, provider: "bing-webmaster", error: "paused", job: "pull" } as const)),
  });
  const deps = async (binding: ReturnType<typeof ingest>) => {
    const ctx = await createTestStore();
    await addSites(ctx, [
      { id: "journey.example", displayName: "Journey Example", status: "live" },
      { id: "old.example", displayName: "Old", status: "retired" },
    ]);
    return {
      ingest: binding, store: ctx.call,
      config: async () => ({ integrations: { catalog: [], assets: { "journey.example": { "bing-webmaster": { status: "needs-setup" as const, note: "", since: "2026-09-23", siteUrl: "https://journey.example/" } } } }, capUsd: 25 }),
      spend: vi.fn(async () => ({ period: "2026-09", spentUsd: 0, unknownPrices: 0, capUsd: 25, perSiteWeekUsd: null, perSiteCeilingUsd: 2.5 })),
    };
  };

  it("answers the account's sites beside the portfolio's live assets and their saved mapping", async () => {
    const binding = ingest(account([bingSite("https://journey.example/")]));
    const d = await deps(binding);
    const res = await handleSitesRequest(new Request("http://t/api/integrations/bing-webmaster/sites"), new URL("http://t/api/integrations/bing-webmaster/sites"), d, "bing-webmaster", "sites");
    const body = (await res.json()) as SitesPayload;
    expect(res.status).toBe(200);
    expect(body.assets).toEqual([{ id: "journey.example", label: "Journey Example", domain: "journey.example", status: "live",
      cells: { "bing-webmaster": { status: "needs-setup", note: "", mapping: { siteUrl: "https://journey.example/" } } } }]);
    expect(body.spend).toBeNull();
    expect(body.domainMatch).toEqual(["bing-webmaster"]);
    expect(d.spend).not.toHaveBeenCalled();
    const metered = await handleSitesRequest(new Request("http://t/x"), new URL("http://t/x"), await deps(ingest({ ok: true, provider: "dataforseo", kind: "portfolio", checkedAt: AT, sites: [] })), "dataforseo", "sites");
    expect(((await metered.json()) as SitesPayload).spend).toMatchObject({ perSiteCeilingUsd: 2.5 });
  });

  it("passes a press to the ingest and returns its answer, refusals included", async () => {
    const binding = ingest(account([]));
    const url = new URL("http://t/api/integrations/bing-webmaster/collect");
    const press = async (body: unknown, headers: Record<string, string> = {}) => handleSitesRequest(
      new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), url, await deps(binding), "bing-webmaster", "collect");
    const res = await press({ assets: ["journey.example"] });
    expect(await res.json()).toEqual({ ok: false, provider: "bing-webmaster", error: "paused", job: "pull" });
    expect(binding.collectNow).toHaveBeenCalledWith({ provider: "bing-webmaster", assets: ["journey.example"] });
    expect((await press({ assets: "journey.example" })).status).toBe(422);
    expect((await press({ assets: ["x"] }, { origin: "http://elsewhere" })).status).toBe(403);
    const unknown = await handleSitesRequest(new Request(url, { method: "POST" }), url, await deps(binding), "nope", "collect");
    expect(unknown.status).toBe(404);
  });

  it("reads every non-retired asset and nothing for a lane it has no cell on", async () => {
    const ctx = await createTestStore();
    await addSites(ctx, [{ id: "n.example", domain: null, displayName: "N", status: "pre-launch" }]);
    expect(await loadSitesAssets(ctx.call, { catalog: [], assets: {} }, ["bing-webmaster"])).toEqual([
      { id: "n.example", label: "N", domain: null, status: "pre-launch", cells: { "bing-webmaster": null } },
    ]);
  });
});

describe("the picker", () => {
  function renderPicker(over: Partial<Parameters<typeof SitePicker>[0]> = {}) {
    const onStart = vi.fn(async (): Promise<CollectNowResult | null> => ({
      ok: true, provider: "bing-webmaster", job: "pull", startedAt: AT, finishedAt: AT,
      sites: [{ asset: "journey.example", outcome: "collected", code: null }],
    }));
    const utils = render(
      <MemoryRouter>
        <SitePicker provider={BING} payload={PAYLOAD} onStart={onStart} onClose={() => {}} {...over} />
      </MemoryRouter>,
    );
    return { ...utils, onStart };
  }

  it("draws each asset once, the unmatched sites under them, and counts what Start will collect", () => {
    renderPicker();
    const rows = screen.getAllByRole("listitem").filter((item) => item.hasAttribute("data-site-row"));
    expect(rows.map((row) => row.getAttribute("data-site-row"))).toEqual(["journey.example", "mapped.example", "second.example", "declined.example"]);
    expect(within(rows[2]!).getByRole("combobox", { name: "Site for Second" })).toBeTruthy();
    expect(within(rows[3]!).getByText("Not using")).toBeTruthy();
    expect(screen.getByText("https://blog.journey.example/")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Start collecting/ }).textContent).toBe("Start collecting · 2 sites");
  });

  it("offers the provider's own place to add a site the account does not hold", () => {
    renderPicker({ payload: { ...PAYLOAD, discovery: account([bingSite("https://journey.example/")]) } });
    const row = document.querySelector('[data-site-row="second.example"]') as HTMLElement;
    expect(within(row).getByText("Not in this account")).toBeTruthy();
    expect(within(row).getByRole("link", { name: /Add in Bing/ }).getAttribute("href")).toBe("https://www.bing.com/webmasters/");
    expect(within(row).getByRole("checkbox")).toHaveProperty("disabled", true);
  });

  it("starts with the ticked rows, then shows each one's status from the connection model", async () => {
    const { onStart } = renderPicker({ siteStatus: (id) => (id === "journey.example" ? { kind: "working", site: null } : null) });
    fireEvent.click(screen.getByRole("checkbox", { name: /Mapped/ }));
    expect(screen.getByRole("button", { name: /Start collecting/ }).textContent).toBe("Start collecting · 1 site");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Start collecting/ })); });
    expect(onStart).toHaveBeenCalledWith({ ops: [laneFieldOp("journey.example", "bing-webmaster", "siteUrl", null, "https://journey.example/")], assets: ["journey.example"], declined: [] });
    const started = document.querySelector('[data-sites-phase="started"]')!;
    expect(started.querySelector('[data-status-for="site:bing-webmaster:journey.example"][data-connection="working"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: /Open Journey/ }).getAttribute("href")).toBe("/assets/journey.example");
  });

  it("says an unticked matched row is still collected, and saves it as Not using once a reason is picked", async () => {
    const { onStart } = renderPicker();
    const row = () => document.querySelector('[data-site-row="journey.example"]') as HTMLElement;
    fireEvent.click(within(row()).getByRole("checkbox"));
    expect(row().dataset.siteDecision).toBe("undecided");
    expect(within(row()).getByText("Still collected")).toBeTruthy();
    const chips = within(row()).getByRole("group", { name: "Why not use Journey?" });
    expect(within(chips).queryAllByRole("button", { pressed: true })).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Start collecting/ }).textContent).toBe("Start collecting · 1 site");

    fireEvent.click(within(chips).getByRole("button", { name: "Not relevant for this site" }));
    expect(row().dataset.siteDecision).toBe("not-using");
    expect(within(row()).getByText("Not using")).toBeTruthy();
    expect(within(row()).queryByText("Still collected")).toBeNull();
    expect(screen.getByRole("button", { name: /Start collecting/ }).textContent).toBe("Start collecting · 1 site · 1 not using");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Start collecting/ })); });
    expect(onStart).toHaveBeenCalledWith({
      ops: declineOps("journey.example", "bing-webmaster", { status: "needs-setup", note: null }, "Not relevant for this site"),
      assets: ["mapped.example"],
      declined: ["journey.example"],
    });
    const started = document.querySelector('[data-sites-phase="started"]')!;
    expect(started.querySelector('[data-site-row="journey.example"] [data-connection="not-using"]')).not.toBeNull();
    expect(within(started as HTMLElement).getByText("Not relevant for this site")).toBeTruthy();
  });

  it("saves a press that only declines, and collects nothing", async () => {
    const onStart = vi.fn(async (): Promise<"saved"> => "saved");
    renderPicker({ onStart });
    fireEvent.click(screen.getByRole("checkbox", { name: /Mapped/ }));
    const row = document.querySelector('[data-site-row="journey.example"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("checkbox"));
    fireEvent.click(within(row).getByRole("button", { name: "Replaced by another tool" }));
    expect((document.querySelector('[data-site-row="mapped.example"]') as HTMLElement).dataset.siteDecision).toBe("undecided");
    const press = screen.getByRole("button", { name: /^Save/ });
    expect(press.textContent).toBe("Save · 1 not using");
    await act(async () => { fireEvent.click(press); });
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ assets: [], declined: ["journey.example"] }));
    expect(document.querySelector('[data-sites-phase="started"] [data-site-row="journey.example"] [data-connection="not-using"]')).not.toBeNull();
    expect(document.querySelector("[data-collect-refusal]")).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("gives Start the focus when its list arrives, unless the operator moved it while the list loaded", () => {
    // The panel's own control beside a list still being read.
    const panel = (payload: SitesPayload | undefined) => (
      <MemoryRouter>
        <button type="button">Replace API key</button>
        <SitePicker provider={BING} payload={payload} onStart={async () => null} onClose={() => {}} />
      </MemoryRouter>
    );
    const untouched = render(panel(undefined));
    untouched.rerender(panel(PAYLOAD));
    expect(document.activeElement?.textContent).toBe("Start collecting · 2 sites");
    untouched.unmount();

    // Tabbed to Replace while the list loaded: the list arriving leaves focus
    // there, so the next Enter presses Replace, not Start.
    const steered = render(panel(undefined));
    const replace = screen.getByRole("button", { name: "Replace API key" });
    fireEvent.keyDown(replace, { key: "Tab" });
    replace.focus();
    steered.rerender(panel(PAYLOAD));
    expect(document.activeElement).toBe(replace);
  });

  it("says why nothing ran, and shows no status it cannot prove", async () => {
    renderPicker({ onStart: async () => ({ ok: false, provider: "bing-webmaster", error: "paused", job: "pull" }) });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Start collecting/ })); });
    expect(document.querySelector('[data-collect-refusal="paused"]')?.textContent).toContain("Schedule paused");
    expect(document.querySelector('[data-site-row] [data-connection]')).toBeNull();
  });

  it("states a metered provider's spend before the press", () => {
    render(
      <MemoryRouter>
        <SitePicker
          provider={DATAFORSEO}
          payload={{
            discovery: { ok: true, provider: "dataforseo", kind: "portfolio", checkedAt: AT, sites: [
              { lane: "dataforseo", ref: "journey.example", label: "journey.example", host: "journey.example", mapping: {}, asset: "journey.example", ready: true },
            ] },
            assets: [asset("journey.example", { cells: { dataforseo: { status: "needs-setup", mapping: {} } } })],
            spend: { period: "2026-09", spentUsd: 3.1, unknownPrices: 0, capUsd: 25, perSiteWeekUsd: 0.45, perSiteCeilingUsd: 2.5 },
          }}
          onStart={async () => null}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("United States · English")).toBeTruthy();
    expect(document.querySelector("[data-spend-week]")?.textContent).toBe("≈ $0.45");
    expect(document.querySelector("[data-spend-month]")?.textContent).toBe("$3.10 of $25");
    expect(screen.getByRole("button", { name: /Start weekly reports/ }).textContent).toBe("Start weekly reports · 1 site");
  });

  it("keeps billing an unticked DataForSEO site in the weekly figure until it is declined", () => {
    const listed = (id: string) => ({ lane: "dataforseo", ref: id, label: id, host: id, mapping: {}, asset: id, ready: true });
    render(
      <MemoryRouter>
        <SitePicker
          provider={DATAFORSEO}
          payload={{
            discovery: { ok: true, provider: "dataforseo", kind: "portfolio", checkedAt: AT, sites: [listed("journey.example"), listed("second.example")] },
            assets: ["journey.example", "second.example"].map((id) => asset(id, { cells: { dataforseo: { status: "needs-setup", note: "", mapping: {} } } })),
            spend: { period: "2026-09", spentUsd: 0, unknownPrices: 0, capUsd: 25, perSiteWeekUsd: 0.5, perSiteCeilingUsd: 2.5 },
          }}
          onStart={async () => null}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    const second = document.querySelector('[data-site-row="second.example"]') as HTMLElement;
    fireEvent.click(within(second).getByRole("checkbox"));
    expect(document.querySelector("[data-spend-week]")?.textContent).toBe("≈ $1.00");
    expect(within(second).getByText("Still collected")).toBeTruthy();
    fireEvent.click(within(second).getByRole("button", { name: "Don't use this product" }));
    expect(document.querySelector("[data-spend-week]")?.textContent).toBe("≈ $0.50");
    expect(screen.getByRole("button", { name: /Start weekly reports/ }).textContent).toBe("Start weekly reports · 1 site · 1 not using");
  });
});

// --- PostHog: one account key, its projects, their saved funnels

describe("PostHog's projects in the panel", () => {
  const POSTHOG = integrationProvider("posthog")!;
  const SIGNUP = { id: "signup", name: "Signup", steps: [{ event: "$pageview" }, { event: "signed_up" }] };
  const project = (id: number, host: string | null, funnels?: typeof SIGNUP[]): DiscoveredSite => ({
    lane: "posthog", ref: `us:${id}`, label: host ?? "Staging", host, mapping: { host: "us", projectId: String(id) }, ready: true,
    ...(funnels ? { funnels } : {}),
  });
  const cell = (over: Record<string, unknown> = {}) => ({ posthog: { status: "needs-setup", mapping: {}, ...over } });
  const payload = (assets: SitesAsset[]): SitesPayload => ({
    discovery: { ok: true, provider: "posthog", kind: "account", checkedAt: AT, sites: [project(596607, "journey.example", [SIGNUP]), project(12, null)] },
    assets,
    spend: null,
  });

  it("matches a project by the domain it records and writes its region, id and saved funnels in one press", () => {
    const plan = planSites(payload([asset("journey.example", { cells: cell() })]));
    const { ops, assets } = startPlan(plan, initialSelection(plan));
    expect(assets).toEqual(["journey.example"]);
    expect(ops).toEqual([
      laneFieldOp("journey.example", "posthog", "host", null, "us"),
      laneFieldOp("journey.example", "posthog", "projectId", null, "596607"),
      laneFieldOp("journey.example", "posthog", "funnels", null, [SIGNUP] as never),
    ]);
  });

  it("never writes picked-up funnels over a list the site already holds", () => {
    const chosen = [{ id: "mine", name: "Mine", steps: [{ event: "a" }, { event: "b" }] }];
    const plan = planSites(payload([asset("journey.example", { cells: cell({ funnels: chosen }) })]));
    expect(startPlan(plan, initialSelection(plan)).ops.map((op) => op.pointer)).toEqual([
      "/assets/journey.example/posthog/host",
      "/assets/journey.example/posthog/projectId",
    ]);
    const empty = planSites(payload([asset("journey.example", { cells: cell({ funnels: [] }) })]));
    expect(startPlan(empty, initialSelection(empty)).ops.at(-1)).toEqual(laneFieldOp("journey.example", "posthog", "funnels", [], [SIGNUP] as never));
  });

  it("shows each project by its name and number, the funnels it brings, and the project no site claims", () => {
    render(
      <MemoryRouter>
        <SitePicker provider={POSTHOG} payload={payload([asset("journey.example", { cells: cell() })])} onStart={async () => null} onClose={() => {}} />
      </MemoryRouter>,
    );
    const row = document.querySelector('[data-site-row="journey.example"]') as HTMLElement;
    expect(row.querySelector("[data-site-detail]")?.textContent).toBe("journey.example · 596607");
    expect(within(row).getByText("1 funnel")).toBeTruthy();
    expect(within(row).getByRole("checkbox")).toHaveProperty("checked", true);
    expect(document.querySelector('[data-other-site="us:12"]')?.textContent).toContain("Staging");
  });
});

describe("Google's two kinds of site on one row", () => {
  const GOOGLE = integrationProvider("google")!;
  const ga4 = (id: string, host: string | null, label = host ?? "Untitled"): DiscoveredSite => ({
    lane: "ga4", ref: id, label, host, mapping: { propertyId: id }, ready: true,
  });
  const gsc = (url: string, host: string, ready = true): DiscoveredSite => ({
    lane: "gsc", ref: url, label: url, host, mapping: { siteUrl: url }, ready,
  });
  const cells = () => ({ ga4: { status: "needs-setup", mapping: {} }, gsc: { status: "needs-setup", mapping: {} } });
  const payload = (sites: DiscoveredSite[], assets: SitesAsset[]): SitesPayload => ({
    discovery: { ok: true, provider: "google", kind: "account", checkedAt: AT, sites },
    assets,
    spend: null,
  });

  it("matches the GA4 property and the Search Console site by the host each answers for, and writes both in one press", () => {
    const plan = planSites(payload(
      [ga4("313598867", "journey.example"), gsc("sc-domain:journey.example", "journey.example"), ga4("402211876", "another.example")],
      [asset("journey.example", { cells: cells() })],
    ));
    const { ops, assets } = startPlan(plan, initialSelection(plan));
    expect(assets).toEqual(["journey.example"]);
    expect(ops).toEqual([
      laneFieldOp("journey.example", "ga4", "propertyId", null, "313598867"),
      laneFieldOp("journey.example", "gsc", "siteUrl", null, "sc-domain:journey.example"),
    ]);
  });

  it("reads the row as the property's number and the site, and names each picker by what it picks", () => {
    render(
      <MemoryRouter>
        <SitePicker
          provider={GOOGLE}
          payload={payload(
            [ga4("313598867", "journey.example"), gsc("sc-domain:journey.example", "journey.example"), ga4("402211876", "another.example")],
            [asset("journey.example", { cells: cells() }), asset("second.example", { cells: cells() })],
          )}
          onStart={async () => null}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    const row = document.querySelector('[data-site-row="journey.example"]') as HTMLElement;
    expect(row.getAttribute("data-site-state")).toBe("matched matched");
    expect(row.querySelector("[data-site-detail]")?.textContent).toBe("GA4 313598867 · sc-domain:journey.example");
    const second = document.querySelector('[data-site-row="second.example"]') as HTMLElement;
    expect(within(second).getByRole("combobox", { name: "GA4 property for Second" })).toBeTruthy();
    expect(document.querySelector('[data-other-site="402211876"]')?.textContent).toContain("another.example");
  });
});
