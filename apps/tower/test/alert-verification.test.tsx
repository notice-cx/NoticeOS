import { fireEvent, render, screen } from "./render";
import { describe, expect, it } from "vitest";
import { summarizeVerification, type SignalVerification } from "@shared/signal-liveness";
import { AlertVerification, alertVerificationLabel, VERIFICATION_REASON_LABEL } from "@/components/AlertVerification";
import { formatTimestamp } from "@/lib/format";

const NOW = Date.parse("2026-09-06T01:00:00.000Z");
const FIRST = "2026-08-04T04:00:00.000Z";
const confirmed: SignalVerification = {
  state: "confirmed", lastConfirmedAt: "2026-09-05T04:00:00.000Z",
  lastEvaluatedAt: "2026-09-05T04:05:00.000Z", source: "Site checks",
  reason: "source-confirms",
};

/** The value beside one labelled fact in the verification tooltip. */
function fact(tooltip: HTMLElement, label: string): string {
  const term = [...tooltip.querySelectorAll("dt")].find((dt) => dt.textContent === label);
  if (!term) throw new Error(`no "${label}" fact in the tooltip`);
  return term.nextElementSibling?.textContent ?? "";
}

describe("AlertVerification", () => {
  it("separates an old first detection from a recent confirmation and evaluation", () => {
    render(<AlertVerification verification={confirmed} firstDetectedAt={FIRST} nowMs={NOW} />);
    expect(screen.getByRole("button", { name: "Alert verification details" })).toHaveTextContent("Confirmed 21h ago");
    fireEvent.focus(screen.getByRole("button"));
    const detail = screen.getByRole("tooltip");
    expect(detail).toHaveTextContent(formatTimestamp(FIRST));
    expect(detail).toHaveTextContent(formatTimestamp(confirmed.lastConfirmedAt!));
    expect(detail).toHaveTextContent(formatTimestamp(confirmed.lastEvaluatedAt!));
    expect(fact(detail, "Checked by")).toBe("Site checks");
    expect(fact(detail, "Why")).toBe(VERIFICATION_REASON_LABEL[confirmed.reason]);
    expect(detail.querySelectorAll("time")).toHaveLength(3);
    expect([...detail.querySelectorAll("time")].map((time) => time.dateTime)).toEqual([FIRST, confirmed.lastConfirmedAt, confirmed.lastEvaluatedAt]);
    expect(detail).not.toHaveTextContent(FIRST);
  });

  it.each([null, "", "not a date", "2026-09-05", "2026-09-05T04:00:00", "2026-02-30T04:00:00Z", "2026-09-07T04:00:00Z"])(
    "does not claim confirmation from missing, malformed or future time %s", (lastConfirmedAt) => {
      const evidence = { ...confirmed, lastConfirmedAt };
      expect(alertVerificationLabel(evidence, NOW)).toBe("Last known");
      const { container } = render(<AlertVerification verification={evidence} firstDetectedAt={FIRST} nowMs={NOW} />);
      expect(screen.getByRole("button")).toHaveTextContent("Last known");
      expect(container.querySelector('[data-alert-verification="unverified"]')).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button"));
      expect(fact(screen.getByRole("tooltip"), "Last confirmed")).toBe("—");
      expect(fact(screen.getByRole("tooltip"), "Why")).toBe("Check timestamps unreadable");
    },
  );

  it("does not infer confirmation from an old open record or a fresh evaluation alone", () => {
    expect(alertVerificationLabel(undefined, NOW)).toBe("Last known");
    expect(alertVerificationLabel({ ...confirmed, state: "unverified" }, NOW)).toBe("Last known");
    render(<AlertVerification firstDetectedAt={FIRST} nowMs={NOW} />);
    fireEvent.click(screen.getByRole("button"));
    expect(fact(screen.getByRole("tooltip"), "Why")).toBe("No check recorded");
  });

  it.each([null, "", "not a date", "2026-09-05", "2026-09-05T04:05:00", "2026-02-30T04:05:00Z", "2026-09-07T04:05:00Z"])(
    "does not claim confirmation without a usable evaluation timestamp (%s)", (lastEvaluatedAt) => {
      const evidence = { ...confirmed, lastEvaluatedAt };
      expect(alertVerificationLabel(evidence, NOW)).toBe("Last known");
      const { container } = render(<AlertVerification verification={evidence} firstDetectedAt={FIRST} nowMs={NOW} />);
      expect(container.querySelector('[data-alert-verification="unverified"]')).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button"));
      expect(fact(screen.getByRole("tooltip"), "Last checked")).toBe("—");
      expect(fact(screen.getByRole("tooltip"), "Why")).toBe("Check timestamps unreadable");
    },
  );

  it("requires confirmation no later than evaluation, allowing the same instant", () => {
    const backwards = { ...confirmed, lastEvaluatedAt: "2026-09-05T03:59:00Z" };
    expect(alertVerificationLabel(backwards, NOW)).toBe("Last known");
    expect(alertVerificationLabel({ ...confirmed, lastEvaluatedAt: confirmed.lastConfirmedAt }, NOW)).toBe("Confirmed 21h ago");
    render(<AlertVerification verification={backwards} firstDetectedAt={FIRST} nowMs={NOW} interactive={false} />);
    expect(screen.getByText("Last known").closest("[data-alert-verification]")).toHaveAttribute("data-alert-verification", "unverified");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each([null, "not a date", "2026-02-30T04:05:00Z", "2026-09-07T04:05:00Z"])(
    "does not claim a condition is no longer reported without valid evaluation (%s)", (lastEvaluatedAt) => {
      const evidence: SignalVerification = { ...confirmed, state: "source-ended", lastConfirmedAt: null, lastEvaluatedAt };
      expect(alertVerificationLabel(evidence, NOW)).toBe("Last known");
      const { container } = render(<AlertVerification verification={evidence} firstDetectedAt={FIRST} nowMs={NOW} />);
      expect(screen.getByRole("button")).toHaveTextContent("Last known");
      expect(container.querySelector('[data-alert-verification="unverified"]')).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button"));
      expect(fact(screen.getByRole("tooltip"), "Why")).toBe("Check timestamps unreadable");
    },
  );

  it("accepts source-ended evidence with a valid evaluation and no prior confirmation", () => {
    expect(alertVerificationLabel({ ...confirmed, state: "source-ended", lastConfirmedAt: null }, NOW)).toBe("No longer reported");
    expect(alertVerificationLabel({ ...confirmed, state: "source-ended", lastEvaluatedAt: "2026-09-05T03:59:00Z" }, NOW)).toBe("Last known");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("fails closed when the display clock is not finite (%s)", (nowMs) => {
    expect(alertVerificationLabel(confirmed, nowMs)).toBe("Last known");
    render(<AlertVerification verification={confirmed} firstDetectedAt={FIRST} nowMs={nowMs} />);
    expect(screen.getByRole("button")).toHaveTextContent("Last known");
    fireEvent.click(screen.getByRole("button"));
    expect(fact(screen.getByRole("tooltip"), "Last confirmed")).toBe("—");
  });

  it.each([
    ["source-ended", "No longer reported"], ["recorded-closed", "Recorded closed"],
    ["not-applicable", "Not a live condition"], ["unverified", "Last known"],
  ] as const)("keeps %s distinct and neutral without adding passive controls", (state, label) => {
    const { container } = render(<button><AlertVerification verification={{ ...confirmed, state }}
      firstDetectedAt={FIRST} nowMs={NOW} interactive={false} /></button>);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button")).toHaveTextContent(label);
    const marker = container.querySelector("[data-alert-verification]")!;
    expect(marker).toHaveClass("text-muted-foreground");
    expect(marker).not.toHaveClass("text-xs");
    expect(marker).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("states recorded closure without claiming source recovery", () => {
    render(<AlertVerification verification={{ ...confirmed, state: "recorded-closed", reason: "recorded-closed" }} firstDetectedAt={FIRST} nowMs={NOW} />);
    fireEvent.click(screen.getByRole("button"));
    expect(fact(screen.getByRole("tooltip"), "Why")).toBe("Closed in the store; recovery not checked");
  });

  it("wears a glyph per state, so the state reads before the label does", () => {
    const { container } = render(<>
      <AlertVerification verification={confirmed} firstDetectedAt={FIRST} nowMs={NOW} interactive={false} />
      <AlertVerification verification={{ ...confirmed, state: "unverified" }} firstDetectedAt={FIRST} nowMs={NOW} interactive={false} />
    </>);
    const marks = [...container.querySelectorAll("[data-alert-verification]")];
    expect(marks.map((mark) => mark.getAttribute("data-alert-verification"))).toEqual(["confirmed", "unverified"]);
    for (const mark of marks) expect(mark.querySelector("svg")).not.toBeNull();
  });

  it("gives every read-model reason a label, never a sentence", () => {
    for (const label of Object.values(VERIFICATION_REASON_LABEL)) {
      expect(label.split(/\s+/).length).toBeLessThanOrEqual(8);
      expect(label).not.toMatch(/\.$/);
    }
  });

  it("honors explicit offsets and does not use first detection to calculate confirmation age", () => {
    expect(alertVerificationLabel({ ...confirmed, lastConfirmedAt: "2026-09-04T21:00:00-07:00" }, NOW)).toBe("Confirmed 21h ago");
  });

  it.each([
    ["lastConfirmedAt", "2026-09-07T04:00:00Z"],
    ["lastConfirmedAt", "2026-02-30T04:00:00Z"],
    ["lastConfirmedAt", "not a timestamp"],
    ["lastEvaluatedAt", "2026-09-07T04:00:00Z"],
  ] as const)("does not let a valid older group member hide unusable %s (%s)", (field, value) => {
    const group = summarizeVerification([confirmed, { ...confirmed, [field]: value }], NOW);
    expect(group.state).toBe("unverified");
    expect(group.lastConfirmedAt).toBeNull();
    expect(group.lastEvaluatedAt).toBeNull();
    render(<AlertVerification verification={group} firstDetectedAt={FIRST} nowMs={NOW} interactive={false} />);
    expect(screen.getByText("Last known")).toBeVisible();
    expect(group.reason).toBe("mixed-states");
    expect(screen.queryByText(/Confirmed/)).toBeNull();
  });
});
