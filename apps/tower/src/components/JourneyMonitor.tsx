import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowDown, Plus, Users } from "lucide-react";
import { type JourneyDefinition, type JourneyPeriod, type JourneySnapshot } from "@noticeos/contract/journeys";
import { Button } from "@/components/ui/button";
import { JourneyDefinitionEditor } from "@/components/JourneyDefinitionEditor";
import { formatCalendarDate, formatCalendarRange, formatInt, formatTimestamp } from "@/lib/format";
import { journeyComparison, journeyReading, journeyStepChange, journeyStepContinuation, journeyWindow, matchingJourneyResult, previousJourneyWeek, type JourneyReading } from "@/lib/journey-presentation";
import "./JourneyMonitor.css";
export interface JourneySaveOutcome {
    saved: boolean;
    refusal?: string;
    undo?: () => Promise<{
        undone: boolean;
        refusal?: string;
    }>;
}
export interface JourneyMonitorProps {
    definitions: readonly JourneyDefinition[];
    snapshot: JourneySnapshot | null;
    onSave?: (next: JourneyDefinition[]) => Promise<JourneySaveOutcome>;
    readOnlyReason?: string | null;
    eventNames?: readonly string[];
    illustrative?: boolean;
}
function percent(value: number | null) { return value === null ? "—" : `${Number(value.toFixed(1))}%`; }
function trend(value: number | null) { return value === null || Math.abs(value) < 0.0001 ? "neutral" : value > 0 ? "positive" : "negative"; }
function useAnimatedNumber(target: number | null) {
    const [value, setValue] = useState(target);
    const previous = useRef(target);
    useEffect(() => {
        const before = previous.current;
        previous.current = target;
        if (before === target || before === null || target === null || typeof requestAnimationFrame !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
            setValue(target);
            return;
        }
        let frame = 0;
        const start = performance.now();
        const tick = (now: number) => { const p = Math.min(1, (now - start) / 500); setValue(before + (target - before) * (1 - (1 - p) ** 3)); if (p < 1)
            frame = requestAnimationFrame(tick); };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [target]);
    return value;
}
function Count({ value }: {
    value: number | null;
}) { const current = useAnimatedNumber(value); return <>{current === null ? "—" : formatInt(Math.round(current))}</>; }
function Rate({ value }: {
    value: number | null;
}) { const current = useAnimatedNumber(value); return <>{percent(current)}</>; }
function JourneySummary({ definition, reading, delta, prior, compare, available }: {
    definition: JourneyDefinition;
    reading: JourneyReading;
    delta: number | null;
    prior: JourneyPeriod | null;
    compare: boolean;
    available: boolean;
}) {
    const loss = reading.largestLoss;
    const lost = loss === null ? null : reading.counts[loss - 1]! - reading.counts[loss]!;
    const lossRate = lost !== null && loss !== null && reading.counts[loss - 1]! > 0 ? lost / reading.counts[loss - 1]! * 100 : null;
    return <div className="journey-summary" data-surface-hero>
    <div className="journey-kpi journey-kpi-visitors">
    <span className="journey-kpi-label"><Users aria-hidden/>Visitors</span>
    <strong className="journey-kpi-number"><Count value={available ? reading.visitors : null}/></strong>
    <p>{reading.visitors === null ? "Visitor baseline unavailable" : reading.visitors === 0 ? "No measured visitors" : "100% · all measured visitors"}</p>
    </div>
    <div className="journey-kpi journey-kpi-outcome">
    <span className="journey-kpi-label">{definition.status === "planned" ? "Planned outcome" : "Completed"}</span>
    <div className="journey-summary-rate">
    <strong>
    <Rate value={available ? reading.rate : null}/>
    </strong>
    </div>
    <span className="journey-kpi-basis">of {reading.rateBasis}</span><p>
    <Count value={available ? reading.counts.at(-1) ?? null : null}/> · {definition.steps.at(-1)?.label}</p>
    </div>
    <div className="journey-kpi journey-kpi-loss">
    <span className="journey-kpi-label">Largest step loss</span>
    <strong className="journey-kpi-number">
    <Rate value={available ? lossRate : null}/>
    </strong>
    <span className="journey-kpi-basis">step drop-off · <Count value={available ? lost : null}/> people</span>
    <p>{loss === null ? "No measured loss" : `${definition.steps[loss - 1]!.label} → ${definition.steps[loss]!.label}`}</p>
    </div>
    <div className="journey-kpi journey-kpi-change" data-trend={available && compare ? trend(delta) : "neutral"}>
    <span className="journey-kpi-label">Change in completion</span>
    <strong className="journey-kpi-number">{available && compare && delta !== null ? `${delta >= 0 ? "+" : ""}${Number(delta.toFixed(1))} pts` : "—"}</strong>
    <p>{!compare ? "Comparison off" : prior && delta !== null ? `vs ${formatCalendarRange(prior.startDate, prior.endDate)}` : "No comparable prior period"}</p>
    </div>
  </div>;
}
/** Ordered users and same-session exploration retain separate measurement states. */
export function JourneyMonitor({ definitions, snapshot, onSave, readOnlyReason, eventNames = [], illustrative = false }: JourneyMonitorProps) {
    const [selectedId, setSelectedId] = useState(definitions[0]?.id ?? "");
    const [days, setDays] = useState<7 | 28>(28);
    const [compare, setCompare] = useState(true);
    const [view, setView] = useState<"steps" | "history">("steps");
    const [weekKey, setWeekKey] = useState<string | null>(null);
    const [selectedWeekKey, setSelectedWeekKey] = useState<string | null>(null);
    const [selectedStep, setSelectedStep] = useState<string | null>(null);
    const [editing, setEditing] = useState<JourneyDefinition | "new" | null>(null);
    const definition = definitions.find((item) => item.id === selectedId) ?? definitions[0] ?? null;
    const result = definition ? matchingJourneyResult(definition, snapshot?.funnels ?? []) : null;
    const weeks = [...(result?.weekly ?? [])].sort((a, b) => a.startDate.localeCompare(b.startDate));
    const selectedWeek = weeks.find((week) => week.startDate === selectedWeekKey) ?? weeks.at(-1) ?? null;
    const weeklyPeriod = weeks.find((week) => week.startDate === weekKey) ?? null;
    const period = view === "history" ? selectedWeek : weeklyPeriod ?? (days === 7 ? result?.current7 : result?.current28) ?? null;
    const prior = period && (view === "history" || weeklyPeriod) ? previousJourneyWeek(period, weeks) : (days === 7 ? result?.prior7 : result?.prior28) ?? null;
    const reading = definition ? journeyReading(definition, period) : { counts: [], rate: null, largestLoss: null, reason: null, visitors: null, visitorReason: null, rateBasis: "entrants" as const };
    const before = definition ? journeyReading(definition, prior) : null;
    const delta = definition ? journeyComparison(definition, period, prior) : null;
    const stepIndex = definition ? Math.max(0, definition.steps.findIndex((step) => step.id === selectedStep)) : 0;
    const selectedIndex = selectedStep === null ? reading?.largestLoss ?? 0 : stepIndex;
    const scope = period ? formatCalendarRange(period.startDate, period.endDate) : `Last ${days} complete days`;
    const listRef = useRef<HTMLDivElement>(null);
    const [highlight, setHighlight] = useState({ top: 0, height: 0 });
    const [ready, setReady] = useState(false);
    useEffect(() => { setReady(true); }, []);
    useLayoutEffect(() => {
        const list = listRef.current;
        const measure = () => { const row = list?.querySelector<HTMLElement>(`[data-step-index="${selectedIndex}"]`); if (row)
            setHighlight({ top: row.offsetTop, height: row.offsetHeight }); };
        measure();
        if (!list || typeof ResizeObserver === "undefined")
            return;
        const observer = new ResizeObserver(measure);
        observer.observe(list);
        return () => observer.disconnect();
    }, [selectedIndex, definition?.id, days, weekKey, view, reading?.counts.length]);
    function choose(id: string) { setSelectedId(id); setView("steps"); setWeekKey(null); setSelectedWeekKey(null); setSelectedStep(null); setEditing(null); }
    const canRead = definition?.status === "active" && definition.kind === "funnel";
    const qualityReason = definition?.kind === "exploration" ? snapshot?.exploration.reason ?? "Session paths require separate collection. Ordered user funnels do not measure session destinations." : definition?.status === "planned" ? "This journey is planned. Activate its definition when collection is ready." : reading.reason;
    return <div className="journey-monitor" data-journey-monitor data-ready={ready} data-kind={definition?.kind}>
    <aside className="journey-goals" aria-label="Journey goals">
    <div className="journey-eyebrow">BUSINESS GOALS</div>
    <div className="journey-goal-list">{definitions.map((item) => <button type="button" key={item.id} className="journey-goal" aria-pressed={definition?.id === item.id} onClick={() => choose(item.id)}>
        <span>{item.goal || item.label}</span>{item.status === "planned" ? <small>Planned</small> : <span aria-hidden>›</span>}</button>)}</div>
    <Button variant="ghost" size="sm" onClick={() => setEditing("new")} disabled={!onSave || definitions.length >= 8}>
    <Plus aria-hidden/>New journey</Button>
    <details className="journey-coverage">
    <summary>Data coverage</summary>
    <p>Conversions use ordered users from one GA4 property and reporting time zone. Independent event totals are not conversion counts.</p>
    <p>Visitors are GA4 active users for the same dates. Visitor percentages show the reach of each ordered step. Step drop-off compares consecutive journey steps.</p>
    <p>Changed definitions start a separate series. Incomplete or sampled reports do not receive improvement or regression colours.</p>
    </details>
    </aside>
    <div className="journey-main">
      <div className="journey-heading">
    <div>
    <div className="journey-eyebrow">{definition?.goal ?? "JOURNEYS"}</div>
    <h2>{definition?.label ?? "Measure a journey"}</h2>
    <p>{definition?.kind === "exploration" ? "Session paths · separate collection required" : "Google Analytics 4 · ordered users"}</p>
    </div>
    <div className="journey-heading-actions">{illustrative ? <span className="journey-sample">Illustrative design data</span> : null}{definition ? <Button size="sm" variant="outline" onClick={() => setEditing(definition)}>Definition</Button> : null}</div>
    </div>
      {!definition ? <div className="journey-empty" data-surface-hero>
        <h3>Define the steps that matter</h3>
        <p>Create an account, activation or another outcome journey. Its ordered report will appear after collection.</p>
        <Button onClick={() => setEditing("new")} disabled={!onSave}>Create journey</Button>
        </div> : <>
        <div className="journey-toolbar">{view === "history" || weeklyPeriod ? <div className="journey-week-scope">
            <strong>{view === "history" ? "Selected week" : "Viewing week"} · {scope}</strong>
            <Button size="sm" variant="ghost" onClick={() => { setWeekKey(null); setView("steps"); }}>Return to {days}-day period</Button>
            </div> : <div className="journey-period" aria-label="Journey reporting period">{([28, 7] as const).map((value) => <button type="button" key={value} aria-pressed={days === value} onClick={() => setDays(value)}>{value} days</button>)}</div>}{view === "steps" ? <label className="journey-compare">
            <input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)}/>Compare prior period</label> : null}</div>
        {definition.kind === "funnel" ? <JourneySummary definition={definition} reading={reading} delta={delta} prior={prior} compare={compare} available={!!canRead}/> : null}
        <section className="journey-chart" aria-label={view === "history" ? "Journey history" : "Journey steps"}>
        <div className="journey-chart-heading">
        <div>
        <h3>{view === "history" ? "Completion over time" : definition.kind === "exploration" ? "Session destinations" : "From visitors to outcome"}</h3>
        <p>{view === "history" ? "Complete weeks · each point uses one ordered population" : scope}</p>
        </div>
        <span>{definition.kind === "exploration" ? "Sessions" : "People"}</span>
        </div>
        <div className="journey-view-controls" aria-label="Journey chart view">
        <button type="button" aria-pressed={view === "steps"} onClick={() => setView("steps")}>Steps</button>
        <button type="button" aria-pressed={view === "history"} onClick={() => setView("history")} disabled={!canRead}>Over time</button>
        </div>
          {!canRead || !reading?.counts.length && view === "steps" ? <div className="journey-quality" data-surface-hero={definition.kind === "exploration" ? "" : undefined} role="status" data-status-for="read:journeys">
            <strong>{definition.kind === "exploration" ? "Session paths are not collected" : definition.status === "planned" ? "Planned journey" : "Ordered conversion is unavailable"}</strong>
            <p>{qualityReason}</p>
            <ol>{definition.steps.map((step) => <li key={step.id}>{step.label}</li>)}</ol>
            </div> : view === "history" ? <JourneyHistory definition={definition} weeks={weeks} selectedWeek={selectedWeek} selectedStep={selectedIndex} onSelect={(week, index) => { setSelectedWeekKey(week.startDate); if (index !== undefined)
                setSelectedStep(definition.steps[index]!.id); }}/> : <>
            <div className="journey-baseline" data-available={reading.visitors !== null}>
            <span className="journey-baseline-label"><Users aria-hidden/><span>Visitors<small><Count value={reading.visitors}/> people</small></span></span>
            <span className="journey-baseline-plot"><i style={{ width: reading.visitors !== null && reading.visitors > 0 ? "100%" : "0%" }}/></span>
            <span className="journey-step-count"><strong>{reading.visitors !== null && reading.visitors > 0 ? "100%" : "—"}</strong><small>starting point</small></span>
            </div>
            <p className="journey-baseline-note">{reading.visitors === null ? `${reading.visitorReason} Step percentages use journey entrants.` : `${formatInt(reading.counts[0] ?? 0)} entered this journey · ${percent(reading.visitors > 0 ? (reading.counts[0] ?? 0) / reading.visitors * 100 : null)} of visitors`}</p>
            <div className="journey-ruler" aria-hidden>{[0,25,50,75,100].map((value) => <span key={value}>{value}%</span>)}</div>
            <div className="journey-bars" ref={listRef}>
            <div className="journey-selected" style={{ height: highlight.height, transform: `translateY(${highlight.top}px)` }} data-loss={selectedIndex === reading.largestLoss}/>{definition.steps.map((step, index) => {
                    const count = reading.counts[index] ?? null;
                    const previous = index > 0 ? reading.counts[index - 1] ?? null : reading.visitors;
                    const lost = count !== null && previous !== null ? previous - count : null;
                    const scale = reading.visitors ?? reading.counts[0] ?? 0;
                    const share = count !== null && scale > 0 ? count / scale * 100 : null;
                    const priorScale = before?.visitors ?? before?.counts[0] ?? 0;
                    const priorShare = before?.counts[index] !== undefined && priorScale > 0 ? before.counts[index]! / priorScale * 100 : null;
                    const dropoff = lost !== null && previous !== null && previous > 0 ? lost / previous * 100 : null;
                    return <button type="button" key={step.id} data-step-index={index} data-largest-loss={index === reading.largestLoss} data-outcome={index === definition.steps.length - 1} aria-pressed={index === selectedIndex} className="journey-step" onClick={() => setSelectedStep(step.id)} aria-label={`Inspect ${step.label}`}>
                    <span className="journey-step-label">
                    <small>{String(index + 1).padStart(2, "0")}</small>
                    <span>{step.label}<small><Count value={count}/> people</small>{index === reading.largestLoss ? <small className="journey-loss-label">Largest loss</small> : null}
                    </span>
                    </span>
                    <span className="journey-step-plot">{lost !== null && count !== null && scale > 0 ? <span className="journey-loss-gap" style={{ left: `${share}%`, width: `${lost / scale * 100}%` }}/> : null}<span className="journey-current" style={{ width: `${share ?? 0}%` }}/>{compare && priorShare !== null && delta !== null ? <span className="journey-prior" style={{ width: `${priorShare}%` }}/> : null}<span className="journey-step-dropoff" data-loss={index === reading.largestLoss}>{index === 0 && reading.visitors === null ? "Journey entry" : <><ArrowDown aria-hidden/><b>{percent(dropoff)} {index === 0 ? "did not enter" : "drop-off"}</b><span>· {lost === null ? "—" : formatInt(lost)} people</span></>}</span></span>
                    <span className="journey-step-count">
                    <strong>
                    <Rate value={share}/>
                    </strong>
                    <small>of {reading.rateBasis}</small>
                    </span>
                    </button>;
                })}</div>
            <div className="journey-legend">
            <span>
            <i />{weeklyPeriod ? "Selected week" : `${days} days`}</span>{compare && delta !== null ? <span>
                <i className="journey-legend-prior"/>Prior period share</span> : null}<span>
            <i className="journey-legend-loss"/>Did not continue</span>
            </div>
          </>}
        </section>
        {view === "history" && selectedWeek && canRead ? <HistoryInspector definition={definition} period={selectedWeek} prior={previousJourneyWeek(selectedWeek, weeks)} index={selectedIndex} onView={() => { setWeekKey(selectedWeek.startDate); setView("steps"); }}/> : reading?.counts.length && canRead ? <StepInspector definition={definition} period={period!} index={selectedIndex}/> : null}
        <div className="journey-scope">{definition.kind === "exploration" ? "Session exploration · not an ordered user funnel" : journeyWindow(definition)}{result ? ` · ${result.timeZone} · GA4 active users` : ""}{result ? ` · collected ${formatTimestamp(result.collectedAt, result.timeZone)}` : snapshot?.generatedAt ? ` · snapshot ${formatTimestamp(snapshot.generatedAt)}` : ""}{illustrative ? " · synthetic fixture" : ""}</div>
      </>}
      {editing ? <JourneyDefinitionEditor key={editing === "new" ? "new" : editing.id} definition={editing === "new" ? null : editing} definitions={definitions} eventNames={eventNames} onSave={onSave} readOnlyReason={readOnlyReason} onClose={() => setEditing(null)} onSelected={setSelectedId}/> : null}
    </div>
  </div>;
}
function StepInspector({ definition, period, index }: {
    definition: JourneyDefinition;
    period: JourneyPeriod;
    index: number;
}) {
    const { counts } = journeyReading(definition, period);
    const count = counts[index] ?? 0;
    const previous = index > 0 ? counts[index - 1] ?? 0 : null;
    const step = definition.steps[index]!;
    return <section className="journey-inspector" aria-live="polite">
    <div>
    <div className="journey-eyebrow">{index === 0 ? "ROUTE ENTRY" : "SELECTED STEP"}</div>
    <h3>{step.label}</h3>
    <p>{index === 0 ? `${formatInt(count)} people entered this route.` : `${formatInt(count)} of ${formatInt(previous ?? 0)} people continued · ${percent(previous ? count / previous * 100 : null)}`}</p>
    <details>
    <summary>Event mapping and scope</summary>{step.alternatives.map((alternative, i) => <p key={i}>
        <code>{alternative.eventName}</code>{alternative.pagePath ? ` · exact page path ${alternative.pagePath}` : ""}{alternative.parameters?.map((parameter) => ` · ${parameter.name} = ${parameter.value}`).join("")}{i > 0 ? " · OR alternative" : ""}</p>)}<p>{formatCalendarRange(period.startDate, period.endDate)} · ordered users</p>
    </details>
    </div>
    <div className="journey-inspector-count">
    <Count value={index === 0 ? count : (previous ?? 0) - count}/>
    <small>{index === 0 ? "people entered" : "people did not continue"}</small>
    </div>
    </section>;
}
function HistoryInspector({ definition, period, prior, index, onView }: {
    definition: JourneyDefinition;
    period: JourneyPeriod;
    prior: JourneyPeriod | null;
    index: number;
    onView: () => void;
}) {
    const reading = journeyReading(definition, period);
    const delta = journeyComparison(definition, period, prior);
    return <section className="journey-inspector journey-history-inspector" aria-live="polite">
    <div>
    <div className="journey-eyebrow">{formatCalendarRange(period.startDate, period.endDate)}</div>
    <h3>{percent(reading.rate)} of {reading.rateBasis} completed</h3>{delta !== null ? <p data-trend={trend(delta)}>{delta >= 0 ? "+" : ""}{Number(delta.toFixed(1))} percentage points vs prior complete week</p> : <p>{reading.reason ?? "No matching prior complete week is available."}</p>}{index > 0 ? <p>{definition.steps[index]?.label}: {percent(journeyStepContinuation(definition, period, index))} continued{journeyStepChange(definition, period, prior, index) === null ? "" : ` · ${(journeyStepChange(definition, period, prior, index) ?? 0) >= 0 ? "+" : ""}${Number((journeyStepChange(definition, period, prior, index) ?? 0).toFixed(1))} pts vs prior week`}</p> : null}
    <div className="journey-week-counts">{definition.steps.map((step, i) => <span key={step.id} data-selected={i === index}>{step.label} {reading.counts[i] === undefined ? "—" : formatInt(reading.counts[i]!)}</span>)}</div>
    </div>
    <Button size="sm" onClick={onView}>View this week →</Button>
    </section>;
}
function JourneyHistory({ definition, weeks, selectedWeek, selectedStep, onSelect }: {
    definition: JourneyDefinition;
    weeks: JourneyPeriod[];
    selectedWeek: JourneyPeriod | null;
    selectedStep: number;
    onSelect: (week: JourneyPeriod, index?: number) => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => { const measure = () => setWidth(ref.current?.clientWidth ?? 0); measure(); if (!ref.current || typeof ResizeObserver === "undefined")
        return; const observer = new ResizeObserver(measure); observer.observe(ref.current); return () => observer.disconnect(); }, []);
    if (weeks.length === 0)
        return <div className="journey-quality">
        <strong>No complete weekly reports yet</strong>
        <p>Weekly history appears after ordered collection. Definition changes remain separate.</p>
        </div>;
    const basis = journeyReading(definition, selectedWeek).rateBasis;
    const rates = weeks.map((week) => { const reading = journeyReading(definition, week); return reading.rateBasis === basis ? reading.rate : null; });
    const real = rates.filter((rate): rate is number => rate !== null);
    const min = Math.max(0, Math.floor(((real.length ? Math.min(...real) : 0) - 3) / 5) * 5);
    const max = Math.min(100, Math.max(min + 5, Math.ceil(((real.length ? Math.max(...real) : 20) + 3) / 5) * 5));
    const w = Math.max(width, 200), left = 48, right = w - 15, top = 30, bottom = 170;
    const firstDate = Date.parse(weeks[0]!.startDate);
    const dateSpan = Math.max(86400000, Date.parse(weeks.at(-1)!.startDate) - firstDate);
    const x = (i: number) => left + (right - left) * (Date.parse(weeks[i]!.startDate) - firstDate) / dateSpan;
    const y = (rate: number) => bottom - (rate - min) / (max - min) * (bottom - top);
    let gap = true;
    const line = rates.map((rate, i) => { if (i > 0 && Date.parse(weeks[i]!.startDate) - Date.parse(weeks[i - 1]!.endDate) !== 86400000)
        gap = true; if (rate === null) {
        gap = true;
        return "";
    } const path = `${gap ? "M" : "L"}${x(i)},${y(rate)}`; gap = false; return path; }).join(" ");
    const selected = Math.max(0, weeks.findIndex((week) => week.startDate === selectedWeek?.startDate));
    const ticks = width < 440 ? [...new Set([0, Math.round((weeks.length - 1) / 3), Math.round((weeks.length - 1) * 2 / 3), weeks.length - 1])] : weeks.map((_, i) => i);
    return <>
    <div ref={ref} className="journey-history-plot">{width > 0 ? <svg viewBox={`0 0 ${w} 225`} height="225" role="img" aria-label="Weekly ordered completion rate">
        <text x={left} y="14">Completed (% of {basis})</text>{[min, (min + max) / 2, max].map((tick) => <g key={tick}>
            <line className="journey-grid-line" x1={left} x2={right} y1={y(tick)} y2={y(tick)}/>
            <text x={left - 9} y={y(tick) + 4} textAnchor="end">{tick}%</text>
            </g>)}<path className="journey-trend-line" d={line}/>
        <g className="journey-week-guide" style={{ transform: `translateX(${x(selected)}px)` }}>
        <line x1="0" x2="0" y1={top} y2={bottom}/>
        </g>{rates.map((rate, i) => rate === null ? null : <circle key={weeks[i]!.startDate} className="journey-trend-point" data-trend={trend(journeyComparison(definition, weeks[i]!, previousJourneyWeek(weeks[i]!, weeks)))} data-selected={i === selected} cx={x(i)} cy={y(rate)} r={i === selected ? 6 : 3.5}/>)}{ticks.map((i) => <text key={i} x={x(i)} y="195" textAnchor={i === 0 ? "start" : i === weeks.length - 1 ? "end" : "middle"}>{formatCalendarDate(weeks[i]!.startDate).replace(/, \d{4}$/, "")}</text>)}<text x={left} y="219">Week starting</text>
        </svg> : null}</div>
    <div className="journey-week-picker" aria-label="Select week">{weeks.map((week, i) => <button type="button" key={week.startDate} aria-pressed={week.startDate === selectedWeek?.startDate} onClick={() => onSelect(week)} aria-label={`${formatCalendarRange(week.startDate, week.endDate)}: ${percent(rates[i] ?? null)} completed`}>
        <small>{formatCalendarDate(week.startDate).replace(/, \d{4}$/, "")}</small>
        <strong>{percent(rates[i] ?? null)}</strong>
        </button>)}</div>
    <div className="journey-heat-heading">
    <h3>Where continuation changed</h3>
    <p>Percentage-point change vs prior complete week</p>
    </div>
    <table className="journey-heat-table">
    <caption className="sr-only">Select a step and week to inspect ordered continuation</caption>
    <thead>
    <tr>
    <th scope="col">Continued to</th>{weeks.map((week) => <th scope="col" key={week.startDate}>{formatCalendarDate(week.startDate).replace(/, \d{4}$/, "")}</th>)}</tr>
    </thead>
    <tbody>{definition.steps.slice(1).map((step, row) => {
            const index = row + 1;
            return <tr key={step.id}>
            <th scope="row">{step.label}</th>{weeks.map((week) => {
                    const rate = journeyStepContinuation(definition, week, index);
                    const change = journeyStepChange(definition, week, previousJourneyWeek(week, weeks), index);
                    return <td key={week.startDate}>
                    <button type="button" data-trend={trend(change)} aria-pressed={selectedStep === index && selectedWeek?.startDate === week.startDate} onClick={() => onSelect(week, index)} aria-label={`${step.label}, ${formatCalendarRange(week.startDate, week.endDate)}: ${percent(rate)} continued; ${change === null ? "no comparable prior week" : `${change >= 0 ? "up" : "down"} ${Number(Math.abs(change).toFixed(1))} percentage points`}`} style={{ "--journey-intensity": `${change === null ? 0 : 6 + Math.min(Math.abs(change), 12) / 12 * 22}%` } as CSSProperties}>
                    <small className="journey-heat-date">{formatCalendarDate(week.startDate).replace(/, \d{4}$/, "")}</small>{change === null ? "—" : `${change > 0 ? "↑" : change < 0 ? "↓" : ""}${Number(Math.abs(change).toFixed(1))}`}<span className="journey-heat-level">{percent(rate)}</span></button>
                    </td>;
                })}</tr>;
        })}</tbody>
    </table>
    <p className="journey-heat-key">↑ Improved · ↓ Regressed · darker shades mean larger changes. The smaller figure is continuation. Gaps stay unmeasured.</p>
    <details className="journey-data-table">
    <summary>Weekly counts and comparability</summary>
    <p>Only complete, unsampled reports with the same definition, percentage baseline and adjacent equal-length periods receive comparison colours. Weeks without the selected baseline appear as gaps.</p>
    <table>
    <thead>
    <tr>
    <th>Week</th>
    <th>Entered</th>
    <th>Completed</th>
    <th>Rate</th>
    </tr>
    </thead>
    <tbody>{weeks.map((week, i) => {
            const counts = journeyReading(definition, week).counts;
            return <tr key={week.startDate}>
            <td>{formatCalendarRange(week.startDate, week.endDate)}</td>
            <td>{counts[0] === undefined ? "—" : formatInt(counts[0])}</td>
            <td>{counts.at(-1) === undefined ? "—" : formatInt(counts.at(-1)!)}</td>
            <td>{percent(rates[i] ?? null)}</td>
            </tr>;
        })}</tbody>
    </table>
    </details>
    </>;
}
