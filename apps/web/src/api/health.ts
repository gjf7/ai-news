import { queryOptions } from "@tanstack/react-query";
import { HealthStatus } from "@ai-news/contracts";
import { request } from "../lib/http.ts";

export const healthQueryOptions = queryOptions({
  queryKey: ["health"],
  queryFn: async () => HealthStatus.parse(await request("/api/health")),
  refetchInterval: 30_000,
});
