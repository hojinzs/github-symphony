import { useMutation, useQueryClient } from "@tanstack/react-query";
import { postRefresh } from "../lib/api";

export function useRefresh() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: postRefresh,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    },
  });
}
