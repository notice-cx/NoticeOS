import { useState, type ReactNode } from "react";
import { siteShownOn, type ShownOnSurface, type SiteDisplay } from "@shared/site-display";
import { DropLine } from "@/components/DropLine";
import { ShownOnSwitches, SiteArrange, type ArrangedSite } from "@/components/SiteArrange";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { movedOrder } from "@/lib/site-arrange";

// Arrange with four invented sites: drag a row by its grip or move it with its
// arrows, flip a switch, the read-only face, and the line a drag draws before
// the drop. Nothing here saves.

const SITES: ArrangedSite[] = [
  { id: "meadow.example", displayName: "Meadow Board", status: "live" },
  { id: "northwind.example", displayName: "Northwind", status: "live" },
  { id: "acorn.example", displayName: "Acorn Atlas", status: "baselining" },
  { id: "ferns.example", displayName: "Fern Index", status: "retired" },
];

function Example({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className={eyebrowClass}>{label}</span>
      {children}
    </div>
  );
}

/** The whole piece, pressable, held in this page's own state. */
function Live() {
  const [order, setOrder] = useState(SITES.map((site) => site.id));
  const [display, setDisplay] = useState<SiteDisplay>({ "northwind.example": { work: false } });
  const sites = order.flatMap((id) => SITES.find((site) => site.id === id) ?? []);
  const flip = (site: ArrangedSite, surface: ShownOnSurface, on: boolean) =>
    setDisplay((current) => ({ ...current, [site.id]: { ...current[site.id], [surface]: on } }));
  return (
    <SiteArrange
      sites={sites}
      display={display}
      onMove={(asset, to) => setOrder((current) => movedOrder(current, asset, to))}
      onSwitch={flip}
    />
  );
}

export function SiteArrangeDemo() {
  const one = SITES[0]!;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Example label="Four sites: drag, arrows and switches">
        <Live />
      </Example>
      <div className="flex flex-col gap-6">
        <Example label="Saves paused (the reason above the list)">
          <SiteArrange
            sites={SITES.slice(0, 2)}
            display={undefined}
            disabled
            disabledReason="This snapshot is read-only."
            onMove={() => {}}
            onSwitch={() => {}}
          />
        </Example>
        <Example label="One site's switches, as its Settings tab draws them">
          <ShownOnSwitches site={one} shown={siteShownOn(one, { [one.id]: { tv: false } })} disabled={false} busy={undefined} onSwitch={() => {}} />
        </Example>
        <Example label="DropLine: where a dragged row lands">
          <div className="relative rounded-md border border-border bg-card px-3 py-3 text-sm">
            Northwind
            <DropLine
              box={{ left: 8, right: 8, height: 4, top: -2 }}
              label="Above Northwind"
              labelStyle={{ left: "3.25rem", top: "50%", transform: "translateY(-50%)" }}
            />
          </div>
        </Example>
      </div>
    </div>
  );
}
