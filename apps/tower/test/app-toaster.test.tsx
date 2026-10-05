import { act, fireEvent, render, screen, waitFor } from "./render";
import { toast } from "sonner";
import { afterEach, describe, expect, it } from "vitest";
import { AppToaster } from "@/lib/toaster";

// Bead ro-ujb9.87 (and ro-ujb9.54): a toast must not bounce keyboard focus back
// to the control it came from. jsdom has no Tab key, so each step is the focus
// move the browser makes for that key: Tab from the page's last control focuses
// the toast (it is the next Tab stop), and Tab from the toast leaves the page,
// which blurs it with no element receiving focus. The browser journey
// (`tabPastToast` in e2e/journeys.spec.ts) presses the real keys, and also
// covers a toast closing while focus is on it: jsdom, unlike a browser, does
// not blur an element it removes.

function Page() {
  return (
    <>
      <button type="button">First</button>
      <button type="button">Last</button>
      <AppToaster />
    </>
  );
}

async function showToast(text: string): Promise<HTMLElement> {
  act(() => {
    toast(text, { duration: Number.POSITIVE_INFINITY });
  });
  const shown = (await screen.findByText(text)).closest<HTMLElement>("[data-sonner-toast]");
  if (!shown) throw new Error("The toast did not render as a sonner toast");
  return shown;
}

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
});

describe("AppToaster keyboard focus", () => {
  it("lets Tab pass through a toast once instead of returning to the last control", async () => {
    render(<Page />);
    const shown = await showToast("Saved — pass through");
    const last = screen.getByRole("button", { name: "Last" });
    act(() => last.focus());
    act(() => shown.focus());
    expect(shown).toHaveFocus();
    act(() => shown.blur());
    expect(last).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it("does not pull focus back when the operator moves on, or when the toast closes", async () => {
    render(<Page />);
    const shown = await showToast("Saved — move on");
    const first = screen.getByRole("button", { name: "First" });
    act(() => screen.getByRole("button", { name: "Last" }).focus());
    act(() => shown.focus());
    act(() => first.focus());
    expect(first).toHaveFocus();
    act(() => {
      toast.dismiss();
    });
    await waitFor(() => expect(screen.queryByText("Saved — move on")).toBeNull());
    expect(first).toHaveFocus();
  });

  it("keeps sonner's Alt+T hotkey: it jumps to the notifications and back", async () => {
    render(<Page />);
    await showToast("Saved — hotkey");
    const last = screen.getByRole("button", { name: "Last" });
    act(() => last.focus());
    fireEvent.keyDown(document, { key: "t", code: "KeyT", altKey: true });
    const list = document.querySelector<HTMLElement>("[data-sonner-toaster]");
    expect(list).toHaveFocus();
    act(() => list!.blur());
    expect(last).toHaveFocus();
  });
});

// Bead ro-ujb9.117: a toast is drawn in the desk's theme, not always dark. The
// theme is the one AppShell applies to <html> (`.light`), so a toast follows a
// toggle without a reload, and the Wall — outside the shell — stays dark.
describe("AppToaster theme", () => {
  afterEach(() => {
    document.documentElement.classList.remove("light");
  });

  const drawnTheme = () => document.querySelector("[data-sonner-toaster]")?.getAttribute("data-sonner-theme");

  it("draws toasts dark on the dark desk", async () => {
    render(<AppToaster />);
    await showToast("Saved — dark");
    expect(drawnTheme()).toBe("dark");
  });

  it("draws toasts light on the light desk", async () => {
    document.documentElement.classList.add("light");
    render(<AppToaster />);
    await showToast("Saved — light");
    expect(drawnTheme()).toBe("light");
  });

  it("follows the theme when the operator toggles it, with a toast up", async () => {
    render(<AppToaster />);
    await showToast("Saved — toggled");
    expect(drawnTheme()).toBe("dark");
    act(() => document.documentElement.classList.add("light"));
    await waitFor(() => expect(drawnTheme()).toBe("light"));
    act(() => document.documentElement.classList.remove("light"));
    await waitFor(() => expect(drawnTheme()).toBe("dark"));
  });
});
