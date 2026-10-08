import { expect, test } from "vite-plus/test";
import {
  CLUSTERING_CASES,
  KEYWORD_IRRELEVANT,
  KEYWORD_RELEVANT,
  KEYWORD_UNDECIDED,
} from "../src/news/__fixtures__/clustering-cases.ts";
import { classifyByKeywords } from "../src/news/filtering.ts";
import { createRecallIndex, RECALL_MIN_RATIO } from "../src/news/recall.ts";
import { isReprint } from "../src/news/similarity.ts";

/**
 * Regression over the saved samples. These are the cases architecture.md
 * requires to stay correct: 转载 / 改写 / 同公司不同事件 / 真实进展, plus the
 * keyword rules the filtering stage relies on.
 *
 * Recall (which candidates reach the model) is index-based; merging still needs
 * either a near-exact reprint or the model's explicit decision.
 */

/** Candidate ids the recall index returns for `query`. */
function recalled(docs: { id: string; titles: string[] }[], query: string): string[] {
  const index = createRecallIndex(docs);
  try {
    return index.rank(query, { limit: 5, minRatio: RECALL_MIN_RATIO }).map((hit) => hit.id);
  } finally {
    index.close();
  }
}

for (const sample of CLUSTERING_CASES) {
  test(`clustering sample: ${sample.name}`, () => {
    if (sample.expect === "merge" && sample.via === "direct") {
      // A reprint must be recognised without the model.
      expect(isReprint(sample.existing, sample.incoming), sample.note).toBe(true);
      return;
    }

    if (sample.expect === "merge" && sample.via === "model") {
      // A rewrite must be recalled (so the model is asked) but must never
      // auto-merge: that band is exactly what the model adjudicates.
      expect(isReprint(sample.existing, sample.incoming), sample.note).toBe(false);
      expect(
        recalled([{ id: "e1", titles: [sample.existing] }], sample.incoming),
        sample.note,
      ).toContain("e1");
      return;
    }

    // "new" cases must never auto-merge.
    expect(isReprint(sample.existing, sample.incoming), sample.note).toBe(false);
  });
}

test("a reprint is recalled and recognised without the model", () => {
  const candidates = [
    { id: "e1", titles: ["Nvidia heads for $6 trillion value as chips rally"] },
    { id: "e2", titles: ["TSMC expands 2nm capacity in Arizona"] },
  ];
  const incoming = "Nvidia Heads for $6 Trillion Value as Chips Rally";

  expect(recalled(candidates, incoming)).toEqual(["e1"]);
  expect(isReprint("Nvidia heads for $6 trillion value as chips rally", incoming)).toBe(true);
});

test("same-company-different-event is never an auto-merge", () => {
  const existing = "Nvidia heads for $6 trillion value as chips rally";
  const incoming = "Nvidia unveils new data center GPU for AI training";

  // It may or may not be recalled; what must never happen is an automatic merge.
  expect(isReprint(existing, incoming)).toBe(false);
});

/**
 * The paraphrase cases that produced duplicate SpaceX notifications in
 * production. Their titles share almost no character trigrams, so a
 * trigram-only filter never asked the model and each headline became its own
 * event. The FTS5 index recalls them through porter stemming and amount
 * normalization, without a hand-written synonym table.
 */
const SPACEX_FINANCING_CASES = [
  "SpaceX seeks $40bn to buy Nvidia chips",
  "SpaceX Reported to Be in $40 Billion Nvidia Chip-Financing Talks",
  "SpaceX Seeks $40B for Nvidia Chips as AI Megadeals Loom",
  "SpaceX Seeks To Join AI Borrowing Bonanza",
];

test("paraphrases of one financing story are recalled without a synonym table", () => {
  const existing = {
    id: "e1",
    titles: ["SpaceX in Talks to Borrow $40 Billion to Buy Nvidia Chips"],
  };

  for (const incoming of SPACEX_FINANCING_CASES) {
    expect(recalled([existing], incoming), incoming).toContain("e1");
    // Recall only: the model still makes the merge decision.
    expect(isReprint(existing.titles[0]!, incoming), incoming).toBe(false);
  }
});

test("word forms unify through stemming rather than a hardcoded list", () => {
  // "Borrowing" must match "Borrow", "chips" must match "chip".
  expect(
    recalled(
      [{ id: "e1", titles: ["SpaceX in Talks to Borrow $40 Billion to Buy Nvidia Chips"] }],
      "SpaceX borrowing for Nvidia chip purchase",
    ),
  ).toContain("e1");
});

test("a new development on the same subject is still recalled", () => {
  // The credit-risk reaction is materially different, but it must reach the
  // model so the notification guard can judge novelty.
  expect(
    recalled(
      [{ id: "e1", titles: ["SpaceX in Talks to Borrow $40 Billion to Buy Nvidia Chips"] }],
      "SpaceX credit risk jumps on its $40 billion Nvidia chip borrowing",
    ),
  ).toContain("e1");
});

test("an unrelated headline recalls nothing", () => {
  const existing = [
    { id: "e1", titles: ["SpaceX in Talks to Borrow $40 Billion to Buy Nvidia Chips"] },
  ];
  expect(recalled(existing, "Weekend football results and league table")).toEqual([]);
  expect(recalled(existing, "Fed minutes show hawkish unity behind September rate hike")).toEqual(
    [],
  );
});

test("amounts are normalized across notations", () => {
  const existing = [{ id: "e1", titles: ["OpenAI raises $40 billion in a new round"] }];
  // "$40bn", "$40 billion" and "$40B" must all reach the same document.
  expect(recalled(existing, "OpenAI $40bn round")).toContain("e1");
  expect(recalled(existing, "OpenAI $40B funding round")).toContain("e1");
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
