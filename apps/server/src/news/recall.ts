import Database from "better-sqlite3";
import { normalizeTitle } from "../sources/url.ts";

/**
 * Recall index for candidate selection: "which known documents might be about
 * the same story as this title?"
 *
 * Backed by SQLite FTS5 with the porter tokenizer, so word forms unify without
 * a hand-maintained synonym table: borrow/borrows/borrowing and chip/chips
 * collapse automatically. Amounts are normalized because publishers write them
 * inconsistently ("$40 Billion" and "$40bn" both become "40b").
 *
 * This only decides which candidates reach the model. Ranking is by the share
 * of query terms a document contains, which is deliberately not a similarity
 * threshold used for merging: a merge still needs either an exact reprint or
 * the model's explicit choice.
 */

const STOP_WORDS = new Set(
  `a an the and or to of for in on at with as by from is are was were be been being its it
   this that these those will would could should may might must can into over after before
   during under above about more most other such only than then when where while
   new says said report reports reported`
    .split(/\s+/)
    .filter(Boolean),
);

const MIN_TERM_LENGTH = 2;
/** Share of query terms a document must contain to be worth showing the model. */
export const RECALL_MIN_RATIO = 0.3;

/** Normalized form used both when indexing and when querying. */
export function recallText(title: string): string {
  return normalizeTitle(title)
    .replace(/(\d+(?:\.\d+)?)\s*(?:billion|bn|b)\b/g, "$1b")
    .replace(/(\d+(?:\.\d+)?)\s*(?:million|mn|m)\b/g, "$1m");
}

function queryTerms(title: string): string[] {
  return [
    ...new Set(
      recallText(title)
        .split(" ")
        .filter((term) => term.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(term)),
    ),
  ];
}

export type RecallDoc = { id: string; titles: string[] };
export type RecallHit = { id: string; ratio: number };

export type RecallIndex = {
  /** Registers another document, e.g. an event this run just created. */
  add: (doc: RecallDoc) => void;
  rank: (title: string, options?: { limit?: number; minRatio?: number }) => RecallHit[];
  /** Ranks by the best match across several query titles for one document. */
  rankAny: (titles: string[], options?: { limit?: number; minRatio?: number }) => RecallHit[];
  close: () => void;
};

export function createRecallIndex(initial: RecallDoc[] = []): RecallIndex {
  const db = new Database(":memory:");
  db.exec(
    `CREATE VIRTUAL TABLE recall USING fts5(doc_id UNINDEXED, body, tokenize='porter unicode61')`,
  );
  const insert = db.prepare("INSERT INTO recall (doc_id, body) VALUES (?, ?)");
  const containing = db.prepare("SELECT DISTINCT doc_id AS id FROM recall WHERE recall MATCH ?");
  const ranked = db.prepare(
    "SELECT doc_id AS id, bm25(recall) AS score FROM recall WHERE recall MATCH ? ORDER BY score LIMIT ?",
  );

  const add = (doc: RecallDoc) => {
    for (const title of doc.titles) {
      const body = recallText(title);
      if (body.length > 0) insert.run(doc.id, body);
    }
  };
  for (const doc of initial) add(doc);

  const rank = (
    title: string,
    { limit = 5, minRatio = RECALL_MIN_RATIO }: { limit?: number; minRatio?: number } = {},
  ): RecallHit[] => {
    const terms = queryTerms(title);
    if (terms.length === 0) return [];

    // Which terms each document contains, through the stemmed index.
    const matched = new Map<string, number>();
    for (const term of terms) {
      for (const row of containing.all(`"${term}"`) as { id: string }[]) {
        matched.set(row.id, (matched.get(row.id) ?? 0) + 1);
      }
    }
    if (matched.size === 0) return [];

    // bm25 only breaks ties between equally-covered documents.
    const scores = new Map<string, number>();
    for (const row of ranked.all(terms.map((term) => `"${term}"`).join(" OR "), limit * 4) as {
      id: string;
      score: number;
    }[]) {
      if (!scores.has(row.id) || row.score < scores.get(row.id)!) scores.set(row.id, row.score);
    }

    return [...matched.entries()]
      .map(([id, hits]) => ({ id, ratio: hits / terms.length }))
      .filter((hit) => hit.ratio >= minRatio)
      .sort((a, b) => b.ratio - a.ratio || (scores.get(a.id) ?? 0) - (scores.get(b.id) ?? 0))
      .slice(0, limit);
  };

  return {
    add,
    rank,
    rankAny: (titles, options) => {
      const best = new Map<string, number>();
      for (const title of titles) {
        for (const hit of rank(title, options)) {
          if (hit.ratio > (best.get(hit.id) ?? -1)) best.set(hit.id, hit.ratio);
        }
      }
      return [...best.entries()]
        .map(([id, ratio]) => ({ id, ratio }))
        .sort((a, b) => b.ratio - a.ratio)
        .slice(0, options?.limit ?? 5);
    },
    close: () => db.close(),
  };
}
