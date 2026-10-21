// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildChangeset } from "@shared/changeset";
import type { FileOp } from "@shared/changeset";
import type { RecurringCost } from "@shared/financials";
import { recurringPriceId, recurringPriceOps as buildPriceOps } from "@/lib/recurring-price";
import { applyDocumentOps, resolveOps, validateSchemaAndSafety } from "../../../scripts/config-documents.mjs";

const recurringPriceOps = (rows: RecurringCost[], index: number, amount: string, month: string, id: string) =>
  buildPriceOps(rows, index, amount, month, id, "2026-08");

const original: RecurringCost = {
  id: "hosting", label: "Hosting", asset: "example.com", family: "infra",
  amountUsdPerMonth: 12, from: "2026-06", note: "Shared plan",
};
const file = "config/recurring-costs.json";

async function apply(rows: RecurringCost[], ops: FileOp[]) {
  const cs = buildChangeset(ops, { slug: "new-price" });
  validateSchemaAndSafety(cs);
  const doc = { costs: structuredClone(rows) };
  const result = await resolveOps(cs, null, {
    readDocument: async (name: string) => name === file ? doc : { assets: [] },
  });
  if (result.mismatches.length) throw new Error("stale guards");
  applyDocumentOps(result.resolved, result.documents);
  return doc.costs;
}

describe("recurring price changes", () => {
  it("splits inclusive months across a year boundary and reverses the entire change", async () => {
    const rows = [{ ...original, to: "2027-06" }];
    const { ops, undo } = recurringPriceOps(rows, 0, "18.75", "2027-01", "hosting-new");
    expect(ops).toHaveLength(2);
    const changed = await apply(rows, ops);
    expect(changed).toEqual([
      { ...rows[0], to: "2026-12" },
      { ...rows[0], id: "hosting-new", amountUsdPerMonth: 18.75, from: "2027-01" },
    ]);
    expect(await apply(changed, undo)).toEqual(rows);
    expect(rows[0]!.amountUsdPerMonth).toBe(12);
  });

  it("keeps an open term open and restores the absence of its end month", async () => {
    const { ops, undo } = recurringPriceOps([original], 0, "0", "2026-09", "hosting-free");
    const changed = await apply([original], ops);
    expect(changed[1]).not.toHaveProperty("to");
    expect(await apply(changed, undo)).toEqual([original]);
  });

  it.each(["", "2026-00", "2026-13", "2026-9", "2026-09-01", "nope"])("rejects invalid first month %s", (month) => {
    expect(() => recurringPriceOps([original], 0, "15", month, "new-price")).toThrow(/month/);
  });
  it.each(["", " ", "-1", "Infinity", "NaN"])("rejects invalid amount %s", (amount) => {
    expect(() => recurringPriceOps([original], 0, amount, "2026-09", "new-price")).toThrow(/USD/);
  });
  it("rejects empty, reversed and out-of-term intervals", () => {
    for (const month of ["2026-05", "2026-06", "2026-10"]) {
      expect(() => recurringPriceOps([{ ...original, to: "2026-09" }], 0, "15", month, "new-price")).toThrow();
    }
    expect(() => recurringPriceOps([], 0, "15", "2026-09", "new-price")).toThrow(/no longer/);
    expect(() => recurringPriceOps([{ ...original, from: "2026-13" }], 0, "15", "2027-01", "new-price")).toThrow();
  });
  it("rejects current, historical and already recorded future ledger months", () => {
    for (const month of ["2026-07", "2026-08", "2026-09"]) {
      expect(() => buildPriceOps([original], 0, "15", month, "new-price", "2026-09")).toThrow(/recorded ledger month/);
    }
    expect(() => buildPriceOps([original], 0, "15", "2026-11", "new-price", "2026-11")).toThrow();
  });
  it("rejects conflicting ids and overlapping successors, but allows adjacent terms", () => {
    const next = { ...original, id: "next", from: "2027-01" };
    const rows = [{ ...original, to: "2026-12" }, next];
    expect(() => recurringPriceOps(rows, 0, "15", "2026-09", "next")).toThrow(/already/);
    expect(() => recurringPriceOps([original, next], 0, "15", "2026-09", "new-price")).toThrow(/overlaps/);
    expect(() => recurringPriceOps(rows, 0, "15", "2026-09", "new-price")).not.toThrow();
  });
  it("mints distinct valid ids even for a maximum-length original id", () => {
    const ids = Array.from({ length: 50 }, () => recurringPriceId("a".repeat(64)));
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(64);
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
  it("refuses stale originals before persisting either operation", async () => {
    const { ops } = recurringPriceOps([original], 0, "15", "2026-09", "new-price");
    await expect(apply([{ ...original, note: "Edited elsewhere" }], ops)).rejects.toThrow(/stale/);
    const rows = [original, { ...original, id: "new-price" }];
    expect(() => recurringPriceOps(rows, 0, "15", "2026-09", "new-price")).toThrow(/already/);
    expect(rows[0]).not.toHaveProperty("to");
  });
  it.each([0, 1])("refuses the entire Undo if row %i moved", async (index) => {
    const { ops, undo } = recurringPriceOps([original], 0, "15", "2026-09", "new-price");
    const changed = await apply([original], ops);
    changed[index] = { ...changed[index]!, note: "Edited elsewhere" };
    await expect(apply(changed, undo)).rejects.toThrow(/stale/);
    expect(changed).toHaveLength(2);
    expect(changed[0]!.to).toBe("2026-08");
  });
});
