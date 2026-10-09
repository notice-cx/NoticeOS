import { describe, expect, it } from "vitest";
import { firstToConnect } from "@shared/connect-panel";

/** D45: the page's one filled Connect never asks a stranger to start with a
 * source that spends money on every collection. */
describe("the source a site connects first", () => {
  const reading = (label: string, provider: string) => ({ label, provider, kind: "not-connected" });

  it("puts a free source ahead of a paid one, whatever the alphabet says", () => {
    const first = firstToConnect([
      reading("DataForSEO rankings", "dataforseo"),
      reading("Google Search Console", "google"),
      reading("Bing Webmaster Tools", "bing-webmaster"),
    ]);
    expect(first?.label).toBe("Bing Webmaster Tools");
  });

  it("still offers the paid source when it is the only one left", () => {
    expect(firstToConnect([reading("DataForSEO rankings", "dataforseo")])?.label).toBe("DataForSEO rankings");
  });

  it("orders free sources by name, and skips what is already connected", () => {
    const first = firstToConnect([
      { label: "Bing Webmaster Tools", provider: "bing-webmaster", kind: "working" },
      reading("Google Search Console", "google"),
      reading("Google Analytics", "google"),
    ]);
    expect(first?.label).toBe("Google Analytics");
  });
});
