import { fireEvent, render, screen, waitFor, within } from "./render";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { FactChip } from "@/components/FactChip";

// The task page's drawn pieces on their own, with invented values.

function inRouter(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("FactChip", () => {
  const choices = [{ value: "open", label: "Open" }, { value: "blocked", label: "Blocked" }];

  it("is a plain fact with nothing to press when it cannot be edited", () => {
    inRouter(
      <FactChip label="Status" valueText="Open" readOnly editor={{ kind: "choice", value: "open", choices }} onSave={() => true}>
        Open
      </FactChip>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Open").closest("[data-fact-chip]")).toHaveAttribute("data-fact-chip", "plain");
  });

  it("saves a choice on press and closes, and names the press by its fact and value", async () => {
    const onSave = vi.fn(async () => true);
    inRouter(
      <FactChip label="Status" valueText="Open" editor={{ kind: "choice", value: "open", choices }} onSave={onSave}>
        Open
      </FactChip>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Status: Open" }));
    const editor = await screen.findByRole("dialog");
    expect(within(editor).getByRole("listbox", { name: "Status" })).toBeInTheDocument();
    expect(within(editor).getByRole("option", { name: "Open" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(editor).getByRole("option", { name: "Blocked" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("blocked"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves between choices with the arrow keys", async () => {
    inRouter(
      <FactChip label="Status" valueText="Open" editor={{ kind: "choice", value: "open", choices }} onSave={() => true}>
        Open
      </FactChip>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Status: Open" }));
    const list = within(await screen.findByRole("dialog")).getByRole("listbox");
    within(list).getByRole("option", { name: "Open" }).focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(list).getByRole("option", { name: "Blocked" }));
    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement).toBe(within(list).getByRole("option", { name: "Open" }));
  });

  it("writes a typed value on Enter, and nothing on Escape", async () => {
    const onSave = vi.fn(async () => true);
    inRouter(
      <FactChip label="Add a label" valueText="" editor={{ kind: "text", value: "", inputLabel: "New label" }} onSave={onSave}>
        Label
      </FactChip>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add a label" }));
    let input = within(await screen.findByRole("dialog")).getByRole("textbox", { name: "New label" });
    fireEvent.change(input, { target: { value: "ops" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Add a label" }));
    input = within(await screen.findByRole("dialog")).getByRole("textbox", { name: "New label" });
    fireEvent.change(input, { target: { value: " ops " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("ops"));
  });

  it("splits into the value's link and the editor's press when it leads somewhere", async () => {
    const onSave = vi.fn(async () => true);
    inRouter(
      <FactChip label="Parent epic" valueText="Ship it" to="/tasks/os-1" editor={{ kind: "choice", value: "os-1", choices: [{ value: "os-1", label: "Ship it" }, { value: "", label: "No epic" }] }} onSave={onSave}>
        Ship it
      </FactChip>,
    );
    expect(screen.getByRole("link", { name: "Ship it" })).toHaveAttribute("href", "/tasks/os-1");
    fireEvent.click(screen.getByRole("button", { name: "Change parent epic" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("option", { name: "No epic" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(""));
  });

  it("offers a date's presets and its clear, and takes a typed day on Enter", async () => {
    const onSave = vi.fn(async () => true);
    inRouter(
      <FactChip label="Parked until" valueText="Oct 20" editor={{ kind: "date", value: "2026-10-20", presets: [{ label: "Tomorrow", value: "2026-10-17" }], clearLabel: "Not parked" }} onSave={onSave}>
        Oct 20
      </FactChip>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Parked until: Oct 20" }));
    const editor = await screen.findByRole("dialog");
    expect(within(editor).getAllByRole("option").map((option) => option.textContent)).toEqual(["Tomorrow", "Not parked"]);
    const day = within(editor).getByLabelText("Date");
    fireEvent.change(day, { target: { value: "2026-11-02" } });
    fireEvent.keyDown(day, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("2026-11-02"));
  });
});
