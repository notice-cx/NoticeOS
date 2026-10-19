import type { AssetCard } from "@shared/wall";
import { ListPanel, ListRow } from "@/components/surface/ListPanel";
import { FileTaskButton } from "@/components/TaskComposer";
import { businessGaps } from "@/lib/business-gaps";
import { formatInt } from "@/lib/format";

/**
 * What the portfolio is missing as a business, ranked: sites that earn
 * nothing, sites nothing measures, and the newest readings' opportunities.
 * Each row files a task through the same composer a finding files one with,
 * opened on the gap's site's project with the gap as its title.
 */
export function GapsModule({ cards }: { cards: readonly AssetCard[] }) {
  const gaps = businessGaps(cards);
  return (
    <div data-home-gaps={gaps.length} className="h-full">
      <ListPanel title="Worth a look" count={formatInt(gaps.length)} empty="Nothing is missing." className="h-full">
        {gaps.map((gap) => (
          <ListRow
            key={gap.key}
            glyph="↗"
            title={gap.title}
            caption={gap.detail ?? undefined}
            marks={{ "data-business-gap": gap.key }}
            rowActions={
              <FileTaskButton
                label="Make a task"
                subject={gap.title}
                prefill={{ ...(gap.siteId ? { project: gap.siteId } : {}), title: gap.title }}
              />
            }
          />
        ))}
      </ListPanel>
    </div>
  );
}
