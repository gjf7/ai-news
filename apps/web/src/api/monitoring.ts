import { queryOptions } from "@tanstack/react-query";
import {
  ConfigView,
  DeliveryList,
  FeedStatus,
  RunDetail,
  RunList,
  SourceList,
} from "@ai-news/contracts";
import { request } from "../lib/http.ts";

/**
 * The status query polls every 15 seconds while the tab is visible. React
 * Query pauses interval refetching in background tabs, so no extra handling is
 * needed for that.
 */
export const statusQueryOptions = queryOptions({
  queryKey: ["status"],
  queryFn: async () => FeedStatus.parse(await request("/api/status")),
  refetchInterval: 15_000,
});

export function runsQueryOptions(page: number) {
  return queryOptions({
    queryKey: ["runs", page],
    queryFn: async () => RunList.parse(await request(`/api/refresh-runs?page=${page}`)),
  });
}

export function runQueryOptions(id: string, active: boolean) {
  return queryOptions({
    queryKey: ["run", id],
    queryFn: async () => RunDetail.parse(await request(`/api/refresh-runs/${id}`)),
    // An active run is polled every 2 seconds until it reaches a terminal state.
    refetchInterval: active ? 2_000 : false,
  });
}

export const sourcesQueryOptions = queryOptions({
  queryKey: ["sources"],
  queryFn: async () => SourceList.parse(await request("/api/sources")),
});

export const configQueryOptions = queryOptions({
  queryKey: ["config"],
  queryFn: async () => ConfigView.parse(await request("/api/config")),
});

export function deliveriesQueryOptions(page: number) {
  return queryOptions({
    queryKey: ["deliveries", page],
    queryFn: async () => DeliveryList.parse(await request(`/api/deliveries?page=${page}`)),
  });
}
