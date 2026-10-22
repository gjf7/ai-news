import { queryOptions } from "@tanstack/react-query";
import { EventDetail, EventList, EventQuery, FocusList, type EventRange } from "@ai-news/contracts";
import { request } from "../lib/http.ts";

export type EventFilters = {
  topic?: string;
  source?: string;
  kind?: string;
  range?: EventRange;
  sort?: "hot" | "importance" | "latest";
  page?: number;
};

/** Query keys are derived from the filters so caching and dedup line up. */
export function eventsQueryOptions(filters: EventFilters) {
  const parsed = EventQuery.parse({
    ...filters,
    page: filters.page ?? 1,
  });

  return queryOptions({
    queryKey: ["events", parsed],
    queryFn: async () => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined) params.set(key, String(value));
      }
      return EventList.parse(await request(`/api/events?${params.toString()}`));
    },
  });
}

export function eventQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["event", id],
    queryFn: async () => EventDetail.parse(await request(`/api/events/${id}`)),
  });
}

/**
 * Today's focus list. A separate query, not a filter on the feed: the window is
 * fixed server-side and its items are not necessarily on the current page.
 */
export function focusQueryOptions() {
  return queryOptions({
    queryKey: ["events", "focus"],
    queryFn: async () => FocusList.parse(await request("/api/events/focus")),
  });
}
