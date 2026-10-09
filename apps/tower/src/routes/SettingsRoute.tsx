import {
  Ban,
  Boxes,
  CalendarPlus,
  Check,
  CircleDashed,
  Globe,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Lock,
  Pencil,
  SlidersHorizontal,
  Timer,
  TriangleAlert,
  Tv,
  Users,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { BACKTESTABLE_RULE_IDS } from "@noticeos/contract/rule-backtest";
import { ruleLabel } from "@shared/alert-rules";
import type { EditableFile, JsonValue, SettingOp } from "@shared/changeset";
import type { KnobFact, PortfolioKnob } from "@shared/asset-detail";
import { configKnob, knobSetOp, type RegisterField } from "@shared/config-registers";
import type { CountdownConfig, DashboardRefusal } from "@shared/dashboard";
import { revenueCalendarDate } from "@shared/daily-revenue";
import { entityAssets, entityOfAsset, type EntityRow } from "@shared/entities";
import { shiftRevenueDate } from "@shared/revenue-projection";
import type {
  KnobValueSetting,
  SettingsPayload,
  TaskHubConnection,
  TaskHubSpoke,
} from "@shared/settings";
import { localTimezone, settingsCollections } from "@shared/scheduled-jobs";
import { driftingTaskDatabases, taskServerFailure } from "@shared/task-map";
import type { AssetCard } from "@shared/wall";
import { CollectionEditor, type DerivedColumn } from "@/components/CollectionEditor";
import { CountdownEditor, CountdownWidget } from "@/components/DashboardWidgets";
import { KnobEditor, type KnobControl } from "@/components/KnobEditor";
import { InfoTooltip } from "@/components/InfoTooltip";
import { KnobRow } from "@/components/KnobRow";
import { Meter } from "@/components/Meter";
import { PageHeader } from "@/components/PageHeader";
import { ReadFailed } from "@/components/ReadFailed";
import { SavesPaused } from "@/components/SavesPaused";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { SeverityDot } from "@/components/SeverityDot";
import {
  RulePreview,
  backtestableKnobs,
  useRulePreview,
} from "@/components/RuleTune";
import { StateChip } from "@/components/StateChip";
import { CommandBlock, NO_HUB_CONNECTION, TaskProjectSteps, TaskSourceSection, taskProjectInitCommand } from "@/components/TaskSourceSection";
import { TuneRate } from "@/components/TuneRate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { pillClass, pillControlClass, pillPickerStateClass } from "@/components/ui/pill";
import { useAlertRuleStats } from "@/hooks/useAlertRuleStats";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { useIntegrations } from "@/hooks/useIntegrations";
import { useNow } from "@/hooks/useNow";
import { useSettings } from "@/hooks/useSettings";
import { useWall } from "@/hooks/useWall";
import { useWork } from "@/hooks/useWork";
import { ScheduleRows } from "@/routes/workflows/ScheduleEditor";
import { cn } from "@/lib/utils";
import { useBrowserContext } from "@/lib/browser-context";
import { MembersSection } from "@/routes/settings/MembersSection";
import {
  formatCalendarDate,
  formatPeriodMonth,
  formatPeriodMonthYear,
  formatUsd,
  formatZoneName,
} from "@/lib/format";
import {
  FLAG_DEFAULT_VALIDATOR,
  validateRegisterField,
  validateUsd,
  type Validated,
} from "@/lib/knob-validators";

/**
 * /settings — every portfolio-wide knob on one page (bead `ro-pbzu.2`).
 *
 * WHY IT EXISTS. Until now an operator (or a stranger) looking for "where do I
 * configure this" had nowhere to go. The countdown editor sat on the dashboard;
 * the spend caps, the operator rate and the alert-rule defaults were repeated on
 * every asset page under "Applies to every asset", so editing the data cap
 * from one asset's page read as editing that asset; and the rest — the counters
 * cadence, the pull registry, the source catalog, the task-hub spoke map — was
 * rendered nowhere at all and lived only as files somebody had to know about.
 *
 * A FEW FOCUSED FORMS, GENERAL FIRST (bead `ro-ujb9.18`; prior art:
 * Vercel's and Plausible's General,
 * Stripe's grouping by what a setting applies to, Linear's sections that
 * appear only for the people they concern). **General** holds the two things a
 * new installation sets — the clock the OS reads in and what it may spend —
 * so the page no longer opens on one select. Then when it shouts, how it
 * collects, the TV in the other room, who owns what (bead `ro-aodz`) and,
 * where core work is tracked (D32). Each has
 * an anchor id, and the old ones still land: `#clock` and `#budget` open
 * General at their row. A left section list on `lg` doubles as the outline.
 *
 * NOTHING CONFIGURED IS NOT AN EMPTY CARD. `config/tower.json`'s countdown is
 * optional (bead `ro-py40`), so a fresh install shows no countdown on the
 * television. Home never renders a countdown. The TV dashboard section offers
 * the way to make one: **Set a countdown**, opening the same editor the configured card
 * shows (bead `ro-fqag`). Before that the section could edit three fields it
 * could never create, and the only path to a first countdown was hand-editing
 * the file — the terminal step D18 retired everywhere else.
 *
 * EDITABLE VS READ-ONLY IS NOT A DESIGN CHOICE — it is what the configuration
 * store's guarded write allows (D22). `config/constants.json` and `config/tower.json` are on its
 * safety allowlist, so the countdown, the caps and the rules are ordinary
 * fields with a Save and an Undo toast. The task-hub project map is a declared
 * REGISTER (bead `ro-x5gu.5`), which licenses rows being added, edited and
 * removed at its own container and nothing else in its file — so it is a table
 * with the same Save and Undo, plus the one thing a file cannot do: saying what
 * is still left to do outside it.
 *
 * TWO MORE SECTIONS STOPPED BEING READ-ONLY ON 2026-09-05 (bead `ro-x5gu.6`),
 * and for the same reason: the lane learned to license them. **Data
 * collection**'s cadence numbers are DECLARED KNOBS (`ro-x5gu.8`) — one exact
 * pointer each, in files that are otherwise still unreachable — so each is a
 * `KnobEditor` row with the declaration's own rule, and what changing it COSTS
 * is the visual beside it (cost per pass, fit inside the window), because a
 * cadence an operator can move without being told the price is a trap rather
 * than a setting. What stays read-only is the pull registry — an endpoint is
 * edited on its own asset's page, where the rest of that asset's wiring is.
 *
 * THE DATA-SOURCE CATALOG LEFT (bead `ro-ujb9.96.14`). It was an editable
 * ten-column table with an Add, but every field ships with the code — a row
 * only works if a collector for its id exists — so a newcomer met the OS's
 * internals and an Add that could never collect. The sources a person sets up
 * are connected on Integrations and set per site on its Data sources tab.
 *
 * EVERY QUANTITY CARRIES ITS VISUAL (doc 14, 2026-09-04). A cap has its meter
 * of month-to-date spend, the alert sensitivity has its position on the
 * conventional scale, the low-volume window has its share of a week, the
 * cadence has a clock, a pull lane has its state chip and a spoke has its
 * asset's favicon. A settings page that is only labels and inputs is not
 * finished.
 *
 * AND NOTHING ON IT NEEDS A PARAGRAPH (bead `ro-ujb9.96.6.3`, doc 14 principle
 * 3a). Every field is a label, a
 * label-length unit or effect line, its control, and its state beside it; a save
 * is confirmed where it was made ("Saved · Undo", `KnobEditor`);
 * a problem leads with what happened and ends in buttons.
 */
export function SettingsRoute() {
  const { runtime, workspaceRole } = useBrowserContext();
  const managesMembers = runtime.owner.mode === 'hosted' && workspaceRole === 'owner';
  const { data, isError, error, isFetching, refetch } = useSettings();
  // The countdown counts down in minutes; a slower clock would leave a stale
  // figure sitting under the editor that changes it.
  const now = useNow(1_000);
  const { hash } = useLocation();
  const requestedSection = sectionOf(hash);
  const section = requestedSection === 'members' && !managesMembers ? 'general' : requestedSection;
  // The old address of the job schedules. A collection's schedule is edited in
  // Data collection now (bead `ro-ujb9.96.7.12`), so that is where it lands.
  if (hash === '#scheduled-jobs') return <Navigate to="/settings#data-collection" replace />;
  // The old address of the data-source catalog. The catalog ships with the
  // product and is not a setting (bead `ro-ujb9.96.14`); the sources a person
  // does set up are connected on Integrations.
  if (hash === '#data-sources') return <Navigate to="/integrations" replace />;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Settings" />
      {/* WHEN SAVES ARE PAUSED THE PAGE SAYS SO ONCE (bead `ro-p8qq`): every
          editor below shows only its lock (`statesReadOnly={false}`). */}
      <SavesPaused />

      {section === 'members' && managesMembers ? <div className="lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:items-start lg:gap-6">
        <SettingsSectionNav section={section} managesMembers={managesMembers} /><MembersSection />
      </div> : !data ? (
        // A failed first read is the desk's one failure state (bead
        // `ro-ujb9.242`), never a sentence of this page's own.
        isError ? (
          <ReadFailed title="Couldn't load settings" subject="read:settings" error={error} retrying={isFetching} onRetry={() => void refetch()} />
        ) : (
          <div className="grid min-h-[40vh] place-items-center text-sm text-muted-foreground">Loading…</div>
        )
      ) : (
        <div className="lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:items-start lg:gap-6">
          <SettingsSectionNav section={section} managesMembers={managesMembers} />
          <div className="flex min-w-0 flex-col gap-4">
            {section === "general" && <GeneralSection settings={data} nowMs={now} anchor={hash.slice(1)} />}
            {section === "tv-dashboard" && (
              <TvDashboardSection
                countdown={data.dashboard.countdown}
                refused={data.dashboard.refused?.countdown ?? null}
                nowMs={now}
              />
            )}
            {section === "alert-rules" && <AlertRulesSection settings={data} />}
            {section === "data-collection" && <CollectionSection settings={data} />}
            {section === "entities" && <EntitiesSection settings={data} />}
            {section === "task-hub" && <TaskHubSection settings={data} />}
          </div>
        </div>
      )}
    </div>
  );
}

