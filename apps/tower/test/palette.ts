// THE PALETTE'S MEASURES, read straight from the two stylesheets that define
// the colours: `public/brand/notice.css` (the Notice identity, D35) and
// `src/index.css` (the application tokens). Shared by the tests that hold the
// palette to its numbers — the brand blue's distance from every meaning-bearing
// colour (brand-identity.test.ts) and each chart series' contrast on the card
// it is drawn on (chart-series-contrast.test.ts) — so both read one resolver.
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
export const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** `--name: value;` pairs of the first block `selector` opens. */
export function block(css: string, selector: RegExp): Map<string, string> {
  const body = withoutComments(css).match(selector)?.[1];
  if (!body) throw new Error(`no block for ${selector}`);
  return new Map([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

// ── the palette validator's two measures (the dataviz method): OKLab ΔE ×100
// under normal vision, and under Machado–Oliveira–Fernandes (2009) protan and
// deutan simulation at full severity. Both read linear sRGB.
export type Rgb = [number, number, number];
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export function linearRgb(value: string): Rgb {
  const hex = value.match(/^#([\da-f]{6})$/i)?.[1];
  if (hex) return [0, 2, 4].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as Rgb;
  const lch = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!lch) throw new Error(`not a colour: ${value}`);
  const [L, C, H] = lch.slice(1).map(Number) as [number, number, number];
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (c: number) => Math.max(0, Math.min(1, c));
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(clamp) as Rgb;
}
function oklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const MACHADO: Record<"protan" | "deutan", number[][]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
};
export const simulate = (rgb: Rgb, kind: "protan" | "deutan") =>
  MACHADO[kind].map((row) => Math.max(0, Math.min(1, row[0]! * rgb[0] + row[1]! * rgb[1] + row[2]! * rgb[2]))) as Rgb;
export const distance = (x: Rgb, y: Rgb) => { const [p, q] = [oklab(x), oklab(y)]; return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

/** WCAG 2.2 contrast ratio of two linear-sRGB colours (1 to 21). */
export function contrastRatio(x: Rgb, y: Rgb): number {
  const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [light, dark] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** `colour` at `alpha` over `under`, blended as a browser composites an
 * opacity: in gamma-encoded sRGB. */
export function over(colour: Rgb, alpha: number, under: Rgb): Rgb {
  const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  return colour.map((c, i) => toLinear(alpha * encode(c) + (1 - alpha) * encode(under[i]!))) as Rgb;
}

export type Theme = "dark" | "light";

/** A token's colour in a theme, following `var()` through both stylesheets. */
export function themeColours(): (mode: Theme, token: string) => Rgb {
  const brand = read("public/brand/notice.css");
  const theme = read("src/index.css");
  const blocks = {
    dark: { brand: block(brand, /:root\s*\{([^}]+)\}/), app: block(theme, /\n:root\s*\{([^}]+)\}/) },
    light: { brand: block(brand, /\.light,\s*:root\[data-theme="light"\]\s*\{([^}]+)\}/), app: block(theme, /\n\.light\s*\{([^}]+)\}/) },
  };
  return (mode, token) => {
    let value = blocks[mode].app.get(token) ?? blocks[mode].brand.get(token);
    for (let hops = 0; value?.startsWith("var("); hops += 1) {
      const next = value.match(/^var\((--[a-z-]+)\)$/)?.[1];
      if (!next || hops > 5) throw new Error(`${token} does not resolve`);
      value = blocks[mode].app.get(next) ?? blocks[mode].brand.get(next);
    }
    if (!value) throw new Error(`${mode}: no ${token}`);
    return linearRgb(value);
  };
}
