import { CircleHelp, Database, Layers, LayoutTemplate, Lock, Pencil, TrendingUp, Wrench, Zap } from "lucide-react";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import type { JourneyTone } from "@/components/viz/ProjectJourneys";
import { useSiteIcons } from "@/hooks/useSiteIcons";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ProjectRecord, ProjectState } from "./project-model";

/** Each state's word, quoted exactly by the docs. */
export const PROJECT_STATE_WORDS: Readonly<Record<ProjectState, string>> = {
  "needs-you": "Needs you",
  urgent: "Urgent",
  blocked: "Blocked",
  "in-progress": "In progress",
  ready: "Ready",
  "not-started": "Not started",
  parked: "Parked",
  done: "Done",
};

/** The ink a state's line is written in: warn for what needs the operator or
 * is held, urgent for P0/P1, green only for work under way. */
export const PROJECT_STATE_TONE: Readonly<Record<ProjectState, JourneyTone>> = {
  "needs-you": "warn",
  urgent: "urgent",
  blocked: "warn",
  "in-progress": "healthy",
  ready: "foreground",
  "not-started": "muted",
  parked: "muted",
  done: "muted",
};

export const TONE_TEXT: Readonly<Record<JourneyTone, string>> = {
  warn: "text-warn",
  urgent: "text-urgent",
  healthy: "text-healthy",
  muted: "text-muted-foreground",
  foreground: "text-foreground",
};

/** "Needs you · 7d", "In progress · Ada": a state and the one fact that goes with it. */
export function projectStateLine(record: ProjectRecord): string {
  const word = PROJECT_STATE_WORDS[record.state];
  if (record.state === "needs-you" && record.agesDays !== null) return `${word} · ${formatInt(record.agesDays)}d`;
  if (record.state === "in-progress" && record.working?.who) return `${word} · ${record.working.who}`;
  return word;
}

/** The kind of change a project makes, as one glyph in a muted square. */
export function KindIcon({ record, className }: { record: Pick<ProjectRecord, "kind" | "bugHeavy">; className?: string }) {
  const Glyph = record.kind === "infra" || (record.kind === null && record.bugHeavy) ? Wrench
    : record.kind === "feature" ? TrendingUp
    : record.kind === "copy" ? Pencil
    : record.kind === "content-data" ? Database
    : record.kind === "template" ? LayoutTemplate
    : Layers;
  return (
    <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground", className)} data-project-kind={record.kind ?? (record.bugHeavy ? "bugs" : "unknown")}>
      <Glyph className="size-4" />
    </span>
  );
}

/** The state as a chip at a card's corner. */
export function ProjectStateChip({ record }: { record: ProjectRecord }) {
  const base = "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums";
  const label = projectStateLine({ ...record, working: null });
  switch (record.state) {
    case "needs-you": {
      const Glyph = record.ask?.verb === "approve" ? Lock : CircleHelp;
      return <span className={cn(base, "border-warn/30 bg-warn-soft text-warn")} data-project-chip={record.state}><Glyph aria-hidden className="size-3.5" />{label}</span>;
    }
    case "urgent":
      return <span className={cn(base, "border-urgent/30 bg-urgent/10 text-urgent")} data-project-chip={record.state}><Zap aria-hidden className="size-3.5" />{label}</span>;
    case "blocked":
      return <span className={cn(base, "border-warn/30 bg-warn-soft text-warn")} data-project-chip={record.state}>{label}</span>;
    case "in-progress":
      return <span className={cn(base, "border-border text-foreground")} data-project-chip={record.state}><span aria-hidden className="size-1.5 rounded-full bg-healthy" />{label}</span>;
    case "ready":
      return <span className={cn(base, "border-border text-foreground")} data-project-chip={record.state}>{label}</span>;
    default:
      return <span className={cn(base, "border-border bg-muted text-muted-foreground")} data-project-chip={record.state}>{label}</span>;
  }
}

/** A site's mark, from the icons the desk already read. */
export function SiteMark({ asset, name, className }: { asset: string; name: string; className?: string }) {
  const iconsOf = useSiteIcons();
  return <PropertyFavicon domain={asset} icons={iconsOf(asset)} displayName={name} className={className} />;
}