// --- the page's outline ----------------------------------------------------
/** Section id → the word in the navigator. The order IS the DOM order, so the
 * list reads as the page's outline rather than as a menu of somewhere else. */
const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "alert-rules", label: "Alert rules", icon: ListChecks },
  { id: "data-collection", label: "Data collection", icon: Timer },
  { id: "tv-dashboard", label: "TV dashboard", icon: Tv },
  { id: "entities", label: "Ownership", icon: Landmark },
  { id: "task-hub", label: "Task projects", icon: Boxes },
  { id: "members", label: "Members", icon: Users },
] as const;

const SECTION_IDS: ReadonlySet<string> = new Set(SECTIONS.map((s) => s.id));

/** Addresses that are rows of a section now rather than sections of their
 * own (bead `ro-ujb9.18`): the clock and the budget are General's rows, and a
 * link to either (Integrations' DataForSEO card links `#budget`) lands there. */
const SECTION_ALIASES: Readonly<Record<string, string>> = { clock: "general", budget: "general" };

/** Which section a hash opens: its own, the one it is a row of, else General. */
function sectionOf(hash: string): string {
  const id = hash.slice(1);
  return SECTION_IDS.has(id) ? id : (SECTION_ALIASES[id] ?? "general");
}

/**
 * The outline names what the page actually renders, and a navigator entry
 * pointing at an anchor that is not there is worse than one fewer line.
 *
 * Every section is rendered today. The one exception used to be TV dashboard
 * (bead `ro-py40`: a config with no countdown got no card), and it stopped being
 * one when that section gained the layout editor's door — every install has a
 * television whether or not it counts down to anything.
 */
