import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SessionState } from "@ai-news/contracts";
import { request } from "../lib/http.ts";

/**
 * Both mutations write the resulting session state straight into the cache
 * rather than invalidating and refetching. The router guard reads this cache
 * synchronously during navigation, so leaving it stale would bounce the user
 * back to /login right after a successful login.
 */
export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (password: string) =>
      SessionState.parse(
        await request("/api/session", {
          method: "POST",
          body: JSON.stringify({ password }),
        }),
      ),
    onSuccess: (session) => client.setQueryData(["session"], session),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>("/api/session", { method: "DELETE" }),
    onSuccess: () => client.setQueryData(["session"], { authenticated: false }),
  });
}
