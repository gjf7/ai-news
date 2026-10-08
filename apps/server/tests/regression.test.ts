import { expect, test } from "vite-plus/test";
import {
  CLUSTERING_CASES,
  KEYWORD_IRRELEVANT,
  KEYWORD_RELEVANT,
  KEYWORD_UNDECIDED,
} from "../src/news/__fixtures__/clustering-cases.ts";
import { classifyByKeywords } from "../src/news/filtering.ts";
import { rankCandidates, trigramSimilarity } from "../src/news/similarity.ts";
import { normalizeTitle } from "../src/sources/url.ts";

/**
 * Regression over the saved samples. These are the cases architecture.md
 * requires to stay correct: 转载 / 改写 / 同公司不同事件 / 真实进展, plus the
 * keyword rules the filtering stage relies on.
 */

// The thresholds the pipeline actually uses.
const DIRECT_MERGE = 0.85;
const CANDIDATE = 0.3;

for (const sample of CLUSTERING_CASES) {
  test(`clustering sample: ${sample.name}`, () => {
    const similarity = trigramSimilarity(
      normalizeTitle(sample.existing),
      normalizeTitle(sample.incoming),
    );

    if (sample.expect === "merge" && sample.via === "direct") {
      // A reprint must clear the direct-merge threshold.
      expect(similarity, `${sample.note} (相似度 ${similarity.toFixed(3)})`).toBeGreaterThanOrEqual(
        DIRECT_MERGE,
      );
      return;
    }

    if (sample.expect === "merge" && sample.via === "model") {
      // A rewrite is a candidate (so the model is asked) but must not
      // auto-merge: that band is exactly what the model adjudicates.
      expect(similarity, `${sample.note} (相似度 ${similarity.toFixed(3)})`).toBeGreaterThanOrEqual(
        CANDIDATE,
      );
      expect(similarity, `${sample.note} (相似度 ${similarity.toFixed(3)})`).toBeLessThan(
        DIRECT_MERGE,
      );
      return;
    }

    // "new" cases must never auto-merge. In practice the same-company and
    // same-topic samples fall below the candidate threshold entirely, so no
    // model call is needed; what matters is that they are never merged.
    expect(similarity, `${sample.note} (相似度 ${similarity.toFixed(3)})`).toBeLessThan(
      DIRECT_MERGE,
    );
  });
}

test("a reprint is ranked as the only candidate and auto-merges", () => {
  const candidates = [
    { id: "e1", titles: ["Nvidia heads for $6 trillion value as chips rally"] },
    { id: "e2", titles: ["TSMC expands 2nm capacity in Arizona"] },
  ];
  const ranked = rankCandidates("Nvidia Heads for $6 Trillion Value as Chips Rally", candidates, {
    threshold: CANDIDATE,
    limit: 5,
  });

  expect(ranked).toHaveLength(1);
  expect(ranked[0]!.item.id).toBe("e1");
  expect(ranked[0]!.similarity).toBeGreaterThanOrEqual(DIRECT_MERGE);
});

test("same-company-different-event is never an auto-merge", () => {
  const candidates = [{ id: "e1", titles: ["Nvidia heads for $6 trillion value as chips rally"] }];
  const ranked = rankCandidates("Nvidia unveils new data center GPU for AI training", candidates, {
    threshold: CANDIDATE,
    limit: 5,
  });

  // Either it is not a candidate (new event directly) or it is handed to the
  // model — what must never happen is an automatic merge.
  for (const candidate of ranked) {
    expect(candidate.similarity).toBeLessThan(DIRECT_MERGE);
  }
});

/**
 * The paraphrase cases that produced duplicate SpaceX notifications in
 * production. Their titles share almost no character trigrams, so a
 * trigram-only candidate filter never asked the model and each headline became
 * its own event. Word/amount overlap must recall them as candidates, while
 * still never reaching the direct-merge band on its own.
 */
const SPACEX_FINANCING_CASES = [
  "SpaceX seeks $40bn to buy Nvidia chips",
  "SpaceX Reported to Be in $40 Billion Nvidia Chip-Financing Talks",
  "SpaceX Seeks $40B for Nvidia Chips as AI Megadeals Loom",
  "SpaceX Seeks To Join AI Borrowing Bonanza",
];

test("paraphrases of one financing story are recalled as candidates", () => {
  const existing = {
    id: "e1",
    titles: ["SpaceX in Talks to Borrow $40 Billion to Buy Nvidia Chips"],
  };
  for (const incoming of SPACEX_FINANCING_CASES) {
    const ranked = rankCandidates(incoming, [existing], { threshold: CANDIDATE, limit: 5 });
    expect(
      ranked.map((entry) => entry.item.id),
      incoming,
    ).toEqual(["e1"]);
    // Recall only: the model must still make the merge decision.
    expect(ranked[0]!.similarity, incoming).toBeLessThan(DIRECT_MERGE);
  }
});

test("a new development is recalled but never auto-merged", () => {
  // The credit-risk reaction is a materially different story; it must reach the
  // model (so the notification guard can judge novelty) without merging blindly.
  const existing = {
    id: "e1",
    titles: ["SpaceX in Talks to Borrow $40 Billion to Buy Nvidia Chips"],
  };
  const ranked = rankCandidates(
    "SpaceX credit risk jumps on its $40 billion Nvidia chip borrowing",
    [existing],
    { threshold: CANDIDATE, limit: 5 },
  );
  expect(ranked.map((entry) => entry.item.id)).toEqual(["e1"]);
  expect(ranked[0]!.similarity).toBeLessThan(DIRECT_MERGE);
});

for (const title of KEYWORD_RELEVANT) {
  test(`keyword rules mark relevant: ${title.slice(0, 48)}`, () => {
    expect(classifyByKeywords(title, null)).toBe("relevant");
  });
}

for (const title of KEYWORD_IRRELEVANT) {
  test(`keyword rules mark irrelevant: ${title.slice(0, 48)}`, () => {
    expect(classifyByKeywords(title, null)).toBe("irrelevant");
  });
}

for (const title of KEYWORD_UNDECIDED) {
  test(`keyword rules leave for the model: ${title.slice(0, 48)}`, () => {
    expect(classifyByKeywords(title, null)).toBe("unknown");
  });
}

test("a relevant term inside a larger word does not match", () => {
  // "ai" must not match "said", "air" or "maintain".
  expect(classifyByKeywords("He said the air was maintained", null)).toBe("unknown");
});
