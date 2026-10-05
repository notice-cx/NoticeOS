import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";


/**
 * WHAT THE CONNECTED GOOGLE ACCOUNT CAN SEE (bead `ro-vu8d.17`).
 *
 * `GET /api/integrations/google/properties` is two free, read-only list calls
 * inside the ingest Worker; nothing is stored, and a failure inside Google comes
 * back as a 200 carrying its own sentence rather than as an error. The asset's
 * Sources tab reads it to turn "type the numeric property id off a browser URL"
 * — the single most error-prone step in setting up an asset — into a list.
 *
 * ONE KEY FOR THE WHOLE PAGE. The GA4 and Search Console cards ask separately
 * and share one answer: the query is the account's, not the lane's, so a tab
 * with both cards open makes one round trip and a tab switch inside the
 * `staleTime` makes none. `enabled` is what keeps a deployment that cannot save
 * anything, and every non-Google lane, from asking at all.
 *
 * A failed read is NOT retried and NOT surfaced as an error state: the field it
 * decorates still works as a text box, so the honest degrade is to say the list
 * is unavailable and let the operator type.
 */
export function useGoogleProperties(enabled: boolean) {
  const { fetchGoogleProperties } = useTowerApi();
  return useQuery({
    queryKey: ["google-properties"],
    queryFn: ({ signal }) => fetchGoogleProperties(signal),
    enabled,
    // A property list is a fact about a Google account, not a live metric: it
    // changes when somebody creates a property, which is not on this page.
    staleTime: 5 * 60_000,
    retry: 0,
  });
}
