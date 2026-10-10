// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  GoogleOAuthCompletion,
  GoogleOAuthStart,
  GooglePropertyDiscovery,
} from "@noticeos/contract";
import {
  type GoogleOAuthIngest,
  handleGoogleOAuthCallbackRequest,
  handleGoogleOAuthStartRequest,
  handleGooglePropertiesRequest,
} from "../worker/integrations-oauth-route";

// Signing in to Google, the Tower's half. Start is same-site (a link on another
// page must not start a sign-in; a typed address still works). Callback is
// cross-site by definition, so it cannot be origin-checked. Every outcome is a
// redirect carrying a code, and the authorization code never appears in a URL
// this Worker writes. The binding is stubbed: Vitest here runs without workerd.

const START_URL = new URL(
  "http://127.0.0.1:5173/api/integrations/google/oauth/start",
);
const CALLBACK = "http://127.0.0.1:5173/api/integrations/google/oauth/callback";
const CODE = "SEKRIT-authorization-code-do-not-echo";

interface Stub {
  ingest: GoogleOAuthIngest;
  starts: { origin: string }[];
  completions: { code: string; state: string; redirectUri: string }[];
  discoveries: number;
}

function stubIngest(
  replies: {
    start?: GoogleOAuthStart | Error;
    complete?: GoogleOAuthCompletion | Error;
    discover?: GooglePropertyDiscovery | Error;
  } = {},
): Stub {
  const starts: { origin: string }[] = [];
  const completions: { code: string; state: string; redirectUri: string }[] = [];
  const stub: Stub = { starts, completions, discoveries: 0, ingest: null as never };
  const answer = <T>(value: T | Error | undefined, fallback: T): T => {
    if (value instanceof Error) throw value;
    return value ?? fallback;
  };
  stub.ingest = {
    beginGoogleOAuth: async (input) => {
      starts.push(input);
      return answer<GoogleOAuthStart>(replies.start, {
        ok: true,
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y",
        redirectUri: CALLBACK,
      });
    },
    completeGoogleOAuth: async (input) => {
      completions.push(input);
      return answer<GoogleOAuthCompletion>(replies.complete, {
        ok: true,
        account: "ops@example.test",
        scopes: [],
      });
    },
    discoverGoogleProperties: async () => {
      stub.discoveries += 1;
      return answer<GooglePropertyDiscovery>(replies.discover, {
        ok: true,
        message: "2 GA4 properties and 1 Search Console site.",
        checkedAt: "2026-09-05T12:00:00.000Z",
        account: "ops@example.test",
        auth: "oauth",
        properties: [],
      });
    },
  };
  return stub;
}

/** A top-level navigation the operator started on their own Tower. */
function navigation(url: string, site = "same-origin"): Request {
  return new Request(url, { headers: { "sec-fetch-site": site } });
}

function landedOn(response: Response): URL {
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}

