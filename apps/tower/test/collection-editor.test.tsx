import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@shared/changeset";
import { CollectionEditor } from "@/components/CollectionEditor";

// The registry's plural of KnobEditor (bead ro-x5gu.1). What is asserted here is
// the promise a row-level Save makes, which is the same one a knob makes plus
// two things a list has and a field does not: adding, and removing.
//
//   - the table is BUILT FROM THE DECLARATION — the columns, the controls, the
//     Add form and the refusals all come from config-registers.mjs, so nothing
//     below names a column this component knows about;
//   - every action is exactly ONE op, carrying the value it was rendered from
//     as `expect`;
//   - the Undo in the toast is that op's exact inverse — a delete for an
//     insert, an insert for a delete, the values swapped for a set;
//   - a value the schema refuses never becomes a request;
//   - loading, empty and a deployment that cannot write are three designed
//     states rather than three empty tables.
//
// Sonner is mocked rather than mounted: the Undo is a callback, and invoking it
// directly is what proves the second write's shape.
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

function withClient(node: ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </QueryClientProvider>
  );
}

interface Call {
  method: string;
  body: { ops: unknown[]; slug?: string } | null;
}

function stubFetch(
  reply: { status: number; body: unknown } = { status: 200, body: { applied: 1, archive: null, commit: null } },
  writable: { writable: boolean; reason: string | null } = { writable: true, reason: null },
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(JSON.stringify(writable), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      calls.push({
        method,
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const DOMAINS = [
  { domain: "fees.example", asset: "fees.example", kind: "registration", paidUsd: 36.32, paidOn: "2026-06-28" },
  { domain: "nosh.example", asset: "nosh.example", kind: "registration", paidUsd: 109.69, paidOn: "2026-06-19" },
];

function renderDomains(overrides: Partial<Parameters<typeof CollectionEditor>[0]> = {}) {
  return render(
    withClient(<CollectionEditor register="domain-costs" rows={DOMAINS} {...overrides} />),
  );
}

/** The one op a change made. Every action here is a single-op changeset. */
function onlyOp(calls: Call[], index = 0): Record<string, unknown> {
  const ops = calls[index]?.body?.ops ?? [];
  expect(ops).toHaveLength(1);
  return ops[0] as Record<string, unknown>;
}

function row(key: string): HTMLElement {
  const found = document.querySelector(`[data-collection-row="${key}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no row for ${key}`);
  return found;
}

/** One cell's control and the Save beside it — every column has its own. */
function cellOf(rowKey: string, column: string) {
  const control = within(row(rowKey)).getByLabelText(column);
  const save = within(control.parentElement as HTMLElement).getByRole("button", { name: "Save" });
  return { control, save };
}

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CollectionEditor", () => {
  it("draws a column per declared field, in the declaration's order", () => {
    stubFetch();
    renderDomains();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.slice(0, 5)).toEqual(["Domain", "Site", "Order", "Paid (USD)", "Paid on"]);
    expect(screen.getAllByDisplayValue("fees.example")).not.toHaveLength(0);
    expect(screen.getByDisplayValue("109.69")).toBeInTheDocument();
  });

  it("edits one field in place: one set op carrying what the cell was rendered from", async () => {
    const calls = stubFetch();
    renderDomains({ slug: "correct-a-price" });

    const { control, save } = cellOf("fees.example", "Paid (USD)");
    fireEvent.change(control, { target: { value: "40" } });
    fireEvent.click(save);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body?.slug).toBe("correct-a-price");
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-set",
      file: "config/domain-costs.json",
      pointer: "/domains/0/paidUsd",
      expect: 36.32,
      value: 40,
    });

    // The Undo is the same write with the values swapped, so it is refused in
    // turn if somebody else moved the row in between — and it sits under the
    // cell, not in a toast (bead ro-ujb9.96.7.12).
    fireEvent.click(await within(row("fees.example")).findByRole("button", { name: "Undo" }));
    expect(toasts.success).not.toHaveBeenCalled();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(onlyOp(calls, 1)).toMatchObject({ expect: 40, value: 36.32 });
  });

  it("never sends a value the field's own rule refuses", async () => {
    const calls = stubFetch();
    renderDomains();

    const { control, save } = cellOf("fees.example", "Paid (USD)");
    fireEvent.change(control, { target: { value: "-5" } });
    fireEvent.click(save);

    expect(await screen.findByText("Paid (USD) must be at least 0")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    expect(control).toHaveAttribute("aria-invalid", "true");
  });

  it("adds a row from the schema: one insert, and an Undo that deletes it again", async () => {
    const calls = stubFetch();
    renderDomains();

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Domain"), { target: { value: "teller.example" } });
    fireEvent.change(within(form).getByLabelText("Site"), { target: { value: "fees.example" } });
    fireEvent.change(within(form).getByLabelText("Order"), { target: { value: "registration" } });
    fireEvent.change(within(form).getByLabelText("Paid (USD)"), { target: { value: "6.69" } });
    fireEvent.change(within(form).getByLabelText("Paid on"), { target: { value: "2026-06-28" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    const added = {
      domain: "teller.example",
      asset: "fees.example",
      kind: "registration",
      paidUsd: 6.69,
      paidOn: "2026-06-28",
    };
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-insert",
      file: "config/domain-costs.json",
      pointer: "/domains/-",
      value: added,
    });

    // An insert appends, so its inverse names the index it landed at and
    // carries the row as `expect` — if anything moved, the undo is refused.
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const undo = toasts.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    undo.action.onClick();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(onlyOp(calls, 1)).toEqual({
      kind: "file-json-delete",
      file: "config/domain-costs.json",
      pointer: "/domains/2",
      expect: added,
    });
  });

  it("refuses an incomplete or duplicate row before it becomes a request", async () => {
    const calls = stubFetch();
    renderDomains();

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Domain is required");
    expect(calls).toHaveLength(0);

    // A key already in the list is the refusal a pointer cannot make: two
    // orders for one domain would double-count it.
    fireEvent.change(within(form).getByLabelText("Domain"), { target: { value: "nosh.example" } });
    fireEvent.change(within(form).getByLabelText("Site"), { target: { value: "nosh.example" } });
    fireEvent.change(within(form).getByLabelText("Order"), { target: { value: "renewal" } });
    fireEvent.change(within(form).getByLabelText("Paid (USD)"), { target: { value: "12" } });
    fireEvent.change(within(form).getByLabelText("Paid on"), { target: { value: "2026-09-01" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("already in this list");
    expect(calls).toHaveLength(0);
  });

  // ONE RED OUTLINE, ON THE FIELD THAT BROKE THE RULE (bead `ro-ujb9.184`). The
  // outline is the glance that says where to look; on every input it said
  // nothing, and a single bad amount painted five inputs red.
  it("outlines and marks invalid only the field the refusal names", async () => {
    const calls = stubFetch();
    renderDomains();

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    const typed: Record<string, string> = {
      Domain: "teller.example",
      Site: "fees.example",
      Order: "registration",
      "Paid (USD)": "-5",
      "Paid on": "2026-06-28",
    };
    for (const [label, value] of Object.entries(typed)) {
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    }
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("Paid (USD) must be at least 0");
    const paid = within(form).getByLabelText("Paid (USD)");
    expect([...form.querySelectorAll('[aria-invalid="true"]')]).toEqual([paid]);
    expect([...form.querySelectorAll(".border-error")]).toEqual([paid]);
    expect(paid).toHaveAttribute("aria-describedby", alert.id);
    expect(calls).toHaveLength(0);

    // Typing into it clears the refusal and its outline.
    fireEvent.change(paid, { target: { value: "6.69" } });
    expect(form.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(form.querySelector(".border-error")).toBeNull();

    // A duplicate names its key, so only the key is outlined.
    fireEvent.change(within(form).getByLabelText("Domain"), { target: { value: "nosh.example" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent('Domain "nosh.example" is already in this list');
    expect([...form.querySelectorAll('[aria-invalid="true"]')]).toEqual([within(form).getByLabelText("Domain")]);
    expect(calls).toHaveLength(0);
  });

  // A JOIN KEY IS NOT A LABEL (bead `ro-xhy5`). Three declared fields are keys
  // whose rename breaks something no table can show, and each of them carried
  // that warning in a tooltip on a control that still offered the edit. The
  // control is now the value itself; the Add form still asks for it, because a
  // new row must set its key, and the write lane refuses the set as well.
  it("shows a field the declaration fixes as its value, with no way to rename it", () => {
    stubFetch();
    renderDomains();

    const fixed = within(row("fees.example")).getByText("fees.example");
    expect(fixed.closest("[data-collection-fixed='domain']")).not.toBeNull();
    expect(within(row("fees.example")).queryByLabelText("Domain")).toBeNull();
    expect(
      document.querySelector("[data-collection-fixed='domain']"),
    ).toHaveAttribute("title", "Fixed once added");

    // Its neighbours are untouched — the rule is one field, not one row.
    expect(within(row("fees.example")).getByLabelText("Paid (USD)")).toBeInTheDocument();

    // And the Add form still asks for it.
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    expect(within(form).getByLabelText("Domain")).toBeInTheDocument();
    // ... and marks it with the lock and state the row will wear, before it
    // is typed (bead `ro-ujb9.96.6.17`).
    expect(form.querySelector("[data-collection-add-fixed='domain']")).toHaveTextContent("Fixed once added");
  });

  /**
   * AND THE REASON IS ON SCREEN FOR A READER WITH NO POINTER (bead
   * `ro-x5gu.12`). The `title` above is a desk hover and the `sr-only` beside
   * it is a screen reader's; a sighted operator on a phone reached neither and
   * saw a value, a lock and no Save. The line says it ONCE for the table —
   * every row shares the reason, and `/financials` draws 22 of them — and
   * carries `sm:hidden`, so the desk gains no prose it already has on hover.
   */
  it("says why a fixed column cannot be edited once per table, below sm", () => {
    stubFetch();
    renderDomains();

    const note = document.querySelector("[data-collection-fixed-note]");
    expect(note).not.toBeNull();
    // A key, not a sentence (bead `ro-ujb9.96.6.17`): the lock and its state.
    expect(note).toHaveTextContent(/^Fixed once added$/);
    // The desk keeps the hover and gains nothing: this line is the phone's.
    expect(note?.className).toContain("sm:hidden");
    // One sentence, not one per row — the table draws three.
    expect(document.querySelectorAll("[data-collection-fixed-note]")).toHaveLength(1);
    expect(
      document.querySelectorAll("[data-collection-fixed='domain']").length,
    ).toBeGreaterThan(1);
  });

  it("removes behind an inline confirm: one delete carrying the whole row", async () => {
    const calls = stubFetch();
    renderDomains();

    fireEvent.click(within(row("nosh.example")).getByRole("button", { name: "Remove nosh.example…" }));
    // Nothing has been written yet — the confirm is the one place this
    // component asks first, because a removal has no inverse in place.
    expect(calls).toHaveLength(0);
    fireEvent.click(within(row("nosh.example")).getByRole("button", { name: "Remove nosh.example" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-delete",
      file: "config/domain-costs.json",
      pointer: "/domains/1",
      expect: DOMAINS[1],
    });

    // The Undo puts the row back WHERE IT WAS (bead `ro-asj9`) — a delete
    // splices, so an append would return the row at the end of the list and
    // leave its neighbours in a different order than it found them.
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const undo = toasts.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    undo.action.onClick();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(onlyOp(calls, 1)).toEqual({
      kind: "file-json-insert",
      file: "config/domain-costs.json",
      pointer: "/domains/1",
      value: DOMAINS[1],
    });
  });

  // The wart this closes was visible on /financials, where the table is drawn in
  // file order: removing the first of 22 domain orders and pressing Undo used to
  // return it as the 22nd (bead `ro-asj9`).
  it("undoes a removal into the row's own position, not onto the end of the list", async () => {
    const calls = stubFetch();
    renderDomains();

    fireEvent.click(within(row("fees.example")).getByRole("button", { name: "Remove fees.example…" }));
    fireEvent.click(within(row("fees.example")).getByRole("button", { name: "Remove fees.example" }));
    await waitFor(() => expect(calls).toHaveLength(1));

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const undo = toasts.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    undo.action.onClick();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(onlyOp(calls, 1)).toEqual({
      kind: "file-json-insert",
      file: "config/domain-costs.json",
      pointer: "/domains/0",
      value: DOMAINS[0],
    });
  });

  it("keeps the row when the confirm is declined", () => {
    const calls = stubFetch();
    renderDomains();
    fireEvent.click(within(row("nosh.example")).getByRole("button", { name: "Remove nosh.example…" }));
    fireEvent.click(within(row("nosh.example")).getByRole("button", { name: "Keep nosh.example" }));
    expect(within(row("nosh.example")).getByRole("button", { name: "Remove nosh.example…" })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("says a refusal out loud and keeps the operator's value on screen", async () => {
    const calls = stubFetch({ status: 409, body: { error: "expect_mismatch" } });
    renderDomains();

    const { control, save } = cellOf("fees.example", "Paid (USD)");
    fireEvent.change(control, { target: { value: "40" } });
    fireEvent.click(save);

    await waitFor(() => expect(calls).toHaveLength(1));
    // Under the cell, as a short state (bead ro-ujb9.96.7.12).
    expect(await within(row("fees.example")).findByRole("alert")).toHaveTextContent(
      "Changed elsewhere — reload to see the current value",
    );
    expect(toasts.error).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
    expect(control).toHaveValue(40);
  });

  // NARROWING A LONG REGISTER (bead `ro-x5gu.11`). Every op addresses a row by
  // its POSITION in the file's array, which is why no page could hand over a
  // filtered or sorted list. Doing it inside the component is what makes it
  // safe — the row keeps the token it had in the file — and this is the case
  // that proves it: edit a row that is NOT first in the file, after filtering
  // and sorting have moved it to the top of the screen.
  describe("a long register narrows itself", () => {
    /** Nine orders, so the table is past the threshold. `zzz.test` is LAST in
     * the file and first alphabetically-by-asset once sorted. */
    const MANY = [
      ...Array.from({ length: 8 }, (_, n) => ({
        domain: `d${n}.test`,
        asset: `nosh.example`,
        kind: "renewal",
        paidUsd: 20 + n,
        paidOn: "2026-06-01",
      })),
      { domain: "zzz.test", asset: "fees.example", kind: "registration", paidUsd: 9, paidOn: "2026-07-04" },
    ];

    function renderMany(overrides: Partial<Parameters<typeof CollectionEditor>[0]> = {}) {
      return render(
        withClient(<CollectionEditor register="domain-costs" rows={MANY} {...overrides} />),
      );
    }

    it("offers no filter for a list somebody can read in one glance", () => {
      stubFetch();
      renderDomains();
      expect(document.querySelector("[data-collection-narrow]")).toBeNull();
      expect(screen.queryByRole("button", { name: /Paid \(USD\)/ })).toBeNull();
    });

    it("draws only the matching rows, and says how many of how many", () => {
      stubFetch();
      renderMany();

      const filter = screen.getByLabelText("Filter domain orders");
      expect(screen.getByText("9 rows")).toBeInTheDocument();
      fireEvent.change(filter, { target: { value: "fees.example" } });

      expect(document.querySelectorAll("[data-collection-row]")).toHaveLength(1);
      expect(row("zzz.test")).toBeInTheDocument();
      // The count is the difference between "this asset owns one" and "somebody
      // deleted eight".
      expect(screen.getByText("1 of 9")).toBeInTheDocument();

      // A filter matching nothing is not an empty register.
      fireEvent.change(filter, { target: { value: "nothing here" } });
      expect(document.querySelector("[data-collection-none]")?.textContent).toContain(
        "Clear the filter to see all 9 entries",
      );
      expect(screen.queryByText("None yet")).toBeNull();
    });

    it("writes the right pointer for a row that is neither first on screen nor first in the file", async () => {
      const calls = stubFetch();
      renderMany();

      // Narrow to the LAST row in the file, which is then the only one drawn.
      fireEvent.change(screen.getByLabelText("Filter domain orders"), {
        target: { value: "fees.example" },
      });
      const { control, save } = cellOf("zzz.test", "Paid (USD)");
      fireEvent.change(control, { target: { value: "12" } });
      fireEvent.click(save);

      await waitFor(() => expect(calls).toHaveLength(1));
      // Index 8, not index 0 — the address travelled with the row.
      expect(onlyOp(calls)).toEqual({
        kind: "file-json-set",
        file: "config/domain-costs.json",
        pointer: "/domains/8/paidUsd",
        expect: 9,
        value: 12,
      });
    });

    it("orders by a column and back again, without touching what a row addresses", async () => {
      const calls = stubFetch();
      renderMany();

      const drawn = () =>
        [...document.querySelectorAll("[data-collection-row]")].map((r) =>
          r.getAttribute("data-collection-row"),
        );
      expect(drawn()[0]).toBe("d0.test");

      // Ascending by amount puts the cheapest — the file's LAST row — on top.
      const header = screen.getByRole("button", { name: "Paid (USD)" });
      fireEvent.click(header);
      expect(drawn()[0]).toBe("zzz.test");
      fireEvent.click(header);
      expect(drawn()[0]).toBe("d7.test");
      // A third press is back to file order, which is a state worth reaching.
      fireEvent.click(header);
      expect(drawn()[0]).toBe("d0.test");

      // And an edit made while sorted still names the row's own index.
      fireEvent.click(header);
      const { control, save } = cellOf("zzz.test", "Paid on");
      fireEvent.change(control, { target: { value: "2026-07-05" } });
      fireEvent.click(save);
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(onlyOp(calls)).toMatchObject({ pointer: "/domains/8/paidOn" });
    });

    // ON A PHONE IT ALSO FOLDS (bead `ro-c59x`). The `ro-md80` reflow made every
    // field of every row reachable at 390px and paid for it in height — 22 rows
    // × 6 fields is 132 labelled lines, and /financials measured 28,244px. The
    // breakpoint is the viewport rather than a prop, so what is asserted here is
    // the structure the CSS acts on: which cells fold, which line replaces them,
    // and that the thumb floor survives.
    it("folds each row to one summary line on a phone, and opens it in place", () => {
      stubFetch();
      renderMany();

      const first = row("d0.test");
      expect(first.hasAttribute("data-stack-fold")).toBe(true);
      const summary = first.querySelector("[data-collection-summary='d0.test']") as HTMLElement;
      // The identity line, plus the second column — enough to pick a row out.
      expect(summary.textContent).toContain("d0.test");
      expect(summary.textContent).toContain("nosh.example");
      const toggle = within(summary).getByRole("button");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle.className).toContain("min-h-11");

      // Every field is still in the row — folded, never dropped — and the cells
      // that fold are marked for the one rule that hides them.
      expect(within(first).getByLabelText("Paid (USD)")).toBeInTheDocument();
      const paid = within(first).getByLabelText("Paid (USD)").closest("td");
      expect(paid?.hasAttribute("data-fold")).toBe(true);

      fireEvent.click(toggle);
      expect(row("d0.test").hasAttribute("data-stack-fold")).toBe(false);
      expect(within(row("d0.test")).getByRole("button", { name: "Remove d0.test…" })).toBeTruthy();
    });

    it("does not fold a register short enough to read whole", () => {
      stubFetch();
      renderDomains();
      expect(row("fees.example").hasAttribute("data-stack-fold")).toBe(false);
      expect(document.querySelector("[data-collection-summary]")).toBeNull();
    });

    it("draws a computed column beside the editable ones, with nothing to edit", () => {
      stubFetch();
      renderMany({
        derived: [
          {
            name: "monthly",
            label: "Per month",
            describe: "the order spread over its 12-month term",
            render: (r) => (
              <span data-monthly>{(Number(r.values.paidUsd) / 12).toFixed(2)}</span>
            ),
          },
        ],
      });

      const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
      expect(headers).toContain("Per month");
      const cell = row("zzz.test").querySelector("[data-collection-derived='monthly']");
      expect(cell?.textContent).toBe("0.75");
      // Computed, so there is no control and no Save inside it.
      expect(cell?.querySelector("input")).toBeNull();
      expect(cell?.querySelector("button")).toBeNull();
    });
  });

  it("shows the table's own shape while it loads, never a spinner", () => {
    stubFetch();
    render(withClient(<CollectionEditor register="domain-costs" rows={undefined} loading />));
    expect(document.querySelector("[data-collection-loading]")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")[0]).toHaveTextContent("Domain");
  });

  // LOADING IS A THIRD STATE, and it offers nothing (bead `ro-x5gu.9`). A page
  // still fetching has no rows, and neither does an asset with no entry in the
  // file — but the first row of a per-asset list is a DIFFERENT write from an
  // append (`seed` files the asset's whole entry), so a decision made against
  // rows that have not arrived is a decision made against the wrong list.
  it("offers no Add while its rows are still loading", () => {
    stubFetch();
    const { rerender } = render(
      withClient(
        <CollectionEditor
          register="value-events"
          params={{ asset: "meals.example" }}
          rows={undefined}
          loading
        />,
      ),
    );
    expect(document.querySelector("[data-collection-loading]")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    // No rows means nothing to Remove either — the skeleton owns the surface.
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();

    // The rows land as ABSENT, which is a real answer and a different one: the
    // file has no entry for this asset, and the Add that files it is offered.
    rerender(
      withClient(
        <CollectionEditor
          register="value-events"
          params={{ asset: "meals.example" }}
          rows={null}
        />,
      ),
    );
    expect(document.querySelector("[data-collection-loading]")).toBeNull();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("closes an open Add form when a refetch starts, rather than filing against rows it lost", () => {
    stubFetch();
    const editor = (loading: boolean) => (
      <CollectionEditor
        register="value-events"
        params={{ asset: "meals.example" }}
        rows={loading ? undefined : ["sign_up"]}
        loading={loading}
      />
    );
    const { rerender } = render(withClient(editor(false)));

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(document.querySelector("[data-collection-add]")).toBeInTheDocument();

    rerender(withClient(editor(true)));
    expect(document.querySelector("[data-collection-add]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("says what an empty list means, and still offers the way to fill it", () => {
    stubFetch();
    render(
      withClient(
        <CollectionEditor register="domain-costs" rows={[]} emptyHint="No orders booked yet." />,
      ),
    );
    expect(screen.getByText("No orders booked yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  // Bead ro-ujb9.96.6.22: the heading names the list, so the empty state is the
  // list's state — never "Nothing in <list> yet", and never the describe line a
  // second time.
  it("titles an empty list with its state, whatever the list is called", () => {
    stubFetch();
    const { container } = render(withClient(<CollectionEditor register="domain-costs" rows={[]} />));
    expect(screen.getByText("None yet")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Nothing in .* yet/);
    const describe = container.querySelector("h3")?.nextElementSibling?.textContent ?? "";
    expect(describe.length).toBeGreaterThan(0);
    expect(container.textContent!.split(describe).length - 1).toBe(1);
  });

  it("a deployment that cannot write says so instead of offering dead controls", async () => {
    stubFetch({ status: 501, body: {} }, { writable: false, reason: "Config is files; this build has none." });
    renderDomains();

    await waitFor(() =>
      expect(screen.getByText("Config is files; this build has none.")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Paid (USD)")).not.toBeInTheDocument();
    expect(screen.getByText("36.32")).toBeInTheDocument();
  });

  it("a scalar register edits the row itself — there is nothing below it to address", async () => {
    const calls = stubFetch();
    render(
      withClient(
        <CollectionEditor
          register="value-events"
          params={{ asset: "meals.example" }}
          rows={["sign_up", "auth_complete"]}
        />,
      ),
    );

    const { control, save } = cellOf("sign_up", "GA4 event");
    fireEvent.change(control, { target: { value: "plan_save_click" } });
    fireEvent.click(save);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-set",
      file: "config/value-events.json",
      pointer: "/assets/meals.example/valueEvents/0",
      expect: "sign_up",
      value: "plan_save_click",
    });
  });

  it("an object register is keyed by its keys, and its rows address them by name", async () => {
    const calls = stubFetch();
    render(
      withClient(
        <CollectionEditor
          register="signal-panels"
          rows={{ "meals.example": { enabled: true, reason: "live-lanes" } }}
        />,
      ),
    );

    const { control, save } = cellOf("meals.example", "Daily refresh");
    fireEvent.change(control, { target: { value: "false" } });
    fireEvent.click(save);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-set",
      file: "config/signal-panels.json",
      pointer: "/assets/meals.example/enabled",
      expect: true,
      value: false,
    });
  });

  it("files the asset's whole entry when the list it belongs to is not there yet", async () => {
    const calls = stubFetch();
    render(
      withClient(
        <CollectionEditor
          register="value-events"
          params={{ asset: "areas.example" }}
          rows={null}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("GA4 event"), {
      target: { value: "calculation_complete" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    // A pointer never creates structure: /assets/areas.example/valueEvents does
    // not exist to be appended to, so the row arrives as that asset's entry.
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-insert",
      file: "config/value-events.json",
      pointer: "/assets/areas.example",
      value: { valueEvents: ["calculation_complete"] },
    });

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const undo = toasts.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    undo.action.onClick();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(onlyOp(calls, 1)).toEqual({
      kind: "file-json-delete",
      file: "config/value-events.json",
      pointer: "/assets/areas.example",
      expect: { valueEvents: ["calculation_complete"] },
    });
  });

  it("appends into an entry that exists and holds nothing — empty is not absent", async () => {
    const calls = stubFetch();
    render(
      withClient(
        <CollectionEditor
          register="value-events"
          params={{ asset: "areas.example" }}
          rows={[]}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("GA4 event"), {
      target: { value: "sign_up" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-insert",
      file: "config/value-events.json",
      pointer: "/assets/areas.example/valueEvents/-",
      value: "sign_up",
    });
  });

  // --- a list whose file has NO empty state (bead ro-x5gu.4) ----------------
  //
  // The asset's Growth tab edits `/assets/<id>/queries` in
  // config/serp-panel.json, where `queries: []` is a validation failure and an
  // absent asset is skipped silently. So the mirror of the seed above has to
  // exist: the last term out takes the entry with it. `emptyIsAbsent` on the
  // register is what says so — this component is told by the declaration, never
  // by the page.

  function renderPanel(
    rows: readonly JsonValue[] | undefined,
    overrides: Partial<Parameters<typeof CollectionEditor>[0]> = {},
  ) {
    return render(
      withClient(
        <CollectionEditor
          register="serp-panel-queries"
          params={{ asset: "nosh.example" }}
          rows={rows}
          {...overrides}
        />,
      ),
    );
  }

  function fillPanelForm(query: string, bet?: string) {
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Query"), { target: { value: query } });
    if (bet !== undefined) {
      fireEvent.change(within(form).getByLabelText("Bet"), { target: { value: bet } });
    }
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    return form;
  }

  it("files a whole tracked panel on the first term, label and all", async () => {
    const calls = stubFetch();
    renderPanel(undefined);

    fillPanelForm("big mac calories", "Item head");

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-insert",
      file: "config/serp-panel.json",
      pointer: "/assets/nosh.example",
      value: { queries: [{ query: "big mac calories", label: "Item head" }] },
    });
  });

  it("appends an unlabelled term as the bare string the file already holds", async () => {
    const calls = stubFetch();
    renderPanel(["big mac calories"]);

    fillPanelForm("mcchicken calories");

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-insert",
      file: "config/serp-panel.json",
      pointer: "/assets/nosh.example/queries/-",
      value: "mcchicken calories",
    });
  });

  it("removes the whole panel when the LAST term goes, rather than leaving an empty list", async () => {
    const calls = stubFetch();
    renderPanel(["big mac calories"]);

    fireEvent.click(
      within(row("big mac calories")).getByRole("button", { name: "Remove big mac calories…" }),
    );
    fireEvent.click(
      within(row("big mac calories")).getByRole("button", { name: "Remove big mac calories" }),
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    const entry = { queries: ["big mac calories"] };
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-delete",
      file: "config/serp-panel.json",
      pointer: "/assets/nosh.example",
      expect: entry,
    });

    // Seed's exact mirror, so the way back files the entry again, whole.
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const undo = toasts.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    undo.action.onClick();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(onlyOp(calls, 1)).toEqual({
      kind: "file-json-insert",
      file: "config/serp-panel.json",
      pointer: "/assets/nosh.example",
      value: entry,
    });
  });

  it("keeps a removal inside the list while other terms remain", async () => {
    const calls = stubFetch();
    renderPanel(["big mac calories", "mcchicken calories"]);

    fireEvent.click(
      within(row("mcchicken calories")).getByRole("button", { name: "Remove mcchicken calories…" }),
    );
    fireEvent.click(
      within(row("mcchicken calories")).getByRole("button", { name: "Remove mcchicken calories" }),
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-delete",
      file: "config/serp-panel.json",
      pointer: "/assets/nosh.example/queries/1",
      expect: "mcchicken calories",
    });
  });

  it("a list its file CAN empty keeps its last row's removal inside the list", async () => {
    // The same action on a register without `emptyIsAbsent`: an entry declaring
    // no value events is a legitimate thing to have written down, so nothing
    // takes the entry away.
    const calls = stubFetch();
    render(
      withClient(
        <CollectionEditor
          register="value-events"
          params={{ asset: "areas.example" }}
          rows={["sign_up"]}
        />,
      ),
    );

    fireEvent.click(within(row("sign_up")).getByRole("button", { name: "Remove sign_up…" }));
    fireEvent.click(within(row("sign_up")).getByRole("button", { name: "Remove sign_up" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-delete",
      file: "config/value-events.json",
      pointer: "/assets/areas.example/valueEvents/0",
      expect: "sign_up",
    });
  });

  it("rewrites the whole term when it gains its cluster label — the row changes shape", async () => {
    const calls = stubFetch();
    renderPanel(["big mac calories"]);

    const { control, save } = cellOf("big mac calories", "Bet");
    fireEvent.change(control, { target: { value: "Item head" } });
    fireEvent.click(save);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-set",
      file: "config/serp-panel.json",
      pointer: "/assets/nosh.example/queries/0",
      expect: "big mac calories",
      value: { query: "big mac calories", label: "Item head" },
    });
  });

  it("names the field a tracked term is missing, before it becomes a request", async () => {
    const calls = stubFetch();
    renderPanel(undefined);

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent("Query is required");
    expect(calls).toHaveLength(0);
  });

  it("refuses an add the LIST has no room for, and says that instead of naming a field", async () => {
    const calls = stubFetch();
    renderPanel(["big mac calories"], {
      refuseAdd: (rows) => (rows.length >= 1 ? "this panel is full — drop one first" : null),
    });

    const form = fillPanelForm("mcchicken calories");
    expect(await within(form).findByRole("alert")).toHaveTextContent("this panel is full");
    // About the list, not a field: no input is outlined (bead `ro-ujb9.184`).
    expect(form.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(form.querySelector(".border-error")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a one-row surface never offers Remove, and offers Add only while the row is missing", () => {
    stubFetch();
    const { rerender } = render(
      withClient(
        <CollectionEditor
          register="signal-panels"
          params={{ asset: "nosh.example" }}
          rows={{ "nosh.example": { enabled: true, reason: "live-lanes" } }}
          oneRow
        />,
      ),
    );
    expect(screen.queryByRole("button", { name: "Remove nosh.example…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    // …and the field is still editable: what this surface refuses is membership,
    // not the decision the row records.
    expect(screen.getByLabelText("Daily refresh")).toBeInTheDocument();

    rerender(
      withClient(
        <CollectionEditor register="signal-panels" params={{ asset: "nosh.example" }} rows={{}} oneRow />,
      ),
    );
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("files a missing one-row entry under the asset the surface is scoped to", async () => {
    const calls = stubFetch();
    render(
      withClient(
        <CollectionEditor register="signal-panels" params={{ asset: "nosh.example" }} rows={{}} oneRow />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "no-lane-yet" } });
    fireEvent.change(within(form).getByLabelText("Task"), {
      target: { value: "ro-2zk.2" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    // The key is not IN the row — an asset register is keyed by the asset id the
    // container carries, which this surface supplies as its param.
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-insert",
      file: "config/signal-panels.json",
      pointer: "/assets/nosh.example",
      value: { enabled: false, reason: "no-lane-yet", task: "ro-2zk.2" },
    });
  });

  it("leaves the read-only sentence to the page when a surface stacks several editors", async () => {
    stubFetch({ status: 501, body: {} }, { writable: false, reason: "Config is files; this build has none." });
    render(
      withClient(
        <CollectionEditor
          register="value-events"
          params={{ asset: "meals.example" }}
          rows={["sign_up"]}
          statesReadOnly={false}
        />,
      ),
    );

    // Still locked — it just does not say so a second time.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Config is files; this build has none.")).toBeNull();
    expect(document.querySelector("[data-collection-read-only]")).toBeNull();
    expect(screen.getByText("sign_up")).toBeInTheDocument();
  });

  // --- the three things only the PAGE can supply --------------------------
  //
  // The declaration cannot know which asset ids exist, that a task-hub project
  // is not finished when its row lands, or what a key looks like as a glyph.
  // Each of those is one prop, and none of them teaches this component the name
  // of any register (bead ro-x5gu.5).

  it("offers the page's own values as a picker and refuses anything else, naming the field", async () => {
    const calls = stubFetch();
    render(
      withClient(
        <CollectionEditor
          register="task-hub-spokes" addFields={["asset", "prefix", "database"]}
          rows={[{ asset: "root-os", prefix: "ro", database: "ro", repo: "." }]}
          fieldOptions={{ asset: ["nosh.example", "fees.example"] }}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    const list = form.querySelector("datalist") as HTMLDataListElement;
    expect([...list.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual([
      "nosh.example",
      "fees.example",
    ]);
    expect(within(form).getByLabelText("Site")).toHaveAttribute("list", list.id);

    fireEvent.change(within(form).getByLabelText("Site"), { target: { value: "nope.example" } });
    fireEvent.change(within(form).getByLabelText("Task prefix"), { target: { value: "np" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent(
      'asset "nope.example" is not one of nosh.example, fees.example',
    );
    expect(calls).toHaveLength(0);
  });

  // A PICKER IS NOT AN ALLOWLIST (bead `ro-g318`). The same prop, the same
  // datalist — and on a field whose domain is OPEN, no refusal, because a
  // cluster the panel does not use yet is a new bet rather than a typo. What
  // still refuses is the near miss, which is a different rule and the reason
  // this picker is worth having at all.
  it("offers an open-domain field's values without refusing a new one, and still refuses a near miss", async () => {
    const calls = stubFetch();
    render(
      withClient(
        <CollectionEditor
          register="serp-panel-queries"
          params={{ asset: "meals.example" }}
          rows={[{ query: "big mac calories", label: "Item head" }]}
          fieldOptions={{ label: ["Item head"] }}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    const list = form.querySelector("datalist") as HTMLDataListElement;
    expect([...list.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual([
      "Item head",
    ]);
    expect(within(form).getByLabelText("Bet")).toHaveAttribute("list", list.id);

    // A case variant of one already in use is still refused, in the collector's
    // own words — the rule the picker exists to make easy to satisfy.
    fireEvent.change(within(form).getByLabelText("Query"), { target: { value: "mcmuffin calories" } });
    fireEvent.change(within(form).getByLabelText("Bet"), { target: { value: "item head" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("spells one cluster two ways");
    expect(calls).toHaveLength(0);

    // A cluster nobody has named yet goes through.
    fireEvent.change(within(form).getByLabelText("Bet"), { target: { value: "Breakfast head" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toMatchObject({
      value: { query: "mcmuffin calories", label: "Breakfast head" },
    });
  });

  it("treats an empty option list as 'the page has not answered', and refuses nothing", async () => {
    const calls = stubFetch();
    render(
      withClient(
        <CollectionEditor
          register="task-hub-spokes" addFields={["asset", "prefix", "database"]}
          rows={[{ asset: "root-os", prefix: "ro", database: "ro", repo: "." }]}
          fieldOptions={{ asset: [] }}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    expect(form.querySelector("datalist")).toBeNull();
    fireEvent.change(within(form).getByLabelText("Site"), { target: { value: "nosh.example" } });
    fireEvent.change(within(form).getByLabelText("Task prefix"), { target: { value: "nom" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it("a field defaults from another until it is typed into itself", async () => {
    const calls = stubFetch();
    render(withClient(<CollectionEditor register="task-hub-spokes" addFields={["asset", "prefix", "database"]} rows={[]} />));

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Site"), { target: { value: "nosh.example" } });
    fireEvent.change(within(form).getByLabelText("Task prefix"), { target: { value: "nom" } });
    expect(within(form).getByLabelText("Database")).toHaveValue("nom");

    // Typed into directly, it stops following — and a later prefix edit must
    // not overrule what the operator chose.
    fireEvent.change(within(form).getByLabelText("Database"), { target: { value: "nomnow" } });
    fireEvent.change(within(form).getByLabelText("Task prefix"), { target: { value: "nn" } });
    expect(within(form).getByLabelText("Database")).toHaveValue("nomnow");

    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toMatchObject({
      value: { asset: "nosh.example", prefix: "nn", database: "nomnow" },
    });
  });

  it("tells the page a row landed, so the page can say what is still left", async () => {
    const calls = stubFetch();
    const added = vi.fn();
    renderDomains({ onAdded: added });

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Domain"), { target: { value: "teller.example" } });
    fireEvent.change(within(form).getByLabelText("Site"), { target: { value: "fees.example" } });
    fireEvent.change(within(form).getByLabelText("Order"), { target: { value: "registration" } });
    fireEvent.change(within(form).getByLabelText("Paid (USD)"), { target: { value: "6.69" } });
    fireEvent.change(within(form).getByLabelText("Paid on"), { target: { value: "2026-06-28" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(added).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "teller.example", paidUsd: 6.69 }),
    );
  });

  it("does not claim a row landed when the lane refused it", async () => {
    stubFetch({ status: 409, body: { error: "expect_mismatch" } });
    const added = vi.fn();
    renderDomains({ onAdded: added });

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = document.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Domain"), { target: { value: "teller.example" } });
    fireEvent.change(within(form).getByLabelText("Site"), { target: { value: "fees.example" } });
    fireEvent.change(within(form).getByLabelText("Order"), { target: { value: "registration" } });
    fireEvent.change(within(form).getByLabelText("Paid (USD)"), { target: { value: "6.69" } });
    fireEvent.change(within(form).getByLabelText("Paid on"), { target: { value: "2026-06-28" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(added).not.toHaveBeenCalled();
  });

  it("draws the row's own glyph beside its first column", () => {
    stubFetch();
    renderDomains({
      rowGlyph: (r) => <span data-row-glyph={r.key} />,
    });
    expect(row("fees.example").querySelector("[data-row-glyph='fees.example']")).not.toBeNull();
  });

  it("writes wherever it is told to, so the gallery never touches the repo", async () => {
    const calls = stubFetch();
    const wrote = vi.fn(async () => {});
    renderDomains({ onSave: wrote });

    const { control, save } = cellOf("fees.example", "Paid (USD)");
    fireEvent.change(control, { target: { value: "40" } });
    fireEvent.click(save);

    await waitFor(() => expect(wrote).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(0);
  });

  /**
   * ONE PARSE, NOT TWO (bead `ro-7mef`).
   *
   * A draft string becomes a typed value in exactly one place —
   * `fieldFromDraft`, beside the `fieldRefusal` that judges the result — so a
   * field type added to the declaration cannot be parsed by the cell and missed
   * by the lane. This component carried an identical private copy for four
   * beads, and that is why the guard reads the SOURCE: a second copy that
   * happens to agree today passes every behaviour test above and diverges on
   * the next field type somebody declares.
   */
  it("parses a draft with the declaration's own parser, never a copy of it", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "../src/components/CollectionEditor.tsx"),
      "utf8",
    );
    const imported =
      /import \{([\s\S]*?)\} from "@shared\/config-registers";/.exec(source)?.[1] ?? "";
    expect(imported).toContain("fieldFromDraft");
    expect(source).not.toMatch(/function\s+\w*[Ff]romDraft\b/);
    // The parse's own tells: nothing else in this component splits a list on
    // commas or rescues a number that did not parse.
    expect(source).not.toContain("string-list");
    expect(source).not.toContain("Number.isNaN");

    /**
     * AND NEITHER DOES THE OTHER DIRECTION (bead `ro-hem5`). `toDraft` lived
     * here, privately, which is why `KnobEditor` seeded its input with
     * `String()` for four beads: the inverse of the parse it validates through
     * was in a component it cannot import from. Half a pair kept where its
     * other half cannot reach it is the same defect as two parsers.
     */
    expect(imported).toContain("fieldToDraft");
    expect(source).not.toMatch(/function\s+\w*[Tt]oDraft\b/);
  });

  it("leaves exactly one toDraft in the app", () => {
    // The declaration's own home, and nowhere else. A `toDraft` PROP is not
    // this — `KnobEditor`'s datetime control takes one, and that is a control
    // format (what `datetime-local` accepts) rather than a value format — so
    // the guard is on a DECLARATION.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return /\.tsx?$/.test(entry.name) ? [full] : [];
      });
    const files = ["../src", "../shared"].flatMap((dir) =>
      walk(path.join(import.meta.dirname, dir)),
    );

    const owners = files.filter((file) =>
      /(?:function|const)\s+\w*[Tt]oDraft\b/.test(readFileSync(file, "utf8")),
    );

    expect(owners.map((file) => path.basename(file))).toEqual([
      "config-registers.ts",
    ]);
  });
});

/**
 * A CELL THAT SAVES ITSELF (bead `ro-ujb9.96.7.12`, `commit="auto"`).
 *
 * /settings' Task projects table had a Save beside every cell — nine on three
 * rows. Inline, a cell saves when it is left (Enter, Tab, a click elsewhere) or
 * when a choice is picked, and says "Saved · Undo" or "Not saved" under its own
 * control. Asserted: the WRITE is unchanged — the same single set, the same
 * `expect`, the same config door — and Undo is `collectionOps`' own inverse.
 */
describe("CollectionEditor — confirm inline", () => {
  const SPOKES = [
    { asset: "meals.example", prefix: "mp", database: "mp" },
    { asset: "nosh.example", prefix: "nom", database: "nom" },
  ];

  function renderSpokes() {
    return render(
      withClient(
        <CollectionEditor
          register="task-hub-spokes"
          rows={SPOKES}
          columns={["asset", "prefix", "database"]}
          slug="map-a-project"
          commit="auto"
        />,
      ),
    );
  }

  it("has no Save button in any cell", () => {
    stubFetch();
    renderSpokes();
    for (const key of ["meals.example", "nosh.example"]) {
      expect(within(row(key)).queryByRole("button", { name: "Save" })).toBeNull();
    }
  });

  it("saves a typed cell when it is left: one set carrying what the cell was rendered from", async () => {
    const calls = stubFetch();
    renderSpokes();

    const database = within(row("nosh.example")).getByLabelText("Database");
    fireEvent.change(database, { target: { value: "nom_tasks" } });
    fireEvent.blur(database);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body?.slug).toBe("map-a-project");
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-set",
      file: "config/beads.json",
      pointer: "/spokes/1/database",
      expect: "nom",
      value: "nom_tasks",
    });
    const saved = await waitFor(() => {
      const found = row("nosh.example").querySelector('[data-save-state="saved"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(saved).getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("saves on Enter too, and a second blur does not send the same edit again", async () => {
    const calls = stubFetch();
    renderSpokes();

    const prefix = within(row("meals.example")).getByLabelText("Task prefix");
    fireEvent.change(prefix, { target: { value: "mpf" } });
    fireEvent.keyDown(prefix, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(row("meals.example").querySelector('[data-save-state="saved"]')).not.toBeNull());
    fireEvent.blur(prefix);

    expect(calls).toHaveLength(1);
    expect(prefix).toHaveValue("mpf");
  });

  it("undoes through the same write with the exact inverse, and the cell shows the old value", async () => {
    const calls = stubFetch();
    renderSpokes();

    const database = within(row("nosh.example")).getByLabelText("Database");
    fireEvent.change(database, { target: { value: "nom_tasks" } });
    fireEvent.blur(database);
    fireEvent.click(await within(row("nosh.example")).findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(onlyOp(calls, 1)).toEqual({
      kind: "file-json-set",
      file: "config/beads.json",
      pointer: "/spokes/1/database",
      expect: "nom_tasks",
      value: "nom",
    });
    await waitFor(() => expect(database).toHaveValue("nom"));
  });

  it("never sends a value the declaration refuses, and says why under the cell", () => {
    const calls = stubFetch();
    renderSpokes();

    const prefix = within(row("nosh.example")).getByLabelText("Task prefix");
    fireEvent.change(prefix, { target: { value: "NOT VALID" } });
    fireEvent.blur(prefix);

    expect(calls).toEqual([]);
    expect(prefix).toHaveAttribute("aria-invalid", "true");
  });

  it("says a refused save under the cell as a short state and keeps the typed value", async () => {
    stubFetch({ status: 409, body: { error: "expect_mismatch", mismatches: [] } });
    renderSpokes();

    const database = within(row("nosh.example")).getByLabelText("Database");
    fireEvent.change(database, { target: { value: "nom_tasks" } });
    fireEvent.blur(database);

    const refused = await within(row("nosh.example")).findByRole("alert");
    expect(refused).toHaveTextContent("Not saved");
    expect(refused).toHaveTextContent("Changed elsewhere — reload to see the current value");
    expect(database).toHaveValue("nom_tasks");
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("puts a picked choice back on what is stored when the save is refused", async () => {
    stubFetch({ status: 409, body: { error: "expect_mismatch", mismatches: [] } });
    render(
      withClient(
        <CollectionEditor
          register="domain-costs"
          rows={[{ domain: "example.com", asset: "example.com", kind: "renewal", paidUsd: 12, paidOn: "2026-01-05" }]}
          columns={["domain", "kind"]}
          commit="auto"
        />,
      ),
    );

    const kind = within(row("example.com")).getByLabelText("Order") as HTMLSelectElement;
    const other = [...kind.options].map((option) => option.value).find((value) => value !== "" && value !== "renewal");
    expect(other).toBeDefined();
    fireEvent.change(kind, { target: { value: other } });

    expect(await within(row("example.com")).findByRole("alert")).toHaveTextContent("Not saved");
    expect(kind).toHaveValue("renewal");
  });
});
