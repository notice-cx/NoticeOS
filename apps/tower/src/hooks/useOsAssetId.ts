import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
import type { WallPayload } from "@shared/wall";


/**
 * The OS's own asset id: the store's `assets.is_os` row, as the Wall payload
 * already carries it (`system.assetId`), and never an id written into the
 * product.
 *
 * It never fetches. It observes the Wall read the desk shell keeps cached
 * (`useWall`, the same query key) and answers null until that read has landed.
 * A caller rendered before then — the component gallery, a unit test — gets
 * null, and a composer opened from it asks for the project instead of guessing.
 */
export function useOsAssetId(): string | null {
  const { fetchWall } = useTowerApi();
  const { data } = useQuery<WallPayload>({
    queryKey: ["wall"],
    queryFn: ({ signal }) => fetchWall(signal),
    enabled: false,
  });
  return data?.system.assetId ?? null;
}
