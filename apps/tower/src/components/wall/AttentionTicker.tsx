import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CircleCheck, CircleHelp, Pause, Play } from "lucide-react";
import type { AttentionTickerItem } from "@/lib/attention-ticker";
import { Button } from "@/components/ui/button";
import { SEVERITY_SHAPE } from "@/components/SeverityDot";
import "./AttentionTicker.css";

export interface AttentionTickerProps {
  items: readonly AttentionTickerItem[];
  status?: "ready" | "loading" | "stale" | "partial" | "unavailable";
  evaluatedConditions?: readonly string[];
}

const STATUS_TEXT = {
  ready: "Nothing needs attention",
  loading: "Checking task status…",
  stale: "Task status stale",
  partial: "Task status incomplete",
  unavailable: "Task status unavailable",
};

/** One measured loop; the second copy is visual only and never a second inbox. */
export function AttentionTicker({ items, status = "ready", evaluatedConditions = [] }: AttentionTickerProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const sequence = useRef<HTMLUListElement>(null);
  const [paused, setPaused] = useState(false);
  const [distance, setDistance] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const width = sequence.current?.offsetWidth ?? 0;
      setDistance(width > (viewport.current?.clientWidth ?? 0) ? width : 0);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (viewport.current) observer?.observe(viewport.current);
    if (sequence.current) observer?.observe(sequence.current);
    document.fonts?.addEventListener("loadingdone", measure);
    return () => { observer?.disconnect(); document.fonts?.removeEventListener("loadingdone", measure); };
  }, [items, status]);
  const list = (duplicate: boolean) => <ul ref={duplicate ? undefined : sequence} className="attention-ticker-sequence" aria-hidden={duplicate || undefined} data-attention-copy={duplicate ? "duplicate" : "original"}>
    {items.map(item => {
      const Glyph = SEVERITY_SHAPE[item.severity];
      // A visual-copy click must not focus and hide that copy before navigation.
      return <li key={item.id} className="attention-ticker-item" data-attention-item={item.id} data-needs-row={item.severity} data-material-condition={item.conditions.join(" ") || undefined}>
        <Glyph className={item.severity === "error" ? "text-error" : "text-warn"} role="img" aria-label={item.severity === "error" ? "Error" : "Warning"} />
        <a href={item.href} aria-label={`${item.assetName}: ${item.title}`} className="attention-ticker-link" tabIndex={duplicate ? -1 : undefined} onPointerDown={duplicate ? event => event.preventDefault() : undefined}><span className="attention-ticker-asset" data-needs-site>{item.assetName}</span><span data-needs-line>{item.title}</span></a>
      </li>;
    })}
  </ul>;
  const hasItems = items.length > 0;
  const conditions = [...new Set([...evaluatedConditions, ...items.flatMap(item => item.conditions)])];
  return <section className="attention-ticker text-wall-body" aria-label="Needs attention" data-wall-attention-ticker data-wall-needs={hasItems ? "rows" : status === "ready" ? "calm" : "unknown"} data-material-condition={conditions.join(" ") || undefined} data-attention-status={status} data-attention-paused={paused ? "true" : "false"} data-attention-moving={distance > 0 && hasItems ? "true" : "false"}>
    {status !== "ready" && hasItems ? <span className="attention-ticker-status text-wall-strip-label text-muted-foreground" title={STATUS_TEXT[status]}><CircleHelp aria-hidden /><span>{STATUS_TEXT[status]}</span></span> : null}
    <div ref={viewport} data-wall-crawl-viewport className="attention-ticker-viewport" tabIndex={0} role="group" aria-label="Attention messages. Focus to pause; scroll horizontally to read all messages." onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.scrollLeft = 0; }} onKeyDown={event => { if (event.target === event.currentTarget && event.key === " ") { event.preventDefault(); setPaused(value => !value); } }}>
      {hasItems ? <div className="attention-ticker-track" style={{ "--attention-distance": `${distance}px`, "--attention-duration": `${distance / 36}s` } as CSSProperties}>{list(false)}{distance > 0 ? list(true) : null}</div> : <span className="attention-ticker-empty text-wall-strip-label text-muted-foreground">{status === "ready" ? <CircleCheck aria-hidden /> : <CircleHelp aria-hidden />}{STATUS_TEXT[status]}</span>}
    </div>
    {hasItems ? <Button type="button" variant="ghost" size="icon" className="attention-ticker-toggle" aria-label={paused ? "Resume attention ticker" : "Pause attention ticker"} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? <Play aria-hidden /> : <Pause aria-hidden />}</Button> : null}
  </section>;
}
