import { CircleHelp } from "lucide-react";
import { StateChip, type StatusSubject } from "./StateChip";

/** Unknown prices accompany known spend without changing the budget's amount. */
export function UnknownPriceCount({ count, subject = "spend:portfolio" }: {
  count: number;
  subject?: StatusSubject;
}) {
  if (count === 0) return null;
  const label = `${count} unknown ${count === 1 ? 'price' : 'prices'}`;
  return <StateChip
    tone="neutral"
    subject={subject}
    glyph={<CircleHelp className="size-3" />}
    label={<><span aria-hidden>{count}</span><span className="sr-only">{label}</span></>}
    title={label}
    className="ms-1.5 tabular-nums"
  />;
}
