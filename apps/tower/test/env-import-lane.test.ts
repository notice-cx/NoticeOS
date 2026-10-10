// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { handleEnvImportRequest } from "../vite/env-import-lane";
import {
  ENV_IMPORT_NO_FILE_DETAIL,
  ENV_IMPORT_PATH,
  type EnvImportResult,
} from "../shared/env-import";

// The local lane that moves the operator's `.dev.secrets.json` into the
// credential store. It runs in the dev server's Node process, reads the file
// holding every provider secret on the machine, and is reachable from a
// browser, so what is asserted is every way it refuses, that what it PUTs is
// what `pnpm dev:secrets:import` would have PUT (it calls that same
// function), and that no answer it gives ever carries a value.

const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A throwaway checkout holding one secrets file — the shape of the machine
 * this lane actually reads. */
async function tempRepo(secrets: Record<string, unknown> | null): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-import-"));
  created.push(root);
  if (secrets !== null) {
    await fs.mkdir(path.join(root, "workers", "ingest"), { recursive: true });
    await fs.writeFile(
      path.join(root, "workers", "ingest", ".dev.secrets.json"),
      JSON.stringify(secrets, null, 2) + "\n",
      "utf8",
    );
  }
  return root;
}

const LOCAL = { host: "127.0.0.1:5173", "sec-fetch-site": "same-origin" };
const JSON_POST = { ...LOCAL, "content-type": "application/json" };

function post(headers: Record<string, string | undefined> = JSON_POST) {
  return { method: "POST", headers, body: "{}", url: ENV_IMPORT_PATH };
}

/** The two providers the fixtures import, as `GET /api/integrations/providers`
 * serves them. Only the catalog half matters here — the lane reads `fields` and
 * `authPaths` to decide what is complete, exactly as the CLI does. */
const PROVIDERS = [
  {
    provider: {
      id: "bing-webmaster",
      fields: [{ name: "BING_WEBMASTER_API_KEY", required: true }],
    },
  },
  {
    provider: {
      id: "dataforseo",
      fields: [
        { name: "DATAFORSEO_LOGIN", required: true },
        { name: "DATAFORSEO_PASSWORD", required: true },
      ],
    },
  },
];

/** A Tower that answers the providers read and takes every PUT. Records what it
 * was sent, so a test can assert the VALUES went to the store and nowhere
 * else. */
