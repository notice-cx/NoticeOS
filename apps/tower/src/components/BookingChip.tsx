import type { BookingState } from "@shared/asset-detail";
import { StateChip, type StatusSubject } from "@/components/StateChip";

/** The STORE's word for a row's booking state → the chip's.
 *
 * A raw ledger row carries `booking_state` verbatim ('reconciled'/'estimated'),
 * while every figure derived from those rows is named for the side it lands on
 * ('booked'/'forecast'). One translation, here, next to the chip both of them
 * end up wearing — so a table of rows and a rollup over the same rows cannot
 * drift into two visual languages (bead `ro-jk7`). */
export function bookingChipState(state: BookingState): "booked" | "forecast" {
  return state === "reconciled" ? "booked" : "forecast";
}

/**
 * Which side of the ledger's honesty split a figure came from.
 *
 * Booked and forecast never share a number, so they never share a chip either:
 * booked is a solid dot on the plain affirmative tone, forecast a hollow notch
 * on muted. Two encodings (fill and tone) so the split survives a glance, a
 * grayscale TV, and colorblind vision — doc 14, state is never color-only.
 *
 * It lives here, not inside a band, because the portfolio headline, every
 * asset card, and the asset page's P&L all state the same fact (beads
 * `ro-uwo.2`, `ro-jk7`): one component means those surfaces cannot drift into
 * three visual languages for one distinction — which is exactly what had
 * happened, the page having grown its own lowercase-word Badge saying
 * "reconciled"/"estimated" while the Wall had already moved to the pair below.
 */
export function BookingChip({
  state,
  subject,
  className,
}: {
  state: "booked" | "forecast";
  /** The money this is the booking state of: a ledger row, `ledger:<id>`. */
  subject: StatusSubject;
  className?: string;
}) {
  return state === "booked" ? (
    <StateChip
      label="Reconciled"
      tone="affirmative"
      subject={subject}
      className={className}
      title="Money somebody confirmed. This is the only figure the headline states."
    />
  ) : (
    <StateChip
      label="Forecast"
      tone="na"
      dot="hollow"
      subject={subject}
      className={className}
      title="Reported, not reconciled. Never added to the booked total."
    />
  );
}
