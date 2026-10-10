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
 * The glyph and word for each annotation kind, shared by the timeline and
 * `ChangeChip`. Its own module so the Wall's `ChangeChip` does not pull the
 * desk timeline into `/wall`'s bundle.
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
