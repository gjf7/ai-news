import { queryOptions } from "@tanstack/react-query";
import { SessionState } from "@ai-news/contracts";
import { request } from "../lib/http.ts";

export const sessionQueryOptions = queryOptions({
  queryKey: ["session"],
  queryFn: async () => SessionState.parse(await request("/api/session")),
});
