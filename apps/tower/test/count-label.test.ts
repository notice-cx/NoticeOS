import { expect, it } from "vitest";
import { boundedCount } from "@/lib/count-label";

it("distinguishes an unknown count, measured zero and known lower bounds", () => {
  expect(boundedCount(null, 0, false)).toBeNull();
  expect(boundedCount(null, null, true)).toBeNull();
  expect(boundedCount(0, 0, true)).toBe("0");
  expect(boundedCount(null, 0, true)).toBe("at least 0");
  expect(boundedCount(null, 12, true)).toBe("at least 12");
});
