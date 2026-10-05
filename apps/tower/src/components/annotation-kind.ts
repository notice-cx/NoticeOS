import {
  AlertTriangle,
  CalendarClock,
  Cpu,
  GitCommit,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import type { ComponentType } from "react";
import type { AnnotationKind } from "@shared/asset-detail";

/**
 * The glyph + word for each annotation kind — one concept, one glyph, one word
 * (doc 14), wherever an annotation is named: the asset page's `Timeline`, its
 * Activity tab and watch composer, and the alert surfaces' `ChangeChip`, which
 * must name a deploy exactly as the timeline it links to does.
 *
 * Its own module, and not an export of `Timeline.tsx`, since bead
 * `ro-ujb9.85`: `ChangeChip` rides the TV's alert rail, and importing one
 * constant from the desk timeline made `/wall` download the timeline and its
 * task badge (`HandoffBeadBadge`) with it. The journey "the TV downloads no desk
 * editing or task code" names both files so the path cannot quietly return.
 */
export const ANNOTATION_KIND: Record<
  AnnotationKind,
  { icon: ComponentType<{ className?: string }>; label: string }
> = {
  deploy: { icon: GitCommit, label: "Deploy" },
  "model-change": { icon: Cpu, label: "Model change" },
  config: { icon: SlidersHorizontal, label: "Config" },
  incident: { icon: AlertTriangle, label: "Incident" },
  "autonomy-change": { icon: ShieldCheck, label: "Autonomy change" },
  external: { icon: CalendarClock, label: "External" },
};
