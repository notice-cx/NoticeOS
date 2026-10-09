// @vitest-environment node
// THE NOTICE IDENTITY (decision D35, bead ro-ujb9.77.3): the app wears the
// Notice mark, a NoticeOS wordmark in Stack Sans Notch and the website's blue,
// and the blue is a BRAND colour only — it may mark an action, a selection or
// focus, never a severity, a state or a data series (AGENTS.md UI tokens rule,
// docs/14-design.md § The Notice identity).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { block, distance, simulate, themeColours, withoutComments } from "./palette";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const png = (file: string) => {
  const bytes = readFileSync(path.join(root, file));
  expect([...bytes.subarray(0, 8)], `${file} is a PNG`).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};
describe("the NoticeOS favicon set", () => {
  const html = read("index.html");

  it("serves the website's icons: the dark N for light tab bars, the white N for dark ones", () => {
    expect(html).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/brand/notice-icon-32.png" />');
    expect(html).toContain(
      '<link rel="icon" type="image/png" sizes="32x32" href="/brand/notice-icon-32-dark.png" media="(prefers-color-scheme: dark)" />',
    );
    expect(html).toContain(
      '<link rel="icon" type="image/png" sizes="16x16" href="/brand/notice-icon-16-dark.png" media="(prefers-color-scheme: dark)" />',
    );
    expect(html).toContain('<link rel="apple-touch-icon" href="/brand/notice-icon-180.png" />');
    expect(png("public/brand/notice-icon-32.png")).toEqual({ width: 32, height: 32 });
    expect(png("public/brand/notice-icon-32-dark.png")).toEqual({ width: 32, height: 32 });
    expect(png("public/brand/notice-icon-16-dark.png")).toEqual({ width: 16, height: 16 });
    expect(png("public/brand/notice-icon-180.png")).toEqual({ width: 180, height: 180 });
  });

  it("leaves no trace of the retired Signal identity", () => {
    for (const file of ["public/brand/signal-icon.png", "public/brand/signal.css", "public/brand/signal-design-system.zip", "public/favicon.svg"]) {
      expect(existsSync(path.join(root, file)), file).toBe(false);
    }
    expect(html).not.toMatch(/signal/i);
    expect(read("src/components/BrandLockup.tsx")).not.toMatch(/<img/);
  });
});

describe("the wordmark's typeface", () => {
  it("ships Stack Sans Notch with its SIL Open Font License, served by the app itself", () => {
    expect(existsSync(path.join(root, "public/fonts/StackSansNotch-Variable.woff2"))).toBe(true);
    expect(read("public/fonts/StackSansNotch-LICENSE.txt")).toMatch(/SIL Open Font License, Version 1\.1/);
    const brand = read("public/brand/notice.css");
    expect(brand).toMatch(/font-family: "Stack Sans Notch";\s*src: url\("\.\.\/fonts\/StackSansNotch-Variable\.woff2"\)/);
    // No font CDN: every URL the brand stylesheet loads is the app's own.
    expect([...brand.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1])).toEqual([
      "../fonts/InterVariable.woff2",
      "../fonts/StackSansNotch-Variable.woff2",
    ]);
    expect(read("index.html")).toContain('href="/fonts/StackSansNotch-Variable.woff2"');
  });
});