describe("GET /api/integrations/google/oauth/start", () => {
  it("sends the browser to Google, uncacheable and without a referrer", async () => {
    const stub = stubIngest();
    const response = await handleGoogleOAuthStartRequest(
      navigation(START_URL.toString()),
      START_URL,
      stub.ingest,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("accounts.google.com");
    // A consent URL carries a one-time state: nothing may cache it, and no
    // referrer may carry it onward.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    // The redirect URI is derived from this request's origin, so what crosses
    // the binding is an origin.
    expect(stub.starts).toEqual([{ origin: "http://127.0.0.1:5173" }]);
  });

  it("refuses a sign-in started by another site, before ingest is called", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const stub = stubIngest();
      const response = await handleGoogleOAuthStartRequest(
        navigation(START_URL.toString(), site),
        START_URL,
        stub.ingest,
      );
      expect(response.status, site).toBe(403);
      expect(stub.starts, site).toEqual([]);
    }
  });

  it("allows a typed or bookmarked address, which is a person deciding", async () => {
    const stub = stubIngest();
    const response = await handleGoogleOAuthStartRequest(
      navigation(START_URL.toString(), "none"),
      START_URL,
      stub.ingest,
    );
    expect(response.status).toBe(302);
    expect(stub.starts).toHaveLength(1);
  });

  it("also allows a client that sends no fetch-metadata at all", async () => {
    const stub = stubIngest();
    const response = await handleGoogleOAuthStartRequest(
      new Request(START_URL.toString()),
      START_URL,
      stub.ingest,
    );
    expect(response.status).toBe(302);
  });

  it("is a GET; anything else is 405", async () => {
    const stub = stubIngest();
    const response = await handleGoogleOAuthStartRequest(
      new Request(START_URL.toString(), { method: "POST" }),
      START_URL,
      stub.ingest,
    );
    expect(response.status).toBe(405);
    expect(stub.starts).toEqual([]);
  });

  it("goes back to the page with the reason when there is nothing to sign in to", async () => {
    const stub = stubIngest({
      start: { ok: false, error: "app_missing", message: "not set up" },
    });
    const landed = landedOn(
      await handleGoogleOAuthStartRequest(
        navigation(START_URL.toString()),
        START_URL,
        stub.ingest,
      ),
    );
    expect(landed.pathname).toBe("/integrations");
    expect(landed.searchParams.get("google")).toBe("app_missing");
  });

  it("goes back to the page when the binding itself fails", async () => {
    const stub = stubIngest({ start: new Error("binding down") });
    const landed = landedOn(
      await handleGoogleOAuthStartRequest(
        navigation(START_URL.toString()),
        START_URL,
        stub.ingest,
      ),
    );
    expect(landed.pathname).toBe("/integrations");
    expect(landed.searchParams.get("google")).toBe("store_failed");
  });
});

describe("GET /api/integrations/google/oauth/callback", () => {
  const arriving = (query: string, site = "cross-site") =>
    navigation(`${CALLBACK}?${query}`, site);

  it("finishes the sign-in and lands the operator back on the page", async () => {
    const stub = stubIngest();
    const url = new URL(`${CALLBACK}?code=${CODE}&state=abc`);
    const landed = landedOn(
      await handleGoogleOAuthCallbackRequest(
        arriving(`code=${CODE}&state=abc`),
        url,
        stub.ingest,
      ),
    );
    expect(landed.pathname).toBe("/integrations");
    expect(landed.searchParams.get("google")).toBe("connected");
    expect(landed.searchParams.get("connect")).toBe("google");

    // The redirect URI is re-derived from this request rather than taken from
    // the state, so the two have to agree: that binds a state to the origin it
    // was minted for.
    expect(stub.completions).toEqual([
      { code: CODE, state: "abc", redirectUri: CALLBACK },
    ]);
  });

  it("never writes the authorization code into the URL it answers with", async () => {
    const stub = stubIngest();
    const url = new URL(`${CALLBACK}?code=${CODE}&state=abc`);
    const response = await handleGoogleOAuthCallbackRequest(
      arriving(`code=${CODE}&state=abc`),
      url,
      stub.ingest,
    );
    expect(response.headers.get("location")).not.toContain(CODE);
  });

  it("works when the browser says the navigation is cross-site — it IS", async () => {
    // The signed, expiring, redirect-bound state stands in for the origin
    // check here; an origin guard on this route would break every real sign-in.
    const stub = stubIngest();
    const url = new URL(`${CALLBACK}?code=${CODE}&state=abc`);
    const response = await handleGoogleOAuthCallbackRequest(
      arriving(`code=${CODE}&state=abc`, "cross-site"),
      url,
      stub.ingest,
    );
    expect(response.status).toBe(302);
    expect(stub.completions).toHaveLength(1);
  });

  it("treats Cancel on Google's screen as its own answer", async () => {
    const stub = stubIngest();
    const url = new URL(`${CALLBACK}?error=access_denied&state=abc`);
    const landed = landedOn(
      await handleGoogleOAuthCallbackRequest(
        arriving("error=access_denied&state=abc"),
        url,
        stub.ingest,
      ),
    );
    expect(landed.searchParams.get("google")).toBe("denied");
    expect(stub.completions).toEqual([]);
  });

  it("refuses a callback with no code or no state, without calling ingest", async () => {
    for (const query of ["state=abc", `code=${CODE}`, ""]) {
      const stub = stubIngest();
      const url = new URL(`${CALLBACK}?${query}`);
      const landed = landedOn(
        await handleGoogleOAuthCallbackRequest(arriving(query), url, stub.ingest),
      );
      expect(landed.searchParams.get("google"), query).toBe("state_invalid");
      expect(stub.completions, query).toEqual([]);
    }
  });

  it("carries ingest's refusal back as its code, never as its sentence", async () => {
    const stub = stubIngest({
      complete: {
        ok: false,
        error: "scope_incomplete",
        message: "Search Console was not granted.",
      },
    });
    const url = new URL(`${CALLBACK}?code=${CODE}&state=abc`);
    const landed = landedOn(
      await handleGoogleOAuthCallbackRequest(
        arriving(`code=${CODE}&state=abc`),
        url,
        stub.ingest,
      ),
    );
    expect(landed.searchParams.get("google")).toBe("scope_incomplete");
    // Nothing the provider said is reflected into this URL, so a query
    // parameter can never become a message on the screen.
    expect(landed.search).not.toContain("Search Console");
  });

  it("goes back to the page when the binding itself fails", async () => {
    const stub = stubIngest({ complete: new Error("binding down") });
    const url = new URL(`${CALLBACK}?code=${CODE}&state=abc`);
    const landed = landedOn(
      await handleGoogleOAuthCallbackRequest(
        arriving(`code=${CODE}&state=abc`),
        url,
        stub.ingest,
      ),
    );
    expect(landed.searchParams.get("google")).toBe("store_failed");
  });

  it("is a GET; anything else is 405", async () => {
    const stub = stubIngest();
    const url = new URL(`${CALLBACK}?code=${CODE}&state=abc`);
    const response = await handleGoogleOAuthCallbackRequest(
      new Request(url.toString(), { method: "POST" }),
      url,
      stub.ingest,
    );
    expect(response.status).toBe(405);
    expect(stub.completions).toEqual([]);
  });
});

