import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { HygieneReading, HygieneStatus } from "@shared/asset-detail";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import { UPTIME_LANE_ID } from "@shared/integrations";
import { segmentName } from "@shared/product";
import type { AssetCard } from "@shared/wall";
import { Sparkline } from "@/components/surface/Sparkline";
import { BarStrip } from "@/components/viz/BarStrip";
import { useSiteIssues } from "@/hooks/useSiteIssues";
import { useWall } from "@/hooks/useWall";
import { formatSeriesDate, formatInt, formatPercent } from "@/lib/format";
import { techHealth, type TechFact, type TechFactKey } from "@/lib/tech-health";
import { cn } from "@/lib/utils";
import { fourWeeks } from "@/lib/wall-sites";
import { FACT_LABEL } from "@/routes/home/HealthModule";
import { tabPath } from "./AssetTabs";
import { alignedSeries, seriesOf } from "./codebase-measures";
import { Hero, Panel } from "./shared";

/**
 * A site's Health tab: the five facts Home's site-health grid draws as dots,
 * here as one row of large words, then every fact's evidence as a panel in the
 * same order, drawn without a press. A word's press scrolls to its panel and
 * marks it. The facts come from the site's card in the Wall's read
 * (`techHealth`), the same calculation Home and the TV use, so the three can
 * never disagree; the evidence comes from this tab's own read.
 */
