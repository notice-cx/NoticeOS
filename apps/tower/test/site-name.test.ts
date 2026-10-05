import { describe, expect, it, vi } from "vitest";
import { isLookupHost, siteNameFromHtml } from "@shared/site-name";
import { handleSiteNameRequest } from "../worker/site-name-route";

// The name a site gives itself, for Add a site (bead `ro-ujb9.96.7.5`). A
// nicety that must never be a door: every refusal and failure answers null with
// 200, and the only host it will fetch is the public one the operator typed.

describe("the site's own name, out of its home page", () => {
  it("prefers the name the site declares for itself", () => {
    const html = `<html><head><title>Hand tools for makers | Example Shop</title>
      <meta property="og:site_name" content="Example Shop"></head></html>`;
    expect(siteNameFromHtml(html, "shop.example.com")).toBe("Example Shop");
  });

  it("takes the brand segment of a title, matched to the domain", () => {
    expect(siteNameFromHtml("<title>Acme — tools for makers</title>", "acme.example.com")).toBe("Acme");
    expect(siteNameFromHtml("<title>Recipe search · RecipeBox</title>", "recipebox.example.org")).toBe("RecipeBox");
    expect(siteNameFromHtml("<title>Field Notes: a birding journal</title>", "fieldnotes.example.net")).toBe("Field Notes");
  });

  it("keeps a short title whole and refuses a sentence", () => {
    expect(siteNameFromHtml("<title>Tide Tables</title>", "tides.example.org")).toBe("Tide Tables");
    expect(siteNameFromHtml("<title>The best way to look up any number anywhere</title>", "numbers.example")).toBeNull();
    expect(siteNameFromHtml("<html><body>no title</body></html>", "x.example")).toBeNull();
  });

  it("decodes the entities a title carries", () => {
    expect(siteNameFromHtml("<title>Tom &amp; Jerry&#39;s</title>", "tomandjerrys.shop")).toBe("Tom & Jerry's");
  });
});

describe("the hosts the lookup will fetch", () => {
  it("allows a public-looking DNS name", () => {
    expect(isLookupHost("shop.example.com")).toBe(true);
    expect(isLookupHost("www.example-site.co.uk")).toBe(true);
  });

  it("refuses literals, loopback and names that resolve inside a network", () => {
    for (const host of ["127.0.0.1", "localhost", "tower.localhost", "nas.local", "db.internal", "journey.example", "a.test", "10.0.0.1", "intranet-host"]) {
      expect(isLookupHost(host), host).toBe(false);
    }
  });
});

function page(html: string, init: ResponseInit = {}): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });
}

async function ask(domain: string, fetcher: typeof fetch) {
  const url = new URL(`https://tower.test/api/site-name?domain=${encodeURIComponent(domain)}`);
  const res = await handleSiteNameRequest(new Request(url), url, fetcher);
  return { status: res.status, body: (await res.json()) as { name: string | null } };
}

describe("GET /api/site-name", () => {
  it("fetches only https://<domain>/ and answers the name", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => page("<title>Example Shop — hand tools</title>"));
    expect(await ask("https://www.shop.example.com/pricing", fetcher as unknown as typeof fetch)).toEqual({ status: 200, body: { name: "Example Shop" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("https://shop.example.com/");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "manual", method: "GET" });
  });

  it("never fetches a host it refuses", async () => {
    const fetcher = vi.fn();
    expect(await ask("127.0.0.1", fetcher as unknown as typeof fetch)).toEqual({ status: 200, body: { name: null } });
    expect(await ask("journey.example", fetcher as unknown as typeof fetch)).toEqual({ status: 200, body: { name: null } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("follows a redirect to a public host, and stops at one pointing inside", async () => {
    const outward = vi.fn(async (url: string) => url === "https://shop.example.com/"
      ? new Response(null, { status: 301, headers: { location: "https://www.shop.example.com/" } })
      : page("<title>Example Shop</title>"));
    expect((await ask("shop.example.com", outward as unknown as typeof fetch)).body).toEqual({ name: "Example Shop" });

    const inward = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8791/api/wall" } }));
    expect((await ask("shop.example.com", inward as unknown as typeof fetch)).body).toEqual({ name: null });
    expect(inward).toHaveBeenCalledTimes(1);
  });

  it("answers null, not an error, when the site fails, is slow or is not a page", async () => {
    const down = vi.fn(async () => { throw new Error("connect ECONNREFUSED"); });
    expect(await ask("shop.example.com", down as unknown as typeof fetch)).toEqual({ status: 200, body: { name: null } });
    const json = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    expect((await ask("shop.example.com", json as unknown as typeof fetch)).body).toEqual({ name: null });
    const missing = vi.fn(async () => new Response("gone", { status: 404, headers: { "content-type": "text/html" } }));
    expect((await ask("shop.example.com", missing as unknown as typeof fetch)).body).toEqual({ name: null });
  });

  it("refuses anything but GET", async () => {
    const url = new URL("https://tower.test/api/site-name?domain=shop.example.com");
    const res = await handleSiteNameRequest(new Request(url, { method: "POST" }), url, vi.fn() as unknown as typeof fetch);
    expect(res.status).toBe(405);
  });
});
