import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isLookupHost } from "@shared/site-name";


/** The value once it has stopped changing for `ms` — so a lookup, or a favicon
 * request, is spent on the domain the operator finished typing, not on every
 * prefix of it. */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The name a site gives itself, once the domain has settled (bead
 * `ro-ujb9.96.7.5`). `null` while nothing is known — no domain yet, a host the
 * lookup does not fetch, a site that has not answered or answered with no
 * name — and the add screen shows the domain's own name meanwhile. Asked once
 * per domain and remembered: a site's name does not change while a dialog is
 * open.
 */
export function useSiteName(domain: string | null): string | null {
  const { fetchSiteName } = useTowerApi();
  const settled = useSettled(domain, 400);
  const asked = settled !== null && settled === domain && isLookupHost(settled) ? settled : null;
  const { data } = useQuery({
    queryKey: ["site-name", asked],
    queryFn: ({ signal }) => fetchSiteName(asked!, signal),
    enabled: asked !== null,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
  return asked === null ? null : (data ?? null);
}
