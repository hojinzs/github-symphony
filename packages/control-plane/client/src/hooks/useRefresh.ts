import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useRefresh() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post("/api/v1/refresh"),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
