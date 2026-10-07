import { createHash, randomUUID } from "node:crypto";

/** Random id for rows whose identity is not derived from content. */
export function newId(): string {
  return randomUUID();
}

/**
 * Deterministic article id derived from the canonical URL. Re-fetching the
 * same article therefore upserts the same row instead of creating a duplicate,
 * and article_sources references stay stable across runs.
 */
export function articleIdFromUrl(canonicalUrl: string): string {
  return createHash("sha1").update(canonicalUrl).digest("hex").slice(0, 24);
}

/** Deterministic event id for the "no candidates" case is not needed; events use newId(). */
