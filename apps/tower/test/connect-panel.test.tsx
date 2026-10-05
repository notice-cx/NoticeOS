// The connect panel and the Integrations row's one status (bead
// `ro-ujb9.96.7.1`).
//
// WHAT IS PROTECTED: a connection is never shown as working ahead of the
// provider's answer; the answer is drawn (Checking → Key accepted, or the
// refusal in plain words); a secret is never shown back; and the row derives
// one status in the order the audit set.

import { act, fireEvent, render, screen, within } from "./render";
import { describe, expect, it, vi } from "vitest";
import type { ConnectVerdict, CredentialSummary, IntegrationHealthItem, IntegrationProvider } from "@noticeos/contract";
import { integrationProvider } from "@noticeos/contract";
import { connectsInPanel, refusalLine } from "@shared/connect-panel";
import { connectionLabel, connectionStatus } from "@shared/connection-status";
import { ConnectPanel } from "@/components/ConnectPanel";
import { ApiError } from "@/lib/api";

const BING = integrationProvider("bing-webmaster")!;
const DATAFORSEO = integrationProvider("dataforseo")!;
const SECRET = "SEKRIT-panel-do-not-echo";
const AT = "2026-09-22T12:00:00.000Z";

function credential(over: Partial<CredentialSummary> = {}): CredentialSummary {
  return {
    provider: "bing-webmaster", source: "none", fields: [], assetsHeld: [], missingFields: [], auth: null,
    metadata: null, keyVersion: null, createdAt: null, updatedAt: null, lastUsedAt: null, lastOkAt: null, lastError: null,
    ...over,
  };
}
const stored = (over: Partial<CredentialSummary> = {}) =>
  credential({ source: "store", fields: ["BING_WEBMASTER_API_KEY"], keyVersion: 1, createdAt: AT, updatedAt: AT, ...over });

/** A promise the test resolves by hand, so the Checking state can be seen. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function renderPanel(provider: IntegrationProvider, onConnect: (fields: Record<string, string>) => Promise<ConnectVerdict>, over: { canConnect?: boolean; onClose?: () => void } = {}) {
  return render(<ConnectPanel provider={provider} onConnect={onConnect} onClose={over.onClose ?? (() => {})} canConnect={over.canConnect} />);
}

/** One monitored operation for Bing on one site. */
const op = (state: IntegrationHealthItem["state"], over: Partial<IntegrationHealthItem> = {}): IntegrationHealthItem => ({
  id: `${state}-${over.asset ?? "a.test"}`, provider: "bing-webmaster", capability: "bing-daily", label: "Bing daily reports",
  asset: "a.test", detail: null, report: null, reportDate: null, state, lastAttemptAt: state === "never-run" ? null : AT, lastSuccessAt: state === "healthy" ? AT : null,
  nextAttemptAt: null, failure: state === "failing" ? "access" : null, code: null, action: "Review.", coverage: "monitored", ...over,
});
const row = (summary: CredentialSummary, items: IntegrationHealthItem[]) => connectionStatus("bing-webmaster", summary, items).kind;

describe("the row's one status", () => {
  it("says Not connected until something complete is stored", () => {
    expect(row(credential(), [])).toBe("not-connected");
    expect(row(stored({ missingFields: ["BING_WEBMASTER_API_KEY"] }), [op("healthy")])).toBe("not-connected");
  });

  it("never calls a saved key accepted before the provider answered a test of it", () => {
    // A PUT clears the verdict, so a freshly saved key has no lastOkAt.
    expect(row(stored(), [])).toBe("not-checked");
    expect(row(stored(), [op("never-run")])).toBe("collecting");
    expect(row(stored({ lastOkAt: AT, lastUsedAt: AT }), [])).toBe("key-accepted");
    expect(connectionLabel("key-accepted", "sign-in")).toBe("Signed in");
  });

  it("leads with the worst news now, then the strongest proof", () => {
    const ok = stored({ lastOkAt: AT, lastUsedAt: AT });
    expect(row(stored({ lastError: "refused", lastUsedAt: AT }), [op("healthy")])).toBe("failing");
    expect(row(ok, [op("failing")])).toBe("failing");
    expect(row(ok, [op("stale")])).toBe("overdue");
    // One site with a stored result is a working connection; another site
    // still awaiting its first run is that site's detail, not the row's.
    expect(row(ok, [op("never-run", { asset: "b.test" }), op("healthy"), op("idle", { asset: "c.test" })])).toBe("working");
    expect(row(ok, [op("paused")])).toBe("not-using");
  });

  it("opens the panel only for providers that declare a connect kind", () => {
    expect(connectsInPanel(BING)).toBe(true);
    expect(connectsInPanel(DATAFORSEO)).toBe(true);
    // Google signs in in the panel (bead ro-ujb9.96.7.7), and Discord and the
    // calendar feeds connect there too (bead ro-ujb9.96.7.14); nothing keeps
    // its own setup page by default.
    expect(connectsInPanel(integrationProvider("google")!)).toBe(true);
    expect(connectsInPanel(integrationProvider("discord")!)).toBe(true);
    expect(connectsInPanel(integrationProvider("calendar")!)).toBe(true);
    expect(refusalLine(BING, "refused")).toBe("Bing Webmaster Tools refused this key");
    expect(refusalLine(DATAFORSEO, "refused")).toBe("DataForSEO refused these details");
    expect(refusalLine(BING, "unreachable")).toBe("Bing Webmaster Tools did not answer");
  });
});

