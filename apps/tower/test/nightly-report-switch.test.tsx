// The asset Settings switch that declares "sends no nightly report" (bead
// ro-ujb9.96.8). What it writes is the whole contract with the rest of the
// OS: one list at config/constants.json /no_nightly_report, guarded by exactly
// what the page read, created by the first declaration and removed by its Undo.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetInfo, Wiring } from "@shared/asset-detail";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import { NightlyReportSwitch, noNightlyReportOps } from "@/routes/asset-detail/NightlyReportSwitch";
import { AssetSettingsPanel } from "@/routes/asset-detail/SettingsTab";
import { everyTabPayload, viewOf } from "./asset-detail-fixture";

const mock = vi.hoisted(() => ({ save: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), saveConfig: mock.save }));
vi.mock("sonner", () => ({ toast: { success: mock.success, error: mock.error, warning: vi.fn() } }));
vi.mock("@/hooks/useConfigWritable", () => ({ useConfigWritable: () => ({ writable: true, reason: null, sources: {} }) }));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ data: undefined }) }));

const FILE = "config/constants.json";
const POINTER = "/no_nightly_report";
let client: QueryClient;

function mount(asset: AssetInfo, wiring: Wiring) {
  return render(
    <QueryClientProvider client={client}>
      <NightlyReportSwitch asset={asset} wiring={wiring} />
    </QueryClientProvider>,
  );
}

