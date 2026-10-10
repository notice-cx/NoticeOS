import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "./render";
import { MemoryRouter, matchRoutes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallPayload } from "@shared/wall";
import type { SettingsPayload, SourceSetting } from "@shared/settings";
import { validateSchemaAndSafety } from "../../../scripts/config-documents.mjs";
import { SITE_ROW_FIELDS, fieldRefusal } from "../../../scripts/config-registers.mjs";

// Add a site, one screen, the domain its only question: the name is read off
// the domain before anything answers and replaced by the site's own when it
// does, a refusal lands beside the field, and Add makes the store row and
// then one changeset, in that order, then lands on the new asset's Data
// sources. The state that is neither success nor failure (the row landed, the
// setup did not) keeps its guarded retry.
//
// `fetch` is stubbed rather than `@/lib/api`, because the order and the bodies
// of the two writes are the subject.

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const state = vi.hoisted(() => ({
  assets: [] as { id: string; status?: string }[],
  writable: { writable: true, reason: null as string | null, sources: {} },
  settingsReady: true,
  wallReady: true,
}));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({
    data: state.wallReady ? { assets: state.assets } as unknown as WallPayload : undefined,
    isPending: !state.wallReady,
    isError: false,
  }),
}));

vi.mock("@/hooks/useConfigWritable", () => ({
  useConfigWritable: () => state.writable,
}));

const CATALOG: SourceSetting[] = [
  { id: "gsc", label: "Google Search Console (GSC API)", scope: "property", layer: "provider", credential: "shared" },
  { id: "ad-network", label: "Ad network reporting", scope: "property", layer: "provider", credential: "shared" },
  { id: "discord-webhooks", label: "Discord operator-notification webhooks", scope: "portfolio", layer: "provider", credential: "shared" },
];

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    data: state.settingsReady
      ? ({ sources: { owner: "config/integrations.json", rows: CATALOG } } as unknown as SettingsPayload)
      : undefined,
    isPending: !state.settingsReady,
    isError: false,
  }),
}));

import { deskRoutes } from "@/App";
import { AddSiteSheet } from "@/components/AddSite";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** The two write endpoints, as far as this screen can tell, plus the site-name
 * lookup answered on the side (never counted as a write). Each write reply is
 * popped in order, so a test says "the row is fine, the lane refuses" as data. */
function stubFetch(replies: ({ status: number; body: unknown } | Error)[], siteName: string | null = null): Call[] {
  const calls: Call[] = [];
  const queue = [...replies];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/site-name")) {
        return new Response(JSON.stringify({ name: siteName }), { status: 200, headers: { "content-type": "application/json" } });
      }
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      const reply = queue.shift() ?? { status: 200, body: { ok: true } };
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

let path = "/";

function Probe() {
  const location = useLocation();
  path = `${location.pathname}${location.hash}`;
  return null;
}

const onClose = vi.fn();

function renderSheet() {
  path = "/";
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/"]}>
        <AddSiteSheet onClose={onClose} />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function typeDomain(value: string) {
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value } });
}

function add() {
  fireEvent.click(screen.getByRole("button", { name: "Add site" }));
}

beforeEach(() => {
  state.assets = [];
  state.writable = { writable: true, reason: null, sources: {} };
  state.settingsReady = true;
  state.wallReady = true;
  toasts.success.mockReset();
  toasts.error.mockReset();
  onClose.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the address is not captured by the site page", () => {
  it("ranks /assets/new above /assets/:id/:tab?", () => {
    expect(matchRoutes(deskRoutes, "/assets/new")?.at(-1)?.route.path).toBe("/assets/new");
    expect(matchRoutes(deskRoutes, "/assets/shop.example.com")?.at(-1)?.route.path).toBe("/assets/:id/:tab?");
    expect(matchRoutes(deskRoutes, "/assets/shop.example.com/sources")?.at(-1)?.route.path).toBe("/assets/:id/:tab?");
  });
});

