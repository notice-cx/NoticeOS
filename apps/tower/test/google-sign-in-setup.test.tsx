// Google, connected by signing in, in the connect panel (bead
// `ro-ujb9.96.7.7`).
//
// WHAT IS PROTECTED: the dropped `client_secret.json` is read for a web
// client's two values and nothing else — a desktop or service-account file is
// refused and nothing is stored; a client that does not list this Tower's
// redirect address says so; hosted, the panel is one button and never shows the
// console steps; and Continue with Google stays disabled until a client exists.

import { act, fireEvent, render, screen, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { GOOGLE_CONSOLE, readGoogleClientFile } from "@shared/google-client-file";
import type { GoogleOAuthCardState } from "@shared/integrations-page";
import { GoogleSignInSetup, type GoogleSignInSetupProps } from "@/components/GoogleSignInSetup";

const REDIRECT = "http://127.0.0.1:4747/api/integrations/google/oauth/callback";
const SECRET = "SEKRIT-google-client-secret-do-not-echo";
const CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com";

const clientFile = (body: unknown) => JSON.stringify(body);
const web = (redirects: string[] = [REDIRECT]) => clientFile({ web: { client_id: CLIENT_ID, client_secret: SECRET, redirect_uris: redirects } });

describe("reading the client file Google hands back", () => {
  it("takes a web client's id and secret, and says whether this Tower's address is listed", () => {
    expect(readGoogleClientFile(web(), REDIRECT)).toEqual({ ok: true, clientId: CLIENT_ID, clientSecret: SECRET, redirectListed: true });
    expect(readGoogleClientFile(web(["https://elsewhere.example/callback"]), REDIRECT)).toMatchObject({ ok: true, redirectListed: false });
  });

  it("refuses what cannot sign in through a browser here", () => {
    expect(readGoogleClientFile("not json", REDIRECT)).toEqual({ ok: false, problem: "not-json" });
    expect(readGoogleClientFile(clientFile({ installed: { client_id: CLIENT_ID, client_secret: SECRET } }), REDIRECT)).toEqual({ ok: false, problem: "not-web-client" });
    expect(readGoogleClientFile(clientFile({ type: "service_account", private_key: "x" }), REDIRECT)).toEqual({ ok: false, problem: "not-web-client" });
    expect(readGoogleClientFile(clientFile({ web: { client_id: CLIENT_ID } }), REDIRECT)).toEqual({ ok: false, problem: "incomplete" });
  });

  it("deep-links the console to the three APIs and the client form", () => {
    expect(GOOGLE_CONSOLE.apis).toContain("apiid=analyticsdata.googleapis.com,analyticsadmin.googleapis.com,searchconsole.googleapis.com");
    expect(GOOGLE_CONSOLE.client).toBe("https://console.cloud.google.com/auth/clients/create");
  });
});

function card(state: GoogleOAuthCardState["state"], over: Partial<GoogleOAuthCardState> = {}): GoogleOAuthCardState {
  return { state, redirectUri: REDIRECT, loopbackUrl: null, account: null, scopes: [], connectedAt: null, ...over };
}

function renderSetup(over: Partial<GoogleSignInSetupProps> = {}) {
  const onSaveClient = vi.fn(async () => {});
  const utils = render(
    <MemoryRouter>
      <GoogleSignInSetup
        card={card("app-missing")}
        selfHosted
        startHref="/api/integrations/google/oauth/start"
        publish={{ url: "https://console.cloud.google.com/auth/audience", label: "Publish" }}
        onSaveClient={onSaveClient}
        {...over}
      />
    </MemoryRouter>,
  );
  return { ...utils, onSaveClient };
}

const drop = (json: string) => new File([json], "client_secret.json", { type: "application/json" });

describe("the sign-in in the panel", () => {
  it('hosted start uses its captured callback without a GET link and respects pending state', () => {
    const onStart = vi.fn();
    const view = renderSetup({ card: card('ready'), selfHosted: false, onStart });
    const start = screen.getByRole('button', { name: 'Continue with Google' });
    expect(start).not.toHaveAttribute('href'); fireEvent.click(start); expect(onStart).toHaveBeenCalledOnce();
    view.unmount();
    renderSetup({ card: card('ready'), selfHosted: false, onStart, starting: true });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(onStart).toHaveBeenCalledOnce();
  });
  it("self-hosted: three steps, the redirect address to copy, and nothing to press until a client exists", () => {
    renderSetup();
    const setup = document.querySelector('[data-google-setup="self-hosted"]') as HTMLElement;
    expect(setup).not.toBeNull();
    expect([...setup.querySelectorAll("[data-google-step]")].map((step) => step.getAttribute("data-google-step"))).toEqual(["1", "2", "3"]);
    expect(within(setup.querySelector('[data-google-step="1"]') as HTMLElement).getByRole("link", { name: /Open/ }).getAttribute("href")).toBe(GOOGLE_CONSOLE.apis);
    expect(setup.querySelector("[data-google-redirect-uri]")?.textContent).toContain(REDIRECT);
    expect(setup.querySelector("[data-google-testing]")?.textContent).toContain("7 days");
    expect(screen.getByRole("button", { name: "Continue with Google" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("link", { name: "Service account instead" }).getAttribute("href")).toBe("/integrations?provider=google&setup=page");
  });

  it("stores a web client's two values and says when its redirect list misses this Tower", async () => {
    const { onSaveClient } = renderSetup();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("client_secret.json"), { target: { files: [drop(web(["https://elsewhere.example/cb"]))] } });
    });
    expect(onSaveClient).toHaveBeenCalledWith({ GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: SECRET });
    expect(document.querySelector('[data-google-client-file="stored"]')).not.toBeNull();
    expect(screen.getByText("Redirect address not in the client")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("refuses a desktop client's file and stores nothing", async () => {
    const { onSaveClient } = renderSetup();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("client_secret.json"), { target: { files: [drop(clientFile({ installed: { client_id: CLIENT_ID, client_secret: SECRET } }))] } });
    });
    expect(onSaveClient).not.toHaveBeenCalled();
    expect(document.querySelector("[data-google-client-refused]")?.textContent).toBe("Not a web client");
  });

  it("says a failed save failed, so the file can be dropped again", async () => {
    const { onSaveClient } = renderSetup();
    onSaveClient.mockRejectedValueOnce(new Error("store down"));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("client_secret.json"), { target: { files: [drop(web())] } });
    });
    expect(document.querySelector("[data-google-client-refused]")?.textContent).toBe("Not saved · try again");
  });

  it("hosted: the grants and one button, no console step and no Testing warning", () => {
    renderSetup({ card: card("ready"), selfHosted: false, publish: null });
    expect(document.querySelector('[data-google-setup="hosted"]')).not.toBeNull();
    expect(screen.getByRole("list", { name: "Google access" }).textContent).toContain("Search Console · read only");
    expect(document.querySelector("[data-google-step]")).toBeNull();
    expect(document.querySelector("[data-google-testing]")).toBeNull();
    expect(screen.getByRole("link", { name: "Continue with Google" }).getAttribute("href")).toBe("/api/integrations/google/oauth/start");
  });

  it("on an address Google will not return to, the press is the loopback address", () => {
    renderSetup({ card: card("redirect-unusable", { loopbackUrl: "http://127.0.0.1:4747/integrations?connect=google" }) });
    expect(screen.getByRole("link", { name: /Open on 127.0.0.1/ }).getAttribute("href")).toBe("http://127.0.0.1:4747/integrations?connect=google");
    expect(screen.queryByRole("link", { name: "Continue with Google" })).toBeNull();
  });
});
