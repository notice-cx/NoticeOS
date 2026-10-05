import { ClockAlert } from "lucide-react";
import type { CalendarUpcoming } from "@noticeos/contract";
import { type ConnectionReads } from "@shared/connection-status";
import type { CountdownConfig } from "@shared/dashboard";
import { ageMs, formatAge } from "@shared/freshness";
import type { AssetCard, SystemBand } from "@shared/wall";
import { compiledSourceVersion } from "@shared/source-version";
import { compiledAppRelease } from "@shared/app-release";
import { BrandLockup } from "@/components/BrandLockup";
import {
  formatMeetingClock,
  formatMeetingDistance,
  isInProgress,
  meetingsPanelHasContent,
  meetingsView,
} from "@/lib/meetings";
import { demoDocumentUrl } from "@/lib/demo-visit";
import { cn } from "@/lib/utils";

// One cohesive read-only header: local time/date, the next meeting and the
// operator's countdown. Specific problems belong in Needs you (ro-trai.49).

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** The strip's time, split so the day period can be drawn smaller than the
 * numerals. */
export interface StripClock {
  /** Plain numerals, no seconds: "1:06", or "13:06" in a 24-hour locale. */
  time: string;
  /** "PM" where the locale's own format has a day period; null where it has
   * none (a 24-hour locale). */
  dayPeriod: string | null;
  /** The locale writes the day period before the time ("오후 1:06"). */
  dayPeriodFirst: boolean;
}

/** The time in the locale's own format, no seconds (the operator's choice over
 * the seven-segment face); `locale` is the viewer's unless a test names one. */
export function stripClock(nowMs: number, locale?: string): StripClock {
  const parts = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).formatToParts(nowMs);
  const hour = parts.findIndex((part) => part.type === "hour");
  const minute = parts.findIndex((part) => part.type === "minute");
  if (hour === -1 || minute === -1) return { time: "", dayPeriod: null, dayPeriodFirst: false };
  const period = parts.findIndex((part) => part.type === "dayPeriod");
  return {
    time: parts
      .slice(Math.min(hour, minute), Math.max(hour, minute) + 1)
      .map((part) => part.value)
      .join(""),
    dayPeriod: period === -1 ? null : parts[period]!.value,
    dayPeriodFirst: period !== -1 && period < Math.min(hour, minute),
  };
}

/** "Tue, Sep 22" in the viewer's locale. */
export function stripDate(nowMs: number): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(nowMs);
}

/** The countdown as days: "12 days", then "5 hours" and "40 min" on the last
 * day, "Reached" once passed; null for a target nobody could read. */
export function stripCountdown(nowMs: number, targetAt: string): string | null {
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(targetMs)) return null;
  const left = targetMs - nowMs;
  if (left <= 0) return "Reached";
  const days = Math.floor(left / DAY_MS);
  if (days >= 1) return `${days} ${days === 1 ? "day" : "days"}`;
  const hours = Math.floor(left / HOUR_MS);
  if (hours >= 1) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `${Math.max(1, Math.floor(left / MINUTE_MS))} min`;
}

/**
 * The next meeting today, as the strip says it — or null when the calendar
 * could not be read at all, because a calendar nobody could read is not an
 * empty day (`meetingsPanelHasContent`). A readable day with nothing left
 * says so.
 */
export function stripMeeting(
  data: CalendarUpcoming | null | undefined,
  nowMs: number,
): { title: string; when: string; inProgress: boolean } | "none-today" | null {
  if (!meetingsPanelHasContent(data)) return null;
  const { hero } = meetingsView(data, nowMs);
  if (!hero) return "none-today";
  const inProgress = isInProgress(hero, nowMs);
  const distance = formatMeetingDistance(hero, nowMs);
  return {
    title: hero.title,
    when: inProgress ? distance : `${formatMeetingClock(hero.startsAt, nowMs)} · ${distance}`,
    inProgress,
  };
}

export interface WallStripProps {
  system: SystemBand;
  /** Retained for callers; source problems are shown in Needs you. */
  assets: readonly AssetCard[];
  /** The credential and monitoring reads every source status is read from. */
  connections?: ConnectionReads;
  /** From `/countdown`; absent, the strip has no countdown. */
  countdown?: CountdownConfig;
  /** The surface's own calendar poll. */
  meetings?: CalendarUpcoming | null;
  /** When the Wall's last poll failed, the time the values on screen were
   * read; null while polls succeed (docs/25 § TV rules: last-good values with
   * their age). */
  heldSince?: string | null;
  /** The Wall's shared one-second tick; the strip shows minutes. */
  nowMs: number;
}

