import { useCallback } from "react";
import { siteAddress, sitePath } from "@shared/first-run";
import { useWall } from "@/hooks/useWall";

/**
 * Where a link that means "open this site" goes, by site id (bead
 * `ro-ujb9.199`) — the rule the sidebar, the Sites table and the command
 * palette already follow (`sitePath`): its Data sources until its first
 * number, its Overview after.
 *
 * For a surface that holds an alert's site id rather than its card. It reads
 * the cards off `useWall()`, the cached query the desk pages already run; an
 * id the Wall does not know yet opens the site's plain address.
 */
export function useSitePath(): (id: string) => string {
  const cards = useWall().data?.assets;
  return useCallback(
    (id: string) => {
      const card = cards?.find((candidate) => candidate.id === id);
      return card ? sitePath(card) : siteAddress(id);
    },
    [cards],
  );
}
