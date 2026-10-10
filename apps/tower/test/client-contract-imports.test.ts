// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The browser never downloads zod. Two contract modules (`schema.ts`,
// `posthog.ts`) build zod schemas on load and the package index re-exports
// both, so browser code imports the contract's zod-free subpaths. This walks
// the real import graph from every file in `src/`, lazy routes included, and
// fails on the package index or `zod` by any path. `import type` is erased and
// skipped; `import { type X }` still loads the module under
// `verbatimModuleSyntax`.

const towerRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(towerRoot, "../..");
const contractSrc = path.join(repoRoot, "packages/contract/src");
const contractManifest = JSON.parse(readFileSync(path.join(repoRoot, "packages/contract/package.json"), "utf8")) as {
  exports: Record<string, string | { default: string }>;
};

const CODE = /\.(?:ts|tsx|mts|js|mjs)$/;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".mjs", ".js"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return CODE.test(name) && !name.endsWith(".d.ts") && !/\.test\./.test(name) ? [full] : [];
  });
}

function resolveFile(candidate: string): string | null {
  const tries = [candidate, ...EXTENSIONS.map((ext) => candidate + ext), ...EXTENSIONS.map((ext) => path.join(candidate, `index${ext}`))];
  // A TypeScript source importing `./x.js` means `./x.ts`.
  if (/\.js$/.test(candidate)) tries.push(candidate.replace(/\.js$/, ".ts"), candidate.replace(/\.js$/, ".tsx"));
  return tries.find((file) => existsSync(file) && statSync(file).isFile()) ?? null;
}

/** The contract file a `@noticeos/contract/<sub>` specifier loads, per the package's exports map. */
function contractSubpath(sub: string): string | null {
  const exact = contractManifest.exports[`./${sub}`];
  const pattern = contractManifest.exports["./*"];
  const target = exact ?? pattern;
  if (!target) return null;
  const file = typeof target === "string" ? target : target.default;
  return resolveFile(path.join(repoRoot, "packages/contract", exact ? file : file.replace("*", sub)));
}

type Edge = { kind: "file"; file: string } | { kind: "index" } | { kind: "zod" } | { kind: "external" };

function classify(specifier: string, from: string): Edge {
  const bare = specifier.split("?")[0]!;
  if (bare === "zod" || bare.startsWith("zod/")) return { kind: "zod" };
  if (bare === "@noticeos/contract") return { kind: "index" };
  if (bare.startsWith("@noticeos/contract/")) {
    const file = contractSubpath(bare.slice("@noticeos/contract/".length));
    if (!file) throw new Error(`${path.relative(repoRoot, from)}: ${specifier} is not in the contract's exports map`);
    return { kind: "file", file };
  }
  let base: string | null = null;
  if (bare.startsWith("@/")) base = path.join(towerRoot, "src", bare.slice(2));
  else if (bare.startsWith("@shared/")) base = path.join(towerRoot, "shared", bare.slice("@shared/".length));
  else if (bare.startsWith(".")) base = path.resolve(path.dirname(from), bare);
  if (base === null) return { kind: "external" };
  if (!CODE.test(base) && /\.[a-z]+$/i.test(base) && !/\.js$/.test(base)) return { kind: "external" }; // json, css, svg
  const file = resolveFile(base);
  if (!file) throw new Error(`${path.relative(repoRoot, from)}: cannot resolve ${specifier}`);
  return { kind: "file", file };
}

/** Every specifier a module loads at runtime (static, re-export and dynamic `import()`). */
function runtimeSpecifiers(file: string, text = readFileSync(file, "utf8")): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, kind);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * Walks the browser's module graph from `roots`. Returns every file reached and
 * each forbidden import as the chain of files that leads to it.
 */
function walkClientGraph(roots: string[]): { files: Set<string>; violations: string[] } {
  const parent = new Map<string, string | null>(roots.map((root) => [root, null]));
  const queue = [...roots];
  const violations: string[] = [];
  const chain = (file: string) => {
    const hops: string[] = [];
    for (let at: string | null | undefined = file; at; at = parent.get(at)) hops.unshift(path.relative(repoRoot, at));
    return hops.join(" → ");
  };
  while (queue.length) {
    const file = queue.shift()!;
    for (const specifier of runtimeSpecifiers(file)) {
      const edge = classify(specifier, file);
      if (edge.kind === "index") violations.push(`${chain(file)} imports the contract index "${specifier}"`);
      else if (edge.kind === "zod") violations.push(`${chain(file)} imports "${specifier}"`);
      else if (edge.kind === "file" && !parent.has(edge.file)) {
        parent.set(edge.file, file);
        queue.push(edge.file);
      }
    }
  }
  return { files: new Set(parent.keys()), violations };
}

