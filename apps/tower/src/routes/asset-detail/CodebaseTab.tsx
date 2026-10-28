import { useId, useState, type ReactNode } from "react";
import { useView } from "@/hooks/useView";
import { prioritize, PurposeSections } from "./purpose-presentation";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import type { CodebaseMeasureKey, CodebaseReport, CodebaseSlice } from "@shared/codebase";
import type { SignalTrend } from "@shared/wall";
import { CopyCommand } from "@/components/CopyCommand";
import { DeltaChip, performanceTone } from "@/components/DeltaChip";
import { InfoTooltip } from "@/components/InfoTooltip";
import { SegmentBar } from "@/components/SegmentBar";
import { FileTaskButton } from "@/components/TaskComposer";
import { HeroChart } from "@/components/surface/HeroChart";
import { Kpi, KpiStrip } from "@/components/surface/KpiStrip";
import { ListPanel, ListRow } from "@/components/surface/ListPanel";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { RangeSelector } from "@/components/surface/RangeSelector";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { Card } from "@/components/ui/card";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { formatCompact, formatInt, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  CODEBASE_RANGES,
  INGEST_SECRET,
  TOKEN_SECRET,
  actionWorkflow,
  alignedSeries,
  changeAgainst,
  changeText,
  codebaseAnswer,
  codebaseWidgets,
  complexTaskTitle,
  dayNotes,
  duplicateFiles,
  duplicateTaskTitle,
  findingSource,
  formatFigure,
  languageShares,
  localCommand,
  passText,
  seriesOf,
  toolChanges,
  unmeasuredReason,
  unusedParts,
  unusedTaskTitle,
  visitorsChange,
  vulnerableTaskTitle,
  type CodebaseRange,
  type CodebaseWidget,
} from "@/routes/asset-detail/codebase-measures";
import { timelineAnnotations } from "@/routes/asset-detail/shared";

/**
 * The Codebase tab: whether the site's code is growing, repeating itself,
 * carrying unused parts or gathering hard-to-change functions, beside its
 * visitors. One sentence, five figures with their 30-day change and 90-day
 * line, the build, test and vulnerable-package checks the site's own workflow
 * sends, the code's size over time with deploys marked, its languages, and
 * the findings each as a task. A site that has never sent a report gets the
 * ways to send one.
 */
export function CodebaseTab({ data, nowMs }: { data: AssetDetailFor<"codebase">; nowMs: number }) {
  const slice = data.codebase;
  const { view } = useView();
  const answerId = useId();
  const visitors = visitorsChange(data.performance.activeUsers);
  const answer = codebaseAnswer(slice, visitors);

  if (!slice.latest) {
    return (
      <div className="@container flex flex-col gap-5" data-codebase="setup">
        <section data-surface-hero="" aria-labelledby={answerId} className="flex flex-col gap-4">
          <PageAnswer id={answerId} answer={answer.answer} detail="Send the first report one of these ways."
            marks={{ "data-codebase-answer": "" }} />
          <CodebaseSetup assetId={data.asset.id} />
        </section>
      </div>
    );
  }

  const report = slice.latest.report;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const deploys = timelineAnnotations(data.annotations.items.filter((item) => item.kind === "deploy"));
  const widgets = prioritize(codebaseWidgets(slice), view.id === "reliability"
    ? ["vulnerable", "tests", "complex", "unused", "repeated", "size", "build", "testRun"]
    : view.id === "delivery" ? ["tests", "complex", "unused", "repeated", "size", "build", "testRun", "vulnerable"] : []);
  const strip = (name: CodebaseWidget["strip"]) => widgets.filter((widget) => widget.strip === name);

  return (
    <PurposeSections surface="codebase" className="@container flex flex-col gap-5" data-codebase="report">
      <section key="hero" data-surface-hero="" aria-labelledby={answerId} className="flex flex-col gap-4">
        <PageAnswer id={answerId} answer={answer.answer} detail={answer.detail} marks={{ "data-codebase-answer": "" }} />
        <Card className="overflow-hidden">
          <KpiStrip columns={5}>
            {strip("code").map((widget) => (
              <WidgetKpi key={widget.key} widget={widget} report={report} />
            ))}
          </KpiStrip>
          <div className="border-t border-border" data-codebase-checks="">
            <KpiStrip columns={3}>
              {strip("checks").map((widget) => (
                <WidgetKpi key={widget.key} widget={widget} report={report} />
              ))}
            </KpiStrip>
          </div>
          <CodeChart slice={slice} today={today} deploys={deploys}
            activeUsers={data.performance.activeUsers} site={data.asset.displayName} />
        </Card>
      </section>

      <Languages key="languages" report={report} />

      <Findings key="findings" slice={slice} report={report} assetId={data.asset.id} site={data.asset.displayName} />
    </PurposeSections>
  );
}

