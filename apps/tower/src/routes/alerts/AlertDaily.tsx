import { HeroChart } from "@/components/surface/HeroChart";
import { Button } from "@/components/ui/button";
import { useAlertDaily } from "@/hooks/useAlertDaily";
import { formatInt, formatTimestamp } from "@/lib/format";

export function AlertDaily() {
  const { data, isError, isFetching, refetch } = useAlertDaily();
  const counts = data?.days.map((day) => ({ ...day,
    total: day.errors === null || day.warnings === null ? null : day.errors + day.warnings,
  })) ?? [];
  return (
    <section aria-label="Daily open-alert snapshots" className="min-w-0 rounded-xl bg-card p-4 ring-1 ring-border/70" data-alert-daily="">
      <div className="flex items-baseline justify-between gap-3"><h2 className="text-sm font-semibold">Open alerts by day</h2><span className="text-xs text-muted-foreground">UTC</span></div>
      {isError ? <div role="status" data-status-for="read:alert-daily" className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span>Couldn't load daily alert snapshots.{data ? " Showing the last successful read." : " Counts are unknown."}</span>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>Try again</Button>
      </div> : null}
      {!data ? isError ? null : <p role="status" data-status-for="read:alert-daily" className="mt-3 text-sm text-muted-foreground">Loading daily alert snapshots…</p>
        : data.days.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No daily alert snapshots recorded yet.</p>
        : <HeroChart
            series={[{ name: "Warnings and errors", points: counts.flatMap((day) => day.total === null ? [] : [{ t: day.day, v: day.total }]) }]}
            range={data.days.length}
            end={data.days.at(-1)!.day}
            notesByDate={Object.fromEntries(data.days.map((day) => [day.day, day.observedAt
              ? `${day.errors} ${day.errors === 1 ? "error" : "errors"} · ${day.warnings} ${day.warnings === 1 ? "warning" : "warnings"} · observed ${formatTimestamp(day.observedAt, "UTC")}`
              : "Snapshot missing; count unknown"]))}
            average={false} weekends={false} showPoints provisionalFrom={null}
            format={formatInt}
            ariaLabel="Daily unresolved warnings and errors, not newly fired alerts"
            className="mt-3"
          />}
      <details className="mt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer underline underline-offset-4">How daily totals are counted</summary>
        <p className="mt-2">Warnings and errors at each daily observation, not newly fired alerts. Informational notices are excluded. Missing days are unknown; zero means none were open.</p>
        <p className="mt-2">Daily totals count alerts recorded then; the current total groups repeats and reflects later changes.</p>
      </details>
    </section>
  );
}
