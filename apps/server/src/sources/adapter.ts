/**
 * Contract every source adapter implements. Adapters only fetch and parse;
 * they never touch the database, the model, or the network beyond the
 * addresses configured for their own source.
 */
export type ArticleKind = "news" | "paper" | "discussion";

export type FetchedArticle = {
  /** Stable identity within the source (RSS guid, HN objectID, ...). */
  externalId: string;
  /** Original publisher URL when known, otherwise the discovery URL. */
  url: string;
  title: string;
  /** Publisher name used for independent-outlet counting. */
  publisher: string;
  publishedAt: Date | null;
  /** RSS/API excerpt. Absent when the source only provides a title. */
  excerpt: string | null;
  /** Paper for preprint servers, discussion for community channels. The
   * registry stamps this from the source definition; adapters may omit it. */
  kind?: ArticleKind;
  /**
   * True when `url` still points at the discovery channel rather than the
   * original article (Google News could not be resolved).
   */
  unresolved?: boolean;
  /** Whether resolution was attempted. Distinguishes "over cap" from "failed". */
  resolveAttempted?: boolean;
  /** Community score when the source exposes one (HN points, Reddit ups). */
  communityScore: number | null;
};

export type FetchResult = {
  articles: FetchedArticle[];
  /** Non-fatal problems worth surfacing on the sources page. */
  warnings: string[];
  /**
   * True when the adapter could not fetch at all (every feed failed). The
   * runner counts this as a failed source; an adapter that merely returned no
   * items today leaves it false. A missing credential is a configuration
   * state, not a fetch failure, so it reports warnings without setting this.
   */
  failed?: boolean;
};

export type SourceAdapter = {
  /** Matches `sources.adapter` in the database. */
  key: string;
  fetch: (signal: AbortSignal) => Promise<FetchResult>;
};