export function HealthTab({ data, nowMs }: { data: AssetDetailFor<"health">; nowMs: number }) {
  const wall = useWall();
  const issues = useSiteIssues();
  const [selected, setSelected] = useState<TechFactKey | null>(null);
  const baseId = useId();
  const card = wall.data?.assets.find((candidate) => candidate.id === data.asset.id) ?? null;

  if (!card) {
    return (
      <Hero>
        <p className="m-0 text-sm text-muted-foreground" data-health-tab="reading">
          {wall.data ? "Not measured yet" : "Reading…"}
        </p>
      </Hero>
    );
  }

  const health = techHealth(card, issues, nowMs);
  const panelId = (key: TechFactKey) => `${baseId}-${key}`;
  const select = (key: TechFactKey) => {
    const next = selected === key ? null : key;
    setSelected(next);
    if (next === null) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    document.getElementById(panelId(next))?.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  return (
    <div className="flex flex-col gap-5" data-health-tab={health.key}>
      <Hero>
        <section aria-label="Site health" className="flex flex-col gap-3">
          {health.report ? (
            <p className="m-0 text-sm text-warn" data-health-report="">
              {health.report.note} · the readings below may be older
            </p>
          ) : null}
          <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-5">
            {health.facts.map((fact) => (
              <li key={fact.key} className="min-w-0">
                <FactButton
                  fact={fact}
                  asOf={asOf(fact.key, card)}
                  pressed={selected === fact.key}
                  controls={panelId(fact.key)}
                  onPress={() => select(fact.key)}
                />
              </li>
            ))}
          </ul>
        </section>
      </Hero>
      <div className="grid gap-4 lg:grid-cols-2">
        {health.facts.map((fact) => (
          <div
            key={fact.key}
            id={panelId(fact.key)}
            className={cn("min-w-0 scroll-mt-4 rounded-[10px]", selected === fact.key && "ring-2 ring-ring")}
            data-health-evidence={fact.key}
            data-selected={selected === fact.key ? "" : undefined}
          >
            <Panel title={FACT_LABEL[fact.key]} count={fact.word} className="h-full">
              <Evidence fact={fact} card={card} data={data} nowMs={nowMs} />
            </Panel>
          </div>
        ))}
      </div>
    </div>
  );
}

function FactButton({
  fact,
  asOf,
  pressed,
  controls,
  onPress,
}: {
  fact: TechFact;
  asOf: string | null;
  pressed: boolean;
  controls: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-controls={controls}
      onClick={onPress}
      data-health-fact={fact.key}
      data-fact-state={fact.state}
      className={cn(
        "flex h-full w-full flex-col items-start gap-1 rounded-[10px] border bg-card p-4 text-start outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors",
        pressed ? "border-foreground/40" : "border-border",
        fact.state === "unknown" && "border-dashed",
      )}
    >
      <span className="text-xs text-muted-foreground">{FACT_LABEL[fact.key]}</span>
      <span
        className={cn(
          "text-figure-sm",
          fact.state === "bad" ? "text-error" : fact.state === "warn" ? "text-warn" : fact.state === "unknown" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {fact.word}
      </span>
      {fact.note ? <span className="text-xs text-foreground">{fact.note}</span> : null}
      {asOf ? <span className="text-xs text-muted-foreground">as of {asOf}</span> : null}
    </button>
  );
}

/** The day the reading behind a fact was taken, when one was. */
function asOf(key: TechFactKey, card: AssetCard): string | null {
  if ((key === "speed" || key === "errors") && card.product) return formatSeriesDate(card.product.observedAt.slice(0, 10));
  if (key === "code" && card.codebase) return formatSeriesDate(card.codebase.date);
  if (key === "search") {
    const last = card.searchClicks.series.at(-1)?.t;
    return last ? formatSeriesDate(last) : null;
  }
  return null;
}

/** One night's check, in words. "Not reached" is about the check, not the site. */
const CHECK_WORD: Record<HygieneStatus, string> = {
  ok: "fine",
  warn: "flagged",
  error: "answered with an error",
  unreachable: "not reached",
};

function checkLine(reading: HygieneReading | null, what: string): string | null {
  return reading ? `${what}: ${CHECK_WORD[reading.status]} on ${formatSeriesDate(reading.date)}` : null;
}

function Lines({ lines }: { lines: readonly (ReactNode | null)[] }) {
  const shown = lines.filter((line) => line !== null);
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm text-foreground">
      {shown.map((line, index) => (
        <li key={index}>{line}</li>
      ))}
    </ul>
  );
}

function NotMeasured({ to, action }: { to: string; action: string }) {
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-3 text-sm text-muted-foreground" data-health-not-measured="">
      <span>Not measured yet</span>
      <Link to={to} className="font-medium text-foreground underline-offset-4 hover:underline" data-health-connect="">
        {action}
      </Link>
    </p>
  );
}

const SPEED_WORD = { good: "fast", "needs-improvement": "OK", poor: "slow" } as const;

function Evidence({ fact, card, data, nowMs }: { fact: TechFact; card: AssetCard; data: AssetDetailFor<"health">; nowMs: number }) {
  const sources = tabPath(card.id, "sources");
  const connect = <NotMeasured to={sources} action="Connect a data feed →" />;
  const hygiene = data.hygiene;
  const product = data.executive?.product ?? null;

  switch (fact.key) {
    case "reachable": {
      const slot = card.dataSources.find((source) => source.id === UPTIME_LANE_ID);
      const headers = hygiene?.headers ?? null;
      const sent = headers?.headers.filter((header) => header.present).length ?? 0;
      const lines = [
        slot?.state === "live" ? "Checked every hour" : slot?.state === "degraded" ? "The hourly check has not run lately" : null,
        checkLine(hygiene?.htmlDepth.latest ?? null, "Home page"),
        headers ? `${formatInt(sent)} of ${formatInt(headers.headers.length)} security headers sent` : null,
      ];
      return lines.some((line) => line !== null) ? <Lines lines={lines} /> : connect;
    }
    case "speed": {
      const segments = product?.vitals?.segments.slice(0, 3) ?? [];
      if (!card.product && segments.length === 0) return connect;
      return (
        <Lines
          lines={[
            card.product?.worstSpeed ? `Slowest group of visitors: ${SPEED_WORD[card.product.worstSpeed]}` : null,
            ...segments.map((segment) => (
              <span key={`${segment.path}-${segmentName(segment)}`} data-health-vital="">
                {segmentName(segment)} on {segment.path}
                {segment.lcpP75 !== null ? ` · main content in ${(segment.lcpP75 / 1000).toFixed(1)} s` : ""}
                {segment.lcpRating ? ` · ${segment.lcpRating === "needs-improvement" ? "needs improvement" : segment.lcpRating}` : ""}
              </span>
            )),
          ]}
        />
      );
    }
    case "errors": {
      const top = product?.exceptions?.top.slice(0, 3) ?? [];
      if (!card.product && top.length === 0) return connect;
      const people = card.product?.errorPeople ?? null;
      return (
        <Lines
          lines={[
            people !== null ? `${formatInt(people)} ${people === 1 ? "person" : "people"} hit an error` : "People who hit an error: not counted",
            ...top.map((error, index) => (
              <span key={index} className="break-words" data-health-error="">
                {error.message ?? error.type ?? "An error"} · {formatInt(error.people)} {error.people === 1 ? "person" : "people"}
              </span>
            )),
          ]}
        />
      );
    }
    case "search": {
      const weeks = fourWeeks(card.searchClicks);
      const sitemap = hygiene?.sitemap.latest ?? null;
      const allowed = hygiene?.bots.filter((bot) => bot.allowed).length ?? 0;
      const blocked = hygiene?.bots.filter((bot) => !bot.allowed).map((bot) => bot.bot) ?? [];
      if (!weeks && !sitemap) return connect;
      const now = weeks?.days.reduce((sum, day) => sum + (day.value ?? 0), 0) ?? null;
      const before = weeks?.hasPrior ? weeks.days.reduce((sum, day) => sum + (day.prior ?? 0), 0) : null;
      const usual = weeks && before !== null ? before / weeks.days.length : null;
      return (
        <div className="flex flex-col gap-3">
          {weeks && weeks.days.some((day) => day.value !== null) ? (
            <BarStrip
              data={weeks.days.map((day) => ({ t: day.date, v: day.value }))}
              tone="text-traffic"
              baseline={usual !== null ? { value: usual, label: `${formatInt(usual)} a day the 4 weeks before` } : null}
              ariaLabel="Visits from search a day, last 4 weeks"
            />
          ) : null}
          <Lines
            lines={[
              now !== null
                ? `${formatInt(now)} visits from search in the last 4 weeks${before !== null ? `, ${formatInt(before)} the 4 before` : ""}${weeks?.change ? ` (${weeks.change.percent >= 0 ? "+" : "−"}${formatPercent(Math.abs(weeks.change.percent))}%)` : ""}`
                : null,
              sitemap
                ? `${checkLine(sitemap, "Sitemap")}${sitemap.value !== null ? ` · ${formatInt(sitemap.value)} addresses listed` : ""}`
                : null,
              hygiene && hygiene.bots.length > 0
                ? `${formatInt(allowed)} of ${formatInt(hygiene.bots.length)} AI crawlers allowed${blocked.length > 0 ? ` · blocked: ${blocked.join(", ")}` : ""}`
                : null,
            ]}
          />
        </div>
      );
    }
    case "code": {
      const codebase = card.codebase ?? null;
      if (!codebase) return <NotMeasured to={`${tabPath(card.id, "codebase")}#codebase-setup`} action="Set up the code report →" />;
      const reports = data.codebase.history.filter((point) => point.measures.code_lines != null).length;
      // A code report need not land every day: each day holds the latest
      // report's count, as the Codebase tab's chart does, so the line joins
      // the reports rather than breaking at every day between two of them.
      const days = seriesOf(alignedSeries(data.codebase.history, (measures) => measures.code_lines ?? null, new Date(nowMs).toISOString().slice(0, 10), 90));
      return (
        <div className="flex flex-col gap-3">
          {reports >= 3 ? (
            <Sparkline data={days} size="wide" area readout average={false} format={(value) => `${formatInt(value)} lines`} ariaLabel="Lines of code over the last 90 days" />
          ) : null}
          <Lines
            lines={[
              codebase.codeLines !== null ? `${formatInt(codebase.codeLines)} lines of code on ${formatSeriesDate(codebase.date)}` : null,
              codebase.growthPercent30d !== null
                ? `${codebase.growthPercent30d >= 0 ? "Grew" : "Shrank"} ${formatPercent(Math.abs(codebase.growthPercent30d))}% in ${formatInt(codebase.comparedDays ?? 30)} days`
                : "Too early to compare with a month before",
            ]}
          />
        </div>
      );
    }
  }
}
