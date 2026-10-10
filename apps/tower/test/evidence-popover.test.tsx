// The evidence popover keeps keyboard focus with the reader: opening moves
// focus into the panel; Escape and a press outside close it and give focus
// back to the trigger; a scroll neither closes it nor strands focus. It is
// built on the desk's Radix popover (components/ui).
import { act, fireEvent, render, screen, waitFor } from "./render";
import { describe, expect, it } from "vitest";
import type { IntegrationEvidence } from "@shared/integrations";
import { EvidencePopover } from "@/components/EvidencePopover";

const EVIDENCE: IntegrationEvidence[] = [
  { source: "Uptime check", polarity: "against", detail: "HTTP 503 twice, 45 s apart", at: "2026-09-06T11:48:00.000Z" },
  { source: "Last success", polarity: "supporting", detail: "200 OK", at: "2026-09-05T11:48:00.000Z" },
];

function renderPopover() {
  return render(
    <div>
      <button type="button">Before</button>
      <EvidencePopover evidence={EVIDENCE} nowMs={Date.parse("2026-09-06T12:00:00.000Z")} question="Why this fired" triggerLabel="Evidence" />
      <p data-testid="outside">Plain text outside</p>
      <button type="button">After</button>
    </div>,
  );
}

const trigger = () => screen.getByRole("button", { name: "Why this fired — 2 evidence notes" });

/** Open it the way a keyboard does: focus the trigger, press it. */
async function openFromKeyboard() {
  trigger().focus();
  fireEvent.click(trigger());
  const dialog = await screen.findByRole("dialog", { name: "Why this fired" });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  return dialog;
}

describe("EvidencePopover focus", () => {
  it("moves focus into the dialog when it opens", async () => {
    renderPopover();
    const dialog = await openFromKeyboard();
    expect(dialog).toHaveTextContent("HTTP 503 twice, 45 s apart");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on Escape and gives focus back to the trigger", async () => {
    renderPopover();
    await openFromKeyboard();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger()).toHaveFocus());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on a press outside and gives focus back rather than dropping it on the page", async () => {
    renderPopover();
    await openFromKeyboard();
    const outside = screen.getByTestId("outside");
    fireEvent.pointerDown(outside);
    // Pressing plain text takes focus nowhere: the browser leaves it on the body.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.pointerUp(outside);
    fireEvent.click(outside);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it("leaves focus on another control a press outside chose", async () => {
    renderPopover();
    await openFromKeyboard();
    const after = screen.getByRole("button", { name: "After" });
    fireEvent.pointerDown(after);
    after.focus();
    fireEvent.pointerUp(after);
    fireEvent.click(after);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Radix hands focus back a tick later; it must not steal it from "After".
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(after).toHaveFocus();
  });

  it("stays open, with focus inside, while the page scrolls", async () => {
    renderPopover();
    const dialog = await openFromKeyboard();
    act(() => {
      fireEvent.scroll(window);
      fireEvent.scroll(document);
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("does not open the row it sits in", async () => {
    let rowOpened = 0;
    render(
      <div role="button" tabIndex={0} onClick={() => { rowOpened += 1; }}>
        <EvidencePopover evidence={EVIDENCE} question="Why this fired" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Why this fired/ }));
    await screen.findByRole("dialog");
    expect(rowOpened).toBe(0);
  });
});