describe("one question: the domain", () => {
  it("is a dialog with one field, Add, and the one optional press", () => {
    stubFetch([]);
    renderSheet();
    expect(screen.getByRole("dialog", { name: "Add a site" })).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add site" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not launched yet" })).toHaveAttribute("aria-pressed", "false");
  });

  it("reads the name off whatever is pasted, before anything answers", () => {
    stubFetch([]);
    renderSheet();
    typeDomain("https://www.journey.example/pricing");
    expect(document.querySelector("[data-add-site-name]")?.textContent).toBe("Journey Example");
    expect(document.querySelector("[data-add-site-source]")?.getAttribute("data-add-site-source")).toBe("domain");
    expect(screen.getByRole("button", { name: "Add site" })).toBeEnabled();
  });

  it("takes the site's own name when the site answers with one", async () => {
    stubFetch([], "Example Shop");
    renderSheet();
    typeDomain("shop.example.com");
    expect(document.querySelector("[data-add-site-name]")?.textContent).toBe("Shop Example");
    await waitFor(() => expect(document.querySelector("[data-add-site-name]")?.textContent).toBe("Example Shop"), { timeout: 2_000 });
    expect(document.querySelector("[data-add-site-source]")?.getAttribute("data-add-site-source")).toBe("site");
  });

  it("refuses a domain the portfolio already has at once, with the way to it", () => {
    state.assets = [{ id: "shop.example.com" }];
    stubFetch([]);
    renderSheet();
    typeDomain("shop.example.com");
    expect(screen.getByText("Already added")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open shop.example.com" })).toHaveAttribute("href", "/assets/shop.example.com");
    expect(screen.getByRole("button", { name: "Add site" })).toBeDisabled();
  });

  // Archive is the one way out of the site list, so an archived site is the
  // one a person most often adds again: its link lands on Restore.
  it("opens an archived site it already has where Restore is", () => {
    state.assets = [{ id: "shop.example.com", status: "retired" }];
    stubFetch([]);
    renderSheet();
    typeDomain("shop.example.com");
    expect(screen.getByText("Already added")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open shop.example.com" })).toHaveAttribute("href", "/assets/shop.example.com/settings#restore");
  });

  it("keeps a half-typed domain quiet, and says what is wrong once Add is pressed", () => {
    stubFetch([]);
    renderSheet();
    typeDomain("shop");
    expect(screen.queryByText(/Not a domain/)).toBeNull();
    add();
    expect(screen.getByText("Not a domain — like example.com")).toBeInTheDocument();
    typeDomain("shop.example.com");
    expect(screen.queryByText(/Not a domain/)).toBeNull();
    typeDomain("shop");
    fireEvent.submit(screen.getByLabelText("Domain").closest("form")!);
    expect(screen.getByText("Not a domain — like example.com")).toBeInTheDocument();
  });

  it("keeps an Add pressed before the source catalog loads, and sends it once it has", async () => {
    state.settingsReady = false;
    const calls = stubFetch([
      { status: 201, body: { ok: true, asset: { id: "shop.example.com" } } },
      { status: 200, body: { applied: 2, archive: null, commit: null } },
    ]);
    const view = renderSheet();
    typeDomain("shop.example.com");
    add();
    expect(screen.getByRole("button", { name: "Adding" })).toBeDisabled();
    expect(calls).toHaveLength(0);
    state.settingsReady = true;
    view.rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/"]}>
          <AddSiteSheet onClose={onClose} />
          <Probe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toMatchObject({ ops: [{ file: "config/integrations.json", value: { gsc: {}, "ad-network": {} } }, {}] });
  });

  it("pauses Add, in the install's own words, where setup cannot be saved", () => {
    state.writable = { writable: false, reason: "This deployment cannot save file-owned settings.", sources: {} };
    stubFetch([]);
    renderSheet();
    typeDomain("shop.example.com");
    expect(screen.getByText("This deployment cannot save file-owned settings.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add site" })).toBeDisabled();
  });
});

