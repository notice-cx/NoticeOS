// One file per icon on the dev server, instead of every icon in one file
// (bead ro-ujb9.83).
//
// WHY. The Tower imports its icons by name from the `lucide-react` package index
// (`import { Plus } from "lucide-react"`), which re-exports all ~2,000 icons. A
// production build keeps only the icons a screen uses (the package declares
// `sideEffects: false`). The dev server — what `os:up` serves to the desk and the
// TV every day — cannot: Vite pre-bundles a dependency once, from its entry, so
// the index became ONE 4.3 MB file that every screen downloaded and parsed, for
// the few dozen icons that screen actually draws.
//
// WHAT. While Vite is serving, and only for the browser's code, each named
// import from the index is rewritten to the icon's own module, which the package
// ships beside the index:
//
//   import { Plus, X as Close } from "lucide-react";
//   → import Plus from "lucide-react/dist/esm/icons/plus.mjs"; import Close from "lucide-react/dist/esm/icons/x.mjs";
//
// and the package is taken out of pre-bundling, so each icon module is served
// as it is (a few hundred bytes, plus `createLucideIcon` shared by all of them).
// The name → file table is read from the installed index itself, so aliases
// (`AlertTriangle` → `triangle-alert.mjs`) resolve exactly as the index does.
//
// WHAT IT DOES NOT DO. It changes no source file and no production output
// (`apply: "serve"`); `vite build` and Vitest still import the index. A name
// the table does not know stays on the index import, which still works, just
// slowly; `test/lucide-icons.test.ts` fails if any import in `src/` would. If
// the index cannot be read, the plugin leaves both the imports and the
// pre-bundling alone, so the worst case is the old 4 MB file, never a broken
// page. The rewrite keeps every line where it was (the generated imports share
// the original's first line), so source maps below the imports are unchanged.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

const PACKAGE = "lucide-react";

/** Where a name exported by the package index really lives. */
export interface LucideExport {
  /** Deep import specifier, e.g. `lucide-react/dist/esm/icons/plus.mjs`. */
  from: string;
  /** `default` for an icon; the export's own name for the rest. */
  imported: string;
}

/** Reads the package index's `export { … } from "./…"` lines into a name → module table. */
export function lucideExportMap(indexSource: string, indexDir: string): Map<string, LucideExport> {
  const table = new Map<string, LucideExport>();
  for (const match of indexSource.matchAll(/export\s*\{([^}]*)\}\s*from\s*["'](\.\/[^"']+)["']/g)) {
    const from = path.posix.join(indexDir, match[2]!);
    for (const part of match[1]!.split(",")) {
      const [imported, exported = imported] = part.trim().split(/\s+as\s+/);
      if (imported && exported) table.set(exported, { from, imported });
    }
  }
  return table;
}

const NAMED_IMPORT = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*(["'])${PACKAGE}\2\s*;?`, "g");

/**
 * Rewrites `import { … } from "lucide-react"` into one import per module. Names
 * the table lacks stay on an index import. Returns null when nothing changed.
 */
export function rewriteLucideImports(code: string, table: ReadonlyMap<string, LucideExport>): string | null {
  let changed = false;
  const out = code.replace(NAMED_IMPORT, (statement, list: string, quote: string) => {
    const imports: string[] = [];
    const rest: string[] = [];
    for (const raw of list.split(",")) {
      const part = raw.trim();
      // `type X` names nothing at runtime; the package has no side effects.
      if (!part || part.startsWith("type ")) continue;
      const [name, local = name] = part.split(/\s+as\s+/);
      const target = name ? table.get(name) : undefined;
      if (!name || !local || !target) {
        rest.push(part);
        continue;
      }
      imports.push(
        target.imported === "default"
          ? `import ${local} from ${quote}${target.from}${quote};`
          : `import { ${target.imported === local ? local : `${target.imported} as ${local}`} } from ${quote}${target.from}${quote};`,
      );
    }
    if (rest.length) imports.push(`import { ${rest.join(", ")} } from ${quote}${PACKAGE}${quote};`);
    changed = true;
    // Same line count as the statement it replaces.
    return imports.join(" ") + "\n".repeat(statement.split("\n").length - 1);
  });
  return changed ? out : null;
}

/** The installed package's index, as a name → module table, or null if unreadable. */
export function installedLucideExports(fromDir: string): Map<string, LucideExport> | null {
  try {
    const require = createRequire(path.join(fromDir, "package.json"));
    const manifestPath = require.resolve(`${PACKAGE}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { module?: string };
    if (!manifest.module) return null;
    const indexFile = path.join(path.dirname(manifestPath), manifest.module);
    const indexDir = path.posix.join(PACKAGE, path.posix.dirname(manifest.module));
    const table = lucideExportMap(readFileSync(indexFile, "utf8"), indexDir);
    // Anything short of the full icon set means the index changed shape.
    return table.size > 1000 ? table : null;
  } catch {
    return null;
  }
}

export function lucideIcons(fromDir: string): Plugin {
  const table = installedLucideExports(fromDir);
  return {
    name: "noticeos:lucide-icons",
    apply: "serve",
    applyToEnvironment: (environment) => environment.name === "client",
    config: () => (table ? { optimizeDeps: { exclude: [PACKAGE] } } : undefined),
    transform: {
      filter: { id: { exclude: /[\\/]node_modules[\\/]/ }, code: PACKAGE },
      handler(code) {
        if (!table) return null;
        const rewritten = rewriteLucideImports(code, table);
        // `map: null`: every line stays where it was, so the existing map holds.
        return rewritten === null ? null : { code: rewritten, map: null };
      },
    },
  };
}
