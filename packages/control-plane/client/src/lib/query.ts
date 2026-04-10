import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

export const queryKeys = {
  projectState: () => ["project", "state"] as const,
  issueDetail: (identifier: string) => ["issue", identifier] as const,
};
