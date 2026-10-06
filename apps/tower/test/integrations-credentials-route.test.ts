// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  ConnectCredentialResult,
  CredentialProbe,
  CredentialStoreState,
  CredentialSummary,
  DeleteCredentialResult,
  IntegrationMeter,
  PutCredentialInput,
  PutSiteTokenInput,
  PutSiteTokenResult,
  PutCredentialResult,
  SetCredentialExpiryInput,
  SetCredentialExpiryResult,
} from "@noticeos/contract";
import { integrationProvider } from "@noticeos/contract";
import {
  assetsUsingProvider,
  handleIntegrationConnectRequest,
  handleIntegrationCredentialRequest,
  handleIntegrationExpiryRequest,
  handleIntegrationProvidersRequest,
  handleIntegrationSiteTokenRequest,
  handleIntegrationTestRequest,
  type IntegrationCredentialWriter,
} from "../worker/integrations-route";
import type { IntegrationsConfig } from "../shared/integrations";

// The Integrations page's write surface (epic `ro-vu8d`, bead `ro-vu8d.1`).
//
// The Tower does not hold credentials: it proxies to the ingest
// WorkerEntrypoint over the private INGEST Service Binding, exactly as the
// annotation and asset-column writes do. So what is asserted here is the
// BOUNDARY — what crosses it, what comes back, and that nothing on the way out
// carries a value. The crypto, the store order and the field rules are pinned
// against real D1 and real WebCrypto in workers/ingest/test/credentials.test.ts,
// which is their only home.
//
// The binding is stubbed rather than bound: this project's Vitest runs in
// node/jsdom with no workerd. The stub is typed by the shared contract, so a
// change to any RPC's shape breaks these tests at compile time.

const SECRET = "SEKRIT-bing-9f2a-do-not-echo";
const NOW = new Date("2026-09-04T12:00:00.000Z");
const CREDENTIAL_URL = new URL(
  "https://tower.local/api/integrations/bing-webmaster/credential",
);
const TEST_URL = new URL("https://tower.local/api/integrations/bing-webmaster/test");

function summary(overrides: Partial<CredentialSummary> = {}): CredentialSummary {
  return {
    provider: "bing-webmaster",
    source: "store",
    fields: ["BING_WEBMASTER_API_KEY"],
    assetsHeld: [],
    missingFields: [],
    auth: null,
    metadata: null,
    keyVersion: 1,
    createdAt: "2026-09-04T11:00:00.000Z",
    updatedAt: "2026-09-04T11:00:00.000Z",
    lastUsedAt: null,
    lastOkAt: null,
    lastError: null,
    ...overrides,
  };
}

function storeState(overrides: Partial<CredentialStoreState> = {}): CredentialStoreState {
  return {
    keyPresent: true,
    keyReason: null,
    blockers: [],
    summaries: [
      summary({ provider: "google", source: "env", fields: [] }),
      summary(),
      summary({ provider: "dataforseo", source: "none", fields: [] }),
      summary({ provider: "calendar", source: "none", fields: [] }),
    ],
    ...overrides,
  };
}

interface Stub {
  ingest: IntegrationCredentialWriter;
  puts: PutCredentialInput[];
  expiries: SetCredentialExpiryInput[];
  deletes: string[];
  probes: string[];
  connects: PutCredentialInput[];
  siteTokens: PutSiteTokenInput[];
}

