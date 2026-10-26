import { useEffect, useState, type CSSProperties } from "react";
import { explorationComparison, explorationFacts, type ExplorationPath, type SessionExplorationPeriod, type SessionExplorationSnapshot } from "@noticeos/contract/session-exploration";
import { formatCalendarRange, formatInt } from "@/lib/format";
import { journeyRateDomain } from "@/lib/journey-presentation";
import "./SessionExploration.css";

export interface SessionExplorationProps { snapshot: SessionExplorationSnapshot; rangeDays: 7 | 28 }
type Selection = { kind: "surface"; id: string } | { kind: "path"; key: string };
const pathKey = (path: ExplorationPath) => JSON.stringify([path.surfaces, path.ending]);
interface Branch { key: string; label: string; count: number; depth: number; y: number; height: number; surface: string | null; ending: ExplorationPath["ending"] | null; parent: string }
const percent = (count: number, total: number) => total > 0 ? `${Number((count / total * 100).toPrecision(3))}%` : "—";
const endingLabel = { exit: "Exited", continued: "Continued beyond this path", unknown: "Next destination unknown" };
const distinct = (path: ExplorationPath) => new Set(path.surfaces).size;
const usable = (period: SessionExplorationPeriod) => period.quality !== "unavailable" && period.sessions !== null && period.sessions > 0;
const sameDefinition = (a: SessionExplorationPeriod, b: SessionExplorationPeriod) => a.definitionId !== null && a.definitionId === b.definitionId && a.sessionTimeoutMinutes === b.sessionTimeoutMinutes;

/** Prefixes preserve observed order: the same surface at two positions is a return, not a new session. */
export function explorationBranches(period: SessionExplorationPeriod): Branch[] {
  if (!usable(period)) return [];
  const total = period.sessions!;
  const names = new Map(period.surfaces.map((surface) => [surface.id, surface.label]));
  const paths = [...period.paths].sort((a, b) => JSON.stringify(a.surfaces).localeCompare(JSON.stringify(b.surfaces)) || a.ending.localeCompare(b.ending));
  const branches = new Map<string, Branch>();
  let offset = 0;
  for (const path of paths) {
    const height = path.sessions / total * 100;
    for (let depth = 0; depth <= path.surfaces.length; depth++) {
      const surface = path.surfaces[depth] ?? null;
      const prefix = path.surfaces.slice(0, depth + 1);
      const key = JSON.stringify(surface === null ? [...prefix, `:${path.ending}`] : prefix);
      const existing = branches.get(key);
      if (existing) { existing.count += path.sessions; existing.height += height; }
      else branches.set(key, { key, label: surface === null ? endingLabel[path.ending] : names.get(surface) ?? surface, count: path.sessions, depth, y: offset, height, surface, ending: surface === null ? path.ending : null, parent: depth === 0 ? "root" : JSON.stringify(path.surfaces.slice(0, depth)) });
    }
    offset += height;
  }
  return [...branches.values()];
}

function selectionCount(period: SessionExplorationPeriod, selection: Selection | null, reference: SessionExplorationPeriod): number | null {
  if (!usable(period) || !sameDefinition(period, reference) || period.quality !== "complete" || period.paths.reduce((sum, path) => sum + path.sessions, 0) !== period.sessions) return null;
  if (!selection) return period.paths.filter((path) => distinct(path) >= 2).reduce((sum, path) => sum + path.sessions, 0);
  if (selection.kind === "surface") return period.paths.filter((path) => path.surfaces.includes(selection.id)).reduce((sum, path) => sum + path.sessions, 0);
  const selected = reference.paths.find(path => pathKey(path) === selection.key);
  if (!selected) return null;
  return period.paths.filter((path) => path.ending === selected.ending && JSON.stringify(path.surfaces) === JSON.stringify(selected.surfaces)).reduce((sum, path) => sum + path.sessions, 0);
}

