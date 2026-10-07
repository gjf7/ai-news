import { and, eq, isNull } from "drizzle-orm";
import type { DbHandle } from "../db/connection.ts";
import { articles } from "../db/schema.ts";
import type { ModelClient } from "../insights/model.ts";

/**
 * Relevance filtering. Generic sources (Hacker News, Reddit, Lobsters,
 * Bloomberg markets) carry a lot of off-topic material, and every irrelevant
 * article that reaches clustering costs model calls.
 *
 * Order: keyword rules first, then a batched model classification for what the
 * rules cannot decide. Irrelevant articles are kept in the database (marked)
 * so they are never classified twice.
 */

export const AI_TERMS = [
  "ai",
  "a.i.",
  "artificial intelligence",
  "machine learning",
  "deep learning",
  "neural",
  "llm",
  "large language model",
  "gpt",
  "chatgpt",
  "openai",
  "anthropic",
  "claude",
  "gemini",
  "deepseek",
  "mistral",
  "llama",
  "transformer",
  "diffusion",
  "agent",
  "inference",
  "fine-tun",
  "prompt",
  "embedding",
  "rag",
  "gpu",
  "nvidia",
  "tpu",
  "cuda",
  "copilot",
  "hugging face",
  "foundation model",
];

export const SEMICONDUCTOR_TERMS = [
  "semiconductor",
  "chip",
  "wafer",
  "foundry",
  "fab",
  "tsmc",
  "intel",
  "asml",
  "euv",
  "lithography",
  "nanometer",
  "3nm",
  "2nm",
  "hbm",
  "dram",
  "nand",
  "risc-v",
  "asic",
  "fpga",
  "chiplet",
  "silicon",
  "microprocessor",
  "amd",
  "qualcomm",
  "broadcom",
  "micron",
  "sk hynix",
  "onsemi",
  "infineon",
  "samsung electronics",
  // GPU vendors and packaging also belong to the chip beat; AI and
  // semiconductors overlap heavily, and an event can be about both.
  "nvidia",
  "gpu",
  "tpu",
  "cuda",
];

/** Terms that almost always mean the article is off-topic for this tool. */
export const NEGATIVE_TERMS = [
  "horoscope",
  "celebrity",
  "football",
  "nba finals",
  "soccer",
  "recipe",
  "crossword",
  "lottery",
  "weather forecast",
];

const ALL_TERMS = [...AI_TERMS, ...SEMICONDUCTOR_TERMS];

export type KeywordVerdict = "relevant" | "irrelevant" | "unknown";

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a term at a word boundary, allowing a plural/verb suffix.
 *
 * Without the optional suffix, real headlines were missed constantly:
 * "semiconductors", "chips", "LLMs" and "GPUs" all failed to match their own
 * terms, which pushed 41% of articles into the model path. The suffix is
 * limited to `s`/`es` so "ai" still does not match "said" or "air".
 */