function stubIngest(replies: {
  list?: CredentialStoreState | Error;
  put?: PutCredentialResult | Error;
  expiry?: SetCredentialExpiryResult | Error;
  remove?: DeleteCredentialResult | Error;
  probe?: CredentialProbe | Error;
  connect?: ConnectCredentialResult | Error;
  siteToken?: PutSiteTokenResult | Error;
} = {}): Stub {
  const puts: PutCredentialInput[] = [];
  const expiries: SetCredentialExpiryInput[] = [];
  const deletes: string[] = [];
  const probes: string[] = [];
  const connects: PutCredentialInput[] = [];
  const siteTokens: PutSiteTokenInput[] = [];
  const answer = <T>(value: T | Error | undefined, fallback: T): T => {
    if (value instanceof Error) throw value;
    return value ?? fallback;
  };
  return {
    puts,
    expiries,
    deletes,
    probes,
    connects,
    siteTokens,
    ingest: {
      async listCredentialSummaries() {
        return answer(replies.list, storeState());
      },
      async putCredential(input) {
        puts.push(input);
        return answer(replies.put, { ok: true, summary: summary() });
      },
      async setCredentialExpiry(input) {
        expiries.push(input);
        return answer(replies.expiry, { ok: true, summary: summary() });
      },
      async deleteCredential(provider) {
        deletes.push(provider);
        return answer(replies.remove, { ok: true, summary: summary({ source: "env" }) });
      },
      async probeCredential(provider) {
        probes.push(provider);
        return answer(replies.probe, {
          ok: true,
          message: "Answered · 5 sites",
          result: { outcome: "answered", facts: { sites: 5 } },
          checkedAt: NOW.toISOString(),
        });
      },
      async connectCredential(input) {
        connects.push(input);
        return answer(replies.connect, {
          ok: true,
          verdict: "accepted",
          checkedAt: NOW.toISOString(),
          facts: { sites: 3 },
        });
      },
      async putSiteToken(input) {
        siteTokens.push(input);
        return answer(replies.siteToken, { ok: true, summary: summary() });
      },
    },
  };
}

const CONFIG: IntegrationsConfig = {
  catalog: [],
  assets: {
    "meals.example": {
      gsc: { status: "live", note: "", since: "2026-08-01" },
      ga4: { status: "needs-setup", note: "", since: "2026-08-01" },
      "bing-webmaster": { status: "live", note: "", since: "2026-08-01" },
    },
    "root-os": {
      gsc: { status: "not-applicable", note: "", since: "2026-08-01" },
    },
  },
};

