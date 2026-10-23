import { HeroChart } from "@/components/surface/HeroChart";
import { Button } from "@/components/ui/button";
import { useAlertDaily } from "@/hooks/useAlertDaily";
import { alertsLine } from "@/lib/alerts-line";
import { formatInt, formatTimestamp } from "@/lib/format";

export function AlertDaily({ current }: { current: { attention: readonly { severity: string }[]; generatedAt: string } }) {
  const { data, isError, isFetching, refetch } = useAlertDaily();
  const counts = data?.days.map((day) => ({ ...day,
    total: day.errors === null || day.warnings === null ? null : day.errors + day.warnings,
  })) ?? [];
  return (
    <section aria-label="Daily open-alert snapshots" className="min-w-0 rounded-xl bg-card p-4 ring-1 ring-border/70" data-alert-daily="">
      <h2 className="text-sm font-semibold">Daily open-alert snapshots</h2>
      <p className="mt-1 text-sm" data-alert-daily-current="">Now: {alertsLine(current.attention)} · <time dateTime={current.generatedAt}>{formatTimestamp(current.generatedAt, "UTC")}</time></p>
      <p className="mt-1 text-xs text-muted-foreground">Warnings and errors at each daily observation (UTC), not newly fired alerts. Informational notices are excluded. Missing days are unknown; zero means none were open.</p>
      <p className="mt-1 text-xs text-muted-foreground">Daily totals count alerts recorded then; the current total groups repeats and reflects later changes.</p>
      {isError ? <div role="status" data-status-for="read:alert-daily" className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span>Couldn't load daily alert snapshots.{data ? " Showing the last successful read." : " Counts are unknown."}</span>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>Try again</Button>
      </div> : null}
      {!data ? isError ? null : <p role="status" data-status-for="read:alert-daily" className="mt-3 text-sm text-muted-foreground">Loading daily alert snapshots…</p>
        : data.days.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No daily alert snapshots recorded yet.</p>
        : <HeroChart
            title="Warnings and errors at daily observation"
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
    </section>
  );
}
