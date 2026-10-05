import { ClockAlert } from "lucide-react";
import type { CalendarUpcoming } from "@noticeos/contract";
import { type ConnectionReads } from "@shared/connection-status";
import type { CountdownConfig } from "@shared/dashboard";
import { ageMs, formatAge } from "@shared/freshness";
import type { AssetCard, SystemBand } from "@shared/wall";
import { compiledLiveSource, compiledSourceVersion } from "@shared/source-version";
import { compiledAppRelease } from "@shared/app-release";
import { BrandLockup } from "@/components/BrandLockup";
import {
  formatMeetingClock,
  formatMeetingDistance,
  isInProgress,
  meetingsPanelHasContent,
  meetingsView,
  type CalendarReadState,
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
): { title: string; when: string; dayPeriod: string | null; dayPeriodFirst: boolean; distance: string; inProgress: boolean } | "none-today" | null {
  if (!meetingsPanelHasContent(data)) return null;
  const { hero } = meetingsView(data, nowMs);
  if (!hero) return "none-today";
  const inProgress = isInProgress(hero, nowMs);
  const distance = formatMeetingDistance(hero, nowMs);
  const clock = stripClock(Date.parse(hero.startsAt));
  return {
    title: hero.title,
    when: formatMeetingClock(hero.startsAt, nowMs),
    dayPeriod: clock.dayPeriod,
    dayPeriodFirst: clock.dayPeriodFirst,
    distance: inProgress ? distance.replace(/^now · /u, "") : distance,
    inProgress,
  };
}

/** Keep the locale's clock text/order, shrinking only its day period. */
function meetingClockText(text: string, dayPeriod: string | null, dayPeriodFirst: boolean) {
  const at = dayPeriod === null ? -1 : text.indexOf(dayPeriod);
  if (at === -1 || dayPeriod === null) return text;
  const before = text.slice(0, at);
  const after = text.slice(at + dayPeriod.length);
  return <>
    {dayPeriodFirst ? before : before.trimEnd()}
    <span className={cn("text-wall-strip-label font-medium", dayPeriodFirst ? "mr-1.5" : "ml-1.5")} data-strip-meeting-period>{dayPeriod}</span>
    {dayPeriodFirst ? after.trimStart() : after}
  </>;
}

function meetingDistanceText(text: string) {
  return text.split(/([hm])\b/u).map((part, index) => part === "h" || part === "m"
    ? <span key={index} className="ml-1 text-wall-strip-label font-medium" data-strip-meeting-unit>{part.toUpperCase()}</span>
    : part);
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
  calendarState?: CalendarReadState;
  /** When the Wall's last poll failed, the time the values on screen were
   * read; null while polls succeed (docs/25 § TV rules: last-good values with
   * their age). */
  heldSince?: string | null;
  /** The Wall's shared one-second tick; the strip shows minutes. */
  nowMs: number;
}

