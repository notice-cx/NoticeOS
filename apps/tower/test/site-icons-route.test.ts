// Read again's route: the Tower asks the ingest's own icon read for the one
// site its path names, and fetches no page itself. A refusal from the ingest
// is an answer; a request from another origin, or one that names anything in
// its body, reaches nothing.

import { describe, expect, it, vi } from "vitest";
import type { SiteIconsReadInput, SiteIconsReadResult } from "@noticeos/contract/site-icons";
import { SITE_ICONS_PATH, handleSiteIconsReadRequest } from "../worker/site-icons-route";

const ORIGIN = "https://tower.example.com";
const PATH = "/api/assets/meadow.example/icons";
const STORED: SiteIconsReadResult = {
  ok: true, asset: "meadow.example", readAt: "2026-10-17T06:00:00.000Z", outcome: "read",
  light: "https://meadow.example/icon.svg", dark: null,
};

function post(body: string | null, headers: Record<string, string> = { "content-type": "application/json" }, method = "POST"): Request {
  return new Request(ORIGIN + PATH, { method, headers, ...(body === null ? {} : { body }) });
}

function ingest(answer: SiteIconsReadResult | Error = STORED) {
  const readSiteIcons = vi.fn(async (_input: SiteIconsReadInput) => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { readSiteIcons };
}

async function send(request: Request, reader = ingest()) {
  const asset = new URL(request.url).pathname.match(SITE_ICONS_PATH)![1]!;
  const response = await handleSiteIconsReadRequest(request, new URL(request.url), reader, asset);
  return { status: response.status, body: (await response.json()) as unknown, reader };
}

describe("POST /api/assets/:id/icons", () => {
  it("runs the ingest's read for the site the path names and answers what it stored", async () => {
    const { status, body, reader } = await send(post("{}"));
    expect(status).toBe(200);
    expect(body).toEqual(STORED);
    expect(reader.readSiteIcons).toHaveBeenCalledExactlyOnceWith({ asset: "meadow.example" });
  });

  it("passes a refusal through as an answer", async () => {
    const paused: SiteIconsReadResult = { ok: false, asset: "meadow.example", error: "paused" };
    const { status, body } = await send(post("{}"), ingest(paused));
    expect(status).toBe(200);
    expect(body).toEqual(paused);
  });

  it("asks nothing for another verb, another origin, another body type or a body that names anything", async () => {
    for (const [request, code] of [
      [post(null, {}, "GET"), 405],
      [post("{}", { "content-type": "application/json", origin: "https://elsewhere.example.com" }), 403],
      [post("{}", { "content-type": "application/json", "sec-fetch-site": "cross-site" }), 403],
      [post("{}", { "content-type": "text/plain" }), 415],
      [post('{"asset":"other.example"}'), 422],
      [post("[]"), 422],
    ] as const) {
      const { status, reader } = await send(request);
      expect(status, `${request.method} ${JSON.stringify([...request.headers])}`).toBe(code);
      expect(reader.readSiteIcons).not.toHaveBeenCalled();
    }
  });

  it("answers a failed ingest call as a failure, not a read", async () => {
    const { status, body } = await send(post("{}"), ingest(new Error("binding down")));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "icons_read_failed" });
  });
});