describe("Add writes the row, then one changeset — the wizard's writes", () => {
  it("calls POST /api/assets before PUT /api/config and lands on the new asset's Data sources", async () => {
    const calls = stubFetch([
      { status: 201, body: { ok: true, asset: { id: "shop.example.com" } } },
      { status: 200, body: { applied: 2, archive: "config/changesets/0042_add-asset.json", commit: null } },
    ]);
    renderSheet();
    typeDomain("shop.example.com");
    add();

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toMatchObject({
      url: "/api/assets",
      method: "POST",
      body: { id: "shop.example.com", displayName: "Shop Example", domain: "shop.example.com", status: "onboarding", senseOnly: 1 },
    });
    expect(calls[1]).toMatchObject({
      url: "/api/config",
      method: "PUT",
      body: {
        slug: "add-asset-shop-example-com",
        ops: [
          { kind: "file-json-insert", file: "config/integrations.json", pointer: "/assets/shop.example.com" },
          { kind: "file-json-insert", file: "config/signal-panels.json", pointer: "/assets/shop.example.com" },
        ],
      },
    });
    expect(() => validateSchemaAndSafety({ version: 1, createdAt: "2026-09-06T12:00:00Z", ...(calls[1]!.body as Record<string, unknown>) })).not.toThrow();
    await waitFor(() => expect(path).toBe("/assets/shop.example.com/sources"));
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("starts a site that has not launched in pre-launch", async () => {
    const calls = stubFetch([
      { status: 201, body: { ok: true, asset: { id: "shop.example.com" } } },
      { status: 200, body: { applied: 2, archive: null, commit: null } },
    ]);
    renderSheet();
    typeDomain("shop.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Not launched yet" }));
    expect(screen.getByRole("button", { name: "Not launched yet" })).toHaveAttribute("aria-pressed", "true");
    add();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]?.body).toMatchObject({ status: "pre-launch" });
  });

  it("sends the store's 409 back to the field as Already added, with the way to it", async () => {
    const calls = stubFetch([{ status: 409, body: { error: "asset_exists", id: "shop.example.com" } }]);
    renderSheet();
    typeDomain("shop.example.com");
    add();
    await screen.findByText("Already added");
    // The config lane was never asked: the cheap guard is spent first.
    expect(calls).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Open shop.example.com" })).toBeInTheDocument();
  });

  // One site per domain: the store's 409 names the site holding the domain,
  // whose id may not be the one typed. The link opens that site.
  it("opens the site the store says holds the domain, not a page for the id typed", async () => {
    state.assets = [{ id: "shop", status: "retired" }];
    const calls = stubFetch([{ status: 409, body: { error: "asset_exists", id: "shop" } }]);
    renderSheet();
    typeDomain("shop.example.com");
    add();
    await screen.findByText("Already added");
    expect(calls).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Open shop.example.com" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open shop" })).toHaveAttribute("href", "/assets/shop/settings#restore");
    fireEvent.click(screen.getByRole("link", { name: "Open shop" }));
    expect(path).toBe("/assets/shop/settings#restore");
  });

  it("offers no way to a site when the refusal names none", async () => {
    stubFetch([{ status: 409, body: { error: "asset_exists" } }]);
    renderSheet();
    typeDomain("shop.example.com");
    add();
    await screen.findByText("Already added");
    expect(screen.queryByRole("link", { name: /^Open / })).toBeNull();
  });

  it.each([
    { status: 'retired', cached: undefined, href: '/assets/shop/settings#restore' },
    { status: 'live', cached: undefined, href: '/assets/shop' },
    { status: 'retired', cached: 'live', href: '/assets/shop/settings#restore' },
    { status: 'live', cached: 'retired', href: '/assets/shop' },
  ])('uses the refused holder status $status when the wall has $cached', async ({ status, cached, href }) => {
    state.wallReady = cached !== undefined;
    state.assets = cached === undefined ? [] : [{ id: 'shop', status: cached }];
    const calls = stubFetch([{ status: 409, body: { error: 'asset_exists', id: 'shop', existingStatus: status } }]);
    renderSheet();
    typeDomain('shop.example.com');
    add();
    const link = await screen.findByRole('link', { name: 'Open shop' });
    expect(link).toHaveAttribute('href', href);
    fireEvent.click(link);
    expect(path).toBe(href);
    expect(calls).toHaveLength(1);
  });

  // The store's refusal names the field by the label beside the input: the
  // sentence is the store's own (`fieldRefusal` over the site row's declared Domain).
  it("puts a 422 beside the field, named by the label beside it", async () => {
    const detail = fieldRefusal(SITE_ROW_FIELDS.domain, "https://shop.example.com/x");
    expect(detail).toBe("Domain must be a hostname such as example.com");
    stubFetch([{ status: 422, body: { error: "invalid_asset", field: "domain", detail } }]);
    renderSheet();
    typeDomain("shop.example.com");
    add();
    const refusal = await screen.findByText(detail!);
    const input = screen.getByLabelText(SITE_ROW_FIELDS.domain.label);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", refusal.id);
  });

  it("says what landed when the row is written and the setup is not, and retries only the setup", async () => {
    const calls = stubFetch([
      { status: 201, body: { ok: true, asset: { id: "shop.example.com" } } },
      { status: 503, body: { error: "store_unavailable", detail: "Please retry" } },
      { status: 503, body: { error: "store_unavailable", detail: "Still unavailable" } },
      { status: 200, body: { applied: 2, archive: null, commit: null } },
    ]);
    renderSheet();
    typeDomain("shop.example.com");
    add();

    await screen.findByText("Setup not saved");
    expect(screen.getByText("added")).toBeInTheDocument();
    expect(screen.getByText(/Please retry/)).toBeInTheDocument();
    expect(screen.getByText("Technical details").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText(/"kind": "file-json-insert"/)).toBeInTheDocument();
    // A refreshed portfolio now knows this asset. It must not block recovery.
    state.assets = [{ id: "shop.example.com" }];
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    await screen.findByText(/Still unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    await waitFor(() => expect(path).toBe("/assets/shop.example.com/sources"));
    expect(calls.map(({ method }) => method)).toEqual(["POST", "PUT", "PUT", "PUT"]);
    expect(calls[2]?.body).toEqual(calls[1]?.body);
    expect(calls[3]?.body).toEqual(calls[1]?.body);
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("does not infer ownership when an asset-create response is lost", async () => {
    const calls = stubFetch([
      new Error("Connection interrupted"),
      { status: 409, body: { error: "asset_exists", id: "shop.example.com" } },
    ]);
    renderSheet();
    typeDomain("shop.example.com");
    add();
    await screen.findByText("Connection interrupted");
    expect(screen.queryByRole("button", { name: "Retry setup" })).toBeNull();
    add();
    await screen.findByText("Already added");
    expect(calls.map(({ method }) => method)).toEqual(["POST", "POST"]);
  });

  it("refuses to attach setup to a different asset returned by the server", async () => {
    const calls = stubFetch([{ status: 201, body: { asset: { id: "other.example" } } }]);
    renderSheet();
    typeDomain("shop.example.com");
    add();
    await screen.findByText(/did not confirm this site/);
    expect(calls).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Retry setup" })).toBeNull();
  });

  it("closes on Escape without writing anything", () => {
    const calls = stubFetch([]);
    renderSheet();
    typeDomain("shop.example.com");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});