describe("GET /api/integrations/google/properties", () => {
  it("answers the discovery payload", async () => {
    const stub = stubIngest();
    const response = await handleGooglePropertiesRequest(
      new Request("http://127.0.0.1:5173/api/integrations/google/properties"),
      stub.ingest,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, auth: "oauth" });
    expect(stub.discoveries).toBe(1);
  });

  it("answers 200 with the reason when Google would not answer", async () => {
    // "Search Console would not answer" is the answer to the question the
    // button asked, not a transport failure.
    const stub = stubIngest({
      discover: {
        ok: false,
        message: "Could not list Analytics (ga4_admin_http_403).",
        checkedAt: "2026-09-05T12:00:00.000Z",
        account: null,
        auth: "oauth",
        properties: [],
      },
    });
    const response = await handleGooglePropertiesRequest(
      new Request("http://127.0.0.1:5173/api/integrations/google/properties"),
      stub.ingest,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("is a GET, and a binding failure is a 500 with a code", async () => {
    const stub = stubIngest({ discover: new Error("binding down") });
    expect(
      (
        await handleGooglePropertiesRequest(
          new Request("http://127.0.0.1:5173/api/integrations/google/properties", {
            method: "POST",
          }),
          stub.ingest,
        )
      ).status,
    ).toBe(405);

    const failed = await handleGooglePropertiesRequest(
      new Request("http://127.0.0.1:5173/api/integrations/google/properties"),
      stub.ingest,
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "google_properties_failed" });
  });
});


describe("hosted Google callback return target", () => {
  it("always returns to the configured origin, including rejected foreign callbacks", async () => {
    const origin = "https://hosted.example.test";
    const state = "a".repeat(43);
    const pathname = `/api/integrations/google/oauth/callback?state=${state}&code=generated-code`;
    const stub = stubIngest();
    const foreign = new URL(`https://foreign.example.test${pathname}`);
    const refused = landedOn(await handleGoogleOAuthCallbackRequest(new Request(foreign), foreign, stub.ingest, origin));
    expect(refused.origin).toBe(origin);
    expect(refused.pathname).toBe("/integrations");
    expect(refused.searchParams.get("google")).toBe("state_invalid");
    expect(stub.completions).toEqual([]);
    const accepted = landedOn(await handleGoogleOAuthCallbackRequest(new Request(origin + pathname), foreign, stub.ingest, origin));
    expect(accepted.origin).toBe(origin);
    expect(accepted.searchParams.get("google")).toBe("connected");
    expect(stub.completions).toHaveLength(1);
  });
});