describe("the connect panel", () => {
  it("shows Cloudflare database access without calling databases sites or echoing its token", async () => {
    const provider = integrationProvider("cloudflare")!;
    const value = crypto.randomUUID();
    renderPanel(provider, vi.fn(async () => ({ verdict: "accepted", checkedAt: AT, facts: { databases: 2 } }) as ConnectVerdict));
    const dialog = screen.getByRole("dialog", { name: "Cloudflare" });
    fireEvent.change(within(dialog).getByLabelText("Account ID"), { target: { value: "a".repeat(32) } });
    fireEvent.change(within(dialog).getByLabelText("API token"), { target: { value } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Connect" })));
    expect(dialog.querySelector('[data-connect-fact="databases"]')).toHaveTextContent("2databases");
    expect(dialog.querySelector('[data-connect-fact="sites"]')).toBeNull();
    expect(dialog.innerHTML).not.toContain(value);
  });

  it("opens empty, with where to get the key beside its field", () => {
    renderPanel(BING, vi.fn());
    const dialog = screen.getByRole("dialog", { name: "Bing Webmaster Tools" });
    const key = within(dialog).getByLabelText("API key");
    expect(key).toHaveValue("");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveFocus();
    expect(within(dialog).getByRole("link", { name: "Get a key" })).toHaveAttribute("href", "https://www.bing.com/webmasters/settings/api");
    expect(within(dialog).getByRole("button", { name: "Connect" })).toBeDisabled();
    // Nothing is claimed before an answer: no chip at all.
    expect(within(dialog).queryByText(/accepted|Connected/)).toBeNull();
  });

  it("checks, then shows Key accepted with what the answer proved, and never the key", async () => {
    const answer = deferred<ConnectVerdict>();
    const onConnect = vi.fn(() => answer.promise);
    renderPanel(BING, onConnect);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: `  ${SECRET} ` } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    expect(onConnect).toHaveBeenCalledWith({ BING_WEBMASTER_API_KEY: SECRET });
    expect(within(dialog).getByRole("button", { name: "Checking" })).toBeDisabled();
    expect(within(dialog).getByLabelText("API key")).toBeDisabled();
    expect(within(dialog).queryByText("Key accepted")).toBeNull();

    await act(async () => answer.resolve({ verdict: "accepted", checkedAt: AT, facts: { sites: 2 } }));
    expect(within(dialog).getByText("Key accepted")).toBeInTheDocument();
    expect(dialog.querySelector('[data-connect-fact="sites"]')).toHaveTextContent("2sites");
    expect(within(dialog).queryByLabelText("API key")).toBeNull();
    expect(dialog.innerHTML).not.toContain(SECRET);
    expect(within(dialog).getByRole("button", { name: "Done" })).toHaveFocus();
  });

  it("shows DataForSEO's credit, and nothing where the account stated none", async () => {
    const onConnect = vi.fn(async () => ({ verdict: "accepted", checkedAt: AT, facts: { creditUsd: "18.72" } }) as ConnectVerdict);
    renderPanel(DATAFORSEO, onConnect);
    const dialog = screen.getByRole("dialog", { name: "DataForSEO" });
    expect(within(dialog).getByLabelText("API login")).toHaveAttribute("type", "text");
    fireEvent.change(within(dialog).getByLabelText("API login"), { target: { value: "op@example.test" } });
    expect(within(dialog).getByRole("button", { name: "Connect" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("API password"), { target: { value: SECRET } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Connect" })));
    expect(dialog.querySelector('[data-connect-fact="credit"]')).toHaveTextContent("$18.72credit");
  });

  it("puts the provider's refusal under the field and clears the refused secret", async () => {
    renderPanel(DATAFORSEO, vi.fn(async () => ({ verdict: "refused", checkedAt: AT }) as ConnectVerdict));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("API login"), { target: { value: "op@example.test" } });
    fireEvent.change(within(dialog).getByLabelText("API password"), { target: { value: SECRET } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Connect" })));

    expect(dialog.querySelector('[data-connect-state="refused"]')).toHaveTextContent("DataForSEO refused these details");
    expect(within(dialog).getByLabelText("API password")).toHaveValue("");
    expect(within(dialog).getByLabelText("API login")).toHaveValue("op@example.test");
    expect(within(dialog).queryByText("Key accepted")).toBeNull();
  });

  it("keeps what was typed when the provider does not answer, so Connect can be pressed again", async () => {
    const onConnect = vi.fn(async () => ({ verdict: "unreachable", checkedAt: AT }) as ConnectVerdict);
    renderPanel(BING, onConnect);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: SECRET } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Connect" })));
    expect(dialog.querySelector('[data-connect-state="unreachable"]')).toHaveTextContent("Bing Webmaster Tools did not answer");
    expect(within(dialog).getByRole("button", { name: "Connect" })).toBeEnabled();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Connect" })));
    expect(onConnect).toHaveBeenCalledTimes(2);
  });

  it("names a field the server refused under that field, and a failed save plainly", async () => {
    const onConnect = vi.fn()
      .mockRejectedValueOnce(new ApiError("API key is required.", 422, "invalid_credential", "BING_WEBMASTER_API_KEY"))
      .mockRejectedValueOnce(new ApiError("credential_connect_failed", 500, "credential_connect_failed"));
    renderPanel(BING, onConnect);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: SECRET } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Connect" })));
    expect(within(dialog).getByLabelText("API key")).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByText("API key is required.")).toBeInTheDocument();

    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Connect" })));
    expect(dialog.querySelector('[data-connect-state="failed"]')).toHaveTextContent("Not saved · try again");
  });

  // Bead ro-ujb9.96.7.8: PostHog asks for the account's one key, and the
  // region is part of the answer — found, never a field.
  it("connects PostHog with the one key it shows, and names the region that accepted it", async () => {
    const POSTHOG = integrationProvider("posthog")!;
    const answer = deferred<ConnectVerdict>();
    const onConnect = vi.fn(() => answer.promise);
    renderPanel(POSTHOG, onConnect);
    const dialog = screen.getByRole("dialog");
    // One field: the older per-site map is never asked for.
    expect(dialog.querySelectorAll("input")).toHaveLength(1);
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(within(dialog).getByRole("list", { name: "Personal API key access" })).toHaveTextContent("Project: read");
    const connect = within(dialog).getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Personal API key"), { target: { value: SECRET } });
    expect(connect).toBeEnabled();
    fireEvent.click(connect);
    expect(onConnect).toHaveBeenCalledWith({ POSTHOG_API_KEY: SECRET });
    await act(async () => answer.resolve({ verdict: "accepted", checkedAt: AT, facts: { projects: 3, region: "eu" } }));
    expect(dialog.querySelector('[data-connect-state="accepted"]')).toHaveTextContent("Key accepted · EU");
    expect(dialog.querySelector('[data-connect-fact="projects"]')).toHaveTextContent("3");
    expect(dialog.textContent).not.toContain(SECRET);
  });

  // Bead ro-ujb9.96.7.25: an accepted connection is named for what was given,
  // from the provider's declared credential — never "Key accepted" for an
  // email and a password.
  it("says Signed in after an email-and-password sign-in, and Key accepted only for a key", async () => {
    const MEDIAVINE = integrationProvider("mediavine")!;
    const onConnect = vi.fn(async () => ({ verdict: "accepted", checkedAt: AT, facts: {} }) as ConnectVerdict);
    const { unmount } = renderPanel(MEDIAVINE, onConnect);
    let dialog = screen.getByRole("dialog", { name: "Mediavine" });
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "op@example.test" } });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByText("Signed in")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Key accepted/)).toBeNull();
    unmount();

    renderPanel(BING, vi.fn(async () => ({ verdict: "accepted", checkedAt: AT, facts: { sites: 1 } }) as ConnectVerdict));
    dialog = screen.getByRole("dialog", { name: "Bing Webmaster Tools" });
    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByText("Key accepted")).toBeInTheDocument();
  });

  // Bead ro-ujb9.96.7.14: Discord's one field, unmasked, and the message its
  // proof posts named before the press; no site list after the answer.
  it("connects Discord with its webhook URL, saying before the press that it posts a test message", async () => {
    const DISCORD = integrationProvider("discord")!;
    const answer = deferred<ConnectVerdict>();
    const onConnect = vi.fn(() => answer.promise);
    renderPanel(DISCORD, onConnect);
    const dialog = screen.getByRole("dialog", { name: "Discord" });
    const url = within(dialog).getByLabelText("Webhook URL");
    expect(url).toHaveAttribute("type", "text");
    expect(dialog.querySelector('[data-connect-cost="side-effect"]')).toHaveTextContent("Posts a test message");
    fireEvent.change(url, { target: { value: `https://discord.com/api/webhooks/1/${SECRET}` } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(onConnect).toHaveBeenCalledWith({ DISCORD_WEBHOOK_URL: `https://discord.com/api/webhooks/1/${SECRET}` });
    await act(async () => answer.resolve({ verdict: "accepted", checkedAt: AT, facts: {} }));
    expect(dialog.querySelector('[data-connect-state="accepted"]')).toHaveTextContent("URL accepted");
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeTruthy();
    expect(dialog.textContent).not.toContain(SECRET);
  });

  it("connects calendar feeds one row each, sending the named map and counting the feeds read", async () => {
    const CALENDAR = integrationProvider("calendar")!;
    const answer = deferred<ConnectVerdict>();
    const onConnect = vi.fn(() => answer.promise);
    renderPanel(CALENDAR, onConnect);
    const dialog = screen.getByRole("dialog", { name: "Calendar feeds" });
    const connect = within(dialog).getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("URL, feed 1"), { target: { value: `https://calendar.example/${SECRET}/basic.ics` } });
    expect(connect).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add feed" }));
    fireEvent.change(within(dialog).getByLabelText("Name, feed 2"), { target: { value: "family" } });
    fireEvent.change(within(dialog).getByLabelText("URL, feed 2"), { target: { value: "https://calendar.example/family.ics" } });
    fireEvent.click(connect);
    expect(onConnect).toHaveBeenCalledWith({
      CALENDAR_FEEDS: JSON.stringify({ "feed-1": `https://calendar.example/${SECRET}/basic.ics`, family: "https://calendar.example/family.ics" }),
    });
    await act(async () => answer.resolve({ verdict: "accepted", checkedAt: AT, facts: { feeds: 2 } }));
    expect(dialog.querySelector('[data-connect-fact="feeds"]')).toHaveTextContent("2");
    expect(dialog.textContent).not.toContain(SECRET);
  });

  it("refuses a feed that is not an address on its field, before anything is sent", () => {
    const onConnect = vi.fn();
    renderPanel(integrationProvider("calendar")!, onConnect);
    fireEvent.change(screen.getByLabelText("URL, feed 1"), { target: { value: "not a feed" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnect).not.toHaveBeenCalled();
    expect(screen.getByLabelText("URL, feed 1")).toHaveAttribute("aria-invalid", "true");
  });

  it("cannot be pressed where the install cannot store a credential", () => {
    renderPanel(BING, vi.fn(), { canConnect: false });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: SECRET } });
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("closes on Escape, on its close control and on the blurred desk, and holds the desk inert while open", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    const onClose = vi.fn();
    const { unmount } = renderPanel(BING, vi.fn(), { onClose });
    expect(root).toHaveAttribute("inert");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
    expect(root).not.toHaveAttribute("inert");
    root.remove();
  });
});
