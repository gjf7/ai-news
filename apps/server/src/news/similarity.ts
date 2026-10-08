import { normalizeTitle } from "../sources/url.ts";

/**
 * Character-trigram Jaccard similarity over normalized titles.
 *
 * Only used to recognise a near-exact reprint (a very high score on a single
 * candidate) so the obvious case skips the model. Candidate *recall* — deciding
 * which events are worth showing the model — lives in recall.ts, which uses an
 * FTS5 index instead so word forms do not need a hand-written table.
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

/** A title is a reprint when its normalized form matches to this similarity. */
export function isReprint(a: string, b: string): boolean {
  return trigramSimilarity(normalizeTitle(a), normalizeTitle(b)) >= 0.85;
}
