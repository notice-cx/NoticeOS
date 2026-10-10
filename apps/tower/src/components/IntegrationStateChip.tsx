import type { ReactNode } from "react";
import { Check, CircleDashed, CircleHelp, Clock3, TriangleAlert } from "lucide-react";
import type { AcceptedAs } from "@noticeos/contract/integrations";
import {
  connectionFacts,
  connectionLabel,
  type ConnectionKind,
  type ConnectionStatus,
  type SiteStatus,
  type SourceKind,
} from "@shared/connection-status";
import type { IntegrationHealthState } from "@shared/integrations";
import { StateChip, type StateChipProps, type StateTone, type StatusSubject } from "@/components/StateChip";
import { cn } from "@/lib/utils";

/** A register cell's recorded state, read in the connection vocabulary. */
const FROM_REGISTER: Record<IntegrationHealthState, ConnectionKind | "not-applicable"> = {
  live: "working",
  unverified: "not-checked",
  degraded: "failing",
  "needs-setup": "not-connected",
  skipped: "not-using",
  "not-applicable": "not-applicable",
};

/** Tone and glyph per status: connectivity green only with proof, severity for
 * a failure or a late result, neutral gray for everything not yet proven. */
const LOOK: Record<SourceKind, { tone: StateChipProps["tone"]; glyph?: ReactNode; dot?: "hollow" }> = {
  working: { tone: "connected", glyph: <Check className="size-3" /> },
  "key-accepted": { tone: "connected", glyph: <Check className="size-3" /> },
  failing: { tone: "critical", glyph: <TriangleAlert className="size-3" /> },
  overdue: { tone: "caution", glyph: <Clock3 className="size-3" /> },
  collecting: { tone: "neutral", glyph: <CircleDashed className="size-3" /> },
  "not-checked": { tone: "na", glyph: <CircleDashed className="size-3" /> },
  unknown: { tone: "na", glyph: <CircleHelp className="size-3" /> },
  "not-connected": { tone: "na", dot: "hollow" },
  "not-using": { tone: "declined", dot: "hollow" },
  "not-applicable": { tone: "na", dot: "hollow" },
};

/** The tone a status wears on every renderer: this chip and the compact source
 * marks (`DataSourceIcons`) take it from here, so they cannot drift apart. */
export function connectionTone(kind: SourceKind): StateTone {
  return LOOK[kind].tone;
}

/** The one word a status reads as, on the chip and in a source mark's name.
 * `lane` names the data source, so uptime reads Up or Down. */
export function connectionWord(kind: SourceKind, accepted: AcceptedAs = "key", lane: string | null = null): string {
  return kind === "not-applicable" ? "Doesn't apply" : connectionLabel(kind, accepted, lane);
}

export interface IntegrationStateChipProps {
  /** A connection status (`@shared/connection-status`), or a register cell's
   * recorded state, which is read in the same vocabulary. */
  state: ConnectionKind | IntegrationHealthState;
  /** What an accepted connection was given (`acceptedAs`): a key, a
   * sign-in or an address — Key accepted, Signed in, URL accepted. */
  accepted?: AcceptedAs;
  /** Appends "· N" — a count of subjects in this state. */
  count?: number;
  /** What this status is about (`StatusSubject`): the connection
   * (`integration:<provider>`), one site's collection
   * (`site:<provider>:<site>`) or a site's data source. */
  subject: StatusSubject;
  /** The data source this is the status of, when it has words of its own
   * (uptime: Up or Down). */
  lane?: string;
  className?: string;
}

/**
 * The one renderer of a connection's status, so a status never reads
 * differently on two screens. The glyph carries the meaning with the word.
 */
export function IntegrationStateChip({ state, accepted = "key", count, subject, lane, className }: IntegrationStateChipProps) {
  const kind = state in FROM_REGISTER ? FROM_REGISTER[state as IntegrationHealthState] : (state as ConnectionKind);
  const look = LOOK[kind];
  const word = connectionWord(kind, accepted, lane ?? null);
  return (
    <span className="inline-flex" data-status-for={subject} data-connection={kind}>
      <StateChip
        tone={look.tone}
        glyph={look.glyph}
        dot={look.dot}
        label={count === undefined ? word : `${word} · ${count}`}
        subject={subject}
        className={className}
      />
    </span>
  );
}

/** The compact facts beside a status — sites failing, reports missing or
 * incomplete — each once, as a chip, never a sentence. */
export function ConnectionFacts({
  status,
  subject,
  className,
}: {
  status: ConnectionStatus | SiteStatus;
  /** The subject the facts are about: the one the status chip beside them names. */
  subject: StatusSubject;
  className?: string;
}) {
  const facts = connectionFacts(status);
  if (facts.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)} data-status-for={subject}>
      {facts.map((fact) => (
        <span key={fact.key} className="inline-flex" data-fact={fact.key}>
          <StateChip tone={fact.tone === "neutral" ? "na" : fact.tone} label={<span className="tabular-nums">{fact.label}</span>} subject={subject} />
        </span>
      ))}
    </span>
  );
}