/**
 * Every repo `config/*.json` the given modules import, as "importer → file".
 * A setting is saved in the store; a file compiled into the browser bundle is
 * the value of the last build, not the saved one, so browser code takes every
 * clock from the payload the Worker built on the saved value.
 */
function ownerConfigImports(files: Iterable<string>): string[] {
  const configDir = path.join(repoRoot, "config") + path.sep;
  return [...files].flatMap((file) =>
    runtimeSpecifiers(file)
      .map((specifier) => specifier.split("?")[0]!)
      .filter((specifier) => specifier.startsWith(".") && specifier.endsWith(".json"))
      .map((specifier) => path.resolve(path.dirname(file), specifier))
      .filter((target) => target.startsWith(configDir))
      .map((target) => `${path.relative(repoRoot, file)} → ${path.relative(repoRoot, target)}`),
  );
}

describe("browser code and the contract", () => {
  const roots = sourceFiles(path.join(towerRoot, "src"));
  const graph = walkClientGraph(roots);

  it("never imports the contract index or reaches zod", () => {
    expect(graph.violations).toEqual([]);
  });

  it("never loads a repo config file, so no day is read on a compiled clock", () => {
    expect(ownerConfigImports(graph.files)).toEqual([]);
    // The check can see the one module that does compile the clock in.
    expect(ownerConfigImports(walkClientGraph([path.join(contractSrc, "os-time-zone.ts")]).files)).toEqual([
      "packages/contract/src/os-time-zone.ts → config/constants.json",
    ]);
    expect([...graph.files].map((file) => path.relative(repoRoot, file))).toContain(
      "packages/contract/src/time-zone-setting.ts",
    );
  });

  it("really walks into shared code and the contract's modules", () => {
    const reached = [...graph.files].map((file) => path.relative(repoRoot, file));
    expect(roots.length).toBeGreaterThan(100);
    expect(reached).toContain("apps/tower/src/lib/api.ts");
    expect(reached).toContain("apps/tower/shared/watch-windows.ts");
    expect(reached).toContain("packages/contract/src/create-watch-window.ts");
    expect(reached).toContain("packages/contract/src/configuration.mjs");
    expect(reached).not.toContain("packages/contract/src/schema.ts");
    expect(reached).not.toContain("packages/contract/src/posthog.ts");
  });

  it("catches a zod-building module reached through a subpath", () => {
    for (const module of ["schema.ts", "posthog.ts"]) {
      const { violations } = walkClientGraph([path.join(contractSrc, module)]);
      expect(violations).toEqual([`packages/contract/src/${module} imports "zod"`]);
    }
    const index = walkClientGraph([path.join(contractSrc, "index.ts")]);
    expect(index.violations.some((line) => line.endsWith('imports "zod"'))).toBe(true);
  });

  it("counts an inline-type import as loading the module, and skips only `import type`", () => {
    const file = path.join(towerRoot, "src/probe.tsx");
    const text = [
      'import type { RuleBacktest } from "@noticeos/contract";',
      'export type { WatchSeries } from "@noticeos/contract";',
      'import { type Ga4RealtimePayload } from "@noticeos/contract";',
      'export { WATCH_SERIES } from "@noticeos/contract/create-watch-window";',
      'const lazy = () => import("zod");',
    ].join("\n");
    expect(runtimeSpecifiers(file, text)).toEqual([
      "@noticeos/contract",
      "@noticeos/contract/create-watch-window",
      "zod",
    ]);
    expect(classify("@noticeos/contract", file)).toEqual({ kind: "index" });
    expect(classify("@noticeos/contract/create-watch-window", path.join(towerRoot, "src/x.ts"))).toEqual({
      kind: "file",
      file: path.join(contractSrc, "create-watch-window.ts"),
    });
    expect(classify("@noticeos/contract/configuration", path.join(towerRoot, "src/x.ts"))).toEqual({
      kind: "file",
      file: path.join(contractSrc, "configuration.mjs"),
    });
  });
});
