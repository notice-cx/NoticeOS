import { performanceTone, type ChipTone } from "@/components/DeltaChip";

/** Wall traffic color shows the signed movement; comparison validity stays in the data. */
export function wallTrafficTone(percent: number | null | undefined): ChipTone {
  if (percent == null || !Number.isFinite(percent) || percent === 0) return "neutral";
  if (percent > 0) return "pace-on";
  switch (performanceTone(percent)) {
    case "negative-subtle": return "pace-behind";
    case "negative": return "wall-traffic-decline";
    case "negative-strong": return "pace-far-behind";
    default: return "neutral";
  }
}
