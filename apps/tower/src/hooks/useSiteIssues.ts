import { useConnections } from "@/hooks/useConnections";
import { useNow } from "@/hooks/useNow";
import { useWall } from "@/hooks/useWall";
import { wallIssues, type WallIssue } from "@/lib/wall-issues";

/**
 * Every site's open problems, from the one read Home's brief and the Wall's
 * Needs you use (`wallIssues`): open alerts, failing sources, late reports,
 * panels due for review. `siteHealth(card, issues)` turns them into the site's
 * one health word, so Home's strip, the Sites list and a site's own
 * header can never call the same site two things. Empty until the Wall's read
 * answers, so a site is never "Off track" on a read that has not arrived.
 */
export function useSiteIssues(): readonly WallIssue[] {
  const { data } = useWall();
  const connections = useConnections();
  const nowMs = useNow();
  // A payload without its site or alert lists (an older cached shape, a read
  // still arriving) has no problems to report rather than a crash to throw.
  if (!data || !Array.isArray(data.assets) || !Array.isArray(data.attention)) return [];
  return wallIssues({ assets: data.assets, attention: data.attention, connections, nowMs });
}
