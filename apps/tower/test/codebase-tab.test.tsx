import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetDetailPayload } from "@shared/asset-detail";
import { AssetDetailRoute } from "@/routes/AssetDetailRoute";
import { everyTabPayload } from "./asset-detail-fixture";
import { codebaseReport, NO_CODEBASE } from "./codebase-fixture";
import { loadAssetTabs } from "./lazy-code";
import { stubJsonFetch } from "./stub-fetch";

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * The Codebase tab as drawn: the answer, five figures, the chart with its
 * visitors, the findings each with Make a task, and before the first report
 * the ways to send one filled in for this site.
 */

const NOW = Date.parse("2026-07-05T14:00:00.000Z");

function renderCodebase(payload: AssetDetailPayload) {
  stubJsonFetch(payload);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/assets/meadow.example/codebase"]}>
        <Routes>
          <Route path="/assets/:id/:tab?" element={<AssetDetailRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(loadAssetTabs);

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Codebase tab with reports", () => {
  it("opens on the answer, then five figures with their change and meaning", async () => {
    const { container } = renderCodebase(everyTabPayload());
    const answer = await waitFor(() => {
      const node = container.querySelector<HTMLElement>("[data-codebase-answer]");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(answer.querySelector("h2")?.textContent).toMatch(/^The code grew 5\.2% in 28 days/);
    const labels = [...container.querySelectorAll("[data-kpi]")].map((node) => node.getAttribute("data-kpi"));
    expect(labels).toEqual(["Lines of code", "Repeated code", "Unused code", "Hard-to-change functions", "Test coverage by size"]);
    const lines = container.querySelector<HTMLElement>('[data-kpi="Lines of code"]')!;
    expect(lines.textContent).toContain("48,210");
    expect(within(lines).getByLabelText("5.2% up vs Jun 7, 28 days before")).toBeInTheDocument();
    const unused = container.querySelector<HTMLElement>('[data-kpi="Unused code"]')!;
    expect(unused.textContent).toContain("9 files, 44 shared pieces");
    expect(container.querySelector('[data-kpi="Test coverage by size"]')!.textContent).toContain("1.0×the code");
    fireEvent.click(within(container.querySelector<HTMLElement>('[data-kpi="Repeated code"]')!).getByRole("button", { name: "About Repeated code" }));
    expect(await screen.findByText("Code copied in more than one place. Each copy needs fixing.")).toBeInTheDocument();
  });

  it("shows Not measured with the report's own reason", async () => {
    const payload = everyTabPayload();
    const report = codebaseReport("meadow.example", "2026-07-05", { code_lines: 900, files: 12 });
    report.byLanguage = [{ language: "Go", files: 12, code_lines: 900 }];
    report.unmeasured = { unused_files: "Unused code is checked in JavaScript, TypeScript and Python only." };
    report.findings = { duplicates: [], complexFunctions: [], unused: [], largestFiles: [] };
    payload.codebase = { history: [], latest: { date: "2026-07-05", revision: 1, receivedAt: "2026-07-05T03:13:00.000Z", report } };
    const { container } = renderCodebase(payload);
    const unused = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('[data-kpi="Unused code"]');
      expect(node).not.toBeNull();
      return node!;
    });
    expect(unused.textContent).toContain("Not measured");
    expect(unused.textContent).toContain("Unused code is checked in JavaScript, TypeScript and Python only.");
    expect(container.querySelector("[data-codebase-answer] h2")?.textContent).toBe("The code has 900 lines.");
  });

  it("draws visitors under the code's chart on request, and every finding offers Make a task", async () => {
    const { container } = renderCodebase(everyTabPayload());
    const chart = await waitFor(() => {
      const node = container.querySelector<HTMLElement>("[data-codebase-chart]");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(chart.querySelectorAll("[data-hero-chart]")).toHaveLength(1);
    fireEvent.click(within(chart).getByRole("button", { name: "Visitors" }));
    expect(chart.querySelectorAll("[data-hero-chart]")).toHaveLength(2);
    const findings = container.querySelector<HTMLElement>("[data-codebase-findings]")!;
    expect(within(findings).getByText("src/a.ts and src/b.ts")).toBeInTheDocument();
    expect(within(findings).getByText("complexity 41")).toBeInTheDocument();
    expect(within(findings).getByRole("button", { name: "Make a task for src/a.ts and src/b.ts" })).toBeInTheDocument();
    expect(within(findings).getByRole("button", { name: "Make a task for left-pad" })).toBeInTheDocument();
    expect(container.querySelector("[data-codebase-languages]")?.textContent).toContain("TypeScript");
  });
});

describe("Codebase tab before the first report", () => {
  it("names the ways to send one, filled in for this site", async () => {
    const payload = everyTabPayload();
    payload.codebase = NO_CODEBASE;
    const { container } = renderCodebase(payload);
    await waitFor(() => expect(container.querySelector("[data-codebase-setup]")).not.toBeNull());
    expect(container.querySelector("[data-codebase-answer] h2")?.textContent).toBe("The code has not been measured yet.");
    expect(container.querySelectorAll("[data-kpi]")).toHaveLength(0);
    const workflow = container.querySelector("[data-codebase-workflow]")!.textContent!;
    expect(workflow).toContain('asset: "meadow.example"');
    expect(workflow).toContain("ingest-url: ${{ secrets.NOTICEOS_INGEST_URL }}");
    expect(screen.getByRole("button", { name: "Central pull · coming later" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Local command" }));
    expect(container.querySelector("[data-codebase-command]")?.textContent)
      .toBe("pnpm os:codebase-report -- --asset meadow.example --repo /path/to/your/code");
  });
});