describe("the Notice blue is a brand colour, never a state", () => {
  const brand = read("public/brand/notice.css");
  const theme = read("src/index.css");
  const themes = [
    { name: "dark", brand: block(brand, /:root\s*\{([^}]+)\}/), app: block(theme, /\n:root\s*\{([^}]+)\}/) },
    { name: "light", brand: block(brand, /\.light,\s*:root\[data-theme="light"\]\s*\{([^}]+)\}/), app: block(theme, /\n\.light\s*\{([^}]+)\}/) },
  ];

  it("is the website's #2745d4 in both themes, and the light theme's accent", () => {
    for (const t of themes) expect(t.brand.get("--brand-blue"), t.name).toBe("#2745d4");
    expect(themes[1]!.brand.get("--brand-accent")).toBe("var(--brand-blue)");
    // On the dark canvas the accent is the tint the website draws it in there.
    expect(themes[0]!.brand.get("--brand-accent")).toBe("#b0b9ff");
  });

  it("feeds actions, selection and focus only", () => {
    for (const t of themes) {
      expect(t.app.get("--primary"), t.name).toBe("var(--brand-accent)");
      expect(t.app.get("--primary-hover"), t.name).toBe("var(--brand-accent-hover)");
      expect(t.app.get("--accent-soft"), t.name).toBe("var(--brand-accent-soft)");
      expect(t.app.get("--ring"), t.name).toBe("var(--brand-accent)");
    }
  });

  it("recolours no severity, status or series token", () => {
    const BRAND_ROLES = new Set(["--primary", "--primary-foreground", "--primary-hover", "--accent-soft", "--ring"]);
    for (const t of themes) {
      const leaks = [...t.app].filter(([name, value]) => !BRAND_ROLES.has(name) && /--brand-(?:blue|accent)/.test(value));
      expect(leaks, `${t.name}: tokens that borrow the brand blue`).toEqual([]);
      // The meaning-bearing tokens are all still defined, on their own values.
      for (const token of ["--error", "--warn", "--info", "--urgent", "--milestone", "--healthy", "--connected", "--trend-positive",
        "--trend-negative", "--pace-on", "--pace-behind", "--pace-far-behind", "--traffic", "--search-bing", "--financial-revenue",
        "--financial-cost"]) {
        expect(t.app.has(token), `${t.name}: ${token}`).toBe(true);
      }
    }
  });
});

describe("the Notice blue stays apart from every colour that carries meaning (D35)", () => {
  const resolve = themeColours();
  // Recorded in docs/14-design.md § The Notice identity. The floors are
  // the validator's: 8 normal-vision, and the colour-blind floor of 6 that is
  // legal only because every one of these states and series carries its word
  // or glyph beside the colour — no pair may slip under it.
  const NAMED = ["--error", "--warn", "--info", "--pace-on", "--pace-behind", "--pace-far-behind", "--trend-positive", "--trend-negative",
    "--traffic", "--search-bing"];
  for (const mode of ["dark", "light"] as const) {
    it(`${mode}: at least 8 apart to the eye and 6 apart to colour-blind vision`, () => {
      const accent = resolve(mode, "--primary");
      const measured = NAMED.map((token) => {
        const other = resolve(mode, token);
        return {
          token,
          normal: Math.round(distance(accent, other) * 10) / 10,
          colourBlind: Math.round(Math.min(distance(simulate(accent, "protan"), simulate(other, "protan")),
            distance(simulate(accent, "deutan"), simulate(other, "deutan"))) * 10) / 10,
        };
      });
      expect(measured.filter((m) => m.normal < 8 || m.colourBlind < 6)).toEqual([]);
    });
  }
});

describe("the lockup", () => {
  it("draws the Notice mark in the current ink and sets the wordmark in Stack Sans Notch", () => {
    const lockup = read("src/components/BrandLockup.tsx");
    expect(lockup).toContain('fill="currentColor"');
    expect(lockup).toContain('d="M0 0H354V394H0ZM100 0H237V137ZM117 137H237V257H117ZM117 257V394H254Z"');
    // The published file is the same shape.
    expect(read("public/brand/notice-mark.svg")).toContain('d="M0 0H354V394H0ZM100 0H237V137ZM117 137H237V257H117ZM117 257V394H254Z"');
    const css = withoutComments(read("src/index.css"));
    expect(css).toMatch(/\.brand-wordmark\s*\{[^}]*font-family: var\(--brand-wordmark-font\);/);
    expect(read("public/brand/notice.css")).toMatch(/--brand-wordmark-font: "Stack Sans Notch"/);
  });
});