export function WallStrip({ countdown, meetings, heldSince = null, nowMs }: WallStripProps) {
  const meeting = stripMeeting(meetings, nowMs);
  const left = countdown ? stripCountdown(nowMs, countdown.targetAt) : null;
  const [count, unit] = left?.split(" ") ?? [];
  const reached = left === "Reached";
  const clock = stripClock(nowMs);
  const dayPeriod = clock.dayPeriod ? (
    <span
      className={cn("text-wall-strip-label font-medium text-muted-foreground", clock.dayPeriodFirst ? "mr-1.5" : "ml-1.5")}
      data-strip-day-period
    >
      {clock.dayPeriod}
    </span>
  ) : null;
  const emoji = countdown?.emoji?.trim() ?? "";
  const version = compiledSourceVersion();
  const release = compiledAppRelease();
  const versionDate = version ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(version.committedAt)) : null;
  return (
    <header
      data-wall-strip
      aria-label="Time, meetings and countdown"
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-6 gap-y-5 rounded-xl bg-muted/40 px-5 py-4 text-wall-strip tv:flex tv:min-h-24 tv:gap-8 tv:px-6"
    >
      <div className="col-span-2 flex min-w-0 items-center gap-6 tv:shrink-0" data-strip-clock-group>
        <a
          href={demoDocumentUrl("/")}
          title="Leave TV mode for the desk home."
          className="shrink-0 whitespace-nowrap rounded text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_.brand-wordmark]:sr-only sm:[&_.brand-wordmark]:not-sr-only"
          data-strip-home
        >
          <BrandLockup size="text" className="text-wall-strip-countdown! leading-none!" />
          <span
            className="block text-wall-list-meta font-normal text-muted-foreground tabular-nums"
            title={version ? `Commit ${version.commit} · ${version.committedAt}${version.modified ? " · local edits" : ""}` : "Source commit unavailable"}
            data-strip-version
          >
            {version ? <>
              <span className="font-mono">{version.commit.slice(0, 7)}</span>
              <span> · <time dateTime={version.committedAt}>{versionDate}</time></span>
              {version.modified ? <span className="block sm:inline"><span className="hidden sm:inline"> · </span>local edits</span> : null}
            </> : release ? `Build ${release.slice(0, 7)}` : "Version unavailable"}
          </span>
        </a>
        <div className="flex min-w-0 flex-col border-l border-border/60 pl-6">
          <time
            dateTime={new Date(nowMs).toISOString()}
            className="whitespace-nowrap text-wall-strip-time font-medium tracking-tight tabular-nums"
            data-strip-time
          >
            {clock.dayPeriodFirst ? dayPeriod : null}
            {clock.time}
            {clock.dayPeriodFirst ? null : dayPeriod}
          </time>
          <span className="whitespace-nowrap text-wall-strip-label text-muted-foreground tabular-nums" data-strip-date>
            {stripDate(nowMs)}
          </span>
        </div>
      </div>
      <div className={cn("col-span-2 flex min-w-0 flex-col tv:flex-1", meeting === null && heldSince === null && "hidden tv:flex")} data-strip-agenda>
        {meeting !== null ? (
          meeting === "none-today" ? (
            <span className="text-wall-strip-label text-muted-foreground" data-strip-meeting="none">No meetings today</span>
          ) : (
            <div className="flex min-w-0 flex-col" data-strip-meeting>
              {heldSince === null ? <span className="text-wall-strip-label text-muted-foreground">{meeting.inProgress ? "Now" : "Up next"}</span> : null}
              <span className="truncate font-medium" title={meeting.title} data-strip-meeting-title>{meeting.title}</span>
              <span className="text-wall-strip-label text-muted-foreground tabular-nums" data-strip-meeting-when>{meeting.when}</span>
            </div>
          )
        ) : null}
        {heldSince !== null ? (
          <span className="flex items-center gap-1.5 text-wall-strip-label text-muted-foreground tabular-nums" data-strip-held>
            <ClockAlert className="size-4 shrink-0" aria-hidden />
            Refreshed {formatAge(ageMs(nowMs, heldSince))} ago · reconnecting
          </span>
        ) : null}
      </div>
      {countdown && left !== null ? (
        <div
          className="col-span-2 flex min-w-0 items-center gap-4 tv:max-w-sm tv:shrink-0"
          data-strip-countdown
          data-countdown-state={reached ? "reached" : "remaining"}
        >
          <span
            className={cn("grid min-w-16 shrink-0 place-items-center rounded-lg border border-border/60 bg-background/50 px-3 py-1.5 font-medium tracking-tight tabular-nums tv:h-16", reached ? "text-wall-strip text-muted-foreground" : "text-wall-strip-countdown")}
            data-strip-countdown-days
          >
            <span data-strip-countdown-value>{count}</span>{unit ? <span className="sr-only"> {unit}</span> : null}
          </span>
          <div className="flex min-w-0 flex-col">
            {!reached ? <span className="whitespace-nowrap text-wall-strip-label text-muted-foreground" aria-hidden data-strip-countdown-unit>{unit} remaining</span> : null}
            <div className="flex min-w-0 items-center gap-2">
              {emoji ? <span aria-hidden className="grid size-wall-strip-mark shrink-0 select-none place-items-center text-wall-strip-emoji" data-strip-countdown-emoji>{emoji}</span> : null}
              <span className="truncate font-medium" title={countdown.label} data-strip-countdown-label>{countdown.label}</span>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