function towerStub(over: { putStatus?: number; putBody?: unknown } = {}) {
  const puts: { url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/integrations/providers")) {
      return new Response(
        JSON.stringify({ keyPresent: true, providers: PROVIDERS }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    puts.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
    const status = over.putStatus ?? 204;
    return status === 204
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(over.putBody ?? {}), {
          status,
          headers: { "content-type": "application/json" },
        });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, puts };
}

describe("the env-import lane", () => {
  it("says it can import when the machine has a secrets file, and says why when it has none", async () => {
    const withFile = await tempRepo({ BING_WEBMASTER_API_KEY: "key" });
    const empty = await tempRepo(null);

    const yes = await handleEnvImportRequest(
      { method: "GET", headers: LOCAL, body: "" },
      { repoRoot: withFile },
    );
    expect(yes.body).toEqual({ importable: true, reason: null });

    // The card must be told before it draws a button.
    const no = await handleEnvImportRequest(
      { method: "GET", headers: LOCAL, body: "" },
      { repoRoot: empty },
    );
    expect(no.body).toEqual({ importable: false, reason: "no-file" });
  });

  it("PUTs every complete provider and answers with names, never values", async () => {
    const root = await tempRepo({
      BING_WEBMASTER_API_KEY: "bing-secret",
      DATAFORSEO_LOGIN: "login@example.com",
      DATAFORSEO_PASSWORD: "dfs-secret",
    });
    const tower = towerStub();

    const reply = await handleEnvImportRequest(post(), {
      repoRoot: root,
      fetchImpl: tower.fetchImpl,
    });

    expect(reply.status).toBe(200);
    const result = reply.body as unknown as EnvImportResult;
    expect(result.imported).toEqual([
      { provider: "bing-webmaster", fields: ["BING_WEBMASTER_API_KEY"] },
      { provider: "dataforseo", fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"] },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);

    // The values reached the store's own route and appear nowhere in the
    // answer the browser gets.
    expect(tower.puts.map((entry) => entry.url)).toEqual([
      "http://127.0.0.1:5173/api/integrations/bing-webmaster/credential",
      "http://127.0.0.1:5173/api/integrations/dataforseo/credential",
    ]);
    expect(tower.puts[0]!.body).toEqual({ fields: { BING_WEBMASTER_API_KEY: "bing-secret" } });
    expect(JSON.stringify(reply.body)).not.toContain("bing-secret");
    expect(JSON.stringify(reply.body)).not.toContain("dfs-secret");
  });

  it("skips a half-held provider by name rather than storing a partial credential", async () => {
    // A partial credential in the store would shadow a complete one in the env.
    const root = await tempRepo({ DATAFORSEO_LOGIN: "login@example.com" });
    const tower = towerStub();

    const reply = await handleEnvImportRequest(post(), {
      repoRoot: root,
      fetchImpl: tower.fetchImpl,
    });

    const result = reply.body as unknown as EnvImportResult;
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual([
      { provider: "bing-webmaster", missing: ["BING_WEBMASTER_API_KEY"] },
      { provider: "dataforseo", missing: ["DATAFORSEO_PASSWORD"] },
    ]);
    expect(tower.puts).toEqual([]);
  });

  it("reports a refused PUT as that provider's failure, in the store's own words", async () => {
    const root = await tempRepo({ BING_WEBMASTER_API_KEY: "key" });
    const tower = towerStub({
      putStatus: 503,
      putBody: { error: "credentials_key_missing", detail: "CREDENTIALS_KEY is not set." },
    });

    const reply = await handleEnvImportRequest(post(), {
      repoRoot: root,
      fetchImpl: tower.fetchImpl,
    });

    const result = reply.body as unknown as EnvImportResult;
    expect(result.imported).toEqual([]);
    expect(result.failed).toEqual([
      { provider: "bing-webmaster", detail: "CREDENTIALS_KEY is not set." },
    ]);
  });

  it("refuses a cross-origin press, a wrong verb, and a body that is not JSON", async () => {
    const root = await tempRepo({ BING_WEBMASTER_API_KEY: "key" });
    const tower = towerStub();
    const lane = { repoRoot: root, fetchImpl: tower.fetchImpl };

    // A page on another site must not be able to move the operator's secrets.
    const foreign = await handleEnvImportRequest(
      post({ ...JSON_POST, origin: "https://evil.example" }),
      lane,
    );
    expect(foreign.status).toBe(403);

    const wrongVerb = await handleEnvImportRequest(
      { method: "DELETE", headers: LOCAL, body: "" },
      lane,
    );
    expect(wrongVerb.status).toBe(405);

    const notJson = await handleEnvImportRequest(post(LOCAL), lane);
    expect(notJson.status).toBe(415);

    expect(tower.puts).toEqual([]);
  });

  it("refuses to import when the machine has no secrets file", async () => {
    const root = await tempRepo(null);
    const tower = towerStub();
    const reply = await handleEnvImportRequest(post(), {
      repoRoot: root,
      fetchImpl: tower.fetchImpl,
    });
    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({
      error: "no_secrets_file",
      detail: ENV_IMPORT_NO_FILE_DETAIL,
    });
    expect(tower.puts).toEqual([]);
  });

  it("aims the PUTs at the address the browser reached it on, not a fixed loopback", async () => {
    // `os:up` serves the wall and the phone on the LAN name; a hard-coded
    // 127.0.0.1 origin would make the Worker's same-origin check refuse every
    // credential the button moved from those.
    const root = await tempRepo({ BING_WEBMASTER_API_KEY: "key" });
    const tower = towerStub();
    await handleEnvImportRequest(
      post({ ...JSON_POST, host: "office-mac.local:5173" }),
      { repoRoot: root, fetchImpl: tower.fetchImpl },
    );
    expect(tower.puts[0]!.url).toBe(
      "http://office-mac.local:5173/api/integrations/bing-webmaster/credential",
    );
  });
});