// --- the figures ----------------------------------------------------------------

/** Under this, a change is noise and gets no colour (the strip's own floor). */
const VERDICT_FLOOR_PERCENT = 2;

function WidgetKpi({ widget, report }: { widget: CodebaseWidget; report: CodebaseReport }) {
  const { change } = widget;
  const parts = widget.key === "unused" ? unusedParts(report.measures) : null;
  // A pass or fail has no size to set against a month before: it shows how many reports passed.
  const pass = widget.unit === "pass";
  return (
    <Kpi
      label={widget.label}
      value={widget.value === null
        ? <span className="text-base font-medium tracking-normal text-muted-foreground" data-codebase-unmeasured="">Not measured</span>
        : formatFigure(widget.unit, widget.value)}
      valueTone={pass && widget.value === 0 ? "error" : "default"}
      note={widget.value === null ? undefined : widget.note ?? undefined}
      caption={widget.value === null
        ? widget.unmeasured
        : pass ? (widget.passes ? passText(widget.passes) : undefined)
        : !change ? "No report from a month before yet"
        : change.change === 0 ? `No change in ${change.days} days`
        : <ChangeChip widget={widget} />}
      explanation={<>
        <span>{widget.meaning}</span>
        {change && !pass ? <span className="tabular-nums">{changeAgainst(change)}: {formatFigure(widget.unit, change.from.value)} → {formatFigure(widget.unit, change.to.value)}</span> : null}
      </>}
      spark={widget.spark}
      sparkLabel={`${widget.label} · 90 days`}
      sparkAverage={false}
      sparkTone="neutral"
      seriesUnavailable={widget.value === null ? undefined : "Fewer than three days of reports so far"}
      format={(value) => formatFigure(widget.unit, value)}
      footer={parts ? <span className="text-xs tabular-nums text-muted-foreground">{parts}</span> : undefined}
    />
  );
}

function ChangeChip({ widget }: { widget: CodebaseWidget }) {
  const change = widget.change!;
  const relative = change.percent ?? (change.change === 0 ? 0 : 100);
  const good = widget.improvement === "none" ? 0 : widget.improvement === "up" ? Math.sign(change.change) : -Math.sign(change.change);
  const tone = good === 0 || Math.abs(relative) < VERDICT_FLOOR_PERCENT ? "neutral" : performanceTone(good * Math.abs(relative));
  const text = changeText(widget.unit, change);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <DeltaChip
        value={change.change}
        render={() => text}
        tone={tone}
        meaning={`${text} ${change.change >= 0 ? "up" : "down"} ${changeAgainst(change)}`}
        className="text-xs"
      />
      <span>in {change.days} days</span>
    </span>
  );
}

// --- the code's size over time ------------------------------------------------

const codeLines = (measures: CodebaseReport["measures"]) => measures.code_lines ?? null;

