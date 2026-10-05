// A token per site, pasted on its row in the connect panel (Clarity, bead
// `ro-ujb9.96.7.9`).
//
// WHAT IS PROTECTED: a pasted token is saved at once and leaves the screen;
// typing waits for Enter or leaving the field; a refusal is said on its row;
// held sites wear the connection model's status; and Run now says what it
// spends and runs only for sites holding a token with calls to spare.

import { act, fireEvent, render, screen, within } from "./render";
import { describe, expect, it, vi } from "vitest";
import type { CollectNowResult } from "@noticeos/contract";
import { integrationProvider } from "@noticeos/contract";
import { SiteTokens, type SiteTokensProps } from "@/components/SiteTokens";

const CLARITY = integrationProvider("clarity")!;
const TOKEN = "SEKRIT-clarity-token-do-not-echo-0123456789";
const SITES = [
  { id: "journey.example", label: "Journey Example", domain: "journey.example", held: false },
  { id: "second.example", label: "Second Example", domain: "second.example", held: true },
];

function renderTokens(over: Partial<SiteTokensProps> = {}) {
  const onSave = vi.fn(async () => {});
  const onRun = vi.fn(async (): Promise<CollectNowResult | null> => null);
  render(
    <SiteTokens
      provider={CLARITY}
      sites={SITES}
      cap={10}
      statusOf={(asset) => (asset === "second.example" ? "working" : null)}
      remaining={() => 10}
      onSave={onSave}
      onRun={onRun}
      {...over}
    />,
  );
  return { onSave, onRun };
}

const input = (asset: string) => document.querySelector(`[data-site-token-input="${asset}"]`) as HTMLInputElement;

describe("tokens pasted per site", () => {
  it("saves a pasted token at once, and never shows it back", async () => {
    const { onSave } = renderTokens();
    await act(async () => { fireEvent.change(input("journey.example"), { target: { value: TOKEN } }); });
    expect(onSave).toHaveBeenCalledWith("journey.example", TOKEN);
    expect(input("journey.example")).toHaveValue("");
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("waits for Enter when a token is typed, not pasted", async () => {
    const { onSave } = renderTokens();
    fireEvent.change(input("journey.example"), { target: { value: "abc" } });
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(input("journey.example"), { key: "Enter" }); });
    expect(onSave).toHaveBeenCalledWith("journey.example", "abc");
  });

  it("says a refusal on the site's own row and clears the token", async () => {
    renderTokens({ onSave: async () => { throw new Error("That site is not one of this installation’s."); } });
    await act(async () => { fireEvent.change(input("journey.example"), { target: { value: TOKEN } }); });
    const row = document.querySelector('[data-site-token-row="journey.example"]') as HTMLElement;
    expect(within(row).getByText("That site is not one of this installation’s.")).toBeInTheDocument();
    expect(input("journey.example")).toHaveValue("");
  });

  it("shows each held site's status, and offers a replacement rather than showing the token", () => {
    renderTokens();
    const held = document.querySelector('[data-site-token-row="second.example"]') as HTMLElement;
    expect(held.querySelector("[data-connection]")).toHaveAttribute("data-connection", "working");
    expect(input("second.example")).toHaveAttribute("placeholder", "Replace token");
    expect(document.querySelector('[data-site-token-row="journey.example"] [data-connection]')).toBeNull();
  });

  it("runs the export for the sites holding a token, saying what it spends", async () => {
    const { onRun } = renderTokens();
    const run = screen.getByRole("button", { name: /Run now/ });
    expect(run).toHaveTextContent("Run now · 1 of 10");
    await act(async () => { fireEvent.click(run); });
    expect(onRun).toHaveBeenCalledWith(["second.example"]);
  });

  it("counts what is left today, and cannot spend a call a site no longer has", () => {
    renderTokens({ remaining: () => 3 });
    expect(screen.getByRole("button", { name: /Run now/ })).toHaveTextContent("Run now · 1 of 3 left");
  });

  it("cannot run with no token held", () => {
    renderTokens({ sites: SITES.map((site) => ({ ...site, held: false })) });
    expect(screen.getByRole("button", { name: /Run now/ })).toBeDisabled();
  });
});
