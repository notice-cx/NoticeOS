import {
  Activity,
  ChartNoAxesCombined,
  Check,
  CircleDashed,
  CircleSlash2,
  Clock3,
  Database,
  Funnel,
  HeartPulse,
  Minus,
  MousePointerClick,
  Radar,
  ScanSearch,
  SearchCheck,
  type LucideIcon,
} from "lucide-react";
import { integrationFailureMessage } from "@noticeos/contract/integration-health";
import { connectionFacts, type SourceKind, type SourceReading } from "@shared/connection-status";
import { connectionTone, connectionWord } from "@/components/IntegrationStateChip";
import type { StateTone } from "@/components/StateChip";
import { cn } from "@/lib/utils";
import { InfoTooltip } from "@/components/InfoTooltip";

const SOURCE_ICONS: Record<string, LucideIcon> = {
  "nightly-report": Activity,
  gsc: SearchCheck,
  "bing-webmaster": Radar,
  ga4: ChartNoAxesCombined,
  clarity: MousePointerClick,
  posthog: Funnel,
  dataforseo: ScanSearch,
  uptime: HeartPulse,
};

/** The box a status's tone draws: the chip's tone (`connectionTone`), at the
 * border strength a 16px mark needs. */
const TONE_BOX: Record<StateTone, string> = {
  connected: "border-connected/50 bg-connected-soft text-connected",
  critical: "border-error/60 bg-error-soft text-error",
  caution: "border-warn/60 bg-warn-soft text-warn",
  neutral: "border-border bg-background text-foreground",
  declined: "border-info/40 bg-info/10 text-info",
  na: "border-border bg-muted/30 text-muted-foreground/80",
  affirmative: "border-border bg-muted/50 text-foreground",
};

/** Nothing proves these yet, so their box is dashed. */
const UNPROVEN: ReadonlySet<SourceKind> = new Set(["not-connected", "not-checked", "unknown"]);

type Mark = "check" | "bang" | "clock" | "pending" | "unknown" | "slash" | "bar";

/** The corner mark per status, so a status never depends on colour alone.
 * Not connected is the dashed box with no mark. */
const MARK: Record<SourceKind, Mark | null> = {
  working: "check",
  "key-accepted": "check",
  failing: "bang",
  overdue: "clock",
  collecting: "pending",
  "not-checked": "unknown",
  unknown: "unknown",
  "not-connected": null,
  "not-using": "slash",
  "not-applicable": "bar",
};

export interface DataSourceIconsProps {
  /** Each source as the status model reads it (`sourceReadings`). */
  sources: readonly SourceReading[];
  className?: string;
}

/** Supporting status evidence: a failing site's reason, the site's
 * facts, or the register's own sentence for a source no provider collects. */
function sourceFacts(source: SourceReading): string[] {
  const { site } = source;
  if (site) {
    return [
      source.kind === "failing" && site.failure ? integrationFailureMessage(site.failure) : null,
      ...connectionFacts(site).map((fact) => fact.label),
      site.lastSuccessAt ? `Last success: ${site.lastSuccessAt}` : null,
    ].filter((line): line is string => Boolean(line));
  }
  if (source.provider) return [];
  return [source.detail, source.observedAt ? `Observed: ${source.observedAt}` : null]
    .filter((line): line is string => Boolean(line));
}

/**
 * EACH SOURCE'S ONE STATUS, AS A ROW OF MARKS: the asset header and Home's
 * asset table (bead `ro-ujb9.96.7.16`). The status is the one the asset's Data
 * sources row and Integrations show — the same `laneStatus`, the same word in
 * the mark's name, the same tone as `IntegrationStateChip`. Colour is the first
 * signal; the corner mark (check, !, clock, dashed circle, ?, slash, bar, or a
 * dashed box) keeps it readable without colour. The Wall's TV-sized row of
 * these left with the pre-D28 Wall (bead `ro-trai.20`); a failing source is a
 * site's issue mark there.
 */
export function DataSourceIcons({ sources, className }: DataSourceIconsProps) {
  if (sources.length === 0) return null;
  /* One chassis for every corner mark, so a status can differ by GLYPH and
     never by geometry. */
  const stateMark = "absolute -right-0.5 -top-0.5 size-2 rounded-full bg-background";
  // A text mark takes its box's colour, so it sets only its size.
  const textMark = cn(stateMark, "grid place-items-center font-bold text-mark-degraded");
  return (
    <InfoTooltip label="About data source states" className={className} trigger={<span
      className="flex flex-nowrap items-center gap-px"
      aria-label="Data source integration states"
    >
      {sources.map((source) => {
        const Icon = SOURCE_ICONS[source.id] ?? Database;
        const word = connectionWord(source.kind, "key", source.id);
        const mark = MARK[source.kind];
        return (
          <span
            key={source.id}
            role="img"
            aria-label={`${source.label}: ${word}`}
            data-source={source.id}
            data-connection={source.kind}
            className={cn(
              "relative inline-flex size-4 items-center justify-center rounded border outline-none focus-visible:ring-2 focus-visible:ring-ring",
              TONE_BOX[connectionTone(source.kind)],
              UNPROVEN.has(source.kind) && "border-dashed",
            )}
          >
            <Icon className="size-2" aria-hidden />
            {mark === "check" ? (
              <Check data-state-mark="check" className={cn(stateMark, "stroke-[3]")} aria-hidden />
            ) : mark === "bang" ? (
              <span data-state-mark="bang" className={textMark} aria-hidden>!</span>
            ) : mark === "clock" ? (
              <Clock3 data-state-mark="clock" className={cn(stateMark, "stroke-[2.5]")} aria-hidden />
            ) : mark === "pending" ? (
              <CircleDashed data-state-mark="pending" className={cn(stateMark, "stroke-[2.5]")} aria-hidden />
            ) : mark === "unknown" ? (
              <span data-state-mark="unknown" className={textMark} aria-hidden>?</span>
            ) : mark === "slash" ? (
              <CircleSlash2 data-state-mark="slash" className={cn(stateMark, "stroke-[2.5]")} aria-hidden />
            ) : mark === "bar" ? (
              /* A DIFFERENT mark from Not using, not a fainter one (bead
                 `ro-kukv.9`): a slash is the switch somebody turned off; a bar
                 is the source that was never in play. */
              <Minus data-state-mark="bar" className={cn(stateMark, "stroke-[3]")} aria-hidden />
            ) : null}
          </span>
        );
      })}
    </span>}>
      {sources.map((source) => <div key={source.id} className="grid gap-1">
        <span className="font-medium">{source.label}: {connectionWord(source.kind, "key", source.id)}</span>
        {sourceFacts(source).map((fact) => <span key={fact}>{fact}</span>)}
      </div>)}
    </InfoTooltip>
  );
}
