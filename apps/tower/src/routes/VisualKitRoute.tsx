import type { ReactNode } from "react";
import { SegmentBar } from "@/components/SegmentBar";
import { Button } from "@/components/ui/button";
import { BarStrip } from "@/components/viz/BarStrip";
import { DecisionQueue } from "@/components/viz/DecisionQueue";
import { EventTimeline } from "@/components/viz/EventTimeline";
import { eventTimelineCompact, eventTimelineDay, eventTimelineWeek } from "@/components/viz/EventTimeline.fixtures";
import { FlowGraph } from "@/components/viz/FlowGraph";
import { FLOW_DEPENDENCIES, FLOW_LOOP, FLOW_NOW_MS, FLOW_SYSTEM } from "@/components/viz/FlowGraph.fixtures";
import { HealthGrid } from "@/components/viz/HealthGrid";
import { HEALTH_COLUMNS, HEALTH_NOW_MS, HEALTH_ROWS, HEALTH_ROWS_HEALTHY } from "@/components/viz/HealthGrid.fixtures";
import { IncidentList } from "@/components/viz/IncidentList";
import { NormalBand } from "@/components/viz/NormalBand";
import { PaceBar } from "@/components/viz/PaceBar";
import { PortfolioRows } from "@/components/viz/PortfolioRows";
import { StatTile } from "@/components/viz/StatTile";
import { formatInt, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DEMO_MARKER, DEMO_NOW, INCIDENTS, PEOPLE_14, PORTFOLIO, QUEUE, REVENUE_14, REVENUE_30 } from "@/routes/visual-kit/demo-data";

/**
 * The visual kit, staged with invented figures: every new form at the size a
 * screen uses it, and the alternatives a region is choosing between. Each
 * specimen carries `data-review` so it can be captured on its own.
 */
export function VisualKitRoute() {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-10 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 text-figure text-foreground">Visual kit</h1>
        <p className="m-0 text-sm text-muted-foreground">Every data shape the Tower draws, at the size a screen uses it.</p>
      </header>
      <VisualKitGallery />
    </div>
  );
}

const usd = (value: number) => formatUsd(value, { cents: true });
const usdWhole = (value: number) => formatUsd(value);