function put(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(CREDENTIAL_URL, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("GET /api/integrations/providers", () => {
  it("answers with every provider, its schema, its state and who depends on it", async () => {
    const { ingest } = stubIngest();
    const response = await handleIntegrationProvidersRequest(
      new Request("https://tower.local/api/integrations/providers"),
      ingest,
      CONFIG,
      NOW,
    );
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.generatedAt).toBe(NOW.toISOString());
    expect(payload.keyPresent).toBe(true);
    expect(payload.providers.map((entry: { provider: { id: string } }) => entry.provider.id)).toEqual([
      "google",
      "bing-webmaster",
      "dataforseo",
      "calendar",
    ]);

    // The form the page renders comes down with the state, so the two can never
    // disagree about what a provider needs.
    const bing = payload.providers[1];
    expect(bing.provider.fields[0].name).toBe("BING_WEBMASTER_API_KEY");
    expect(bing.provider.fields[0].kind).toBe("password");
    expect(bing.credential.fields).toEqual(["BING_WEBMASTER_API_KEY"]);
    expect(bing.assets).toEqual([{ id: "meals.example", lanes: ["bing-webmaster"] }]);

    // Google's two lanes are one credential, and the System's not-applicable
    // cell is not a dependency.
    expect(payload.providers[0].assets).toEqual([
      { id: "meals.example", lanes: ["ga4", "gsc"] },
    ]);
  });

  it("carries today's budget for a metered provider, and null for the rest", async () => {
    // Bead `ro-vu8d.25`: the reading comes from rows this OS already wrote, so
    // rendering a quota costs no provider call — which is the whole point on a
    // ten-a-day cap whose Test button already refuses to spend one.
    const asked: IntegrationMeter[] = [];
    const response = await handleIntegrationProvidersRequest(
      new Request("https://tower.local/api/integrations/providers"),
      stubIngest({ list: storeState({ summaries: [summary({ provider: "clarity" })] }) })
        .ingest,
      CONFIG,
      NOW,
      async (meter) => {
        asked.push(meter);
        return { window: "asset-day", day: "2026-09-04", assets: [{ asset: "meals.example", spent: 3 }] };
      },
    );
    const payload = await response.json();
    // The DECLARATION reaches the reader, not a bare id: the two metered
    // providers meter two different windows, and the reader is what turns one
    // into the other (bead `ro-qpas`).
    expect(asked).toEqual([{ ...integrationProvider("clarity")!.meter }]);
    expect(payload.providers[0].meter).toEqual({
      window: "asset-day",
      day: "2026-09-04",
      assets: [{ asset: "meals.example", spent: 3 }],
    });
  });

  it("carries the month's dollars for the provider that meters those", async () => {
    // Bead `ro-qpas`: DataForSEO's ceiling is the portfolio's monthly reserve,
    // and it is read from the costs its own reports recorded — never from the
    // prepaid balance, which only a probe can see and nothing stores.
    const response = await handleIntegrationProvidersRequest(
      new Request("https://tower.local/api/integrations/providers"),
      stubIngest({ list: storeState({ summaries: [summary({ provider: "dataforseo" })] }) })
        .ingest,
      CONFIG,
      NOW,
      async (meter) =>
        meter.window === "portfolio-month"
          ? { window: "portfolio-month", period: "2026-09", spentUsd: 4.49, unknownPrices: 0, capUsd: 25 }
          : { window: "asset-day", day: "2026-09-04", assets: [] },
    );
    expect((await response.json()).providers[0].meter).toEqual({
      window: "portfolio-month",
      period: "2026-09",
      spentUsd: 4.49, unknownPrices: 0,
      capUsd: 25,
    });
  });

  it("costs one block rather than the page when the store cannot answer", async () => {
    const response = await handleIntegrationProvidersRequest(
      new Request("https://tower.local/api/integrations/providers"),
      stubIngest({ list: storeState({ summaries: [summary({ provider: "clarity" })] }) })
        .ingest,
      CONFIG,
      NOW,
      async () => {
        throw new Error("relation \"noticeos.archive_runs\" does not exist");
      },
    );
    // A card that invented a budget would be worse than one that shows none.
    expect(response.status).toBe(200);
    expect((await response.json()).providers[0].meter).toBeNull();
  });

  it("still renders when the installation has no encryption key", async () => {
    const { ingest } = stubIngest({
      list: storeState({
        keyPresent: false,
        keyReason: "CREDENTIALS_KEY is not set. Generate one with `openssl rand -base64 32`…",
        blockers: ["key-missing"],
      }),
    });
    const response = await handleIntegrationProvidersRequest(
      new Request("https://tower.local/api/integrations/providers"),
      ingest,
      CONFIG,
      NOW,
    );
    // A page an operator opens to FIX something must not be able to go blank,
    // and must not offer a form that cannot save.
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.keyPresent).toBe(false);
    expect(payload.keyReason).toContain("openssl rand -base64 32");
    expect(payload.blockers).toEqual(["key-missing"]);
    expect(payload.providers).toHaveLength(4);
  });

  it("503s rather than 500s when the binding itself is down", async () => {
    const { ingest } = stubIngest({ list: new Error("binding down") });
    const response = await handleIntegrationProvidersRequest(
      new Request("https://tower.local/api/integrations/providers"),
      ingest,
      CONFIG,
      NOW,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "integration_credentials_unavailable" });
  });

  it("refuses any verb but GET", async () => {
    const { ingest } = stubIngest();
    const response = await handleIntegrationProvidersRequest(
      new Request("https://tower.local/api/integrations/providers", { method: "POST" }),
      ingest,
      CONFIG,
      NOW,
    );
    expect(response.status).toBe(405);
  });
});

