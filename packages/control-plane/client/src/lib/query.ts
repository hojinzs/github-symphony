import { QueryClient } from "@tanstack/react-query";

export const queryKeys = {
  issueDetail: (identifier: string) => ["issue", identifier] as const,
};

export const queryClient = new QueryClient();
