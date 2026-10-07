import { normalizeTitle } from "../sources/url.ts";

/**
 * Character-trigram Jaccard similarity over normalized titles. Used to pick
 * candidate events before the model decides, and to auto-merge obvious
 * reprints at very high similarity.
 *
 * Deliberately in-memory: within a 72-hour window the event set is only in the
 * hundreds, so there is no reason to reach for a database extension.
 */

function trigrams(input: string): Set<string> {
  const padded = `  ${input}  `;
  const grams = new Set<string>();
  for (let index = 0; index < padded.length - 2; index += 1) {
    grams.add(padded.slice(index, index + 3));
  }
  return grams;
}

export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const gram of left) {
    if (right.has(gram)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export type Candidate<T> = { item: T; similarity: number };

/**
 * Ranks candidate events for a new article by comparing the article's
 * normalized title against every title already inside each candidate event.
 * Returns the top `limit` candidates at or above `threshold`, best first.
 */
export function rankCandidates<T extends { id: string; titles: string[] }>(
  newTitle: string,
  candidates: T[],
  { threshold = 0.3, limit = 5 }: { threshold?: number; limit?: number } = {},
): Candidate<T>[] {
  const target = normalizeTitle(newTitle);

  return candidates
    .map((item) => {
      let best = 0;
      for (const title of item.titles) {
        const similarity = trigramSimilarity(target, normalizeTitle(title));
        if (similarity > best) best = similarity;
      }
      return { item, similarity: best };
    })
    .filter((candidate) => candidate.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}
