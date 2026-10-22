import { HeroChart } from "@/components/surface/HeroChart";
import { Button } from "@/components/ui/button";
import { useAlertDaily } from "@/hooks/useAlertDaily";
import { formatInt } from "@/lib/format";

export function AlertDaily() {
  const { data, isError, isFetching, refetch } = useAlertDaily();
  return (
    <section aria-label="Daily open-alert snapshots" className="min-w-0 rounded-xl bg-card p-4 ring-1 ring-border/70" data-alert-daily="">
      <h2 className="text-sm font-semibold">Daily open-alert snapshots</h2>
      <p className="mt-1 text-xs text-muted-foreground">Unresolved alerts across every site at each daily observation (UTC), not newly fired alerts. Missing days are unknown; zero means none were open.</p>
      {isError ? <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span>Couldn't load daily alert snapshots.{data ? " Showing the last successful read." : " Counts are unknown."}</span>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>Try again</Button>
      </div> : null}
      {!data ? isError ? null : <p role="status" className="mt-3 text-sm text-muted-foreground">Loading daily alert snapshots…</p>
        : data.days.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No daily alert snapshots recorded yet.</p>
        : <HeroChart
            title="Open alerts at daily observation"
            series={[{ name: "Open alerts", points: data.days.flatMap((day) => day.open === null ? [] : [{ t: day.day, v: day.open }]) }]}
            range={data.days.length}
            end={data.days.at(-1)!.day}
            notesByDate={Object.fromEntries(data.days.map((day) => [day.day, day.observedAt
              ? `${day.errors} errors · ${day.warnings} warnings · observed ${day.observedAt}`
              : "Snapshot missing; count unknown"]))}
            average={false} weekends={false} showPoints provisionalFrom={null}
            format={formatInt}
            ariaLabel="Daily open-alert snapshots, not newly fired alerts"
            className="mt-3"
          />}
    </section>
  );
}
