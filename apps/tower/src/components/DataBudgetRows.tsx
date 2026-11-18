import type { MeteredBudgetAvailability } from "@noticeos/contract";
import { formatUsd } from "@/lib/format";

export function DataBudgetRows({ budget }: { budget: MeteredBudgetAvailability }) {
  return <>
    <dt className="text-muted-foreground">Held pending price</dt>
    <dd className="text-end tabular-nums">{formatUsd(budget.heldUsd, { fractionalCents: true })}</dd>
    <dt className="text-muted-foreground">Available</dt>
    <dd className="text-end tabular-nums">{formatUsd(budget.availableUsd, { fractionalCents: true })}</dd>
  </>;
}