function CodeChart({ slice, today, deploys, activeUsers, site }: {
  slice: CodebaseSlice;
  today: string;
  deploys: ReturnType<typeof timelineAnnotations>;
  activeUsers: SignalTrend;
  site: string;
}) {
  const [range, setRange] = useState<CodebaseRange>(90);
  const [visitors, setVisitors] = useState(false);
  const days = alignedSeries(slice.history, codeLines, today, range);
  const marks = [...deploys, ...toolChanges(slice.history)];
  const hasVisitors = activeUsers.series.length > 0;
  return (
    <div className="flex flex-col gap-3 border-t border-border p-4 max-sm:p-3" data-codebase-chart="">
      <div className="flex flex-wrap items-center gap-2">
        <RangeSelector value={range} options={CODEBASE_RANGES} label="Chart range"
          onChange={(next) => setRange(next as CodebaseRange)} />
        {hasVisitors ? (
          <button type="button" aria-pressed={visitors} onClick={() => setVisitors((on) => !on)}
            className={cn(pillChoiceClass, pillChoiceStateClass(visitors))} data-codebase-visitors="">
            Visitors
          </button>
        ) : null}
      </div>
      <HeroChart
        series={[{ name: "Lines of code", points: seriesOf(days), tone: "primary" }]}
        range={range}
        end={today}
        variant="step"
        weekends={false}
        notesByDate={dayNotes(days)}
        annotations={marks}
        format={formatCompact}
        formatValue={formatInt}
        emptyLabel="No reports in this range"
        ariaLabel={`${site} lines of code over the last ${range} days`}
        footnote={<span>Between two reports the line holds the earlier report's count.</span>}
      />
      {visitors ? (
        <HeroChart
          series={[{
            name: "Visitors a day",
            points: [...(activeUsers.contextSeries ?? []), ...activeUsers.series],
            tone: "traffic",
            provisionalFrom: activeUsers.provisionalFrom,
          }]}
          range={range}
          end={today}
          height={160}
          annotations={deploys}
          provisionalFrom={activeUsers.provisionalFrom}
          emptyLabel="No visitors reported in this range"
          ariaLabel={`${site} visitors a day over the last ${range} days`}
        />
      ) : null}
    </div>
  );
}

// --- languages ------------------------------------------------------------------

/** One ink, stepped lighter by rank: the bar shows proportion, and the names
 * and shares beside it say which is which. */
const LANGUAGE_FILLS = ["bg-foreground/80", "bg-foreground/55", "bg-foreground/35", "bg-foreground/20", "bg-foreground/10", "bg-muted-foreground/25"];

function Languages({ report }: { report: CodebaseReport }) {
  const shares = languageShares(report.byLanguage);
  if (shares.length === 0) return null;
  const files = report.measures.files;
  const share = (value: number) => `${formatPercent(value * 100)}%`;
  return (
    <section className="flex flex-col gap-2" data-codebase-languages="">
      <SectionLabel title="Languages" caption={files === undefined ? undefined : `${formatInt(files)} files`} />
      <Card className="flex flex-col gap-3 p-4">
        <SegmentBar
          className="h-2.5"
          ariaLabel={`Code by language: ${shares.map((one) => `${one.name} ${share(one.share)}`).join(", ")}`}
          segments={shares.map((one, index) => ({ name: one.name, value: one.lines, fill: LANGUAGE_FILLS[index] ?? LANGUAGE_FILLS.at(-1)! }))}
        />
        <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1.5 p-0 text-xs">
          {shares.map((one, index) => (
            <li key={one.name} className="inline-flex items-center gap-1.5 tabular-nums">
              <span aria-hidden className={cn("size-2.5 rounded-sm", LANGUAGE_FILLS[index] ?? LANGUAGE_FILLS.at(-1))} />
              <span className="font-medium text-foreground">{one.name}</span>
              <span className="text-muted-foreground">{share(one.share)} · {formatInt(one.lines)} lines</span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

// --- findings ----------------------------------------------------------------------

/** "20 of 37": a bounded list says how much of the whole it is. */
function shownOf(shown: number, total: number | undefined): string {
  return total !== undefined && total > shown ? `${shown} of ${formatInt(total)}` : formatInt(shown);
}

function Findings({ slice, report, assetId, site }: { slice: CodebaseSlice; report: CodebaseReport; assetId: string; site: string }) {
  const { measures, findings } = report;
  const source = findingSource(slice);
  const task = (title: string, subject: string): ReactNode => (
    <FileTaskButton
      label="Make a task"
      variant="outline"
      className="h-8"
      subject={subject}
      prefill={{ project: assetId, title, description: source }}
    />
  );
  const notMeasured = (keys: readonly CodebaseMeasureKey[]) => `Not measured · ${unmeasuredReason(keys, report)}`;
  return (
    <section className="flex flex-col gap-2" data-codebase-findings="">
      <SectionLabel title="Findings" caption="From the latest report" />
      <div className="grid gap-3.5 @3xl:grid-cols-2 [&>*]:min-w-0">
        <ListPanel
          title="Repeated blocks"
          count={findings.duplicates.length > 0 ? shownOf(findings.duplicates.length, measures.duplicate_blocks) : undefined}
          empty={measures.duplication_percent === undefined ? notMeasured(["duplication_percent"]) : "No repeated blocks found."}
        >
          {findings.duplicates.map((duplicate, index) => (
            <ListRow
              key={index}
              glyph="△"
              title={duplicateFiles(duplicate)}
              caption={duplicate.files.map((file) => `line ${formatInt(file.startLine)}`).join(" · ")}
              value={formatInt(duplicate.lines)}
              valueLabel="lines"
              rowActions={task(duplicateTaskTitle(duplicate), duplicateFiles(duplicate))}
              marks={{ "data-codebase-duplicate": String(index) }}
            >
              <ul className="m-0 grid list-none gap-0.5 p-0 font-mono">
                {duplicate.files.map((file) => <li key={`${file.path}:${file.startLine}`}>{file.path}:{file.startLine}</li>)}
              </ul>
            </ListRow>
          ))}
        </ListPanel>

        <ListPanel
          title="Hard-to-change functions"
          count={
            <span className="inline-flex items-center gap-1">
              {findings.complexFunctions.length > 0 ? shownOf(findings.complexFunctions.length, measures.complex_functions) : null}
              <InfoTooltip label="About complexity">
                Complexity counts paths through a function. Above 15 is hard to change.
              </InfoTooltip>
            </span>
          }
          empty={measures.complex_functions === undefined ? notMeasured(["complex_functions"]) : "No hard-to-change functions found."}
        >
          {findings.complexFunctions.map((fn, index) => (
            <ListRow
              key={`${fn.path}:${fn.line}`}
              glyph="△"
              title={<span className="font-mono">{fn.name}</span>}
              caption={`${fn.path}:${fn.line} · ${formatInt(fn.length)} lines`}
              value={`complexity ${formatInt(fn.complexity)}`}
              rowActions={task(complexTaskTitle(fn), fn.name)}
              marks={{ "data-codebase-complex": String(index) }}
            />
          ))}
        </ListPanel>

        <ListPanel
          title="Unused"
          count={findings.unused.length > 0 ? formatInt(findings.unused.length) : undefined}
          empty={unusedParts(measures) === null ? notMeasured(["unused_files", "unused_exports", "unused_dependencies"]) : "Nothing unused found."}
        >
          {findings.unused.map((item, index) => (
            <ListRow
              key={index}
              glyph="△"
              title={<span className="font-mono">{item.kind === "file" ? item.path : item.name}</span>}
              caption={item.kind === "file" ? "File" : item.kind === "export" ? `Shared piece in ${item.path}` : "Package"}
              rowActions={task(unusedTaskTitle(item), item.kind === "file" ? item.path : item.name)}
              marks={{ "data-codebase-unused": item.kind }}
            />
          ))}
        </ListPanel>

        <ListPanel
          title="Vulnerable packages"
          empty={measures.vulnerable_dependencies === undefined ? notMeasured(["vulnerable_dependencies"]) : "No vulnerable packages found."}
        >
          {measures.vulnerable_dependencies ? (
            <ListRow
              glyph="△"
              title={`${formatInt(measures.vulnerable_dependencies)} ${measures.vulnerable_dependencies === 1 ? "package has" : "packages have"} a known vulnerability`}
              caption="Counted by the package audit in this asset's workflow"
              rowActions={task(vulnerableTaskTitle(measures.vulnerable_dependencies, site), "vulnerable packages")}
              marks={{ "data-codebase-vulnerable": "" }}
            />
          ) : null}
        </ListPanel>
      </div>
    </section>
  );
}

// --- the first report ---------------------------------------------------------------

type Way = "action" | "local";

function CodebaseSetup({ assetId }: { assetId: string }) {
  const [way, setWay] = useState<Way>("action");
  const choice = (key: Way, label: string) => (
    <button type="button" aria-pressed={way === key} onClick={() => setWay(key)}
      className={cn(pillChoiceClass, pillChoiceStateClass(way === key))}>
      {label}
    </button>
  );
  return (
    <Card id="codebase-setup" className="scroll-mt-4 flex flex-col gap-4 p-4" data-codebase-setup="">
      <div role="group" aria-label="Ways to send a report" className="flex flex-wrap items-center gap-1.5">
        {choice("action", "GitHub Action")}
        {choice("local", "Local command")}
        <button type="button" disabled className={cn(pillChoiceClass, "border-dashed border-border text-muted-foreground opacity-70")}>
          Central pull · coming later
        </button>
      </div>
      {way === "action" ? (
        <div className="grid gap-3" data-codebase-way="action">
          <Steps steps={[
            <>
              Add repository secrets <code className="font-mono text-xs">{TOKEN_SECRET}</code>, the asset's token, and{" "}
              <code className="font-mono text-xs">{INGEST_SECRET}</code>, the ingest address.
            </>,
            <>
              <span>Save this as <code className="font-mono text-xs break-all">.github/workflows/codebase-report.yml</code>.</span>
              <CopyCommand block label="the workflow file" command={actionWorkflow(assetId)} mark={{ "data-codebase-workflow": "" }} />
            </>,
            "Push to main. A report runs on every push and every Monday.",
          ]} />
          <p className="m-0 text-xs text-muted-foreground">
            If GitHub cannot reach this installation, use the local command.
          </p>
        </div>
      ) : (
        <div data-codebase-way="local">
          <Steps steps={[
            <>
              <span>In the NoticeOS folder, run this with the path to your code:</span>
              <CopyCommand command={localCommand(assetId)} mark={{ "data-codebase-command": "" }} />
            </>,
            "The report reads the code without running it and arrives here.",
          ]} />
        </div>
      )}
    </Card>
  );
}

function Steps({ steps }: { steps: ReactNode[] }) {
  return (
    <ol className="m-0 grid list-none gap-3 p-0 text-sm">
      {steps.map((step, index) => (
        <li key={index} className="flex min-w-0 items-start gap-2.5">
          <span aria-hidden className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-border text-[11px] tabular-nums text-muted-foreground">
            {index + 1}
          </span>
          <span className="grid min-w-0 flex-1 gap-2">{step}</span>
        </li>
      ))}
    </ol>
  );
}