function fixture(declarations: string[] | null) {
  const payload = everyTabPayload();
  return { asset: payload.asset, wiring: { ...payload.wiring, noReportDeclarations: declarations } };
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mock.save.mockResolvedValue({ applied: 1 });
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("noNightlyReportOps — the one write", () => {
  it("creates the list when nobody has declared yet", () => {
    expect(noNightlyReportOps("fees.example", null, true)).toEqual([
      { kind: "file-json-set", file: FILE, pointer: POINTER, expectAbsent: true, value: ["fees.example"] },
    ]);
  });

  it("adds to and takes from the saved list, guarded by it", () => {
    expect(noNightlyReportOps("fees.example", ["areas.example"], true)).toEqual([
      { kind: "file-json-set", file: FILE, pointer: POINTER, expect: ["areas.example"], value: ["areas.example", "fees.example"] },
    ]);
    expect(noNightlyReportOps("areas.example", ["areas.example", "fees.example"], false)).toEqual([
      { kind: "file-json-set", file: FILE, pointer: POINTER, expect: ["areas.example", "fees.example"], value: ["fees.example"] },
    ]);
  });

  it("writes nothing when the list already says so", () => {
    expect(noNightlyReportOps("fees.example", ["fees.example"], true)).toEqual([]);
    expect(noNightlyReportOps("fees.example", null, false)).toEqual([]);
    expect(noNightlyReportOps("fees.example", ["areas.example"], false)).toEqual([]);
  });
});

describe("NightlyReportSwitch", () => {
  it("shows the saved state and declares No report with a first write whose Undo removes it", async () => {
    const { asset, wiring } = fixture(null);
    mount(asset, wiring);
    expect(screen.getByRole("button", { name: "Expected" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "No report" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const first = { kind: "file-json-set", file: FILE, pointer: POINTER, expectAbsent: true, value: [asset.id] };
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith([first], "no-nightly-report"));

    // The way back sits beside the switch (bead ro-ujb9.96.7.12), not in a toast.
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(mock.success).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mock.save).toHaveBeenLastCalledWith(
        [{ kind: "file-json-delete", file: FILE, pointer: POINTER, expect: [asset.id] }],
        "no-nightly-report",
      ),
    );
  });

  // D29 amended (ro-ujb9.121): a site that has never sent a report expects
  // none, so the undeclared side is a neutral "Not set up", and No report is
  // still one press away.
  it("reads a site that has never sent a report as Not set up, neutral, with No report available", async () => {
    const { asset, wiring } = fixture(null);
    mount(asset, { ...wiring, lastPulseReceivedAt: null });
    const notSetUp = screen.getByRole("button", { name: "Not set up" });
    expect(notSetUp).toHaveAttribute("aria-pressed", "true");
    expect(notSetUp).toHaveClass("text-muted-foreground");
    expect(screen.queryByRole("button", { name: "Expected" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "No report" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mock.save).toHaveBeenCalledWith(
        [{ kind: "file-json-set", file: FILE, pointer: POINTER, expectAbsent: true, value: [asset.id] }],
        "no-nightly-report",
      ),
    );
  });

  it("reads a declared asset as No report and switches it back to Expected", async () => {
    const { asset, wiring } = fixture(["areas.example", "meals.example"]);
    mount({ ...asset, id: "meals.example" }, wiring);
    expect(screen.getByRole("button", { name: "No report" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Expected" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mock.save).toHaveBeenCalledWith(
        [{ kind: "file-json-set", file: FILE, pointer: POINTER, expect: ["areas.example", "meals.example"], value: ["areas.example"] }],
        "no-nightly-report",
      ),
    );
  });
});

// ro-ujb9.96.13 — the card the switch governs. With "No report" saved, the
// switch is the Data collection card's one state; the rows about how the
// report arrives come back when it is set to Expected.
describe("the Data collection card under the switch", () => {
  function mountCard(declarations: string[] | null, wiring: Partial<Wiring> = {}) {
    const payload = everyTabPayload();
    payload.wiring = { ...payload.wiring, noReportDeclarations: declarations, ...wiring };
    payload.asset = { ...payload.asset, noNightlyReport: (declarations ?? []).includes(payload.asset.id) };
    const data = viewOf(payload, "settings") as unknown as AssetDetailFor<"settings">;
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AssetSettingsPanel data={data} nowMs={Date.parse("2026-07-05T12:00:00.000Z")} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { view, card: within(screen.getByRole("region", { name: "Data collection" })), id: payload.asset.id };
  }

  it("shows only No report while it is saved: no delivery chip, endpoint, auth, schedule or freshness rows", () => {
    const { card, id } = mountCard(["meals.example"]);
    expect(id).toBe("meals.example");
    expect(card.getByRole("button", { name: "No report" })).toHaveAttribute("aria-pressed", "true");
    for (const gone of ["The site sends it", "Report endpoint", "Auth source", "Schedule", "Last report"]) {
      expect(card.queryByText(gone)).toBeNull();
    }
    expect(card.queryByText(/data-freshness/i)).toBeNull();
  });

  it("restores every row on Expected, with the auth source as a pointer and a short state", () => {
    const { card } = mountCard(null);
    expect(card.getByRole("button", { name: "Expected" })).toHaveAttribute("aria-pressed", "true");
    for (const shown of ["The site sends it", "Report endpoint", "Auth source", "Schedule", "Last report"]) {
      expect(card.getByText(shown)).toBeInTheDocument();
    }
    expect(card.getByText("Never shown")).toBeInTheDocument();
    expect(card.queryByText(/never read here/)).toBeNull();
  });

  // Bead ro-ujb9.96.6.4: the calm state is a value, never a sentence.
  it("reads no open freshness alert as a value once a report has arrived", () => {
    const { card } = mountCard(null);
    expect(card.getByText("Freshness alerts")).toBeInTheDocument();
    expect(card.getByText("None open")).toBeInTheDocument();
    expect(card.queryByText(/no open collection or freshness alerts/)).toBeNull();
  });

  it("says nothing about freshness before the first report, which Last report already says", () => {
    const { card } = mountCard(null, { lastPulseReceivedAt: null, lastPulseDate: null });
    expect(card.getByText("None received yet")).toBeInTheDocument();
    expect(card.queryByText("Freshness alerts")).toBeNull();
    expect(card.queryByText(/data-freshness/i)).toBeNull();
  });
});
