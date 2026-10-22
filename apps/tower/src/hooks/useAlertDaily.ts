import { useQuery } from "@tanstack/react-query";
import { useTowerApi } from "@/lib/browser-context";

export function useAlertDaily() {
  const { fetchAlertDaily } = useTowerApi();
  return useQuery({
    queryKey: ["alert-daily"],
    queryFn: ({ signal }) => fetchAlertDaily(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