export function VisualKitGallery() {
  const average = REVENUE_14.reduce((sum, point) => sum + point.v, 0) / REVENUE_14.length;
  const peopleAverage = PEOPLE_14.reduce((sum, point) => sum + point.v, 0) / PEOPLE_14.length;
  return (
    <div className="flex flex-col gap-10">
      <Group title="Primitives">
        <Specimen id="bar-strip" title="BarStrip — recent days, now highlighted, usual level dashed" className="w-80">
          <BarStrip data={REVENUE_14} tone="text-financial-revenue" baseline={{ value: average, label: `usual ${usd(average)}` }} format={usd} ariaLabel="Revenue a day, last 14 days" />
        </Specimen>
        <Specimen id="bar-strip-gaps" title="BarStrip — a day not reported, today still counting" className="w-80">
          <BarStrip
            data={[...PEOPLE_14.slice(0, 6), { t: PEOPLE_14[6]!.t, v: null }, ...PEOPLE_14.slice(7), { t: "2026-10-11", v: 1800 }]}
            tone="text-traffic"
            provisionalFrom="2026-10-11"
            format={formatInt}
            ariaLabel="People a day, last 15 days"
          />
        </Specimen>
        <Specimen id="pace-bar" title="PaceBar — the month so far, where it is heading, last month's total" className="w-[28rem]">
          <PaceBar value={364} label="Oct so far" previousAtSameDay={null} previousTotal={1127} previousLabel="Sep" projected={1020} tone="text-financial-revenue" format={usdWhole} />
        </Specimen>
        <Specimen id="normal-band" title="NormalBand — a reading against its usual range" className="w-80">
          <NormalBand value={1} low={9} high={17} label="API requests yesterday" unit="a day" bad="below" severity="warn" />
        </Specimen>
        <Specimen id="normal-band-ok" title="NormalBand — within its range" className="w-80">
          <NormalBand value={3891} low={3500} high={4400} label="Visitors yesterday" />
        </Specimen>
      </Group>

      <Group title="Stat figures">
        <Specimen id="stat-figures" title="StatTile — label with window, figure, comparison, history, context; the top rule is its role" className="w-full">
          <div className="grid w-full gap-4 md:grid-cols-3">
            <StatTile
              label="Revenue, yesterday"
              value={11.76}
              format={usd}
              note="est."
              role="money"
              comparison={{ percent: -6.2, change: -0.78, against: "vs last Sat" }}
              history={<BarStrip data={REVENUE_14} tone="text-financial-revenue" baseline={{ value: average, label: `usual ${usd(average)}` }} format={usd} ariaLabel="Revenue a day, last 14 days" />}
              context={<>Plume Studio earned <b>$11.42</b> of it; Mosaic Finder <b>$0.31</b></>}
            />
            <StatTile
              label="Visitors, yesterday"
              value={3891}
              format={formatInt}
              role="people"
              comparison={{ percent: 4.1, change: 153, against: "vs last Sat" }}
              history={<BarStrip data={PEOPLE_14} tone="text-traffic" baseline={{ value: peopleAverage, label: `usual ${formatInt(peopleAverage)}` }} ariaLabel="Visitors a day, last 14 days" />}
              context={<><b>84%</b> of them on Plume Studio</>}
            />
            <StatTile
              label="Data sources failing, now"
              value={3}
              format={formatInt}
              note="of 38"
              role="problem"
              context={<>Uptime and Bing on <b>Summit</b>, and <b>backups</b>; the newest <b>37m</b> ago</>}
            />
          </div>
        </Specimen>
      </Group>

      <Group title="Home: the money region (pick one)">
        <Specimen id="money-a" title="A — one hero: the month on its pace bar beside its daily bars, with yesterday and visitors beside it" className="w-full">
          <MoneyHeroA average={average} peopleAverage={peopleAverage} />
        </Specimen>
        <Specimen id="money-b" title="B — three equal figures, the month's pace bar inside the first" className="w-full">
          <div className="grid w-full gap-4 md:grid-cols-3">
            <StatTile
              label="Revenue, October so far"
              value={364}
              format={usdWhole}
              note="est."
              role="money"
              size="display"
              history={<PaceBar value={364} label="Oct so far" previousAtSameDay={null} previousTotal={1127} previousLabel="Sep" projected={1020} tone="text-financial-revenue" format={usdWhole} />}
              context={<>Heading for <b>$1,020</b> by Oct 31, <b>9% under</b> September</>}
            />
            <StatTile
              label="Revenue, yesterday"
              value={11.76}
              format={usd}
              note="est."
              role="money"
              size="display"
              comparison={{ percent: -6.2, change: -0.78, against: "vs last Sat" }}
              history={<BarStrip data={REVENUE_14} tone="text-financial-revenue" baseline={{ value: average, label: `usual ${usd(average)}` }} format={usd} ariaLabel="Revenue a day, last 14 days" />}
            />
            <StatTile
              label="Visitors, yesterday"
              value={3891}
              format={formatInt}
              role="people"
              size="display"
              comparison={{ percent: 4.1, change: 153, against: "vs last Sat" }}
              history={<BarStrip data={PEOPLE_14} tone="text-traffic" baseline={{ value: peopleAverage, label: `usual ${formatInt(peopleAverage)}` }} ariaLabel="Visitors a day, last 14 days" />}
            />
          </div>
        </Specimen>
      </Group>

      <Group title="Data-source health">
        <Specimen id="health-grid" title="HealthGrid — every site × every data source; the failing cell lights where it lives" className="w-full">
          <HealthGrid rows={HEALTH_ROWS} columns={HEALTH_COLUMNS} nowMs={HEALTH_NOW_MS} action={<a href="#" className="text-xs text-muted-foreground">Integrations →</a>} />
        </Specimen>
        <Specimen id="health-grid-calm" title="HealthGrid, calm: working cells recede so only problems carry colour" className="w-full">
          <HealthGrid rows={HEALTH_ROWS} columns={HEALTH_COLUMNS} nowMs={HEALTH_NOW_MS} calm />
        </Specimen>
        <Specimen id="health-grid-healthy" title="HealthGrid on a good day" className="w-[52rem]">
          <HealthGrid rows={HEALTH_ROWS_HEALTHY} columns={HEALTH_COLUMNS} nowMs={HEALTH_NOW_MS} />
        </Specimen>
        <Specimen id="health-grid-narrow" title="HealthGrid in a narrow column" className="w-[24rem]">
          <HealthGrid rows={HEALTH_ROWS} columns={HEALTH_COLUMNS} nowMs={HEALTH_NOW_MS} />
        </Specimen>
      </Group>

      <Group title="Home: problems">
        <Specimen id="timeline-day" title="EventTimeline — the last 24 hours, one row per site; open problems run to NOW; since-you-looked shaded" className="w-full">
          <EventTimeline {...eventTimelineDay} />
        </Specimen>
        <Specimen id="timeline-week" title="EventTimeline — the last 7 days" className="w-full">
          <EventTimeline {...eventTimelineWeek} />
        </Specimen>
        <Specimen id="timeline-compact" title="EventTimeline, one site's row (for its own page)" className="w-[40rem]">
          <EventTimeline {...eventTimelineCompact} />
        </Specimen>
        <Specimen id="incidents" title="IncidentList — ranked; new since you looked leads; over a week folds into one line" className="w-[40rem]">
          <IncidentList
            items={INCIDENTS.map((item) =>
              item.key === "api-nom"
                ? { ...item, evidence: <NormalBand value={1} low={9} high={17} label="API requests yesterday" unit="a day" bad="below" compact /> }
                : item,
            )}
            nowMs={DEMO_NOW}
            marker={DEMO_MARKER}
            action={{ label: "All alerts →", to: "#" }}
          />
        </Specimen>
      </Group>

      <Group title="Connections">
        <Specimen id="flow-loop" title="FlowGraph — the loop NoticeOS runs, each stage with its live count" className="w-full">
          <FlowGraph {...FLOW_LOOP} nowMs={FLOW_NOW_MS} />
        </Specimen>
        <Specimen id="flow-system" title="FlowGraph — the system: sources → collectors → store → runner → backups" className="w-full">
          <FlowGraph {...FLOW_SYSTEM} nowMs={FLOW_NOW_MS} />
        </Specimen>
        <Specimen id="flow-deps" title="FlowGraph — an epic's tasks, the blocked chain marked" className="w-full">
          <FlowGraph {...FLOW_DEPENDENCIES} nowMs={FLOW_NOW_MS} />
        </Specimen>
      </Group>

      <Group title="Home: decisions and sites">
        <Specimen id="decision-queue" title="DecisionQueue — size, age spread, then the rows with age as a length" className="w-[34rem]">
          <DecisionQueue
            items={QUEUE.map((item) => ({
              ...item,
              actions: (
                <Button size="sm" variant={item.kind === "approval" ? "outline" : "ghost"}>
                  {item.kind === "approval" ? "Approve" : "Answer"}
                </Button>
              ),
            }))}
            total={147}
            action={{ label: "All tasks →", to: "#" }}
          />
        </Specimen>
        <Specimen id="portfolio" title="PortfolioRows — one ruled row per site; names never wrap" className="w-[52rem]">
          <PortfolioRows rows={PORTFOLIO} formatMoney={usd} action={{ label: "All sites →", to: "#" }} />
        </Specimen>
        <Specimen id="portfolio-narrow" title="PortfolioRows in a narrow column" className="w-[22rem]">
          <PortfolioRows rows={PORTFOLIO} formatMoney={usd} />
        </Specimen>
      </Group>
    </div>
  );
}

