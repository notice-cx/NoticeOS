import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { Link } from "react-router-dom";
import { isRetired } from "@shared/asset-setup";
import { siteShownOn } from "@shared/site-display";
import { ShownOnSwitches, useSiteArrange } from "@/components/SiteArrange";
import { KnobRow } from "@/components/KnobRow";
import { SITES_ARRANGE_ITEM } from "@/components/nav-items";
import { Button } from "@/components/ui/button";
import { formatInt, formatOrdinal } from "@/lib/format";
import { Panel } from "@/routes/asset-detail/shared";

/**
 * This one site's row of Arrange: its place in the order every surface uses,
 * with Move up and Move down, and its three switches for where it shows. The
 * same reads and writes as Arrange on the Sites page, so the two never
 * disagree; the whole list is one link away.
 */
export function WhereItShowsCard({ assetId }: { assetId: string }) {
  const arrange = useSiteArrange();
  const sites = arrange.sites ?? [];
  const index = sites.findIndex((site) => site.id === assetId);
  const site = sites[index];
  const above = sites[index - 1];
  const below = sites[index + 1];
  const locked = !arrange.writable;

  return (
    <Panel title="Where it shows" id="where-it-shows">
      {site === undefined ? (
        <span className="text-sm text-muted-foreground">—</span>
      ) : (
        <div className="flex flex-col gap-3" data-where-it-shows={site.id}>
          <KnobRow
            label="Place"
            value={
              <span className="inline-flex items-center gap-2">
                <span data-where-it-shows-place>
                  {formatOrdinal(index + 1)} of {formatInt(sites.length)}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Move ${site.displayName} up`}
                  disabled={locked || arrange.moving || above === undefined}
                  onClick={() => above && arrange.onMove(site.id, above.id)}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Move ${site.displayName} down`}
                  disabled={locked || arrange.moving || below === undefined}
                  onClick={() => below && arrange.onMove(site.id, below.id)}
                >
                  <ArrowDown className="size-4" />
                </Button>
              </span>
            }
          />
          <ShownOnSwitches
            site={site}
            shown={siteShownOn(site, arrange.display)}
            disabled={locked}
            busy={arrange.busy}
            onSwitch={arrange.onSwitch}
          />
          {isRetired(site.status) ? (
            <p className="m-0 text-xs leading-snug text-muted-foreground" data-where-it-shows-retired>
              A retired site shows nowhere until you turn a switch on.
            </p>
          ) : null}
          <Link
            to={SITES_ARRANGE_ITEM.to}
            className="inline-flex min-h-11 items-center gap-1 self-start text-xs font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
            data-where-it-shows-arrange
          >
            {SITES_ARRANGE_ITEM.label}
            <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
          </Link>
        </div>
      )}
    </Panel>
  );
}
