import { TAG_IDS, type TagId } from "@ai-news/contracts";

/**
 * Keyword tagging.
 *
 * `AI_TERMS` / `SEMICONDUCTOR_TERMS` also drive relevance filtering, so their
 * behaviour is kept intact. The finer tags use narrower terms and match only
 * the title: an excerpt that mentions "funding" in passing should not relabel
 * an article about a product launch.
 *
 * Bare "cpu" is deliberately absent: it also matches index and ETF tickers.
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
  "fine-tune",
  "fine-tuned",
  "fine-tuning",
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

export const TAG_TERMS: Record<TagId, string[]> = {
  ai: AI_TERMS,
  semiconductor: SEMICONDUCTOR_TERMS,
  model: [
    "gpt",
    "chatgpt",
    "claude",
    "gemini",
    "llama",
    "qwen",
    "deepseek",
    "mistral",
    "grok",
    "llm",
    "large language model",
    "frontier model",
    "foundation model",
    "language model",
    "ai model",
    "new model",
    "open-weight",
    "open weights",
    "model release",
  ],
  agent: [
    "ai agent",
    "agentic",
    "copilot",
    "ai assistant",
    "ai app",
    "ai tool",
    "ai product",
    "chatbot",
    "mcp server",
  ],
  infra: [
    "data center",
    "datacenter",
    "gpu",
    "tpu",
    "cuda",
    "cloud",
    "inference",
    "ai compute",
    "compute cluster",
    "compute capacity",
    "compute credits",
    "supercomputer",
    "nvidia",
    "accelerator",
    "ai server",
  ],
  design: [
    "chip design",
    "eda",
    "asic",
    "fpga",
    "risc-v",
    "chiplet",
    "processor",
    "chip architecture",
    "ip core",
    "gpu architecture",
  ],
  manufacturing: [
    "fab",
    "foundry",
    "wafer",
    "lithography",
    "euv",
    "tsmc",
    "taiwan semiconductor",
    "asml",
    "chip packaging",
    "advanced packaging",
    "3nm",
    "2nm",
    "cleanroom",
    "semiconductor manufacturing",
    "semiconductor equipment",
    "fab equipment",
  ],
  memory: [
    "hbm",
    "dram",
    "nand",
    "memory chip",
    "memory market",
    "memory bandwidth",
    "sk hynix",
    "micron",
    "ddr4",
    "ddr5",
    "flash memory",
    "memory controller",
    "memory prices",
  ],
  research: [
    "arxiv",
    "paper",
    "study",
    "studies",
    "benchmark",
    "dataset",
    "preprint",
    "peer-reviewed",
    "research paper",
    "proof",
    "proofs",
    "experiment",
  ],
  capital: [
    "stock",
    "share price",
    "share buyback",
    "market cap",
    "valuation",
    "funding",
    "raise",
    "raising",
    "ipo",
    "acquisition",
    "acquire",
    "merger",
    "investor",
    "analyst",
    "earnings",
    "revenue",
    "profit",
    "etf",
    "lockup",
    "adr",
  ],
  policy: [
    "regulation",
    "regulator",
    "regulate",
    "export control",
    "ban",
    "banned",
    "bill",
    "senate",
    "congress",
    "antitrust",
    "lawsuit",
    "sued",
    "court",
    "chips act",
    "subsidy",
    "fda",
    "ftc",
    "policy",
    "politics",
    "white house",
    "ministry",
  ],
  safety: [
    "safety",
    "alignment",
    "misuse",
    "security",
    "vulnerability",
    "vulnerabilities",
    "hack",
    "hacked",
    "hacking",
    "attack",
    "threat",
    "ethics",
    "privacy",
    "deepfake",
    "jailbreak",
    "prompt injection",
    "hallucination",
  ],
};

/** Taxonomy text shared by the classification and insight prompts. */
export const TAG_GUIDE = [
  "ai=人工智能（广义）",
  "semiconductor=半导体（广义）",
  "model=大模型、LLM、模型发布",
  "agent=AI 应用、Agent、助手",
  "infra=算力、数据中心、云与推理",
  "design=芯片设计、EDA、处理器架构",
  "manufacturing=晶圆制造、代工、设备与材料",
  "memory=存储、HBM、DRAM、NAND",
  "research=论文、研究、基准与数据集",
  "capital=融资、并购、股价与财报",
  "policy=政策、监管、出口管制与诉讼",
  "safety=安全、伦理、隐私与滥用",
].join("；");

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
export function termPattern(term: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}(s|es)?([^a-z0-9]|$)`, "i");
}

const TAG_PATTERNS: Record<TagId, RegExp[]> = Object.fromEntries(
  TAG_IDS.map((id) => [id, TAG_TERMS[id].map(termPattern)]),
) as Record<TagId, RegExp[]>;

export function matchesTag(id: TagId, text: string): boolean {
  return TAG_PATTERNS[id].some((pattern) => pattern.test(text));
}

/**
 * Tags for one article, in registry order.
 *
 * Fine tags match the title only: an excerpt that mentions "funding" in
 * passing should not relabel an article about a product launch. The broad
 * beats also consider the excerpt because relevance classification does; a
 * title that needs the excerpt to look relevant would otherwise produce no
 * beat tag at all.
 */
export function keywordTags(title: string, excerpt: string | null = null): TagId[] {
  const titleText = title.toLowerCase();
  const fullText = excerpt ? `${titleText} ${excerpt.toLowerCase()}` : titleText;
  return TAG_IDS.filter((id) =>
    id === "ai" || id === "semiconductor" ? matchesTag(id, fullText) : matchesTag(id, titleText),
  );
}

/** Keeps known ids only, removes duplicates, preserves registry order. */
export function mergeTags(...groups: unknown[]): TagId[] {
  const seen = new Set<TagId>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const value of group) {
      if (typeof value === "string" && (TAG_IDS as readonly string[]).includes(value)) {
        seen.add(value as TagId);
      }
    }
  }
  return TAG_IDS.filter((id) => seen.has(id));
}

/**
 * Model output is untrusted: an unknown id or a long list is dropped rather
 * than failing the whole insight. Four tags is enough for a card.
 */
export function normalizeTags(value: unknown): TagId[] {
  return mergeTags(value).slice(0, 4);
}

/** Reads the JSON array stored in `articles.topics` / `events.topics`. */
export function parseTagJson(raw: string | null): TagId[] {
  if (!raw) return [];
  try {
    return mergeTags(JSON.parse(raw));
  } catch {
    return [];
  }
}
