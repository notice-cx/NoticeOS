import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserEntry } from "@/BrowserEntry";
import { NoticeMark } from "@/components/BrandLockup";
import { RouteLoadFailure } from "@/components/RouteLoading";
import {
  BOOT_SPLASH_FADE_MS,
  BOOT_SPLASH_ID,
  BOOT_SPLASH_QUIET_MS,
  BOOT_SPLASH_SAFETY_MS,
  BOOT_SPLASH_SETTLE_CAP_MS,
  BootSplashDismiss,
  armBootSplash,
  dismissBootSplash,
  dismissBootSplashWhenSettled,
  useBootSplashRelease,
  type BootReads,
} from "@/lib/boot-splash";
import type { ApiTransport } from "@/lib/api";
import { createBrowserEntry } from "@/lib/browser-entry";

const root = path.resolve(import.meta.dirname, "..");
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");

/** index.html's own splash, put into the test document the way the page has it. */
function mountSplash(): HTMLElement {
  const page = new DOMParser().parseFromString(indexHtml, "text/html");
  const splash = page.getElementById(BOOT_SPLASH_ID)!;
  document.body.append(document.importNode(splash, true));
  return document.getElementById(BOOT_SPLASH_ID)!;
}
const splash = () => document.getElementById(BOOT_SPLASH_ID);
const leaving = () => splash()?.hasAttribute("data-leaving") ?? false;

