// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkedDefault } from "../vite/checked-default";

// The pull, integrations and counters defaults the Tower compiles in as its
// Worker's fallback are judged at the build boundary by the declarations
// every Save is judged by. The shipped files themselves are
// scripts/config-registers.test.mjs's. Synthetic documents only.
describe("checkedDefault — the build boundary for a compiled default", () => {
  it("hands a well-formed document back unchanged", () => {
    const pull = [{ asset: "meals.example", url: "https://meals.example/m", enabled: true }];
    expect(checkedDefault("config/pull.json", pull)).toBe(pull);
    const counters = { assets: { "meals.example": { cards: [] } } };
    expect(checkedDefault("config/counters.json", counters)).toBe(counters);
  });

  it("fails naming the file and where, instead of compiling a malformed default in", () => {
    expect(() => checkedDefault("config/pull.json", { asset: "meals.example" })).toThrow(
      "config/pull.json: the document must be a JSON array",
    );
    expect(() => checkedDefault("config/counters.json", {})).toThrow("config/counters.json: /assets is missing");
    expect(() =>
      checkedDefault("config/integrations.json", { catalog: [{ id: "gsc" }], assets: {} }),
    ).toThrow("config/integrations.json: /catalog/0 — Label is required");
  });
});