function MoneyHeroA({ average, peopleAverage }: { average: number; peopleAverage: number }) {
  return (
    <div className="grid w-full gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section className="relative flex flex-col gap-5 overflow-hidden rounded-xl bg-card p-6 shadow-raised ring-1 ring-border/70" data-money-hero="">
        <span aria-hidden className="pointer-events-none absolute -end-24 -top-32 size-80 rounded-full bg-financial-revenue/10 blur-3xl" />
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Revenue, October so far</span>
            <span className="flex items-baseline gap-2">
              <span className="text-display tabular-nums text-foreground">$364</span>
              <span className="text-sm font-medium text-muted-foreground">est.</span>
            </span>
            <span className="text-sm text-muted-foreground">
              Heading for <b className="font-semibold text-foreground">$1,020</b> · <b className="font-semibold text-warn">9% under</b> September
            </span>
          </div>
          <div className="w-full max-w-sm flex-1">
            <BarStrip data={REVENUE_30} tone="text-financial-revenue" baseline={{ value: average, label: `usual ${usd(average)} a day` }} format={usd} ariaLabel="Revenue a day, last 30 days" className="h-20" />
          </div>
        </div>
        <PaceBar value={364} label="Oct so far" previousAtSameDay={null} previousTotal={1127} previousLabel="Sep" projected={1020} tone="text-financial-revenue" format={usdWhole} showValue={false} />
        <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
          <span className="text-xs font-medium text-muted-foreground">Where October came from</span>
          <SegmentBar
            ariaLabel="October revenue by site: Plume Studio $352, Mosaic Finder $12"
            className="h-2"
            segments={[
              { name: "Plume Studio", value: 352, fill: "bg-financial-revenue" },
              { name: "Mosaic Finder", value: 12, fill: "bg-financial-revenue/45" },
            ]}
          />
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-financial-revenue" />Plume Studio <b className="font-semibold text-foreground">$352</b> · 97%</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-financial-revenue/45" />Mosaic Finder <b className="font-semibold text-foreground">$12</b> · 3%</span>
            <span>4 sites earn nothing yet</span>
          </div>
        </div>
      </section>
      <div className="grid gap-4">
        <StatTile
          label="Revenue, yesterday"
          value={11.76}
          format={usd}
          note="est."
          role="money"
          comparison={{ percent: -6.2, change: -0.78, against: "vs last Sat" }}
          history={<BarStrip data={REVENUE_14} tone="text-financial-revenue" baseline={{ value: average, label: `usual ${usd(average)}` }} format={usd} ariaLabel="Revenue a day, last 14 days" className="h-10" />}
        />
        <StatTile
          label="Visitors, yesterday"
          value={3891}
          format={formatInt}
          role="people"
          comparison={{ percent: 4.1, change: 153, against: "vs last Sat" }}
          history={<BarStrip data={PEOPLE_14} tone="text-traffic" baseline={{ value: peopleAverage, label: `usual ${formatInt(peopleAverage)}` }} ariaLabel="Visitors a day, last 14 days" className="h-10" />}
        />
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="m-0 border-b border-border pb-2 text-base font-semibold text-foreground">{title}</h2>
      <div className="flex flex-wrap items-start gap-6">{children}</div>
    </section>
  );
}

function Specimen({ id, title, className, children }: { id: string; title: string; className?: string; children: ReactNode }) {
  return (
    <figure className={cn("m-0 flex max-w-full flex-col gap-3", className)} data-review={id}>
      <figcaption className="text-xs text-muted-foreground">{title}</figcaption>
      <div className="flex min-w-0 [&>*]:min-w-0 [&>*]:flex-1">{children}</div>
    </figure>
  );
}

export default VisualKitRoute;
