import { useQuery } from "@tanstack/react-query";
import { fetchProjectState } from "../lib/api";
import { queryKeys } from "../lib/query";

export function useProjectState() {
  return useQuery({
    queryKey: queryKeys.projectState(),
    queryFn: fetchProjectState,
    refetchInterval: 30_000,
  });
}
