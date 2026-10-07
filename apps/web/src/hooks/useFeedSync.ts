import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { statusQueryOptions } from "../api/monitoring.ts";

/**
 * Feed freshness. `feedRevision` is max(events.updated_at); when it changes the
 * page either reloads the list automatically or offers a "new content" prompt,
 * depending on whether the reader is at the top with nothing expanded.
 */
export function useFeedSync({ autoReload }: { autoReload: boolean }) {
  const status = useQuery(statusQueryOptions);
  const [hasNewContent, setHasNewContent] = useState(false);
  const seenRevision = useRef<string | null>(null);

  const revision = status.data?.feedRevision ?? null;

  if (revision && seenRevision.current === null) {
    seenRevision.current = revision;
  } else if (revision && seenRevision.current !== revision) {
    if (autoReload) {
      seenRevision.current = revision;
      if (hasNewContent) setHasNewContent(false);
    } else if (!hasNewContent) {
      setHasNewContent(true);
    }
  }

  const acknowledge = () => {
    seenRevision.current = revision;
    setHasNewContent(false);
  };

  return { status: status.data, hasNewContent, acknowledge };
}