export function WallStrip({ countdown, meetings, calendarState, heldSince = null, nowMs }: WallStripProps) {
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
  const liveSource = compiledLiveSource();
  const release = compiledAppRelease();
  const hasAgenda = meeting !== null || calendarState !== undefined || heldSince !== null;
  const versionDate = version ? new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(version.committedAt)) : null;
  const heldCaption = heldSince !== null ? (
    <span className="flex items-center gap-1.5 text-wall-strip-label text-muted-foreground tabular-nums" data-strip-held data-strip-meta>
      <ClockAlert className="size-4 shrink-0" aria-hidden />
      Refreshed {formatAge(ageMs(nowMs, heldSince))} ago · reconnecting
    </span>
  ) : null;
  const calendarCaption = calendarState ? (
    <span
      className={cn("flex items-center gap-1.5 text-wall-strip-label tabular-nums", calendarState === "failed" ? "text-error" : calendarState === "partial" ? "text-warn" : "text-muted-foreground")}
      data-strip-calendar-status={calendarState}
    >
      {calendarState !== "loading" ? <ClockAlert className="size-4 shrink-0" aria-hidden /> : null}
      {calendarState === "loading" ? "Loading events…"
        : calendarState === "partial" ? "Some calendars unavailable"
        : meeting !== null && meetings ? `Cached · ${formatAge(ageMs(nowMs, meetings.fetchedAt))} old · retrying`
        : "Retrying automatically"}
    </span>
  ) : null;
  return (
    <header
      data-wall-strip
      aria-label="Time, meetings and countdown"
      className="wall-strip grid min-w-0 rounded-xl bg-muted/40 px-3 py-4 tv:min-h-24 tv:px-6"
      data-strip-has-agenda={hasAgenda || undefined}
    >
      <a
        href={demoDocumentUrl("/")}
        aria-label="NoticeOS"
        title="Leave TV mode for the desk home."
        className="wall-strip-widget wall-strip-brand rounded text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        data-strip-home
      >
        <span className="wall-strip-brand-primary" data-strip-primary>
          <BrandLockup size="text" className="text-wall-strip-brand! leading-none!" />
        </span>
        <span
          className="wall-strip-version text-wall-strip-label font-normal text-muted-foreground tabular-nums"
          title={version ? `Commit ${version.commit} · ${version.committedAt}${version.modified ? " · local edits" : ""}` : "Source commit unavailable"}
          data-strip-version
          data-strip-meta
        >
          {liveSource ? <><span>DEV</span><span aria-hidden> · </span></> : null}
          {version ? <>
            <span className="font-mono">{version.commit.slice(0, 7)}{version.modified && liveSource ? "*" : null}</span>
            <span aria-hidden> · </span>
            <time dateTime={version.committedAt}>{versionDate}</time>
            {version.modified && !liveSource ? <span> · local edits</span> : null}
          </> : release ? `Build ${release.slice(0, 7)}` : "Version unavailable"}
        </span>
      </a>
      <div className="wall-strip-widget wall-strip-clock" data-strip-clock-group>
        <span className="wall-strip-divider border-border/60" aria-hidden data-strip-separator />
        <time
          dateTime={new Date(nowMs).toISOString()}
          className="whitespace-nowrap text-wall-strip-time font-medium tracking-tight tabular-nums"
          data-strip-time
          data-strip-primary
        >
          {clock.dayPeriodFirst ? dayPeriod : null}
          {clock.time}
          {clock.dayPeriodFirst ? null : dayPeriod}
        </time>
        <span className="whitespace-nowrap text-wall-strip-label text-muted-foreground tabular-nums" data-strip-date data-strip-meta>
          {stripDate(nowMs)}
        </span>
      </div>
      {hasAgenda ? <div className="wall-strip-widget wall-strip-agenda" data-strip-agenda>
        <span className="wall-strip-divider border-border/60" aria-hidden data-strip-separator />
        {meeting !== null ? (
          meeting === "none-today" ? (
            <span className="text-wall-strip-time font-medium text-muted-foreground" data-strip-meeting="none" data-strip-primary>{calendarState === "partial" ? "Calendar incomplete" : calendarState === "failed" ? "No cached meetings today" : "No meetings today"}</span>
          ) : (
            <div className="wall-strip-meeting" data-strip-meeting>
              <div className="wall-strip-meeting-primary min-w-0 text-wall-strip-time font-medium tracking-tight" data-strip-primary>
                <span className="whitespace-nowrap font-normal text-muted-foreground tabular-nums" data-strip-meeting-when>{meetingClockText(meeting.when, meeting.dayPeriod, meeting.dayPeriodFirst)}</span>
                <span className="min-w-0 truncate" title={meeting.title} data-strip-meeting-title>{meeting.title}</span>
                <span className="whitespace-nowrap font-normal text-muted-foreground tabular-nums" data-strip-meeting-distance>{meetingDistanceText(meeting.distance)}</span>
              </div>
              <div className="flex min-w-0 flex-wrap items-start gap-x-3" data-strip-meta>
                {heldSince === null && !calendarState ? <span className="text-wall-strip-label text-muted-foreground" data-strip-meeting-cue>{meeting.inProgress ? "Now" : "Up next"}</span> : null}
                {calendarCaption}
                {heldCaption}
              </div>
            </div>
          )
        ) : <span className={cn("text-wall-strip-time font-medium", calendarState === "failed" ? "text-error" : "text-muted-foreground")} role={calendarState === "failed" ? "alert" : undefined} data-strip-primary>{calendarState === "failed" ? "Calendar unavailable" : calendarState === "loading" ? "Calendar" : "Reconnecting"}</span>}
        {meeting === null || meeting === "none-today" ? <div className="flex min-w-0 flex-wrap gap-x-3" data-strip-meta>{calendarCaption}{heldCaption}</div> : null}
      </div> : null}
      {countdown && left !== null ? (
        <div
          className="wall-strip-widget wall-strip-countdown text-wall-strip"
          data-strip-countdown
          data-countdown-state={reached ? "reached" : "remaining"}
        >
          <span className="wall-strip-divider border-border/60" aria-hidden data-strip-separator />
          <span
            className={cn("row-start-2 whitespace-nowrap text-wall-strip-time font-medium tracking-tight tabular-nums", reached && "text-muted-foreground")}
            data-strip-countdown-days
            data-strip-primary
          >
            <span data-strip-countdown-value>{count}</span>{unit ? <span className="sr-only"> {unit}</span> : null}
          </span>
          {!reached ? <span className="col-start-2 row-start-2 whitespace-nowrap text-wall-strip-label text-muted-foreground" aria-hidden data-strip-countdown-unit data-strip-meta>{unit} remaining</span> : null}
          {emoji ? <span aria-hidden className="col-start-1 row-start-1 grid size-wall-strip-mark select-none place-items-center justify-self-center text-wall-strip-emoji" data-strip-countdown-emoji>{emoji}</span> : null}
          <span className="col-start-2 row-start-1 min-w-0 truncate font-medium" title={countdown.label} data-strip-countdown-label>{countdown.label}</span>
        </div>
      ) : null}
    </header>
  );
}