function History({ periods, reference, selection, label }: { periods: SessionExplorationPeriod[]; reference: SessionExplorationPeriod; selection: Selection | null; label: string }) {
  const weeks = [...periods].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const baseline = reference.definitionId === null && selection === null ? weeks.findLast(week => week.quality === "complete") ?? reference : reference;
  const values = weeks.map((period) => { const count = selectionCount(period, selection, baseline); return count === null ? null : count / period.sessions! * 100; });
  const domain = journeyRateDomain(values);
  const x = (index: number) => 62 + index / Math.max(1, weeks.length - 1) * 640;
  const y = (value: number) => 150 - (value - domain.min) / (domain.max - domain.min) * 125;
  let previous = false;
  const line = values.map((value, index) => { if (value === null) { previous = false; return ""; } const command = `${previous ? "L" : "M"}${x(index)},${y(value)}`; previous = true; return command; }).join(" ");
  return <section className="session-history" aria-label={`${label} history`}>
    <div className="session-section-heading"><h3>{label} over time</h3><span>% of all sessions · weekly</span></div>
    {values.some((value) => value !== null) ? <><svg viewBox="0 0 730 178" role="img" aria-label={`${label}, weekly percentage of all sessions. Y axis ${domain.min}% to ${domain.max}%.`}>
      {domain.ticks.map((tick) => <g key={tick}><line x1="62" x2="702" y1={y(tick)} y2={y(tick)} className="session-grid"/><text x="52" y={y(tick) + 4} textAnchor="end">{Number(tick.toPrecision(3))}%</text></g>)}
      <path d={line} className="session-history-line"/>
      {values.map((value, index) => value === null ? null : <circle key={weeks[index]!.startDate} cx={x(index)} cy={y(value)} r="4"><title>{formatCalendarRange(weeks[index]!.startDate, weeks[index]!.endDate)} · {Number(value.toPrecision(3))}%</title></circle>)}
    </svg><div className="session-history-dates"><span>{weeks[0]?.startDate}</span><span>{weeks.at(-1)?.endDate}</span></div>
    <details><summary>Weekly values</summary><ul>{weeks.map((week, i) => <li key={week.startDate}><span>{formatCalendarRange(week.startDate, week.endDate)}</span><strong>{values[i] === null ? "Unavailable" : `${Number(values[i]!.toPrecision(3))}%`}</strong></li>)}</ul></details></> : <p>Comparable weekly history is unavailable.</p>}
  </section>;
}

