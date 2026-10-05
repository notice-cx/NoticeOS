// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installedLucideExports, lucideExportMap, lucideIcons, rewriteLucideImports } from "../vite/lucide-icons";

// The dev server serves each icon as its own module instead of the whole
// 4 MB icon set (bead ro-ujb9.83). See vite/lucide-icons.ts for why.

const towerRoot = path.resolve(import.meta.dirname, "..");
const table = installedLucideExports(towerRoot);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(?:ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("lucide icon imports on the dev server (bead ro-ujb9.83)", () => {
  it("reads the installed index into a table of every icon and helper", () => {
    expect(table).not.toBeNull();
    expect(table!.size).toBeGreaterThan(1000);
    expect(table!.get("Plus")).toEqual({ from: "lucide-react/dist/esm/icons/plus.mjs", imported: "default" });
    // Aliases resolve the way the index resolves them.
    expect(table!.get("AlertTriangle")).toEqual(table!.get("TriangleAlert"));
    expect(table!.get("createLucideIcon")).toEqual({
      from: "lucide-react/dist/esm/createLucideIcon.mjs",
      imported: "default",
    });
    expect(table!.get("LucideProvider")).toEqual({ from: "lucide-react/dist/esm/context.mjs", imported: "LucideProvider" });
  });

  it("points every entry at a module the package really ships", () => {
    const require = createRequire(path.join(towerRoot, "package.json"));
    const packageDir = path.dirname(require.resolve("lucide-react/package.json"));
    for (const { from } of new Set(table!.values())) {
      expect(existsSync(path.join(packageDir, from.slice("lucide-react/".length))), from).toBe(true);
    }
  });

  it("rewrites named imports one module each, keeping every line in place", () => {
    const code = [
      'import { useState } from "react";',
      "import {",
      "  Plus,",
      "  X as Close,",
      "  type LucideIcon,",
      "  LucideProvider,",
      '} from "lucide-react";',
      "export const a = 1;",
    ].join("\n");
    const out = rewriteLucideImports(code, table!)!;
    expect(out.split("\n")).toEqual([
      'import { useState } from "react";',
      'import Plus from "lucide-react/dist/esm/icons/plus.mjs"; import Close from "lucide-react/dist/esm/icons/x.mjs"; import { LucideProvider } from "lucide-react/dist/esm/context.mjs";',
      "",
      "",
      "",
      "",
      "",
      "export const a = 1;",
    ]);
  });

  it("keeps a name it does not know on the index import, and leaves other code alone", () => {
    const small = lucideExportMap("export { default as Plus } from './icons/plus.mjs';", "lucide-react/dist/esm");
    expect(rewriteLucideImports("import { Plus, Mystery } from 'lucide-react';", small)).toBe(
      "import Plus from 'lucide-react/dist/esm/icons/plus.mjs'; import { Mystery } from 'lucide-react';",
    );
    expect(rewriteLucideImports('import type { LucideIcon } from "lucide-react";', small)).toBeNull();
    expect(rewriteLucideImports('import { Plus } from "lucide-react-native";', small)).toBeNull();
  });

  it("leaves no import in the Tower's browser code on the 4 MB index", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(path.join(towerRoot, "src")), ...sourceFiles(path.join(towerRoot, "shared"))]) {
      const code = readFileSync(file, "utf8");
      if (!code.includes("lucide-react")) continue;
      const out = (rewriteLucideImports(code, table!) ?? code).replace(
        /import\s+type\s*\{[^}]*\}\s*from\s*["']lucide-react["']/g,
        "",
      );
      for (const line of out.split("\n")) {
        if (/["']lucide-react["']/.test(line)) offenders.push(`${path.relative(towerRoot, file)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("applies only while serving, only to the browser, and takes the package out of pre-bundling", () => {
    const plugin = lucideIcons(towerRoot);
    expect(plugin.apply).toBe("serve");
    const applies = plugin.applyToEnvironment as (environment: { name: string }) => boolean;
    expect(applies({ name: "client" })).toBe(true);
    expect(applies({ name: "tower" })).toBe(false);
    const config = plugin.config as () => unknown;
    expect(config()).toEqual({ optimizeDeps: { exclude: ["lucide-react"] } });
  });
});