describe("PUT /api/integrations/:provider/credential", () => {
  it("passes the fields through and answers 204 with no body", async () => {
    const { ingest, puts } = stubIngest();
    const response = await handleIntegrationCredentialRequest(
      put({ fields: { BING_WEBMASTER_API_KEY: SECRET } }),
      CREDENTIAL_URL,
      ingest,
      "bing-webmaster",
    );

    expect(response.status).toBe(204);
    // NOTHING is echoed. The only thing a caller could do with a returned
    // credential is leak it into a cache, a proxy log, or a screenshot.
    expect(await response.text()).toBe("");
    expect(puts).toEqual([
      { provider: "bing-webmaster", fields: { BING_WEBMASTER_API_KEY: SECRET } },
    ]);
  });

  it("refuses a cross-origin write before the binding is called", async () => {
    const { ingest, puts } = stubIngest();
    const response = await handleIntegrationCredentialRequest(
      put({ fields: { BING_WEBMASTER_API_KEY: SECRET } }, { origin: "https://evil.test" }),
      CREDENTIAL_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(403);
    expect(puts).toEqual([]);
  });

  it("404s an unknown provider without asking ingest", async () => {
    const { ingest, puts } = stubIngest();
    const response = await handleIntegrationCredentialRequest(
      put({ fields: {} }),
      CREDENTIAL_URL,
      ingest,
      // Deliberately a provider that has never existed: "clarity" stood here
      // until bead `ro-vu8d.9` gave it a catalog row, and a stale sentinel that
      // quietly became real is how a 404 guard stops guarding anything.
      "no-such-provider",
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "provider_not_found",
      provider: "no-such-provider",
    });
    expect(puts).toEqual([]);
  });

  it("415s a body that does not declare JSON, and 400s one that is not", async () => {
    const { ingest } = stubIngest();
    expect(
      (
        await handleIntegrationCredentialRequest(
          new Request(CREDENTIAL_URL, { method: "PUT", body: "fields=1" }),
          CREDENTIAL_URL,
          ingest,
          "bing-webmaster",
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handleIntegrationCredentialRequest(
          new Request(CREDENTIAL_URL, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: "{",
          }),
          CREDENTIAL_URL,
          ingest,
          "bing-webmaster",
        )
      ).status,
    ).toBe(400);
  });

  it("422s a body with no fields object, naming the field", async () => {
    const { ingest } = stubIngest();
    const response = await handleIntegrationCredentialRequest(
      put({ BING_WEBMASTER_API_KEY: SECRET }),
      CREDENTIAL_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "invalid_credential",
      field: "fields",
    });
  });

  it("renders ingest's validation refusal as a 422 naming the first bad field", async () => {
    const { ingest } = stubIngest({
      put: {
        ok: false,
        error: "validation",
        issues: [
          { path: "DATAFORSEO_PASSWORD", code: "required", message: "API password is required." },
        ],
      },
    });
    const response = await handleIntegrationCredentialRequest(
      put({ fields: { DATAFORSEO_LOGIN: "op@example.test" } }),
      CREDENTIAL_URL,
      ingest,
      "dataforseo",
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_credential",
      field: "DATAFORSEO_PASSWORD",
      detail: "API password is required.",
    });
  });

  it("503s a missing bootstrap key, and carries the sentence that fixes it", async () => {
    const { ingest } = stubIngest({
      put: {
        ok: false,
        error: "key_missing",
        message:
          "CREDENTIALS_KEY is not set. Generate one with `openssl rand -base64 32`, then …",
      },
    });
    const response = await handleIntegrationCredentialRequest(
      put({ fields: { BING_WEBMASTER_API_KEY: SECRET } }),
      CREDENTIAL_URL,
      ingest,
      "bing-webmaster",
    );
    // 503 and not 500: nothing is wrong with the request. The install is
    // missing one env secret.
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("credentials_key_missing");
    expect(body.detail).toContain("openssl rand -base64 32");
  });

  it("503s an unapplied migration with the apply command", async () => {
    const { ingest } = stubIngest({
      put: {
        ok: false,
        error: "store_unavailable",
        message: "The credentials table is not in the store yet. Apply it with `pnpm migrate:local`.",
      },
    });
    const response = await handleIntegrationCredentialRequest(
      put({ fields: { BING_WEBMASTER_API_KEY: SECRET } }),
      CREDENTIAL_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("credential_store_unavailable");
  });

  it("keeps the service boundary opaque when the binding throws", async () => {
    const { ingest } = stubIngest({ put: new Error("workerd exploded") });
    const response = await handleIntegrationCredentialRequest(
      put({ fields: { BING_WEBMASTER_API_KEY: SECRET } }),
      CREDENTIAL_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(500);
    // The browser gets a code, never ingest's internals.
    expect(await response.json()).toEqual({ error: "credential_write_failed" });
  });
});

