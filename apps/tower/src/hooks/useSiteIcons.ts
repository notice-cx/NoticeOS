import { QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useSyncExternalStore } from "react";
import type { SiteIcons } from "@noticeos/contract/site-icons";
import type { WallPayload } from "@shared/wall";

/** `useWall`'s key. */
const WALL_KEY = ["wall"] as const;

/**
 * A site's icons by site id (`AssetCard.icons`), for a surface that holds the
 * id rather than the card; `PropertyFavicon` draws `/favicon.ico` for null.
 *
 * It never reads the Wall and never adds a query: it watches the read the
 * desk shell keeps cached (`useWall`) and answers null until that read has
 * landed, for an id the read does not carry, and outside a query client (the
 * component gallery, a unit test).
 */
export function useSiteIcons(): (site: string) => SiteIcons | null {
  const client = useContext(QueryClientContext);
  const subscribe = useCallback(
    (changed: () => void) =>
      client
        ? client.getQueryCache().subscribe(({ query }) => {
            if (query.queryKey.length === 1 && query.queryKey[0] === WALL_KEY[0]) changed();
          })
        : () => {},
    [client],
  );
  const cards = useSyncExternalStore(subscribe, () => client?.getQueryData<WallPayload>(WALL_KEY)?.assets);
  return useCallback(
    // A payload held from an older shape may carry no site list.
    (site: string) => (Array.isArray(cards) ? cards.find((card) => card.id === site)?.icons ?? null : null),
    [cards],
  );
}
