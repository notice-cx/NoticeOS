import type { FileOp } from "@shared/changeset";
import { configRegister, duplicateIssue, rowIssue } from "@shared/config-registers";
import { PERIOD_PATTERN, type RecurringCost } from "@shared/financials";

const file = "config/recurring-costs.json";

/** Split a subscription's inclusive term without changing its booked price. */
export function recurringPriceOps(
  rows: readonly RecurringCost[],
  index: number,
  amount: string,
  firstMonth: string,
  successorId: string,
  bookedThrough: string,
): { ops: FileOp[]; undo: FileOp[] } {
  const original = rows[index];
  if (!original) throw new Error("The recurring cost is no longer available. Reload and try again.");
  if (!PERIOD_PATTERN.test(firstMonth) || !PERIOD_PATTERN.test(original.from) ||
      (original.to !== undefined && !PERIOD_PATTERN.test(original.to))) {
    throw new Error("First month must be a month, YYYY-MM.");
  }
  if (!PERIOD_PATTERN.test(bookedThrough) || firstMonth <= bookedThrough) {
    throw new Error("First month must follow the current month and every recorded ledger month.");
  }
  if (firstMonth <= original.from) throw new Error("First month must follow the original start month.");
  if (original.to !== undefined && firstMonth > original.to) {
    throw new Error("First month must be within the original term.");
  }
  if (amount.trim() === "" || !Number.isFinite(Number(amount)) || Number(amount) < 0) {
    throw new Error("USD / month must be a number of at least 0.");
  }
  const successor: RecurringCost = {
    ...original, id: successorId, amountUsdPerMonth: Number(amount), from: firstMonth,
  };
  const register = configRegister("recurring-costs");
  const issue = rowIssue(register, successor) ?? duplicateIssue(register, [...rows], successor);
  if (issue) throw new Error(issue.message);
  if (rows.some((row, at) => at !== index && row.asset === successor.asset &&
      row.family === successor.family && row.label === successor.label &&
      row.from <= (successor.to ?? "9999-12") && (row.to ?? "9999-12") >= successor.from)) {
    throw new Error("The new price overlaps another term for this recurring cost.");
  }
  const year = Number(firstMonth.slice(0, 4));
  const month = Number(firstMonth.slice(5));
  const preceding = month === 1
    ? `${String(year - 1).padStart(4, "0")}-12`
    : `${firstMonth.slice(0, 4)}-${String(month - 1).padStart(2, "0")}`;
  const ended = { ...original, to: preceding };
  const pointer = `/costs/${index}`;
  return {
    ops: [
      { kind: "file-json-set", file, pointer, expect: original, value: ended },
      { kind: "file-json-insert", file, pointer: "/costs/-", value: successor },
    ],
    undo: [
      { kind: "file-json-delete", file, pointer: `/costs/${rows.length}`, expect: successor },
      { kind: "file-json-set", file, pointer, expect: ended, value: original },
    ],
  };
}

export function recurringPriceId(id: string): string {
  return `${id.slice(0, 27).replace(/-+$/, "")}-${crypto.randomUUID()}`;
}