describe("DELETE /api/integrations/:provider/credential", () => {
  it("forgets the credential and answers 204", async () => {
    const { ingest, deletes } = stubIngest();
    const response = await handleIntegrationCredentialRequest(
      new Request(CREDENTIAL_URL, { method: "DELETE" }),
      CREDENTIAL_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(204);
    expect(deletes).toEqual(["bing-webmaster"]);
  });

  it("refuses a cross-origin disconnect", async () => {
    const { ingest, deletes } = stubIngest();
    const response = await handleIntegrationCredentialRequest(
      new Request(CREDENTIAL_URL, {
        method: "DELETE",
        headers: { "sec-fetch-site": "cross-site" },
      }),
      CREDENTIAL_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(403);
    expect(deletes).toEqual([]);
  });

  it("refuses a verb that is neither PUT nor DELETE", async () => {
    const { ingest } = stubIngest();
    const response = await handleIntegrationCredentialRequest(
      new Request(CREDENTIAL_URL, { method: "GET" }),
      CREDENTIAL_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(405);
  });
});

describe("POST /api/integrations/:provider/test", () => {
  it("returns the probe verdict as a 200", async () => {
    const { ingest, probes } = stubIngest();
    const response = await handleIntegrationTestRequest(
      new Request(TEST_URL, { method: "POST" }),
      TEST_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      message: "Answered · 5 sites",
      result: { outcome: "answered", facts: { sites: 5 } },
      checkedAt: NOW.toISOString(),
    });
    expect(probes).toEqual(["bing-webmaster"]);
  });

  it("keeps a failing credential a 200 — it is the answer, not a fault", async () => {
    const { ingest } = stubIngest({
      probe: {
        ok: false,
        message: "Refused",
        result: { outcome: "refused", fix: { kind: "replace" } },
        checkedAt: NOW.toISOString(),
      },
    });
    const response = await handleIntegrationTestRequest(
      new Request(TEST_URL, { method: "POST" }),
      TEST_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(false);
  });

  it("guards origin, verb and provider before it probes anything", async () => {
    const { ingest, probes } = stubIngest();
    expect(
      (
        await handleIntegrationTestRequest(
          new Request(TEST_URL, { method: "GET" }),
          TEST_URL,
          ingest,
          "bing-webmaster",
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handleIntegrationTestRequest(
          new Request(TEST_URL, { method: "POST", headers: { origin: "https://evil.test" } }),
          TEST_URL,
          ingest,
          "bing-webmaster",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleIntegrationTestRequest(
          new Request(TEST_URL, { method: "POST" }),
          TEST_URL,
          ingest,
          "no-such-provider",
        )
      ).status,
    ).toBe(404);
    // A probe costs a real provider call, so nothing reaches one until all
    // three guards have passed.
    expect(probes).toEqual([]);
  });

  it("500s when the binding itself fails", async () => {
    const { ingest } = stubIngest({ probe: new Error("binding down") });
    const response = await handleIntegrationTestRequest(
      new Request(TEST_URL, { method: "POST" }),
      TEST_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(500);
  });
});

describe("POST /api/integrations/:provider/connect (bead ro-ujb9.96.7.1)", () => {
  const CONNECT_URL = new URL("https://tower.local/api/integrations/bing-webmaster/connect");
  const connect = (body: unknown, headers: Record<string, string> = {}, provider = "bing-webmaster"): Request =>
    new Request(new URL(`https://tower.local/api/integrations/${provider}/connect`), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("answers the provider's verdict and facts as a 200, and never echoes a value", async () => {
    const { ingest, connects } = stubIngest();
    const response = await handleIntegrationConnectRequest(
      connect({ fields: { BING_WEBMASTER_API_KEY: SECRET } }), CONNECT_URL, ingest, "bing-webmaster");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ verdict: "accepted", checkedAt: NOW.toISOString(), facts: { sites: 3 } });
    expect(text).not.toContain(SECRET);
    expect(connects).toEqual([{ provider: "bing-webmaster", fields: { BING_WEBMASTER_API_KEY: SECRET } }]);
  });

  it("keeps a refusal and an unreachable provider 200s — each is the answer", async () => {
    for (const verdict of ["refused", "unreachable"] as const) {
      const { ingest } = stubIngest({ connect: { ok: true, verdict, checkedAt: NOW.toISOString() } });
      const response = await handleIntegrationConnectRequest(
        connect({ fields: { BING_WEBMASTER_API_KEY: SECRET } }), CONNECT_URL, ingest, "bing-webmaster");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ verdict, checkedAt: NOW.toISOString() });
    }
  });

  it("guards verb, origin, provider and panel kind before the provider is asked", async () => {
    const { ingest, connects } = stubIngest();
    expect((await handleIntegrationConnectRequest(
      new Request(CONNECT_URL, { method: "PUT" }), CONNECT_URL, ingest, "bing-webmaster")).status).toBe(405);
    expect((await handleIntegrationConnectRequest(
      connect({ fields: {} }, { origin: "https://evil.test" }), CONNECT_URL, ingest, "bing-webmaster")).status).toBe(403);
    expect((await handleIntegrationConnectRequest(
      connect({ fields: {} }, {}, "nope"), CONNECT_URL, ingest, "nope")).status).toBe(404);
    // A provider that does not connect with one key: Clarity's tokens are
    // pasted per site, on their own rows (bead ro-ujb9.96.7.9).
    const clarity = await handleIntegrationConnectRequest(
      connect({ fields: {} }, {}, "clarity"), CONNECT_URL, ingest, "clarity");
    expect(clarity.status).toBe(409);
    expect(await clarity.json()).toMatchObject({ error: "connect_not_supported" });
    expect((await handleIntegrationConnectRequest(
      connect({ nothing: true }), CONNECT_URL, ingest, "bing-webmaster")).status).toBe(422);
    expect(connects).toEqual([]);
  });

  it("names the refused field, and carries a store that cannot hold it as a 503", async () => {
    const invalid = stubIngest({ connect: { ok: false, error: "validation",
      issues: [{ path: "BING_WEBMASTER_API_KEY", code: "required", message: "API key is required." }] } });
    const refused = await handleIntegrationConnectRequest(
      connect({ fields: {} }), CONNECT_URL, invalid.ingest, "bing-webmaster");
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ field: "BING_WEBMASTER_API_KEY" });

    const keyless = stubIngest({ connect: { ok: false, error: "key_missing", message: "Generate CREDENTIALS_KEY." } });
    expect((await handleIntegrationConnectRequest(
      connect({ fields: { BING_WEBMASTER_API_KEY: SECRET } }), CONNECT_URL, keyless.ingest, "bing-webmaster")).status).toBe(503);

    const down = stubIngest({ connect: new Error("binding down") });
    expect((await handleIntegrationConnectRequest(
      connect({ fields: { BING_WEBMASTER_API_KEY: SECRET } }), CONNECT_URL, down.ingest, "bing-webmaster")).status).toBe(500);
  });
});

describe("PUT /api/integrations/:provider/site-token (bead ro-ujb9.96.7.9)", () => {
  const url = (provider = "clarity") => new URL(`https://tower.local/api/integrations/${provider}/site-token`);
  const put = (body: unknown, headers: Record<string, string> = {}, provider = "clarity"): Request =>
    new Request(url(provider), { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("passes one site's token to the ingest to merge, and answers 204 with nothing to echo", async () => {
    const { ingest, siteTokens } = stubIngest();
    const response = await handleIntegrationSiteTokenRequest(put({ asset: "example.com", token: SECRET }), url(), ingest, "clarity");
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(siteTokens).toEqual([{ provider: "clarity", asset: "example.com", token: SECRET }]);
  });

  it("takes tokens only for a provider that issues them per site, and guards verb, origin and body first", async () => {
    const { ingest, siteTokens } = stubIngest();
    expect((await handleIntegrationSiteTokenRequest(new Request(url(), { method: "POST" }), url(), ingest, "clarity")).status).toBe(405);
    expect((await handleIntegrationSiteTokenRequest(put({ asset: "example.com", token: SECRET }, { origin: "https://evil.test" }), url(), ingest, "clarity")).status).toBe(403);
    const bing = await handleIntegrationSiteTokenRequest(put({ asset: "example.com", token: SECRET }, {}, "bing-webmaster"), url("bing-webmaster"), ingest, "bing-webmaster");
    expect(bing.status).toBe(409);
    expect(await bing.json()).toMatchObject({ error: "site_tokens_not_supported" });
    expect((await handleIntegrationSiteTokenRequest(put({ token: SECRET }), url(), ingest, "clarity")).status).toBe(422);
    expect(siteTokens).toEqual([]);
  });

  it("names the refused field, and carries a store that cannot hold it as a 503", async () => {
    const refused = stubIngest({ siteToken: { ok: false, error: "validation", issues: [{ path: "asset", code: "unknown_asset", message: "That site is not one of this installation’s." }] } });
    const response = await handleIntegrationSiteTokenRequest(put({ asset: "nope.example", token: SECRET }), url(), refused.ingest, "clarity");
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field: "asset" });
    const keyless = stubIngest({ siteToken: { ok: false, error: "key_missing", message: "Generate CREDENTIALS_KEY." } });
    expect((await handleIntegrationSiteTokenRequest(put({ asset: "example.com", token: SECRET }), url(), keyless.ingest, "clarity")).status).toBe(503);
  });

  it("refuses the one-key connect for a provider whose tokens are pasted per site", async () => {
    const { ingest, connects } = stubIngest();
    const request = new Request(new URL("https://tower.local/api/integrations/clarity/connect"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: { CLARITY_TOKENS: "{}" } }),
    });
    expect((await handleIntegrationConnectRequest(request, new URL(request.url), ingest, "clarity")).status).toBe(409);
    expect(connects).toEqual([]);
  });
});

