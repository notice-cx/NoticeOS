import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "./render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SNOOZE_MAX_DAYS } from "@shared/snooze";
import { FlagActions } from "@/components/FlagActions";
import { SnoozeUntil } from "@/components/SnoozeUntil";
import { ALERT_HISTORY_KEY } from "@/hooks/useAlertHistory";

// The snooze half of the alert lifecycle in the browser: the menu under the
// row, what it writes, and the chip that says when the thing comes back. The
// store side is `test/flag-actions.test.ts` and the HTTP contract is
// `test/flag-route.test.ts`; what is asserted here is an operator picking
// "3 days" and the request carrying exactly that.
//
// Sonner is mocked rather than mounted: the toast's Undo is a callback, and
// invoking it directly is what proves the inverse write's shape.
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

interface Call {
  url: string;
  body: { action?: string; until?: string };
}

function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
  return calls;
}

function withClient(node: ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  toasts.success.mockClear();
  toasts.error.mockClear();
});

const DAY = 86_400_000;

describe("FlagActions — the snooze menu", () => {
  it("offers Snooze beside the two actions it always had", () => {
    render(withClient(<FlagActions flagId={7} assetId="nosh.example" />));
    expect(screen.getByRole("button", { name: "Mark alert read" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Snooze alert" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve alert" })).toBeInTheDocument();
  });

  it("opens the horizons in place, and Escape puts the row back", () => {
    render(withClient(<FlagActions flagId={7} assetId="nosh.example" />));
    fireEvent.click(screen.getByRole("button", { name: "Snooze alert" }));

    for (const label of ["1 day", "3 days", "1 week"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Snooze until date")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve alert" })).toBeNull();

    fireEvent.keyDown(screen.getByLabelText("Snooze until date"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Resolve alert" })).toBeInTheDocument();
  });

  it("writes the preset the operator picked, as a date the store can hold", async () => {
    const calls = stubFetch();
    render(withClient(<FlagActions flagId={7} assetId="nosh.example" />));
    fireEvent.click(screen.getByRole("button", { name: "Snooze alert" }));
    fireEvent.click(screen.getByRole("button", { name: "3 days" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe("/api/flags/7");
    expect(calls[0]!.body.action).toBe("snooze");
    const until = Date.parse(calls[0]!.body.until!);
    expect(until - Date.now()).toBeGreaterThan(3 * DAY - 5_000);
    expect(until - Date.now()).toBeLessThan(3 * DAY + 5_000);
  });

  it("bounds the date picker to the horizon the Worker enforces", () => {
    render(withClient(<FlagActions flagId={7} assetId="nosh.example" />));
    fireEvent.click(screen.getByRole("button", { name: "Snooze alert" }));
    const picker = screen.getByLabelText("Snooze until date") as HTMLInputElement;

    // Tomorrow at the earliest, and never past SNOOZE_MAX_DAYS, so the field
    // cannot offer what the store would refuse.
    expect(Date.parse(`${picker.min}T00:00:00.000Z`) - Date.now()).toBeGreaterThan(0);
    expect(picker.max).toBe(
      new Date(Date.now() + SNOOZE_MAX_DAYS * DAY).toISOString().slice(0, 10),
    );
  });

  it("refuses a past date without sending it, and says what is allowed", async () => {
    const calls = stubFetch();
    render(withClient(<FlagActions flagId={7} assetId="nosh.example" />));
    fireEvent.click(screen.getByRole("button", { name: "Snooze alert" }));
    fireEvent.change(screen.getByLabelText("Snooze until date"), {
      target: { value: "2020-01-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Until date" }));

    expect(calls).toHaveLength(0);
    expect(toasts.error).toHaveBeenCalledWith("Pick a date in the next 90 days");
  });

  it("hands back an Undo that is the real inverse, not a second snooze", async () => {
    const calls = stubFetch();
    render(withClient(<FlagActions flagId={7} assetId="nosh.example" />));
    fireEvent.click(screen.getByRole("button", { name: "Snooze alert" }));
    fireEvent.click(screen.getByRole("button", { name: "1 day" }));

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const options = toasts.success.mock.calls[0]![1] as {
      action: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe("Undo");

    options.action.onClick();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.body).toEqual({ action: "unsnooze" });
  });

  it("gives a parked row Unsnooze alone", async () => {
    const calls = stubFetch();
    render(withClient(<FlagActions flagId={7} assetId="nosh.example" snoozed />));
    // Mark read and Resolve on a row nobody is being shown are decisions made
    // blind, so the parked variant does not offer them.
    expect(screen.queryByRole("button", { name: "Mark alert read" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve alert" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Unsnooze alert" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ action: "unsnooze" });
  });

  it("says so when the write fails rather than pretending the row went quiet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 409 })),
    );
    render(withClient(<FlagActions flagId={7} assetId="nosh.example" />));
    fireEvent.click(screen.getByRole("button", { name: "Snooze alert" }));
    fireEvent.click(screen.getByRole("button", { name: "1 day" }));

    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Could not update the alert"),
    );
    expect(toasts.success).not.toHaveBeenCalled();
  });
});

/** The archive is not polled, so every action must re-read it. */
describe("FlagActions — every outcome re-reads the settled archive", () => {
  async function invalidatedAfter(
    click: (client: QueryClient) => void,
  ): Promise<unknown[][]> {
    stubFetch();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    click(client);
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
    return invalidate.mock.calls.map(([filters]) => [...((filters as { queryKey: unknown[] }).queryKey)]);
  }

  const renderWith = (client: QueryClient, snoozed = false) =>
    render(
      <QueryClientProvider client={client}>
        <FlagActions flagId={7} assetId="nosh.example" snoozed={snoozed} />
      </QueryClientProvider>,
    );

  const outcomes: [string, (client: QueryClient) => void][] = [
    ["Mark read", (client) => {
      renderWith(client);
      fireEvent.click(screen.getByRole("button", { name: "Mark alert read" }));
    }],
    ["Snooze", (client) => {
      renderWith(client);
      fireEvent.click(screen.getByRole("button", { name: "Snooze alert" }));
      fireEvent.click(screen.getByRole("button", { name: "3 days" }));
    }],
    ["Unsnooze", (client) => {
      renderWith(client, true);
      fireEvent.click(screen.getByRole("button", { name: "Unsnooze alert" }));
    }],
    ["Resolve", (client) => {
      renderWith(client);
      fireEvent.click(screen.getByRole("button", { name: "Resolve alert" }));
    }],
  ];

  for (const [outcome, click] of outcomes) {
    it(`re-reads it after ${outcome}`, async () => {
      const keys = await invalidatedAfter(click);
      expect(keys).toContainEqual([...ALERT_HISTORY_KEY]);
      expect(keys).toContainEqual(["wall"]);
      expect(keys).toContainEqual(["asset-detail", "nosh.example"]);
    });
  }
});

describe("SnoozeUntil — when a parked alert comes back", () => {
  const NOW = Date.parse("2026-09-04T12:00:00.000Z");

  it("counts down to the date while the snooze is running", () => {
    const { container } = render(
      <SnoozeUntil until="2026-09-07T12:00:00.000Z" nowMs={NOW} />,
    );
    const chip = container.querySelector("[data-snooze-state]")!;
    expect(chip.getAttribute("data-snooze-state")).toBe("active");
    expect(chip.textContent).toContain("quiet until");
    expect(chip.textContent).toContain("Sep 7, 2026");
    expect(chip.textContent).toContain("in 3d");
  });

  it("flips to came-back once the date has passed", () => {
    const { container } = render(
      <SnoozeUntil until="2026-09-02T12:00:00.000Z" nowMs={NOW} />,
    );
    const chip = container.querySelector("[data-snooze-state]")!;
    // An expired snooze is an open alert whose row still records the silence;
    // it must never read "quiet until" a date in the past.
    expect(chip.getAttribute("data-snooze-state")).toBe("ended");
    expect(chip.textContent).toContain("back since");
    expect(chip.textContent).toContain("2d ago");
  });
});