function termPattern(term: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}(s|es)?([^a-z0-9]|$)`, "i");
}

export function classifyByKeywords(title: string, excerpt: string | null): KeywordVerdict {
  const text = `${title} ${excerpt ?? ""}`.toLowerCase();

  if (NEGATIVE_TERMS.some((term) => termPattern(term).test(text))) return "irrelevant";

  const matched = ALL_TERMS.some((term) => termPattern(term).test(text));

  return matched ? "relevant" : "unknown";
}

const MODEL_BATCH_SIZE = 50;

const CLASSIFY_SYSTEM = `You classify news items for a personal AI-and-semiconductor news reader.
For each item decide whether it is about artificial intelligence or the semiconductor/chip industry.
Include: AI models and products, AI companies and research, chips, fabs, EDA, memory, GPUs, chip supply chains.
Exclude: general business, general politics, sports, entertainment, health, and anything unrelated.
Respond with JSON only: {"results":[{"index":0,"relevant":true}]}`;

export type FilterDeps = {
  handle: DbHandle;
  model: ModelClient;
  signal: AbortSignal;
  /** Caps model batches per run so filtering cannot eat the whole budget. */
  maxModelBatches?: number;
};

export type FilterResult = {
  relevant: number;
  irrelevant: number;
  /** Left as pending because a batch failed or the cap was hit. */
  deferred: number;
};

type PendingArticle = {
  id: string;
  title: string;
  excerpt: string | null;
  /** Set when every source that discovered this article has a default topic. */
  sourceTopic: string | null;
};

export async function runFiltering({
  handle,
  model,
  signal,
  maxModelBatches = 4,
}: FilterDeps): Promise<FilterResult> {
  // An article's source default topic decides it outright when the source is
  // topic-specific (Semiconductor Engineering, arXiv categories, ...). The
  // query returns one row per (article, source) so a generic source's lack of
  // a default topic is visible.
  const rows = handle.sqlite
    .prepare(
      `SELECT a.id AS id, a.title AS title, a.excerpt AS excerpt,
              s.default_topics AS defaultTopics
       FROM articles a
       LEFT JOIN article_sources asrc ON asrc.article_id = a.id
       LEFT JOIN sources s ON s.id = asrc.source_id
       WHERE a.relevance = 'pending'`,
    )
    .all() as { id: string; title: string; excerpt: string | null; defaultTopics: string | null }[];

  const byId = new Map<string, PendingArticle>();
  for (const row of rows) {
    const topics = parseTopics(row.defaultTopics);
    const existing = byId.get(row.id);
    if (!existing) {
      byId.set(row.id, {
        id: row.id,
        title: row.title,
        excerpt: row.excerpt,
        sourceTopic: topics[0] ?? null,
      });
    } else if (existing.sourceTopic && !topics.includes(existing.sourceTopic)) {
      // Discovered by a source without a default topic, so the source rule
      // cannot decide it.
      existing.sourceTopic = null;
    }
  }

  const pending = [...byId.values()];
  const result: FilterResult = { relevant: 0, irrelevant: 0, deferred: 0 };
  const undecided: PendingArticle[] = [];

  for (const article of pending) {
    // Source default topic: directly relevant, no keyword or model call needed.
    if (article.sourceTopic) {
      setRelevance(handle, article.id, "relevant");
      result.relevant += 1;
      continue;
    }

    const verdict = classifyByKeywords(article.title, article.excerpt);
    if (verdict === "relevant") {
      setRelevance(handle, article.id, "relevant");
      result.relevant += 1;
    } else if (verdict === "irrelevant") {
      setRelevance(handle, article.id, "irrelevant");
      result.irrelevant += 1;
    } else {
      undecided.push(article);
    }
  }

  if (undecided.length === 0 || !model.available) {
    result.deferred += undecided.length;
    return result;
  }

  const batches = Math.min(Math.ceil(undecided.length / MODEL_BATCH_SIZE), maxModelBatches);
  for (let batchIndex = 0; batchIndex < batches; batchIndex += 1) {
    if (signal.aborted) break;
    const batch = undecided.slice(
      batchIndex * MODEL_BATCH_SIZE,
      (batchIndex + 1) * MODEL_BATCH_SIZE,
    );

    try {
      const verdicts = await classifyBatch(model, batch, signal);
      for (const [index, article] of batch.entries()) {
        const relevant = verdicts.get(index);
        if (relevant === undefined) {
          result.deferred += 1;
          continue;
        }
        setRelevance(handle, article.id, relevant ? "relevant" : "irrelevant");
        if (relevant) result.relevant += 1;
        else result.irrelevant += 1;
      }
    } catch {
      // The model is an external dependency: any failure defers this batch to
      // the next run instead of aborting the whole pipeline.
      result.deferred += batch.length;
      continue;
    }
  }

  result.deferred += Math.max(0, undecided.length - batches * MODEL_BATCH_SIZE);
  return result;
}

async function classifyBatch(
  model: ModelClient,
  batch: PendingArticle[],
  signal: AbortSignal,
): Promise<Map<number, boolean>> {
  const listing = batch
    .map(
      (article, index) =>
        `${index}. ${article.title}${article.excerpt ? ` — ${article.excerpt.slice(0, 160)}` : ""}`,
    )
    .join("\n");

  const content = await model.complete({
    signal,
    temperature: 0,
    // 50 items with per-item JSON already need ~1.5k, and a reasoning model
    // adds its reasoning tokens on top of that.
    maxTokens: 4096,
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM },
      { role: "user", content: listing },
    ],
  });

  return parseClassification(content, batch.length);
}

/** Tolerant parse: a malformed response leaves items undecided rather than guessing. */
export function parseClassification(content: string, size: number): Map<number, boolean> {
  const result = new Map<number, boolean>();
  const json = extractJson(content);
  if (!json) return result;

  try {
    const parsed = JSON.parse(json) as { results?: { index?: number; relevant?: boolean }[] };
    for (const entry of parsed.results ?? []) {
      if (typeof entry.index !== "number" || entry.index < 0 || entry.index >= size) continue;
      if (typeof entry.relevant !== "boolean") continue;
      result.set(entry.index, entry.relevant);
    }
  } catch {
    return result;
  }
  return result;
}

function extractJson(content: string): string | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return content.slice(start, end + 1);
}

function setRelevance(handle: DbHandle, id: string, relevance: "relevant" | "irrelevant"): void {
  handle.db.update(articles).set({ relevance }).where(eq(articles.id, id)).run();
}

function parseTopics(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** Articles already marked relevant and not yet attached to an event. */
export function pendingClusterArticles(handle: DbHandle) {
  return handle.db
    .select()
    .from(articles)
    .where(and(eq(articles.relevance, "relevant"), isNull(articles.eventId)))
    .all();
}