/** Reads whose in-flight count the test sets, notifying as a query cache does. */
function fakeReads(initial: number) {
  let fetching = initial;
  const listeners = new Set<() => void>();
  const reads = {
    isFetching: () => fetching,
    getQueryCache: () => ({
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
  } as unknown as BootReads;
  return {
    reads,
    listeners,
    set(count: number) {
      fetching = count;
      for (const listener of listeners) listener();
    },
  };
}

afterEach(() => {
  splash()?.remove();
  vi.useRealTimers();
});

describe("the splash index.html draws", () => {
  const page = new DOMParser().parseFromString(indexHtml, "text/html");
  const element = page.getElementById(BOOT_SPLASH_ID)!;

  it("is a status named for screen readers, its drawing hidden from them", () => {
    expect(element.getAttribute("role")).toBe("status");
    expect(element.getAttribute("aria-label")).toBe("Loading NoticeOS");
    expect(element.getAttribute("data-status-for")).toBe("app:boot");
    for (const child of element.children) expect(child.getAttribute("aria-hidden")).toBe("true");
  });

  it("sits beside #root, never inside it, so React's first render leaves it alone", () => {
    expect(page.getElementById("root")!.children).toHaveLength(0);
    expect(element.parentElement).toBe(page.body);
    expect(page.getElementById("root")!.nextElementSibling).toBe(element);
  });

  it("draws the Notice mark from the same path as NoticeMark", () => {
    const { container } = render(<NoticeMark />);
    const drawn = container.querySelector("path")!;
    const copy = element.querySelector("svg path")!;
    expect(copy.getAttribute("d")).toBe(drawn.getAttribute("d"));
    expect(copy.getAttribute("fill-rule")).toBe("evenodd");
    expect(copy.getAttribute("fill")).toBe("currentColor");
    expect(element.textContent?.replace(/\s+/g, "")).toBe("NoticeOS");
  });

  it("never takes a click, fades out when dismissed and holds still under reduced motion", () => {
    const style = [...page.querySelectorAll("head style")].map((node) => node.textContent ?? "").join("\n");
    const rule = (selector: string) => style.match(new RegExp(`${selector.replace(/[[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule("#boot-splash")).toMatch(/pointer-events:\s*none/);
    expect(rule("#boot-splash")).toMatch(/position:\s*fixed/);
    expect(rule("#boot-splash")).toMatch(new RegExp(`transition:\\s*opacity ${BOOT_SPLASH_FADE_MS}ms`));
    expect(rule("#boot-splash[data-leaving]")).toMatch(/opacity:\s*0/);
    const reduced = style.slice(style.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/#boot-splash\s*\{\s*transition:\s*none/);
    expect(reduced).toMatch(/\.boot-splash-mark\s*\{\s*animation:\s*none/);
    expect(reduced).toMatch(/\.boot-splash-line\s*\{\s*display:\s*none/);
    // Colours are the brand's tokens, never a second copy of a value.
    expect(style).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("is outside the head block the demo build rewrites", () => {
    expect(indexHtml.indexOf("<style>")).toBeLessThan(indexHtml.indexOf("<!-- document-head:begin -->"));
  });
});

describe("dismissBootSplash", () => {
  beforeEach(() => vi.useFakeTimers());

  it("fades the splash, removes it once the fade has run, and acts once", () => {
    mountSplash();
    dismissBootSplash();
    expect(leaving()).toBe(true);
    dismissBootSplash();
    vi.advanceTimersByTime(BOOT_SPLASH_FADE_MS - 1);
    expect(splash()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(splash()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => dismissBootSplash()).not.toThrow();
  });

  it("is dismissed by the safety limit when nothing else takes it down", () => {
    mountSplash();
    armBootSplash();
    vi.advanceTimersByTime(BOOT_SPLASH_SAFETY_MS - 1);
    expect(leaving()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(leaving()).toBe(true);
  });

  it("leaves the safety limit disarmed once cancelled", () => {
    mountSplash();
    armBootSplash()();
    vi.advanceTimersByTime(BOOT_SPLASH_SAFETY_MS);
    expect(leaving()).toBe(false);
  });
});

describe("dismissBootSplashWhenSettled", () => {
  beforeEach(() => vi.useFakeTimers());

  it("waits for the first screen's reads, then for a short quiet, then dismisses", () => {
    mountSplash();
    const reads = fakeReads(2);
    dismissBootSplashWhenSettled(reads.reads);
    vi.advanceTimersByTime(1_000);
    expect(leaving()).toBe(false);
    reads.set(0);
    vi.advanceTimersByTime(BOOT_SPLASH_QUIET_MS - 1);
    expect(leaving()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(leaving()).toBe(true);
    expect(reads.listeners.size).toBe(0);
  });

  it("holds through a read that another read's answer starts", () => {
    mountSplash();
    const reads = fakeReads(1);
    dismissBootSplashWhenSettled(reads.reads);
    reads.set(0);
    vi.advanceTimersByTime(BOOT_SPLASH_QUIET_MS / 2);
    reads.set(1);
    vi.advanceTimersByTime(BOOT_SPLASH_QUIET_MS);
    expect(leaving()).toBe(false);
    reads.set(0);
    vi.advanceTimersByTime(BOOT_SPLASH_QUIET_MS);
    expect(leaving()).toBe(true);
  });

  it("never holds the splash past the cap for a slow or polling screen", () => {
    mountSplash();
    const reads = fakeReads(1);
    dismissBootSplashWhenSettled(reads.reads);
    vi.advanceTimersByTime(BOOT_SPLASH_SETTLE_CAP_MS - 1);
    expect(leaving()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(leaving()).toBe(true);
    expect(reads.listeners.size).toBe(0);
  });

  it("dismisses at once with nothing in flight after the quiet, or with no client", () => {
    mountSplash();
    dismissBootSplashWhenSettled(fakeReads(0).reads);
    vi.advanceTimersByTime(BOOT_SPLASH_QUIET_MS);
    expect(leaving()).toBe(true);
    splash()!.remove();
    mountSplash();
    dismissBootSplashWhenSettled(undefined);
    expect(leaving()).toBe(true);
  });

  it("does nothing once the splash is gone, and stops when cancelled", () => {
    const gone = fakeReads(1);
    dismissBootSplashWhenSettled(gone.reads);
    expect(gone.listeners.size).toBe(0);
    mountSplash();
    const reads = fakeReads(1);
    dismissBootSplashWhenSettled(reads.reads)();
    vi.advanceTimersByTime(BOOT_SPLASH_SETTLE_CAP_MS);
    expect(leaving()).toBe(false);
    expect(reads.listeners.size).toBe(0);
  });
});

describe("the screens that take the splash down", () => {
  function Screen({ load }: { load: () => Promise<string> }) {
    const { data } = useQuery({ queryKey: ["screen"], queryFn: load });
    useBootSplashRelease();
    return <p>{data ?? "waiting"}</p>;
  }

  it("a screen root: once its first read has answered", async () => {
    mountSplash();
    let answer = (_: string) => {};
    const load = () => new Promise<string>((resolve) => (answer = resolve));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Screen load={load} /></QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, BOOT_SPLASH_QUIET_MS * 2));
    expect(leaving()).toBe(false);
    await act(async () => answer("drawn"));
    expect(await screen.findByText("drawn")).toBeInTheDocument();
    await waitFor(() => expect(leaving()).toBe(true));
  });

  it("a failure: at once", () => {
    mountSplash();
    render(<RouteLoadFailure openUpdated={() => {}} />);
    expect(leaving()).toBe(true);
  });

  it("a screen with nothing to wait for: at once", () => {
    mountSplash();
    render(<BootSplashDismiss />);
    expect(leaving()).toBe(true);
  });
});

describe("the session check", () => {
  it("holds the splash while the session is checked and the sign-in screen's code arrives", async () => {
    mountSplash();
    let open = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const fetch: ApiTransport = async () => {
      await gate;
      return Response.json({ mode: "hosted", session: null, workspaces: [], selectedWorkspace: null, nextCursor: null });
    };
    const view = render(
      <BrowserEntry
        createEntry={() => createBrowserEntry({ origin: window.location.origin, page: window, fetch, landing: { kind: "none" } })}
      />,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, BOOT_SPLASH_QUIET_MS * 2));
      expect(leaving()).toBe(false);
      open();
      await screen.findByRole("button", { name: "Send code" });
      await waitFor(() => expect(leaving()).toBe(true));
    } finally {
      view.unmount();
    }
  });
});