export function SessionExploration({ snapshot, rangeDays }: SessionExplorationProps) {
  const period = rangeDays === 7 ? snapshot.current7 : snapshot.current28;
  const prior = rangeDays === 7 ? snapshot.prior7 : snapshot.prior28;
  const change = explorationComparison(period, prior);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setSelection(null); setShowAll(false); }, [rangeDays, period.definitionId, period.startDate, period.endDate]);
  useEffect(() => {
    if (selection?.kind === "path" && !period.paths.some(path => pathKey(path) === selection.key)) setSelection(null);
    if (selection?.kind === "surface" && !period.surfaces.some(surface => surface.id === selection.id)) setSelection(null);
  }, [period.paths, period.surfaces, selection]);
  const names = new Map(period.surfaces.map((surface) => [surface.id, surface.label]));
  const surfaceIds = period.surfaces.map((surface) => surface.id).sort();
  const tone = (id: string | null): CSSProperties => ({ "--session-tone": id === null ? "var(--journey-continuation)" : `var(--asset-${surfaceIds.indexOf(id) % 6 + 1})` }) as CSSProperties;
  const total = period.sessions;
  const available = usable(period);
  const facts = explorationFacts(period);
  const represented = total === null ? 0 : total - (facts.unobservedSessions ?? 0);
  const unobserved = facts.unobservedSessions;
  const explored = facts.exploredSessions ?? 0;
  const uncertain = facts.uncertainSessions ?? 0;
  const diagramPaths = [...period.paths].sort((a, b) => b.sessions - a.sessions || JSON.stringify(a).localeCompare(JSON.stringify(b))).slice(0, 8);
  const diagramSessions = diagramPaths.reduce((sum, path) => sum + path.sessions, 0);
  const omittedSessions = represented - diagramSessions;
  const branches = explorationBranches({ ...period, paths: diagramPaths });
  const depth = Math.max(1, ...branches.map((branch) => branch.depth + 1));
  const root: Branch = { key: "root", label: "All sessions", count: total ?? 0, depth: -1, y: 0, height: 100, surface: null, ending: null, parent: "" };
  const lookup = new Map([["root", root], ...branches.map((branch) => [branch.key, branch] as const)]);
  const graphWidth = 190 * (depth + 1);
  const columnRows = Array.from({ length: depth }, (_, index) => branches.filter(branch => branch.depth === index).sort((a,b) => a.y - b.y));
  const mostRows = Math.max(1, ...columnRows.map(rows => rows.length));
  const gap = 12;
  const graphHeight = 400 + (mostRows - 1) * gap;
  const xpos = (branch: Branch) => 20 + (branch.depth + 1) * 190;
  const ypos = (branch: Branch) => {
    if (branch.key === "root") return 48 + (mostRows - 1) * gap / 2;
    const rows = columnRows[branch.depth]!;
    return 48 + branch.y * 3 + rows.indexOf(branch) * gap + (mostRows - rows.length) * gap / 2;
  };
  const selectedPath = selection?.kind === "path" ? period.paths.find(path => pathKey(path) === selection.key) : null;
  const selectionLabel = selection?.kind === "surface" ? names.get(selection.id) ?? selection.id : selectedPath ? "Selected path" : "Explored beyond one section";
  const count = selection?.kind === "surface" ? period.paths.filter((path) => path.surfaces.includes(selection.id)).reduce((sum, path) => sum + path.sessions, 0) : selectedPath?.sessions ?? explored;
  const returnSessions = period.paths.filter((path) => distinct(path) < path.surfaces.length).reduce((sum, path) => sum + path.sessions, 0);
  const unresolvedEndings = period.paths.some((path) => path.ending !== "exit") || (unobserved ?? 0) > 0;
  const exits = facts.exitSessions ?? 0;
  const largestExit = period.paths.filter((path) => path.ending === "exit").sort((a, b) => b.sessions - a.sessions)[0];
  const selected = (branch: Branch) => selection?.kind === "surface" ? selection.id === branch.surface : selectedPath ? branch.key === JSON.stringify(branch.ending ? [...selectedPath.surfaces, `:${selectedPath.ending}`] : selectedPath.surfaces.slice(0, branch.depth + 1)) : false;
  function chooseBranch(branch: Branch) {
    if (branch.surface) setSelection({ kind: "surface", id: branch.surface });
    else if (branch.ending) {
      const index = period.paths.findIndex((path) => branch.key === JSON.stringify([...path.surfaces, `:${path.ending}`]));
      if (index >= 0) setSelection({ kind: "path", key: pathKey(period.paths[index]!) });
    }
  }
  return <div className="session-exploration" data-session-exploration>
    <header className="session-heading"><div><h2>Where sessions go</h2><p>{formatCalendarRange(period.startDate, period.endDate)} · {period.timeZone ?? "Reporting time zone unavailable"}{period.estimatedDays ? ` · ${period.estimatedDays} estimated days` : ''}</p></div><span className="session-unit">Sessions</span></header>
    {!available ? <div className="session-empty"><h3>{total === 0 ? "No sessions in this period" : "Session paths are unavailable"}</h3><p>{period.reason ?? (total === 0 ? "The report records zero sessions for these dates." : "No complete session-path report has been received for these dates.")}</p></div> : <>
      <div className="session-summary">
        <div><span>{period.coveredDays < period.expectedDays ? "All reported sessions" : "All sessions"}</span><strong>{formatInt(total!)}</strong><p>100% · all reported sessions</p></div>
        <div><span>Explored beyond one section</span><strong>{uncertain > 0 ? "≥ " : ""}{percent(explored, total!)}</strong><p>{formatInt(explored)} sessions · two or more distinct sections</p></div>
        <div><span>Returned to a section</span><strong>{unresolvedEndings ? "≥ " : ""}{percent(returnSessions, total!)}</strong><p>{formatInt(returnSessions)} sessions · visited a section again</p></div>
        <div className="session-change" data-trend={change === null || change === 0 ? "neutral" : change > 0 ? "positive" : "negative"}><span>Change in exploration</span><strong>{change === null ? "—" : `${change > 0 ? "+" : ""}${Number(Math.abs(change) >= .1 ? change.toFixed(1) : change.toPrecision(2))} pts`}</strong><p>{change === null ? "No comparable prior period" : `vs ${formatCalendarRange(prior.startDate, prior.endDate)}`}</p></div>
      </div>
      <div className="session-coverage"><span>{period.coveredDays} of {period.expectedDays} complete days</span><span>{percent(represented, total!)} with displayed paths</span>{period.quality === "partial" && <strong>Partial coverage</strong>}{period.reason && <p>{period.reason}</p>}</div>
      <details className="session-counting"><summary>How sessions are counted</summary><p>Paths follow sections visited within the same session.{period.sessionTimeoutMinutes !== null ? ` A session ends after ${period.sessionTimeoutMinutes} minutes of inactivity.` : " The session timeout is unavailable."} Returns remain in the same session. Continued and unknown destinations do not count as exits. A ≥ percentage is a measured minimum.</p></details>
      {largestExit && <p className="session-exit-insight"><span>Largest recorded exit</span><strong>{percent(largestExit.sessions, total!)} of sessions</strong> ended after {largestExit.surfaces.map((id) => names.get(id) ?? id).join(" → ")}</p>}
      <div className="session-section-heading"><h3>Follow the branches</h3><span>{omittedSessions > 0 ? "Eight largest paths · " : ""}Band thickness = share of all sessions</span></div>
      <div className="session-graph-scroll" tabIndex={0} role="region" aria-label="Session paths. Scroll horizontally for later destinations.">
        <svg className="session-graph" viewBox={`0 0 ${graphWidth} ${graphHeight}`} style={{ minWidth: `${graphWidth}px` }} aria-label="Session paths on a shared 100 percent scale">
          <text x="20" y="24">START</text>{Array.from({ length: depth }, (_, index) => <text key={index} x={210 + index * 190} y="24">{index === 0 ? "FIRST SECTION" : `NEXT ${index}`}</text>)}
          {branches.map((branch) => { const parent = lookup.get(branch.parent)!; const top = ypos(branch), bottom = top + branch.height * 3; const left = xpos(parent) + 10, right = xpos(branch), sourceTop = ypos(parent) + (branch.y - parent.y) * 3, sourceBottom = sourceTop + branch.height * 3; return <path key={`edge-${branch.key}`} d={`M${left},${sourceTop} C${left + 85},${sourceTop} ${right - 85},${top} ${right},${top} L${right},${bottom} C${right - 85},${bottom} ${left + 85},${sourceBottom} ${left},${sourceBottom} Z`} className="session-band" style={tone(branch.surface)} data-ending={branch.ending ?? undefined} data-selected={selected(branch)} onClick={() => chooseBranch(branch)}><title>{branch.label} · {percent(branch.count, total!)} · {formatInt(branch.count)} sessions</title></path>; })}
          {[root, ...branches].map((branch) => <g key={branch.key} className="session-node" style={tone(branch.surface)} data-ending={branch.ending ?? undefined} data-selected={selected(branch)} role={branch.surface || branch.ending ? "button" : undefined} tabIndex={branch.surface || branch.ending ? 0 : undefined} aria-label={branch.surface || branch.ending ? `${branch.label}, ${percent(branch.count, total!)} of all sessions, inspect ${branch.surface ? "section" : "path"}` : undefined} onClick={() => chooseBranch(branch)} onKeyDown={(event) => { if ((branch.surface || branch.ending) && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); chooseBranch(branch); } }}>
            <rect x={xpos(branch)} y={ypos(branch)} width="10" height={branch.height * 3}/>
            {branch.height >= 13 ? <><text x={xpos(branch) + 17} y={ypos(branch) + 16}>{branch.label.length > 21 ? `${branch.label.slice(0, 20)}…` : branch.label}</text><text className="session-node-rate" x={xpos(branch) + 17} y={ypos(branch) + 34}>{percent(branch.count, total!)}</text></> : branch.height >= 2 ? <text x={xpos(branch) + 17} y={ypos(branch) + Math.max(10, branch.height * 1.5)}>{branch.label.length > 15 ? `${branch.label.slice(0, 14)}…` : branch.label} · {percent(branch.count, total!)}</text> : null}
          </g>)}
          {omittedSessions > 0 && <g className="session-other"><rect x="20" y={ypos(root) + diagramSessions / total! * 300} width="10" height={omittedSessions / total! * 300}/><title>{formatInt(omittedSessions)} sessions in other recorded paths</title></g>}
          {unobserved! > 0 && <g className="session-unobserved"><rect x="20" y={ypos(root) + represented / total! * 300} width="10" height={unobserved! / total! * 300}/><title>{formatInt(unobserved!)} sessions without reported destinations</title></g>}
        </svg>
      </div>
      {(omittedSessions > 0 || unobserved! > 0) && <div className="session-diagram-remainder">{omittedSessions > 0 && <span className="session-other-label">{percent(omittedSessions, total!)} · Other recorded paths <small>Available in Recorded paths below</small></span>}{unobserved! > 0 && <span className="session-unobserved-label">{percent(unobserved!, total!)} · destinations not reported</span>}</div>}
      <p className="session-scroll-hint">Scroll to follow later destinations →</p>
      <div className="session-surface-controls" aria-label="Inspect a section">{period.surfaces.map((surface) => <button type="button" key={surface.id} style={tone(surface.id)} aria-label={`${surface.label} · ${percent(period.paths.filter((path) => path.surfaces.includes(surface.id)).reduce((sum, path) => sum + path.sessions, 0), total!)} of all sessions`} aria-pressed={selection?.kind === "surface" && selection.id === surface.id} onClick={() => setSelection({ kind: "surface", id: surface.id })}>{surface.label}<strong>{percent(period.paths.filter((path) => path.surfaces.includes(surface.id)).reduce((sum, path) => sum + path.sessions, 0), total!)}</strong></button>)}</div>
      <div className="session-inspection" aria-live="polite"><div><span className="session-eyebrow">{selection ? "SELECTED" : "SESSION EXPLORATION"}</span><h3>{selectionLabel}</h3><strong>{percent(count, total!)} <small>of all sessions · {formatInt(count)} sessions</small></strong><p>{selection?.kind === "surface" ? "Each session counts once here, including sessions that return to this section." : selectedPath ? `${selectedPath.surfaces.map((id) => names.get(id) ?? id).join(" → ")} · ${endingLabel[selectedPath.ending]}` : `${percent(exits, total!)} have a recorded exit. ${uncertain > 0 ? `${formatInt(uncertain)} sessions have an unresolved destination or later path.` : "Every displayed path has a recorded ending."}`}</p></div>{selection && <button type="button" onClick={() => setSelection(null)}>Clear selection</button>}</div>
      <section className="session-path-list"><div className="session-section-heading"><h3>Recorded paths</h3><span>Each session appears in one path</span></div>{(showAll ? period.paths : period.paths.slice(0, 6)).map((path) => <button type="button" key={`${path.surfaces.join("/")}-${path.ending}`} aria-pressed={selection?.kind === "path" && selection.key === pathKey(path)} onClick={() => setSelection({ kind: "path", key: pathKey(path) })}><span>{path.surfaces.map((id) => names.get(id) ?? id).join(" → ")}<small>{endingLabel[path.ending]}{distinct(path) < path.surfaces.length ? " · includes a return" : ""}</small></span><span className="session-path-value"><strong>{percent(path.sessions, total!)}</strong><small>{formatInt(path.sessions)} sessions</small><i style={{ "--session-share": `${path.sessions / total! * 100}%` } as CSSProperties}/></span></button>)}{period.paths.length > 6 && <button className="session-show-all" type="button" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer paths" : `Show all ${period.paths.length} paths`}</button>}</section>
    </>}
    <History periods={snapshot.weekly} reference={period} selection={selection} label={selectionLabel}/>
  </div>;
}
