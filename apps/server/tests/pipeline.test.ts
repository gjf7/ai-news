import { expect, test } from "vite-plus/test";
import { trigramSimilarity } from "../src/news/similarity.ts";
import { createRecallIndex, RECALL_MIN_RATIO } from "../src/news/recall.ts";
import { classifyByKeywords, parseClassification } from "../src/news/filtering.ts";
import { computeHotScore, normalizeCommunity, topicsFor } from "../src/news/scoring.ts";
import {
  computeInputHash,
  parseInsightOutput,
  selectEvidence,
  shouldBumpNotificationRevision,
  type EvidenceArticle,
} from "../src/insights/insight.ts";

function article(overrides: Partial<EvidenceArticle> = {}): EvidenceArticle {
  return {
    id: "a1",
    title: "Title",
    excerpt: "Excerpt",
    publisher: "Pub",
    scope: "excerpt",
    publishedAt: new Date("2026-10-06T00:00:00Z"),
    ...overrides,
  };
}

test("identical titles are maximally similar", () => {
  expect(trigramSimilarity("openai ships gpt", "openai ships gpt")).toBe(1);
});

test("a reprint with a changed suffix stays highly similar", () => {
  const a = "nvidia unveils blackwell successor for data centers";
  const b = "nvidia unveils blackwell successor for data centers - reuters";
  expect(trigramSimilarity(a, b)).toBeGreaterThan(0.8);
});

test("unrelated titles score low", () => {
  expect(trigramSimilarity("nvidia earnings beat", "olympic opening ceremony")).toBeLessThan(0.3);
});

test("candidates are recalled and the unrelated one is filtered out", () => {
  const candidates = [
    { id: "e1", titles: ["nvidia unveils new data center gpu"] },
    { id: "e2", titles: ["completely unrelated story about cooking"] },
    { id: "e3", titles: ["nvidia unveils new data center gpu for training"] },
  ];
  const index = createRecallIndex(candidates);
  try {
    const hits = index.rank("nvidia unveils new data center gpu", {
      limit: 5,
      minRatio: RECALL_MIN_RATIO,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.id !== "e2")).toBe(true);
    for (let position = 1; position < hits.length; position += 1) {
      expect(hits[position - 1]!.ratio).toBeGreaterThanOrEqual(hits[position]!.ratio);
    }
  } finally {
    index.close();
  }
});

test("keyword rules mark obvious AI and chip stories relevant", () => {
  expect(classifyByKeywords("OpenAI launches a new model", null)).toBe("relevant");
  expect(classifyByKeywords("TSMC expands 2nm capacity", null)).toBe("relevant");
  expect(classifyByKeywords("Nvidia data center GPU demand", null)).toBe("relevant");
});

test("keyword rules do not match substrings like 'said' for 'ai'", () => {
  expect(classifyByKeywords("He said the market moved", null)).toBe("unknown");
});

test("negative terms mark a story irrelevant", () => {
  expect(classifyByKeywords("Weekend football results", null)).toBe("irrelevant");
});

test("classification parsing ignores out-of-range and malformed entries", () => {
  const parsed = parseClassification(
    '{"results":[{"index":0,"relevant":true},{"index":9,"relevant":true},{"index":1,"relevant":"yes"}]}',
    2,
  );
  expect(parsed.get(0)).toBe(true);
  expect(parsed.has(9)).toBe(false);
  expect(parsed.has(1)).toBe(false);
});

test("classification parsing survives a fenced JSON block", () => {
  const parsed = parseClassification('```json\n{"results":[{"index":0,"relevant":false}]}\n```', 1);
  expect(parsed.get(0)).toBe(false);
});

test("topics are detected independently for AI and semiconductors", () => {
  expect(topicsFor("OpenAI releases a new model", null)).toEqual(["ai"]);
  expect(topicsFor("TSMC 2nm wafer capacity", null)).toEqual(["semiconductor"]);
  expect(topicsFor("Nvidia GPU for AI training", null)).toEqual(["ai", "semiconductor"]);
});

test("hot score favours recency and corroboration", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const fresh = computeHotScore({
    effectiveTime: new Date("2026-10-06T11:55:00Z"),
    topics: ["ai"],
    publisherCount: 3,
    communityScores: [{ source: "hacker-news", score: 500 }],
    now,
  });
  const stale = computeHotScore({
    effectiveTime: new Date("2026-10-04T12:00:00Z"),
    topics: [],
    publisherCount: 1,
    communityScores: [],
    now,
  });
  expect(fresh).toBeGreaterThan(stale);
});

test("community heat is normalized within each source", () => {
  // Raw points are not comparable across channels: each is scaled against the
  // reference that counts as "hot" for its own source.
  expect(normalizeCommunity([{ source: "reddit", score: 200 }])).toBeCloseTo(1, 5);
  expect(normalizeCommunity([{ source: "reddit", score: 100 }])).toBeCloseTo(0.5, 5);
  // 50 lobsters points is hot for lobsters, but 50 reddit upvotes is not.
  expect(normalizeCommunity([{ source: "lobsters", score: 50 }])).toBeCloseTo(1, 5);
  expect(normalizeCommunity([{ source: "reddit", score: 50 }])).toBeCloseTo(0.25, 5);

  // The best article in the event wins.
  expect(
    normalizeCommunity([
      { source: "reddit", score: 50 },
      { source: "hacker-news", score: 300 },
    ]),
  ).toBeCloseTo(1, 5);

  // Capped at 1, and no scores means no contribution.
  expect(normalizeCommunity([{ source: "hacker-news", score: 99999 }])).toBe(1);
  expect(normalizeCommunity([])).toBe(0);
});