function SettingsSectionNav({
  section,
  managesMembers,
}: {
  section: string;
  managesMembers: boolean;
  /** Task projects is listed only once it concerns this installation (D32). */
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="mb-4 flex gap-1 overflow-x-auto pb-1 lg:sticky lg:top-4 lg:mb-0 lg:flex-col"
    >
      {SECTIONS.filter(item => item.id !== 'members' || managesMembers).map(({ id, label, icon: Icon }) => (
        <Link
          key={id}
          to={`#${id}`}
          aria-current={section === id ? "page" : undefined}
          className={cn("inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", section === id ? "bg-muted font-medium text-foreground" : "text-muted-foreground")}
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * One section: an anchor the navigator and an external link can both reach, a
 * title, and — only where the scope is not obvious from the fields — one chip or
 * link beside it.
 *
 * NO DESCRIPTION LINE AND NO HELP TOOLTIP (bead `ro-ujb9.96.6.3`, doc 14
 * principle 3a). Every section used to open with a sentence or an "About"
 * paragraph saying what it held; the fields below said the same thing, and the
 * one fact they added — alert rules judge every site — is an `aside` chip now.
 */
function Section({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  // The navigator beside the card already names the one section shown
  // (D44: not a repeat), so the title is the card's accessible name only.
  return (
    <Card id={id} className="scroll-mt-4" aria-labelledby={`${id}-title`} role="region">
      <h2 id={`${id}-title`} className="sr-only">{title}</h2>
      {aside ? (
        <CardHeader className="flex-row flex-wrap items-center justify-end gap-3 pb-0">
          <div className="flex shrink-0 items-center gap-2">{aside}</div>
        </CardHeader>
      ) : null}
      <CardContent className={aside ? undefined : "pt-4"}>
        {children}
      </CardContent>
    </Card>
  );
}

/** A field and the visual that makes its value legible, side by side. The field
 * keeps its own layout; the visual is a fixed column beside it so three fields
 * in a section line their meters up rather than each finding its own width. */
function FieldWithVisual({
  id,
  children,
  visual,
}: {
  /** An anchor a link can land on (`#clock`, `#budget`). */
  id?: string;
  children: ReactNode;
  visual?: ReactNode;
}) {
  return (
    <div id={id} className="flex scroll-mt-4 flex-col gap-2 border-b border-border py-3 last:border-0 sm:flex-row sm:items-start sm:gap-6">
      <div className="min-w-0 flex-1">{children}</div>
      {visual ? <div className="shrink-0 sm:w-56">{visual}</div> : null}
    </div>
  );
}

/** The op a file-owned knob writes: the file, the exact pointer, and the value
 * the field was rendered from as the concurrency guard. */
function fileOp(file: EditableFile, pointer: string, expect: JsonValue) {
  return (value: JsonValue): SettingOp => ({
    kind: "file-json-set",
    file,
    pointer,
    expect,
    value,
  });
}

// --- 1. General -----------------------------------------------------------
/**
 * WHAT A NEW INSTALLATION SETS, ON THE PAGE SETTINGS OPENS ON (bead
 * `ro-ujb9.18`): the clock the OS reads in, and what it may spend. They were
 * two sections of their own — a first screen of one select, and a press on
 * "Budget" before the data cap could be typed — and they are three rows of one
 * form now, the way Vercel's and Plausible's General pages hold the settings
 * everything else rests on. `#clock` and `#budget` still land on their rows.
 */
function GeneralSection({
  settings,
  nowMs,
  anchor,
}: {
  settings: SettingsPayload;
  nowMs: number;
  /** The hash the page was opened at: a row's old address scrolls to it. */
  anchor: string;
}) {
  useEffect(() => {
    if (anchor !== "clock" && anchor !== "budget") return;
    // Optional-called: jsdom has no layout to scroll.
    document.getElementById(anchor)?.scrollIntoView?.({ block: "start" });
  }, [anchor]);
  return (
    <Section id="general" title="General">
      <ClockField settings={settings} nowMs={nowMs} />
      <BudgetFields settings={settings} />
    </Section>
  );
}

/**
 * The one zone the whole OS reads in (bead `ro-py40`). It used to be a string
 * literal in `packages/contract`, which meant an operator in another timezone
 * edited TypeScript; it is now `config/constants.json` `os_time_zone`, and that
 * file is on the write lane's allowlist (D18), so this is an ordinary field.
 *
 * IT CARRIES ITS VISUAL (doc 14, 2026-09-04): a zone name is not legible on its
 * own — two neighbouring zone names look equally plausible
 * until you see what time it currently is in each. The field's visual is the
 * clock the setting produces, which is the only check that answers "is this the
 * zone I meant".
 *
 * AND IT SHOWS WHAT THE ZONE DECIDES (beads `ro-ujb9.88`, `ro-ujb9.96.6.3`):
 * not only the time, but which date is yesterday's revenue and which month is
 * the current one, since a save moves both at once. Those used to be a
 * 32-word tooltip; they are values now, and they move as the zone does — the
 * Stripe start-of-day pattern.
 *
 * PICK TO SAVE, UNDO BESIDE IT: a zone is one low-risk choice, so choosing it is the
 * save and "Saved · Undo" appears next to the picker.
 *
 * THIS DEVICE'S ZONE LEADS THE LIST (bead `ro-ujb9.18`): the zone a person
 * most likely means is the one their browser runs in, so it is the first
 * option, named as such, rather than one of four hundred to scroll to. Home's
 * first-run proposal (`ClockProposal`) offers the same zone in one press.
 */
function ClockField({
  settings,
  nowMs,
}: {
  settings: SettingsPayload;
  nowMs: number;
}) {
  const { clock } = settings;
  const [previewZone, setPreviewZone] = useState<string | null>(null);
  return (
    <FieldWithVisual id="clock" visual={<ZonePreview timeZone={previewZone ?? clock.timeZone} nowMs={nowMs} />}>
      <KnobEditor
        statesReadOnly={false}
        className="border-0 py-0"
        label="Time zone"
        current={clock.timeZone}
        onDraft={(value) => setPreviewZone(typeof value === "string" ? value : null)}
        format={(v) => String(v)}
        slug="os-time-zone"
        makeOp={fileOp("config/constants.json", "/os_time_zone", clock.timeZone)}
        autosave
        control={{ type: "select", options: zoneOptions(clock.timeZone, localTimezone()) }}
      />
    </FieldWithVisual>
  );
}

/** Every zone the runtime knows, sorted, with this device's own zone first and
 * named as such — unless it is the one already saved, which the field shows. */
function zoneOptions(saved: string, device: string | null): { value: string; label: string }[] {
  const all = [...new Set([saved, "UTC", ...Intl.supportedValuesOf("timeZone")])].sort();
  const options = all.map((zone) => ({ value: zone, label: formatZoneName(zone) }));
  if (!device || device === saved || !all.includes(device)) return options;
  return [
    { value: device, label: `${formatZoneName(device)} · this device` },
    ...options.filter((option) => option.value !== device),
  ];
}

/** The date `nowMs` falls on in `timeZone` (YYYY-MM-DD), the same reading the
 * revenue days use — or null for a zone the runtime cannot resolve. */
function zoneDate(nowMs: number, timeZone: string): string | null {
  try {
    return revenueCalendarDate(new Date(nowMs), timeZone);
  } catch {
    return null;
  }
}

/**
 * What the zone decides, as values: the time there now, the date that counts as
 * yesterday's revenue, and the current month (Home, the TV and Financials).
 *
 * A zone the runtime cannot resolve is shown as a critical chip and the values
 * in UTC, which is what the charts would fall back to — the field's validator
 * refuses to save such a zone, so this is a belt for a file edited by hand.
 */
function ZonePreview({ timeZone, nowMs }: { timeZone: string; nowMs: number }) {
  const known = zoneDate(nowMs, timeZone) !== null;
  const zone = known ? timeZone : "UTC";
  const today = zoneDate(nowMs, zone) ?? "";
  const time = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    weekday: "short",
  }).format(nowMs);
  // Intl names UTC "GMT"; the chip and the option both say UTC, so this does.
  const short =
    zone === "UTC"
      ? "UTC"
      : (new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortGeneric" })
          .formatToParts(nowMs)
          .find((part) => part.type === "timeZoneName")?.value ?? zone);
  const rows: [string, string][] = [
    ["Now", `${time} ${short}`],
    ["Yesterday's revenue", formatCalendarDate(shiftRevenueDate(today, -1))],
    ["Current month", formatPeriodMonthYear(today.slice(0, 7))],
  ];
  return (
    <div className="flex flex-col gap-1.5" data-zone-clock={known ? timeZone : "unresolved"}>
      {known ? null : <StateChip tone="critical" label="Unknown zone · UTC used" subject="field:portfolio:Time zone" className="self-start" />}
      <dl className="m-0 flex flex-col gap-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="m-0 shrink-0 tabular-nums text-foreground" data-zone-value={label}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// --- 4. TV dashboard -------------------------------------------------------
/**
 * The television, from the desk.
 *
 * TWO THINGS LIVE HERE and they are different sizes. The LAYOUT — which widgets
 * the TV shows, in what rows, how wide — is arranged on its own page
 * (`/wall/edit`, bead `ro-lzmq.2`), because rearranging a television needs the
 * television on screen and a settings card cannot hold one; this section is
 * where the operator goes looking for it. The COUNTDOWN is three fields and
 * belongs right here, where it has always been.
 *
 * The section now renders whether or not a countdown is configured, which is a
 * change from bead `ro-py40`: that rule said a fresh install gets no empty card
 * for an event nobody declared, and it still holds for the countdown itself —
 * but every install has a TV layout, so the section always has a subject.
 */
function TvDashboardSection({
  countdown,
  refused,
  nowMs,
}: {
  countdown?: CountdownConfig;
  /** A saved countdown the Tower refused (bead `ro-trai.45`). */
  refused: DashboardRefusal | null;
  nowMs: number;
}) {
  return (
    <Section id="tv-dashboard" title="TV dashboard">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <span className="text-sm font-medium text-foreground">TV layout</span>
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link to="/wall/edit">
              <LayoutDashboard className="size-4" />
              Edit layout
            </Link>
          </Button>
        </div>
        {countdown ? (
          <CountdownWidget config={countdown} nowMs={nowMs} interactive statesReadOnly={false} />
        ) : refused ? (
          // Saved, and refused: not "No countdown set" — the store holds one,
          // and the form saves over it (bead `ro-trai.45`).
          <div className="flex flex-col gap-2" data-settings-countdown-refused>
            <span className="self-start">
              <StateChip
                label="Saved countdown refused"
                tone="critical"
                glyph={<TriangleAlert className="size-3" aria-hidden />}
                title={refused.reason}
                subject="wall:countdown"
              />
            </span>
            <CountdownEditor refused={refused} nowMs={nowMs} statesReadOnly={false} />
          </div>
        ) : (
          <NoCountdown nowMs={nowMs} />
        )}
      </div>
    </Section>
  );
}

/**
 * No countdown yet — and the way to make the first one (bead `ro-fqag`).
 *
 * WHY THERE IS A BUTTON RATHER THAN A FORM. A countdown is optional (bead
 * `ro-py40`) and most installs have none: an open three-field form in a section
 * about the television would be a permanent ask about a feature nobody chose.
 * The sentence says what is true, the button says what can be done about it, and
 * the form is the same `CountdownEditor` the configured card shows — never a
 * second one, which is the whole reason that component is exported.
 *
 * Until today this said "it is one entry in config/tower.json under countdown",
 * which was accurate and was also a terminal step: `/settings` could edit the
 * three fields and never create them, so the only path to a first countdown was
 * hand-editing the file. That is what D18 retired everywhere else.
 */
function NoCountdown({ nowMs }: { nowMs: number }) {
  const [open, setOpen] = useState(false);
  const { writable } = useConfigWritable();

  return (
    <div className="flex flex-col gap-2" data-settings-no-countdown>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-xs leading-snug text-muted-foreground">
          No countdown set.
        </p>
        {open ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={!writable}
            onClick={() => setOpen(true)}
          >
            <CalendarPlus className="size-4" />
            Set a countdown
          </Button>
        )}
      </div>
      {open ? <CountdownEditor nowMs={nowMs} statesReadOnly={false} /> : null}
    </div>
  );
}

// --- the budget, General's money rows ----------------------------------------
function BudgetFields({ settings }: { settings: SettingsPayload }) {
  const { data: matrix } = useIntegrations();
  const spend = matrix?.dataSpend ?? null;
  const { budget } = settings;

  return (
    <div id="budget" className="scroll-mt-4">
      {budget.knobs.map((knob) => (
        <FieldWithVisual key={knob.key} visual={budgetVisual(knob, spend)}>
          {/* Label, unit and effect in one line, the control, and the state
              beside it — no help tooltip (bead `ro-ujb9.96.6.3`). */}
          <KnobEditor
            statesReadOnly={false}
            className="border-0 py-0"
            label={knob.label}
            explain={knob.unit === "usd_per_min" ? "USD per minute · prices review time in ROI" : "USD per month · all sites"}
            current={knob.value}
            format={(v) => formatKnobValue(v, knob.unit)}
            makeOp={fileOp("config/constants.json", knob.pointer, knob.value)}
            control={{
              type: "number",
              validate: validateUsd,
              step: knob.unit === "usd_per_min" ? "0.5" : "1",
            }}
          />
        </FieldWithVisual>
      ))}
    </div>
  );
}

/** What the eye reads beside each budget field. A cap is a ceiling, so it gets
 * the meter of what has been spent against it; a rate is not a ceiling, so it
 * gets the hourly figure the per-minute number hides instead of a bar with no
 * maximum to draw.
 *
 * EVERY CAP HERE HAS A METER, which is now true because the one that could not
 * have one is gone: the monthly inference cap was withdrawn on 2026-09-05 (D6,
 * bead `ro-uj7x`) rather than keep drawing an empty bar labelled *not
 * instrumented*. The OS makes no model calls of its own, so there was nothing
 * to meter — and a ceiling this page cannot back is worse than no row. */
function budgetVisual(
  knob: PortfolioKnob,
  spend: { period: string; spentUsd: number; unknownPrices: number } | null,
) {
  if (knob.key === "monthly_caps.data_usd") {
    return <DataSpendMeter cap={knob.value} spend={spend} />;
  }
  if (knob.key === "operator_rate_usd_per_min") {
    return (
      <div className="flex items-baseline justify-between gap-2 text-xs" data-budget-rate>
        <span className="text-muted-foreground">Per hour</span>
        <span className="shrink-0 tabular-nums text-foreground">{formatUsd(knob.value * 60)}</span>
      </div>
    );
  }
  return undefined;
}

function DataSpendMeter({
  cap,
  spend,
}: {
  cap: number;
  spend: { period: string; spentUsd: number; unknownPrices: number } | null;
}) {
  return (
    <div data-budget-meter="data">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          {spend ? `Spent in ${formatPeriodMonth(spend.period)}` : "Spent this month"}
        </span>
        <span className="shrink-0 tabular-nums text-foreground">
          {/* Never a fabricated zero: a spend nobody has read yet is unread, not
              nothing (doc 14 "a request failure is unavailable, never zero"). */}
          {spend ? `${formatUsd(spend.spentUsd, { cents: true })} of ${formatUsd(cap)}` : "not read yet"}
          {spend ? <UnknownPriceCount count={spend.unknownPrices} /> : null}
        </span>
      </div>
      <Meter
        className="mt-1.5"
        value={spend?.spentUsd ?? 0}
        max={cap}
        ariaLabel="Metered data spend this month against the monthly cap"
      />
      {/* What happens at the cap, as a state beside the meter rather than a
          sentence under it (bead `ro-ujb9.18`; Vercel's spend amount beside
          its Pause action). */}
      <div className="mt-1.5 flex items-center gap-1">
        <StateChip tone="neutral" label="Stops at the budget" glyph={<Ban className="size-3" />} subject="budget:portfolio" className="font-normal" />
        <InfoTooltip label="How data spend is counted">Includes scheduled DataForSEO collection and one-off research bought on the same account.</InfoTooltip>
      </div>
    </div>
  );
}

function formatKnobValue(v: JsonValue, unit: PortfolioKnob["unit"]): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (unit === "usd") return formatUsd(n);
  if (unit === "usd_per_min") return `${formatUsd(n)}/min`;
  return String(n);
}

// --- 2. Alert rules --------------------------------------------------------
/** The conventional significance ceiling. Alpha above it is a deliberately
 * loose rule that will fire often — which is exactly what the meter's over-cap
 * amber is for. */
const ALPHA_CONVENTIONAL_CEILING = 0.05;
/** One week of history, the scale a "how much prior history" window is read
 * against. */
const HOURS_IN_A_WEEK = 168;

function AlertRulesSection({ settings }: { settings: SettingsPayload }) {
  const { alertRules } = settings;
  const { data: wall } = useWall();
  const assets = replayableAssets(wall?.assets ?? []);

  // What the operator is currently looking at, per setting — the value the
  // preview must be a picture of. `null` while a field holds something the
  // detector would refuse, which the shared hook turns into its own sentence.
  const [drafts, setDrafts] = useState<Record<string, JsonValue | null>>({});

  return (
    <Section
      id="alert-rules"
      title="Alert rules"
      // The one fact the fields cannot show: they judge every asset. A chip in
      // the header, where a 19-word note sat (bead `ro-ujb9.96.6.3`).
      aside={<StateChip tone="neutral" label="All sites" glyph={<Globe className="size-3" />} subject="alert-rules:portfolio" />}
    >
      {/* SHOW, THEN ASK (docs/15 principle 1, bead `ro-w35m`). The evidence
          leads the fields it is about, exactly as it does in the panel these
          same three settings open from an alert row. */}
      {assets.length === 0 ? (
        <p
          className="flex items-center gap-1.5 border-b border-border pb-3 text-xs text-muted-foreground"
          data-alert-rule-preview-empty
        >
          <CircleDashed className="size-3.5 shrink-0" aria-hidden />
          No reports to replay yet
        </p>
      ) : (
        <AlertRulePreview
          assets={assets}
          knobs={backtestableKnobs(alertRules.knobs)}
          drafts={drafts}
        />
      )}

      <AlertRuleRecord />

      {alertRules.knobs.map((knob) => (
        <FieldWithVisual key={knob.key} visual={alertRuleVisual(knob)}>
          <KnobEditor
            statesReadOnly={false}
            className="border-0 py-0"
            label={knob.label}
            help={knob.explain}
            current={knob.raw}
            format={(v) => String(v)}
            makeOp={fileOp("config/constants.json", knob.pointer, knob.raw)}
            control={{
              type: "number",
              validate: FLAG_DEFAULT_VALIDATOR[knob.key] ?? validateUsd,
              step: knob.key === "alpha" ? "0.001" : "1",
            }}
            onDraft={(value) =>
              setDrafts((current) => ({ ...current, [knob.key]: value }))
            }
          />
        </FieldWithVisual>
      ))}
    </Section>
  );
}

/**
 * WHAT EACH RULE HAS ACTUALLY COST — the false-positive rate docs/15 flow E has
 * promised since the beginning and nothing has ever rendered (bead `ro-ayxy`).
 *
 * The write half landed with `ro-van6`: a save from the Tune panel records
 * `disposition='tune'` on the alert it was made from. Until this block, that
 * record went into the store and came out nowhere — the operator could see that
 * THIS alert was tuned (the row's chip) but not that they have now tuned this
 * rule five times this quarter, which is the only version of the fact that
 * changes a decision.
 *
 * IT IS A SECOND READ, not a field on the settings payload. That payload is a
 * pure builder over `config/constants.json` on purpose (see
 * `worker/settings-payload.ts`): nothing on this page is evidence, so an empty
 * or unreachable store must not blank the page an operator opens to fix things.
 * This block is the exception that proves it — it IS evidence, so it travels on
 * `GET /api/alerts/rules`, and a store that cannot answer costs the operator
 * this block and nothing else. The fields below still edit.
 *
 * ONLY RULES THAT HAVE FIRED get a row. A rule the store has never seen is
 * absent rather than a line of zeros, which would read as "this rule has never
 * been a problem" — a claim from silence.
 */
function AlertRuleRecord() {
  const { data, isError } = useAlertRuleStats();

  // Not yet answered is not the same as nothing to say: an empty block while the
  // read is in flight beats a "no firings yet" the store never confirmed.
  if (!data) {
    // Unknown, said as a state: the fields below are enabled either way, so
    // saying that they "still edit" restated the page (bead `ro-ujb9.96.6.3`).
    return isError ? (
      <p
        className="flex items-center gap-1.5 border-b border-border py-3 text-xs text-muted-foreground"
        data-alert-rule-record="unavailable"
      >
        <CircleDashed className="size-3.5 shrink-0" aria-hidden />
        Tuning history unavailable
      </p>
    ) : null;
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border py-3" data-alert-rule-record>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-wall-label font-semibold uppercase tracking-widest text-muted-foreground">
          Answered by tuning
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          last {data.windowDays} days
        </span>
      </div>

      {data.rules.length === 0 ? (
        <p
          className="flex items-center gap-1.5 text-xs leading-snug text-muted-foreground"
          data-alert-rule-record-empty
        >
          <CircleDashed className="size-3.5 shrink-0" aria-hidden />
          No rule has fired
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {data.rules.map((stat) => (
            <li
              key={stat.ruleId}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5"
              data-alert-rule-row={stat.ruleId}
            >
              {/* The rule id is EVIDENCE and rides in the hover, never as the
                  headline (docs/17 rule 4) — except for a rule nothing has a
                  name for, where the id is the only honest identity there is. */}
              <span className="text-xs text-foreground" title={stat.ruleId}>
                {ruleLabel(stat.ruleId)}
              </span>
              <TuneRate stat={stat} windowDays={data.windowDays} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The two rules these settings steer, in the operator's words. Which one an
 * asset can answer depends on the asset's own volume, so the choice is the
 * operator's rather than a default that would leave half the portfolio looking
 * at a strip of unjudged days. The rule id rides in the hover — evidence, not a
 * label (docs/17 rule 4).
 *
 * NEITHER HALF IS TYPED HERE. The ids come from the contract that decides which
 * rules a replay can honestly serve (`BACKTESTABLE_RULE_IDS`), and the words
 * from the one map every rule is named by (`shared/alert-rules.ts`, bead
 * `ro-ayxy`) — so the picker above, the record below, and the Tune panel on an
 * alert row cannot call one rule three different things. */
const REPLAYABLE_RULES = BACKTESTABLE_RULE_IDS.map((id) => ({ id, label: ruleLabel(id) }));

/**
 * WHAT THESE SETTINGS WOULD HAVE DONE, on the page they are edited on (bead
 * `ro-w35m`).
 *
 * The same three settings typed on an alert row have shown their 30-day replay
 * since `ro-u072`, and typed one click away on `/settings` showed nothing —
 * which is docs/15 principle 1 holding on one surface and not the other, for
 * the same edit. The reason was never the machinery: the replay is scoped by
 * PARAMETER, not by surface. What this page lacked was an ASSET, so it asks for
 * one.
 *
 * IT IS THE SAME PREVIEW, NOT A SECOND ONE: `useRulePreview` builds the request
 * and `RulePreview` renders all four of its states, both imported from the panel
 * that already had them. A page that computed its own would be free to disagree
 * with the alert row about the same numbers.
 *
 * THE SCOPE IS STATED, NOT IMPLIED. These settings judge every asset, and this
 * strip is one asset's thirty days — so the caption names the asset AND the
 * values replayed, and the picker is visibly a choice of what to look at rather
 * than a scope the settings apply to.
 */
function AlertRulePreview({
  assets,
  knobs,
  drafts,
}: {
  assets: readonly AssetCard[];
  knobs: readonly KnobFact[];
  drafts: Record<string, JsonValue | null>;
}) {
  // Absent until the operator picks: the default follows the payload, so an
  // asset that goes quiet between polls cannot strand the strip on a choice
  // nobody made.
  const [picked, setPicked] = useState<string | null>(null);
  const [ruleId, setRuleId] = useState<string>(BACKTESTABLE_RULE_IDS[0]);
  const asset = assets.find((a) => a.id === picked) ?? assets[0]!;
  const preview = useRulePreview({
    asset: asset.id,
    ruleId,
    // The whole asset, not one metric: the settings page has no alert in front
    // of it, so it has no metric to be about either.
    metric: null,
    knobs,
    drafts,
  });

  return (
    <div className="flex flex-col gap-2 border-b border-border py-3" data-alert-rule-preview>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-wall-label font-semibold uppercase tracking-widest text-muted-foreground">
          Replay against
        </span>
        <div className="flex flex-wrap items-center gap-1" data-replay-assets>
          {assets.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              aria-pressed={candidate.id === asset.id}
              onClick={() => setPicked(candidate.id)}
              data-replay-asset={candidate.id}
              /* The box, the thumb floor and the pressed state are
                 `ui/pill.ts` (bead `ro-s4rg`) — this row and the preset row
                 below it are the two call sites that carry that pressed pair
                 exactly, and they used to carry it as two literals kept in step
                 by hand.
                 WHAT IS LOCAL IS THE PRICE (bead `ro-zmyq`): this row PAYS its
                 18px rather than claiming them, and it is the one place on this
                 route that does. `ro-9smi`'s idiom claims the height back with a
                 negative margin, which works when the control draws nothing — an
                 owner chip is a pointer inside a 44px target. These pills draw a
                 border and a fill and are the whole control: claiming would put
                 this row's target inside the preset row's below it, and two
                 pickers sharing pixels is worse on a thumb than a taller page. */
              className={cn(
                pillClass,
                pillControlClass,
                pillPickerStateClass(candidate.id === asset.id),
              )}
            >
              <PropertyFavicon
                domain={candidate.id}
                displayName={candidate.displayName}
                className="size-4"
              />
              {candidate.displayName}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1" data-replay-rules>
        {REPLAYABLE_RULES.map((rule) => (
          <button
            key={rule.id}
            type="button"
            aria-pressed={rule.id === ruleId}
            onClick={() => setRuleId(rule.id)}
            title={rule.id}
            data-replay-rule={rule.id}
            /* The same three reads as the asset picker above, which is the
               point of `ui/pill.ts`: this row and that one are one pill, and
               the floor `ro-zmyq` gave them both is now declared once. */
            className={cn(pillClass, pillControlClass, pillPickerStateClass(rule.id === ruleId))}
          >
            {rule.label}
          </button>
        ))}
      </div>

      <RulePreview preview={preview} />

      {/* The values the strip above is a picture OF. Without it the reader has
          to trust that the fields below are what was replayed — and after one
          edit and no Save, they would be trusting the wrong ones. That the
          settings judge every asset is the section's "All assets" chip now. */}
      <p className="text-[11px] leading-snug text-muted-foreground" data-replay-caption>
        {asset.displayName} · last 30 days ·{" "}
        <span className="tabular-nums">
          {knobs
            .map((knob) => `${knob.label.toLowerCase()} ${replayedValue(knob, drafts)}`)
            .join(" · ")}
        </span>
      </p>
    </div>
  );
}

/** What the replay was told for one setting: the edited value while a field is
 * being typed into, the saved one otherwise — the same precedence the request
 * itself uses, so the sentence cannot describe a different replay from the one
 * that ran. */
function replayedValue(
  knob: KnobFact,
  drafts: Record<string, JsonValue | null>,
): string {
  const draft = knob.key in drafts ? drafts[knob.key] : undefined;
  return String(draft ?? knob.raw);
}

/**
 * The assets a replay can honestly serve, noisiest first.
 *
 * FILTERED to those that have filed a report: the rest have nothing to replay,
 * and offering them would put the operator one click from a strip that can only
 * say "this asset filed nothing".
 *
 * SORTED by open alerts, because the operator on this page is here to quieten
 * something, and the asset with the most open alerts is the one they mean. It is
 * deliberately NOT "most alerts in the last 30 days", which would read better
 * and which no payload holds — the Wall counts what is OPEN. Inventing a read
 * for it belongs to the bead that surfaces per-rule false-positive counts, not
 * to a picker's default.
 */
function replayableAssets(assets: readonly AssetCard[]): AssetCard[] {
  return assets
    .filter((asset) => asset.pulseReceivedAt !== null)
    .slice()
    .sort((a, b) => b.openError + b.openWarn - (a.openError + a.openWarn));
}

/** Two of these three numbers mean nothing on their own. A probability is read
 * against the conventional 0.05 ceiling and a window in hours is read against a
 * week; a minimum daily count is already the plain number it claims to be, so it
 * gets no bar — a visual that answers nothing the figure does not is decoration
 * (doc 14).
 *
 * WHAT THESE METERS DO NOT SAY, since `ro-w35m`, is what the value would DO.
 * The sensitivity field used to carry "about one false alert per N tested days",
 * an estimate from the number alone; the strip above the fields now answers the
 * same question from the store, for a real asset over thirty real days. Keeping
 * both would be an estimate arguing with a measurement about one fact (doc 14),
 * and the estimate is the one that loses. The position on the scale is a
 * different fact and stays. */
function alertRuleVisual(knob: KnobFact) {
  const n = typeof knob.raw === "number" ? knob.raw : Number(knob.raw);
  if (!Number.isFinite(n)) return undefined;

  if (knob.key === "alpha") {
    return (
      <div data-rule-scale="alpha">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Stricter · looser</span>
          <span className="shrink-0 tabular-nums text-foreground">
            {`of ${ALPHA_CONVENTIONAL_CEILING}`}
          </span>
        </div>
        <Meter
          className="mt-1.5"
          value={n}
          max={ALPHA_CONVENTIONAL_CEILING}
          ariaLabel="Anomaly sensitivity against the conventional 0.05 ceiling"
        />
      </div>
    );
  }

  if (knob.key === "low_volume_window_hours") {
    return (
      <div data-rule-scale="low-volume-window">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Of one week</span>
          <span className="shrink-0 tabular-nums text-foreground">
            {`${n} h · ${formatDays(n)}`}
          </span>
        </div>
        <Meter
          className="mt-1.5"
          value={n}
          max={HOURS_IN_A_WEEK}
          ariaLabel="Low-volume history window as a share of one week"
        />
      </div>
    );
  }

  return undefined;
}

function formatDays(hours: number): string {
  const days = hours / 24;
  const rounded = Math.round(days * 10) / 10;
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}

// --- 3. Data collection ----------------------------------------------------
/**
 * How often the OS reads and how far back it looks — the declared knobs, in
 * declaration order, each with what changing it costs (bead `ro-x5gu.6`).
 *
 * The section renders whatever `CONFIG_KNOBS` declares that this deployment
 * could read a value for. Nothing here names a pointer, a label or a rule: a
 * knob added to the declaration appears as a row, and a knob whose block a
 * config does not carry is simply not in the payload and draws nothing — never
 * a zero nobody configured.
 */
function CollectionSection({ settings }: { settings: SettingsPayload }) {
  const { collection } = settings;
  const { writable } = useConfigWritable();
  const byKey = new Map(collection.knobs.map((knob) => [knob.key, knob] as const));
  const historyWindow = byKey.get("panel-refresh-window");
  const { knobs } = collection;

  return (
    <Section id="data-collection" title="Data collection">
      {/* WHEN A COLLECTION NO CONNECTION FEEDS RUNS, EDITED HERE (beads
          `ro-ujb9.96.7.12`, `ro-ujb9.96.7.28`). One row per collection and one
          pick, saved beside the row with its Undo. A collection a connection
          feeds — ad revenue, the traffic and search archives, product
          analytics, rankings, Clarity — is changed on that connection's Manage
          panel on Integrations instead (`connectionCollections`), the sync
          frequency on the connection as Fivetran and Airbyte place it; what is
          left here is what no connection feeds: nightly reports, live
          counters, local research. System health keeps the runner's own view
          and links to wherever the job's one editor is (`scheduleHref`). */}
      <div className={cn("pb-3", knobs.length > 0 && "border-b border-border")}>
        <ScheduleRows
          jobs={settingsCollections()}
          overrides={collection.schedules}
          writable={writable}
        />
      </div>
      {knobs.map((knob) => {
        const declared = configKnob(knob.key);
        return (
          <FieldWithVisual
            key={knob.key}
            visual={collectionVisual(knob, numberOf(historyWindow?.value))}
          >
            {/* What changing it COSTS is the visual beside it — the price per
                pass, the fit inside the window — not the declaration's
                consequence paragraph, which said the same in 40 words. */}
            <KnobEditor
              statesReadOnly={false}
              className="border-0 py-0"
              label={declared.label}
              help={declared.field.describe}
              explain={declared.unit}
              current={knob.value}
              format={(v) => String(v)}
              slug={knob.key}
              makeOp={(value) => knobSetOp(declared, knob.value, value)}
              control={knobControl(declared.field)}
            />
          </FieldWithVisual>
        );
      })}

      <div className="mt-4 border-t border-border pt-3">
        <span className="text-sm font-medium text-foreground">Nightly report pulls</span>
      </div>
      {collection.pullAssets.length === 0 ? (
        // A state, not a sentence (bead `ro-ujb9.96.7.12`: 0 words to act on
        // this section): nothing is fetched, so every asset sends its own.
        <p className="py-2" data-pull-none>
          <StateChip tone="na" label="None · sites send their own" subject="collection:portfolio" />
        </p>
      ) : (
        collection.pullAssets.map((entry) => (
          <div
            key={entry.asset}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border py-2.5 last:border-0"
            data-pull-asset={entry.asset}
          >
            <div className="flex min-w-0 items-center gap-2">
              <PropertyFavicon domain={entry.asset} displayName={entry.asset} />
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium text-foreground">{entry.asset}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{entry.url}</span>
              </div>
            </div>
            <StateChip
              // Deliberately NOT the connected green: that token means a
              // collector run succeeded, and this is a switch in a file. A
              // lane can be enabled and failing, and this chip must never be
              // read as health (doc 14 — health comes from the latest stored
              // attempt, never from the presence of config).
              label={entry.enabled ? "Enabled" : "Paused"}
              tone={entry.enabled ? "affirmative" : "na"}
              subject={`collection:${entry.asset}`}
            />
          </div>
        ))
      )}
    </Section>
  );
}

// --- the collection knobs' controls and visuals -----------------------------

/**
 * The control a declared field gets, chosen by its TYPE — the same rule
 * `CollectionEditor` follows for a table cell, so a knob and a column of the
 * same type are edited the same way.
 *
 * Everything today is an `integer`, and the cast is where the two vocabularies
 * meet: `validateRegisterField` answers in the declaration's `JsonValue`, and
 * this control's callback is typed to the number it has already refused
 * anything else from being.
 */
function knobControl(field: RegisterField): KnobControl {
  const validate = validateRegisterField(field);
  if (field.type === "number" || field.type === "integer") {
    return {
      type: "number",
      step: field.type === "integer" ? "1" : "any",
      validate: validate as (raw: string) => Validated<number>,
    };
  }
  if (field.type === "enum") {
    return {
      type: "select",
      options: (field.values ?? []).map((value) => ({ value, label: value })),
    };
  }
  return { type: "text", validate: validate as (raw: string) => Validated<string> };
}

/** A stored knob value as a number, or null when it is not one. */
function numberOf(value: JsonValue | undefined): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * What the eye reads beside a cadence field — the figure the number itself
 * hides, never a bar for its own sake (doc 14).
 *
 * A read interval in minutes hides how many reads a day that is. A history
 * window in days hides how many weeks. And the freshness bar is the one that is
 * meaningless alone: it has to fit INSIDE the window, so it gets the meter of
 * itself against it — the only visual here that shows an invariant rather than
 * a restatement.
 */
function collectionVisual(knob: KnobValueSetting, windowDays: number | null) {
  const n = numberOf(knob.value);
  if (n === null || n <= 0) return undefined;

  if (knob.key === "panel-refresh-window") {
    const weeks = Math.round((n / 7) * 10) / 10;
    // Two label/value rows: how much history a pass asks for, and what a
    // pass costs — a refresh pass makes zero provider calls.
    return (
      <dl className="m-0 flex flex-col gap-1 text-xs" data-collection-scale="panel-refresh-window">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">Each pass asks for</dt>
          <dd className="m-0 shrink-0 tabular-nums text-foreground">
            {weeks} {weeks === 1 ? "week" : "weeks"}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">Cost per pass</dt>
          <dd className="m-0 shrink-0 tabular-nums text-foreground" data-collection-cost>
            {formatUsd(0, { cents: true })}
          </dd>
        </div>
      </dl>
    );
  }

  if (knob.key === "panel-freshness-bar" && windowDays !== null) {
    // The one invariant here — the bar must fit inside the window — as a
    // meter and a ✓/✕ chip, where a sentence said it (bead `ro-ujb9.96.6.3`).
    const fits = n <= windowDays;
    return (
      <div data-collection-scale="panel-freshness-bar">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Of the history window</span>
          <span className="shrink-0 tabular-nums text-foreground">
            {n} of {windowDays} d
          </span>
        </div>
        <Meter
          className="mt-1.5"
          value={n}
          max={windowDays}
          ariaLabel="Panel freshness bar as a share of the history window one pass asks for"
        />
        <StateChip
          className="mt-1.5"
          tone={fits ? "affirmative" : "critical"}
          label={fits ? "Fits the window" : "Outside the window"}
          glyph={fits ? <Check className="size-3" /> : <X className="size-3" />}
          subject={`field:portfolio:${knob.key}`}
        />
      </div>
    );
  }

  return undefined;
}

// --- 5. Ownership -----------------------------------------------------------
/**
 * WHO OWNS WHAT (bead `ro-aodz`).
 *
 * The add-asset wizard has asked for an owning entity since `ro-qsoo` and had
 * nowhere to put it, so it went into the ad-network source's note — where D5
 * makes it matter and where nobody asking "who owns this asset" would look.
 * `config/entities.json` is that fact's own home, and this is the table over it.
 *
 * THE TABLE EDITS THE ENTITY; THE ASSET PAGE EDITS THE MEMBERSHIP. The declared
 * `assets` column is deliberately not offered here (`columns`): an asset belongs
 * to exactly one entity, no field of one row can see another, and a list typed
 * into two rows would claim the same asset twice with nothing to catch it. On
 * the asset's own Identity card the move is ONE change that takes it off the old
 * list on its way onto the new one, so the rule holds by construction rather
 * than by a check. What this section owes instead is the READ — who owns what,
 * and which assets nobody has claimed — which is the map below the table.
 *
 * REMOVING AN ENTITY LEAVES ITS ASSETS UNOWNED rather than deleting anything,
 * and the map is where that shows: the assets it held move straight into the
 * *no entity* line. Said under the table, because a Remove that quietly changes
 * a fact about five assets is one an operator should meet before pressing it.
 */
function EntitiesSection({ settings }: { settings: SettingsPayload }) {
  const { entities } = settings;
  const { data: matrix } = useIntegrations();
  const known = (matrix?.assets ?? []).map((asset) => asset.id);
  const unowned = known.filter((id) => entityOfAsset(entities.rows, id) === null);

  return (
    // No OwnerChip here: the table below carries the file it writes, and one
    // fact rendered twice on one card is one fact too many (doc 14) — the same
    // reason the Tasks section below states its file once. No description or
    // help either (bead `ro-ujb9.96.6.3`): the table is titled "Legal
    // entities", and where an asset is assigned is its own link in the map.
    <Section id="entities" title="Ownership">
      <CollectionEditor
        statesReadOnly={false}
        register="entities"
        rows={entities.rows as unknown as JsonValue[]}
        // The asset list is read below and changed on the asset's own page.
        columns={["slug", "name", "form", "jurisdiction"]}
        title="Legal entities"
        describe="one legal entity that owns sites"
        slug="declare-an-entity"
        emptyHint="Sites have no owner"
        commit="auto"
      />
      <EntityOwnership rows={entities.rows} unowned={unowned} />
    </Section>
  );
}

/**
 * The map: one line per entity, plus the assets nobody has claimed.
 *
 * It is a READ of the same field the asset pages write, not a second place to
 * write it — every asset here is a link to the Identity card that owns the
 * change. An asset id is a domain and reads faster with its favicon than
 * without it (doc 14), which is also what makes the unowned line scannable.
 *
 * The unowned line renders only when the matrix has answered. An empty asset
 * list means "nothing said" rather than "every asset is owned", and a green
 * all-clear that came from an unanswered read is the one claim this page must
 * not make.
 */
function EntityOwnership({
  rows,
  unowned,
}: {
  rows: EntityRow[];
  unowned: string[];
}) {
  if (rows.length === 0 && unowned.length === 0) return null;
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3" data-entity-ownership={rows.length}>
      <span className="text-sm font-medium text-foreground">Sites by owner</span>
      {rows.map((row) => {
        const owned = entityAssets(row);
        return (
          <div key={row.slug} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="font-medium text-foreground">{row.name}</span>
            {owned.length === 0 ? (
              <span className="text-muted-foreground">owns no site yet</span>
            ) : (
              <AssetLinks ids={owned} />
            )}
          </div>
        );
      })}
      {/* Unowned is the one line that needs the operator, so it wears the
          caution chip; every asset in it is the link to where it is assigned.
          Removing an entity moves its assets here at once — the map shows the
          consequence instead of a footnote warning about it. */}
      {unowned.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-entity-unowned={unowned.length}>
          <StateChip tone="caution" label="No owner" subject="entity:unowned" />
          <AssetLinks ids={unowned} />
        </div>
      ) : null}
    </div>
  );
}

/** The assets on one line, each a link to the Identity card that changes it. */
function AssetLinks({ ids }: { ids: string[] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {ids.map((id) => (
        <Link
          key={id}
          to={`/assets/${encodeURIComponent(id)}/settings`}
          className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
        >
          <PropertyFavicon domain={id} displayName={id} />
          {id}
        </Link>
      ))}
    </span>
  );
}

// --- 6. Task projects -----------------------------------------------------------
/**
 * The map from an asset to the project its tasks live in (bead `ro-x5gu.5`).
 *
 * IT USED TO BE A LIST YOU COULD ONLY LOOK AT. Adding a project meant knowing
 * `config/beads.json` existed, which is the definition of a setting with no
 * surface — so it is now the declared register's own table, with the same Add,
 * Save, Remove and Undo every other register on this page has.
 *
 * BUT THE FILE IS NOT THE WHOLE JOB, AND THE PAGE SAYS SO. A row here is a
 * mapping, not a project: the database still has to be created, the repo still
 * has to be pointed at the hub, and a project is not onboarded until it carries
 * its own freeze register. So an Add is answered with the steps that are left,
 * as commands an operator can copy — the honest alternative to a table that
 * looks finished and produces a board entry nobody can read.
 *
 * THE ASSET COLUMN PICKS FROM REALITY. The declaration can say "an asset id"
 * but not WHICH ids exist — those are rows in the store — so the assets the OS
 * actually has come from the integrations matrix this page already reads, and
 * the picker offers the ones no project has claimed yet.
 *
 * THE CONNECTION IS NOT A SETTING. Its port lives in three files that must
 * agree and a test pins them, so it is shown as the fixed fact it is rather than
 * as a field that would break two other files.
 *
 * AND IT SAYS WHEN A NAME IS WRONG (bead `ro-eb7z`). The runner reconciles each
 * project's declared database against what actually exists once an hour and
 * files an operator task about the ones that disagree — which the operator used
 * to meet in his inbox rather than on the field he had typed it into. The mark
 * comes off THAT TASK, read from `/api/work`, not from a probe: `/api/settings`
 * is a pure builder over config with no store read, so the page an operator
 * opens to fix things cannot blank on a store that is empty or down.
 * `shared/task-map.ts` owns the join and the reasoning.
 */
function TaskHubSection({ settings }: { settings: SettingsPayload }) {
  const { taskHub } = settings;
  const { data: matrix } = useIntegrations();
  const { data: work } = useWork();
  const [added, setAdded] = useState<TaskHubSpoke | null>(null);

  // Every asset the OS knows, minus the ones already mapped. An empty list is
  // "the matrix has not answered", and offers no picker rather than an empty one
  // — the same distinction the budget meter makes about unread spend.
  const mapped = new Set(taskHub.spokes.map((spoke) => spoke.asset));
  const known = (matrix?.assets ?? []).map((asset) => asset.id);
  const unclaimed = known.filter((id) => !mapped.has(id));

  // WHAT THE HOURLY CHECK FOUND, read off the task it filed rather than probed
  // from here (`shared/task-map.ts` says why). `null` is "nothing answered", and
  // the column is not offered at all in that case: an unanswered board must not
  // render as a table where every row is fine.
  const drifting = driftingTaskDatabases(work?.projects);
  const marked = taskHub.spokes.filter((spoke) => drifting?.has(spoke.asset));
  // Every project's read failed: the server row says so, and the column says
  // it does not know rather than disappearing (bead `ro-ujb9.208`).
  const serverDown = taskServerFailure(work?.projects);
  const found = drifting !== null ? FOUND_COLUMN(drifting) : serverDown !== null ? FOUND_UNKNOWN : null;

  return (
    <Section
      id="task-hub"
      title="Task projects"
      // A deployed view cannot reach the machine the projects live on: the
      // section says so as a chip, and the rows are a plain list rather than an
      // editor that would refuse every save (bead `ro-ujb9.96.6.3`). What an
      // Add leaves to do is the checklist it opens, not a description line.
      aside={
        taskHub.hub === null ? (
          <StateChip tone="na" label="Read-only here" glyph={<Lock className="size-3" />} subject="tasks:projects" />
        ) : undefined
      }
    >
      <TaskSourceSection />
      {taskHub.hub === null ? (
        <div data-task-projects-read-only>
          {taskHub.spokes.length === 0 ? <p className="text-sm text-muted-foreground">No task projects configured.</p> : taskHub.spokes.map((spoke) => (
            <KnobRow key={spoke.asset} label={spoke.asset} value={spoke.prefix} explain={`Task database: ${spoke.database}`} />
          ))}
        </div>
      ) : (
      <CollectionEditor
        statesReadOnly={false}
        register="task-hub-spokes"
        columns={["asset", "prefix", "database"]}
        addFields={["asset", "prefix", "database"]}
        rows={taskHub.spokes as unknown as JsonValue[]}
        title="Projects"
        // The register's own line runs to a sentence about maps; a row is this.
        describe="one site's task prefix and database"
        emptyHint="Tasks board empty"
        slug="map-a-project"
        fieldOptions={known.length === 0 ? undefined : { asset: unclaimed }}
        rowGlyph={(row) => <PropertyFavicon domain={row.key} displayName={row.key} />}
        derived={found === null ? undefined : [found]}
        onAdded={(row) => setAdded(spokeOf(row))}
        commit="auto"
      />
      )}
      {taskHub.hub !== null && marked.length > 0 ? <DatabaseNotFound spokes={marked} hub={taskHub.hub} /> : null}
      {taskHub.hub !== null && added ? (
        <div className="mt-4">
          <TaskProjectSteps
            spoke={added}
            hub={taskHub.hub}
            onDismiss={() => setAdded(null)}
          />
        </div>
      ) : null}
      <HubConnection hub={taskHub.hub} failure={serverDown} />
    </Section>
  );
}

/**
 * The one column this page WORKS OUT rather than stores (bead `ro-eb7z`): does a
 * database by this name exist where the tasks live?
 *
 * It is a computed column and not a field, for the reason `CollectionEditor`
 * gives: nothing writes it, nothing addresses it, and a file holding it would be
 * a file that can disagree with itself. It carries no control either — the fix
 * is the `Database` cell one column to the left, or a command in the repo, and
 * both are said under the table.
 *
 * ONLY THE WRONG ROWS ARE MARKED. An agreeing row is blank rather than
 * green-ticked, because `/api/work` carries a bounded head of each list and a
 * filed task can exist without travelling — so blank means "nothing here says
 * otherwise", which is all that can honestly be claimed. The column is not
 * offered at all when nothing answered (`shared/task-map.ts`).
 */
function FOUND_COLUMN(drifting: ReadonlySet<string>): DerivedColumn {
  // No header tooltip (bead `ro-ujb9.96.6.3`): a blank cell or a warn dot whose
  // own hover names the missing database, and the note under the table.
  return {
    name: "found",
    label: "Found",
    render: (row) =>
      drifting.has(row.key) ? (
        <SeverityDot
          severity="warn"
          size="sm"
          title={`No database named ${String(row.values.database ?? row.key)} where the tasks live`}
        />
      ) : null,
  };
}

/** The same column when no project could be read (bead `ro-ujb9.208`): each row
 * says it is not known, never blank — blank there claims "nothing here says
 * otherwise", and nothing was asked. */
const FOUND_UNKNOWN: DerivedColumn = {
  name: "found",
  label: "Found",
  render: () => (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-found-unknown>
      <CircleDashed aria-hidden className="size-3.5 shrink-0" />
      Unknown
    </span>
  ),
};

/**
 * What was found, and the two ways out of it.
 *
 * The runner already files this as an operator task; what it could not do is put
 * it on the field the operator typed the value into. So the same two fixes the
 * filed task names are offered here — change the name on this page, or point
 * the repo at the name that is already there — because from this page the first
 * one is a single edit and the operator should not have to open an inbox to
 * learn that.
 *
 * WHAT HAPPENED, THEN TWO BUTTONS (bead `ro-ujb9.96.6.3`). This was an 83-word
 * paragraph explaining that the Tasks board keeps working and that the nightly
 * copy is what reads the name. The consequence is the headline now — the project
 * is not being backed up — and the fixes are side by side, Vercel-domain
 * style: *Edit name* puts the cursor in the
 * Database cell, *Keep* is the command with Copy. Choosing between them is the
 * decision; nothing needs reading to make it.
 *
 * A COMMAND IS COPIED, NOT READ (doc 14 principle 10), so it keeps the
 * machinery's own words inside a labelled block with a Copy button, exactly as
 * the onboarding checklist below does.
 */
function DatabaseNotFound({
  spokes,
  hub,
}: {
  spokes: TaskHubSpoke[];
  hub: TaskHubConnection | null;
}) {
  return (
    <div
      className="mt-4 flex flex-col gap-4 rounded-md border border-warn/40 bg-warn/5 p-3"
      data-database-not-found
    >
      {spokes.map((spoke) => (
        <div key={spoke.asset} className="flex flex-col gap-2" data-database-not-found-project={spoke.asset}>
          <div className="flex items-start gap-2">
            <SeverityDot severity="warn" size="sm" title="Not found" className="mt-1.5" />
            <div className="flex min-w-0 flex-col">
              <h4 className="text-sm font-medium text-foreground">
                {spoke.asset} is not being backed up
              </h4>
              <span className="text-xs text-muted-foreground">
                No database named <span className="font-mono">{spoke.database}</span>
              </span>
            </div>
          </div>
          <div className="grid items-start gap-2 sm:grid-cols-2">
            <FixOption title="Use a name that exists">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => focusDatabaseCell(spoke.asset)}
              >
                <Pencil className="size-3.5" />
                Edit name
              </Button>
            </FixOption>
            <FixOption title={`Keep ${spoke.database}`}>
              <CommandBlock
                command={taskProjectInitCommand(spoke, hub, true)}
                label={`Terminal · run in ${spoke.repo}`}
                fallback={NO_HUB_CONNECTION}
              />
            </FixOption>
          </div>
        </div>
      ))}
    </div>
  );
}

/** One of two ways out: a short title and the one control that does it. */
function FixOption({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-background/60 p-2.5">
      <span className="text-xs font-medium text-foreground">{title}</span>
      {children}
    </div>
  );
}

/** Put the cursor in a project's Database cell — the "rename it here" fix. The
 * cell is `CollectionEditor`'s own input, addressed by the row's key. */
function focusDatabaseCell(asset: string) {
  const input = document.querySelector<HTMLInputElement>(
    `[data-collection-row="${asset}"] input[aria-label="Database"]`,
  );
  if (!input) return;
  // Optional-called: not every DOM (jsdom) implements it, and focus alone is
  // still the fix.
  input.scrollIntoView?.({ block: "center" });
  input.focus();
  input.select();
}

/** The added row as the four strings the checklist needs. Whatever the form
 * produced, a required string field cannot be anything else by the time a write
 * has landed. */
function spokeOf(row: Record<string, JsonValue>): TaskHubSpoke {
  const text = (value: JsonValue | undefined) => (typeof value === "string" ? value : "");
  return {
    asset: text(row.asset),
    prefix: text(row.prefix),
    database: text(row.database),
    repo: text(row.repo),
  };
}

/** The connection, as the fixed fact it is: a label, a lock and the value. Absent
 * in a build that has no filesystem, where it would be a claim about a machine
 * this page cannot see.
 *
 * AND WHETHER IT ANSWERED (bead `ro-ujb9.208`): when every project's last read
 * failed, the address carries *Not answering* and the read's own error as a
 * chip, once each — an address alone looks the same up or down. */
function HubConnection({ hub, failure }: { hub: TaskHubConnection | null; failure: { errors: string[] } | null }) {
  if (hub === null) return null;
  return (
    <div
      className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-border pt-3"
      data-task-hub-connection
      data-task-server={failure === null ? undefined : "not-answering"}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Lock aria-hidden className="size-3 text-muted-foreground" />
        Task database server
      </span>
      <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
        {failure !== null ? <StateChip tone="critical" label="Not answering" subject="tasks:server" /> : null}
        <span className="font-mono text-[11px] text-muted-foreground">
          {hub.host}:{hub.port} · {hub.user} · {hub.dataDir}
        </span>
      </span>
      {failure?.errors.map((error) => (
        <StateChip
          key={error}
          tone="na"
          label={error}
          subject="tasks:server-error"
          className="w-full whitespace-normal break-words rounded-md font-mono text-[11px] font-normal"
        />
      ))}
    </div>
  );
}

export default SettingsRoute;
import { UnknownPriceCount } from "@/components/UnknownPriceCount";
