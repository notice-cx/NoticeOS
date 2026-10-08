import { readFileSync } from "node:fs";
import path from "node:path";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { render } from "./render";
import { documentHead } from "../vite/document-head";
import { documentTitle } from "@/lib/document-title";
import { PageHeader } from "@/components/PageHeader";

const root = path.resolve(__dirname, "..");
const index = readFileSync(path.join(root, "index.html"), "utf8");
const demoHead = readFileSync(path.join(root, "vite/demo-head.html"), "utf8");
const tag = (html: string, pattern: RegExp) => html.match(pattern)?.[1] ?? null;

describe("the head a build ships", () => {
  it("keeps an installation out of search, with a title and description of the product", () => {
    for (const profile of ["standalone", "hosted"] as const) {
      const html = documentHead(index, profile, demoHead);
      expect(html).toBe(index);
      expect(tag(html, /<meta name="robots" content="([^"]+)"/u)).toBe("noindex, nofollow");
      expect(tag(html, /<title>([^<]+)<\/title>/u)).toMatch(/^NoticeOS · /u);
      expect(tag(html, /<meta name="description" content="([^"]+)"/u)!.length).toBeLessThanOrEqual(160);
      expect(html).not.toContain("__NOTICEOS_PUBLIC_ORIGIN__");
    }
  });
  it("lets search index the public demo and previews it with the TV dashboard", () => {
    const html = documentHead(index, "demo", demoHead);
    expect(html.match(/<title>/gu)).toHaveLength(1);
    expect(html.match(/<meta name="robots"/gu)).toHaveLength(1);
    expect(tag(html, /<meta name="robots" content="([^"]+)"/u)).toMatch(/^index, follow/u);
    expect(tag(html, /<title>([^<]+)<\/title>/u)!.length).toBeLessThanOrEqual(60);
    expect(tag(html, /<meta name="description" content="([^"]+)"/u)!.length).toBeLessThanOrEqual(160);
    expect(tag(html, /<meta property="og:image" content="([^"]+)"/u)).toBe("__NOTICEOS_PUBLIC_ORIGIN__/brand/notice-demo-wall.png");
    expect(tag(html, /<meta name="twitter:card" content="([^"]+)"/u)).toBe("summary_large_image");
    // The icons, fonts and app entry stay the installation's.
    expect(html).toContain('<link rel="apple-touch-icon" href="/brand/notice-icon-180.png" />');
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
  });
  it("refuses a page whose head block moved", () => {
    expect(() => documentHead(index.replace("<!-- document-head:end -->", ""), "demo", demoHead)).toThrow("document-head block");
    expect(() => documentHead(index.replace("<!-- document-head:begin -->", "<!-- document-head:begin --><!-- document-head:begin -->"), "standalone", demoHead)).toThrow();
  });
});

describe("the tab names the page", () => {
  it("is the page's heading, then the product, and says when it is the demo", () => {
    expect(documentTitle("Sites", false)).toBe("Sites · NoticeOS");
    expect(documentTitle("Sites", true)).toBe("Sites · NoticeOS demo");
  });
  it("follows a plain heading, an explicit name for a rich one, and nothing otherwise", () => {
    const view = render(<MemoryRouter><PageHeader title="Financials" /></MemoryRouter>);
    expect(document.title).toBe("Financials · NoticeOS");
    view.rerender(<MemoryRouter><PageHeader title={<span>Light Brief</span>} documentTitle="Light Brief" /></MemoryRouter>);
    expect(document.title).toBe("Light Brief · NoticeOS");
    view.rerender(<MemoryRouter><PageHeader title="Home" documentTitle={null} /></MemoryRouter>);
    expect(document.title).toBe(documentTitle(null, false));
  });
});