test("evidence prefers distinct publishers and excerpts", () => {
  const evidence = selectEvidence([
    article({ id: "1", publisher: "A", scope: "headline" }),
    article({ id: "2", publisher: "A", scope: "excerpt" }),
    article({ id: "3", publisher: "B", scope: "excerpt" }),
  ]);
  // One article per publisher comes first, then the remainder.
  expect(evidence.articles[0]!.publisher).toBe("A");
  expect(evidence.articles[1]!.publisher).toBe("B");
  expect(evidence.scope).toBe("excerpt");
});

test("evidence is capped at eight articles", () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    article({ id: `a${index}`, publisher: `P${index}` }),
  );
  expect(selectEvidence(many).articles).toHaveLength(8);
});

test("headline-only evidence reports headline scope", () => {
  const evidence = selectEvidence([
    article({ id: "1", scope: "headline", excerpt: null }),
    article({ id: "2", scope: "headline", excerpt: null }),
  ]);
  expect(evidence.scope).toBe("headline");
});

test("input hash is order independent", () => {
  const a = [article({ id: "1" }), article({ id: "2", publisher: "B" })];
  const b = [article({ id: "2", publisher: "B" }), article({ id: "1" })];
  const left = computeInputHash({ articles: a, scope: "excerpt" }, { model: "m" });
  const right = computeInputHash({ articles: b, scope: "excerpt" }, { model: "m" });
  expect(left).toBe(right);
});

test("input hash changes when the model or evidence changes", () => {
  const articles = [article({ id: "1" })];
  const base = computeInputHash({ articles, scope: "excerpt" }, { model: "m1" });
  expect(computeInputHash({ articles, scope: "excerpt" }, { model: "m2" })).not.toBe(base);
  expect(
    computeInputHash(
      { articles: [article({ id: "1", excerpt: "different" })], scope: "excerpt" },
      {
        model: "m1",
      },
    ),
  ).not.toBe(base);
});

const validOutput = JSON.stringify({
  title: "标题",
  facts: [{ text: "事实", citations: ["0"] }],
  importance: { score: 80, reason: "重要" },
  impact: "影响",
  watch: null,
  material_update: { is: true, reason: "新进展" },
});

test("valid insight output parses", () => {
  const result = parseInsightOutput(validOutput, {
    articles: [article({ id: "1" })],
    scope: "excerpt",
  });
  expect(result.ok).toBe(true);
});

test("a citation outside the evidence is rejected", () => {
  const content = validOutput.replace('["0"]', '["5"]');
  const result = parseInsightOutput(content, {
    articles: [article({ id: "1" })],
    scope: "excerpt",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("not in this evidence set");
});

test("headline-only evidence must not carry an impact judgement", () => {
  const result = parseInsightOutput(validOutput, {
    articles: [article({ id: "1", scope: "headline" })],
    scope: "headline",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("headline-only");
});

test("malformed output is rejected rather than guessed", () => {
  expect(
    parseInsightOutput("not json at all", { articles: [article()], scope: "excerpt" }).ok,
  ).toBe(false);
});

test("the first insight always bumps the notification revision", () => {
  const output = { material_update: { is: false, reason: "" }, facts: [] } as never;
  expect(
    shouldBumpNotificationRevision({
      previousInsightExists: false,
      output,
      evidenceArticleIds: ["1"],
      previousArticleIds: [],
    }),
  ).toBe(true);
});

test("a reprint wave does not bump the revision", () => {
  // Evidence grew, but the insight cites only the article already known.
  const output = {
    material_update: { is: false, reason: "" },
    facts: [{ text: "f", citations: ["0"] }],
  } as never;
  expect(
    shouldBumpNotificationRevision({
      previousInsightExists: true,
      output,
      evidenceArticleIds: ["1", "2"],
      previousArticleIds: ["1"],
    }),
  ).toBe(false);
});

test("a material update citing a new article bumps the revision", () => {
  const output = {
    material_update: { is: true, reason: "new action" },
    facts: [{ text: "f", citations: ["1"] }],
  } as never;
  expect(
    shouldBumpNotificationRevision({
      previousInsightExists: true,
      output,
      evidenceArticleIds: ["1", "2"],
      previousArticleIds: ["1"],
    }),
  ).toBe(true);
});

test("a material update citing only old articles does not bump", () => {
  const output = {
    material_update: { is: true, reason: "new action" },
    facts: [{ text: "f", citations: ["0"] }],
  } as never;
  expect(
    shouldBumpNotificationRevision({
      previousInsightExists: true,
      output,
      evidenceArticleIds: ["1"],
      previousArticleIds: ["1"],
    }),
  ).toBe(false);
});
