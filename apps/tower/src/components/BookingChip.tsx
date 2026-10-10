import type { BookingState } from "@shared/asset-detail";
import { StateChip, type StatusSubject } from "@/components/StateChip";

/** The store's booking state ('reconciled'/'estimated') to the chip's word
 * ('booked'/'forecast'): one translation, so rows and rollups over the same
 * rows wear the same chip. */
export function bookingChipState(state: BookingState): "booked" | "forecast" {
  return state === "reconciled" ? "booked" : "forecast";
}

/**
 * Which side of the ledger's booked/forecast split a figure came from. Two
 * encodings, fill and tone, so the split survives a glance, a grayscale TV and
 * colour-blind vision.
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