describe("PUT /api/integrations/:provider/expiry", () => {
  const EXPIRY_URL = new URL(
    "https://tower.local/api/integrations/bing-webmaster/expiry",
  );
  const putExpiry = (body: unknown, headers: Record<string, string> = {}): Request =>
    new Request(EXPIRY_URL, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("passes the date through and answers 204", async () => {
    const { ingest, expiries } = stubIngest();
    const response = await handleIntegrationExpiryRequest(
      putExpiry({ expiresAt: "2026-10-04T00:00:00.000Z" }),
      EXPIRY_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(204);
    expect(expiries).toEqual([
      { provider: "bing-webmaster", expiresAt: "2026-10-04T00:00:00.000Z" },
    ]);
  });

  it("forwards an explicit null, because that is the answer and not an omission", async () => {
    // "This does not expire" is a statement the store records and stamps
    // `operator`, which is what stops the next Google sign-in re-assuming.
    const { ingest, expiries } = stubIngest();
    const response = await handleIntegrationExpiryRequest(
      putExpiry({ expiresAt: null }),
      EXPIRY_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(204);
    expect(expiries).toEqual([{ provider: "bing-webmaster", expiresAt: null }]);
  });

  it("refuses a body that says nothing at all, which is not the same as null", async () => {
    const { ingest, expiries } = stubIngest();
    const response = await handleIntegrationExpiryRequest(
      putExpiry({}),
      EXPIRY_URL,
      ingest,
      "bing-webmaster",
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field: "expiresAt" });
    expect(expiries).toEqual([]);
  });

  it("answers 409 when the provider states no expiry, carrying the sentence the card prints", async () => {
    const { ingest } = stubIngest({
      expiry: {
        ok: false,
        error: "not_expirable",
        message: "Calendar feeds: a secret calendar address does not expire.",
      },
    });
    const response = await handleIntegrationExpiryRequest(
      putExpiry({ expiresAt: "2026-10-04T00:00:00.000Z" }),
      EXPIRY_URL,
      ingest,
      "calendar",
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "credential_not_expirable",
      detail: expect.stringContaining("does not expire"),
    });
  });

  it("refuses cross-origin and unknown providers before the binding is called", async () => {
    const { ingest, expiries } = stubIngest();
    expect(
      (
        await handleIntegrationExpiryRequest(
          putExpiry({ expiresAt: null }, { origin: "https://evil.test" }),
          EXPIRY_URL,
          ingest,
          "bing-webmaster",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleIntegrationExpiryRequest(
          putExpiry({ expiresAt: null }),
          EXPIRY_URL,
          ingest,
          "not-a-provider",
        )
      ).status,
    ).toBe(404);
    expect(expiries).toEqual([]);
  });
});

describe("assetsUsingProvider", () => {
  it("skips lanes the register says never apply to that asset", () => {
    // "What breaks if this credential is wrong" — and a lane that never applied
    // to an asset breaks nothing there.
    expect(assetsUsingProvider(CONFIG, ["gsc"])).toEqual([
      { id: "meals.example", lanes: ["gsc"] },
    ]);
  });

  it("counts a needs-setup cell — it is the row most waiting on this credential", () => {
    expect(assetsUsingProvider(CONFIG, ["ga4"])).toEqual([
      { id: "meals.example", lanes: ["ga4"] },
    ]);
  });

  it("answers empty for a provider with no register lane at all", () => {
    expect(assetsUsingProvider(CONFIG, [])).toEqual([]);
  });
});

// The other half of the same question — "what does this credential still have to
// CARRY" — used to be derived HERE, from `config/integrations.json` alone, and
// its tests lived beside these. Both are gone with bead `ro-vu8d.22`: the
// question is asked of the assets the CREDENTIAL names, which only the ingest
// can read, so there is one function
// (`credentialPropertyMapUse`, workers/ingest/src/lane-mapping.ts) and it is the
// collector's own. The answer now arrives on `CredentialSummary.propertyMap` and
// this route forwards it untouched.
