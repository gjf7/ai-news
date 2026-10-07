import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { RefreshReceipt } from "@ai-news/contracts";
import { request } from "../lib/http.ts";
import { runQueryOptions, statusQueryOptions } from "../api/monitoring.ts";

/**
 * Manual refresh.
 *
 * The mutation is never retried blindly. When the request fails without a
 * definite HTTP answer (offline, connection reset), the client asks for the
 * current active run instead of firing again: the server would merge a second
 * request into the same run anyway, so re-issuing only risks confusing state.
 *
 * The active run is polled every 2 seconds and polling stops as soon as the run
 * reaches a terminal state.
 */
export function useRefresh() {
  const client = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () =>
      RefreshReceipt.parse(await request("/api/refresh-runs", { method: "POST" })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["status"] });
    },
    onError: () => {
      // Uncertain outcome: ask the server what is actually running.
      void client.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const status = useQuery(statusQueryOptions);
  const activeRunId = status.data?.activeRun?.runId ?? null;

  const active = useQuery({
    ...runQueryOptions(activeRunId ?? "", true),
    enabled: Boolean(activeRunId),
    // Stop polling once the run is no longer queued or running.
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "queued" || state === "running" ? 2_000 : false;
    },
  });

  const activeState = active.data?.state;
  const settled =
    activeState !== undefined && activeState !== "queued" && activeState !== "running";

  // Refreshing the feed is a side effect, so it belongs in an effect rather
  // than in the render body.
  useEffect(() => {
    if (!settled) return;
    void client.invalidateQueries({ queryKey: ["events"] });
    void client.invalidateQueries({ queryKey: ["status"] });
  }, [settled, activeState, client]);

  return { refresh: mutation, status, activeRun: active.data };
}
