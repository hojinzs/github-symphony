import { useQuery } from "@tanstack/react-query";
import type { IssueStatusSnapshot } from "@gh-symphony/core";
import { api } from "../lib/api";
import { queryKeys } from "../lib/query";

export function useIssueDetail(identifier: string) {
  return useQuery({
    queryKey: queryKeys.issueDetail(identifier),
    queryFn: () =>
      api
        .get<IssueStatusSnapshot>(`/api/v1/${encodeURIComponent(identifier)}`)
        .then((response) => response.data),
    refetchInterval: 10_000,
  });
}
