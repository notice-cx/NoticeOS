import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";


/**
 * What the connected Google account can see: two free, read-only list calls
 * inside the ingest Worker; nothing is stored, and a failure inside Google
 * comes back as a 200 carrying its own sentence. One key for the whole page:
 * the GA4 and Search Console cards share one answer, so a tab with both open
 * makes one round trip. A failed read is not retried and not surfaced as an
 * error state: the field it decorates still works as a text box.
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
