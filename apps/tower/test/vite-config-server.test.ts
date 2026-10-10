// @vitest-environment node
//
// The dev server settings the Tower's own vite.config.ts returns, loaded the
// way Vite loads it. Its installation folders point at an empty temp dir.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PRODUCT_ENV } from "../../../scripts/product-env.mjs";

const towerRoot = path.dirname(fileURLToPath(new URL("../vite.config.ts", import.meta.url)));
let home: string;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "tower-vite-config-"));
  vi.stubEnv(PRODUCT_ENV.home.name, home);
  vi.stubEnv(PRODUCT_ENV.installationDir.name, path.join(home, "installation"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

async function serverSettings(immutable: string | undefined) {
  vi.stubEnv("NOTICEOS_IMMUTABLE_APP", immutable);
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "test" },
    path.join(towerRoot, "vite.config.ts"),
    towerRoot,
    "silent",
  );
  return loaded?.config.server;
}

describe("the Tower's dev server", () => {
  it("never paints Vite's error overlay, and keeps hot reload for editable source", async () => {
    const server = await serverSettings(undefined);
    expect(server?.hmr).toEqual({ overlay: false });
    expect(server?.ws).toBeUndefined();
  }, 60_000);

  it("runs an immutable app with no hot reload and no reconnect socket", async () => {
    const server = await serverSettings("1");
    expect(server?.hmr).toBe(false);
    expect(server?.ws).toBe(false);
  }, 60_000);
});
