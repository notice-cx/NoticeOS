// @vitest-environment node
// The Tower suite never reads the checkout's own config/: this proves the
// node:fs refusal is live here (scripts/test-config-isolation.test.mjs tests the
// guard itself). The import refusal cannot be shown from a passing test, since
// a literal `import("../../../config/…")` fails the file's transform.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const OWNER_CONSTANTS = new URL("../../../config/constants.json", import.meta.url);
const REFUSED = /apps\/tower\/test\/owner-config-guard\.test\.ts reads the checkout's config\/constants\.json\. Unit tests run on fixture configuration/;

describe("a test reading the checkout's config with node:fs", () => {
  it("is refused with node:fs, sync or not, before the file is touched", async () => {
    expect(() => readFileSync(OWNER_CONSTANTS, "utf8")).toThrow(REFUSED);
    await expect(readFile(OWNER_CONSTANTS, "utf8")).rejects.toThrow(REFUSED);
  });

  it("still reads its own fixture copy", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixture-config/constants.json", import.meta.url), "utf8")) as { os_time_zone?: unknown };
    expect(typeof fixture.os_time_zone).toBe("string");
  });
});
