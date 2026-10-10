import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "./render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countersEntryOp, pullEntryOp } from "@shared/asset-wizard";
import { validateSchemaAndSafety } from "../../../scripts/config-documents.mjs";
import { configSaveReply } from "./config-save-reply";

// The defaults Add a site does not ask, changeable on the asset's Settings
// tab: an asset that sends its own reports switched to being fetched, and the
// totals on its card, each written with the very insert the add would have sent.

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/hooks/useConfigWritable", () => ({
  useConfigWritable: () => ({ writable: true, reason: null, sources: {} }),
}));

import { CardTotalsCard, FetchEndpointEditor } from "@/routes/asset-detail/CollectionSetup";

function stubFetch(): { url: string; method: string; body: unknown }[] {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(configSaveReply(init)), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

function wrap(children: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("an asset that sends its own reports, switched to being fetched", () => {
  it("writes the add's own pull entry, and refuses an endpoint the OS cannot fetch", async () => {
    const calls = stubFetch();
    wrap(<FetchEndpointEditor asset="journey.example" />);
    fireEvent.click(screen.getByRole("button", { name: "Fetch from an endpoint" }));
    fireEvent.change(screen.getByLabelText("Metrics endpoint"), { target: { value: "journey.example/metrics" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("A full https:// URL")).toBeInTheDocument();
    expect(calls).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Metrics endpoint"), { target: { value: "https://journey.example/api/metrics" } });
    fireEvent.change(screen.getByLabelText("Answers with"), { target: { value: "prometheus" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      url: "/api/config",
      method: "PUT",
      body: { slug: "fetch-endpoint", ops: [pullEntryOp("journey.example", "https://journey.example/api/metrics", "prometheus")] },
    });
    expect(() => validateSchemaAndSafety({ version: 1, createdAt: "2026-09-23T12:00:00Z", ...(calls[0]!.body as Record<string, unknown>) })).not.toThrow();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Saved — Metrics endpoint"));
  });
});

describe("the totals on the asset's card", () => {
  it("adds them as the add's own counters entry", async () => {
    const calls = stubFetch();
    wrap(<CardTotalsCard asset="journey.example" stored={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Add totals" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Metric key needed")).toBeInTheDocument();
    expect(screen.getByText("Label needed")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "signups" } });
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Accounts" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ slug: "card-totals", ops: [countersEntryOp("journey.example", [{ metric: "signups", label: "Accounts" }])] });
    expect(() => validateSchemaAndSafety({ version: 1, createdAt: "2026-09-23T12:00:00Z", ...(calls[0]!.body as Record<string, unknown>) })).not.toThrow();
  });

  it("shows the ones the file holds and takes them away whole, guarded by what it holds", async () => {
    const calls = stubFetch();
    const expect_ = { cards: [{ metric: "signups", label: "Accounts" }] };
    wrap(<CardTotalsCard asset="journey.example" stored={expect_} />);
    expect(screen.getByText("Accounts")).toBeInTheDocument();
    expect(screen.getByText("signups")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove totals" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({
      ops: [{ kind: "file-json-delete", file: "config/counters.json", pointer: "/assets/journey.example", expect: expect_ }],
    });
  });
});
