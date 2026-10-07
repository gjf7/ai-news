/**
 * Saved regression samples for the model-facing judgements, as architecture.md
 * requires ("用保存的真实样本做回归：转载、改写、同公司不同事件、真实进展").
 *
 * The headline strings are real titles observed from the live sources; the
 * expected outcome is the decision the pipeline should reach. These cases drive
 * both the similarity thresholds and the adjudication contract, so a threshold
 * change that breaks a known case fails the test suite.
 *
 * Clustering thresholds live in apps/server/src/news/clustering.ts.
 */

export type ClusteringCase = {
  name: string;
  /** The article already in an event. */
  existing: string;
  /** The new article being classified. */
  incoming: string;
  /** What the pipeline should decide. */
  expect: "merge" | "new";
  /** Which mechanism should decide it, for diagnostics. */
  via: "direct" | "model";
  note: string;
};

export const CLUSTERING_CASES: ClusteringCase[] = [
  {
    name: "转载：同一稿件的两家转载",
    existing: "Nvidia heads for $6 trillion value as chips rally",
    incoming: "Nvidia Heads for $6 Trillion Value as Chips Rally",
    expect: "merge",
    via: "direct",
    note: "大小写与标点差异，三元组相似度应超过 0.85",
  },
  {
    name: "转载：带出版方后缀",
    existing: "ASML's chip technology move threatens Besi shares, BofA says",
    incoming: "ASML's chip technology move threatens Besi shares, BofA says - Reuters",
    expect: "merge",
    via: "direct",
    note: "标题后缀是出版方名，normalizeTitle 应先剥离",
  },
  {
    name: "改写：同一事件不同措辞",
    existing: "OpenAI in $30 billion round talks with BlackRock, UAE funds",
    incoming: "OpenAI discusses $30bn funding round with BlackRock and Emirati investors",
    expect: "merge",
    via: "model",
    note: "措辞差异大但同一具体事件，交给模型裁决",
  },
  {
    name: "同公司不同事件：不应合并",
    existing: "Nvidia heads for $6 trillion value as chips rally",
    incoming: "Nvidia unveils new data center GPU for AI training",
    expect: "new",
    via: "model",
    note: "同公司但不同事情，模型应判为 new",
  },
  {
    name: "同主题不同事件：不应合并",
    existing: "TSMC expands 2nm capacity in Arizona",
    incoming: "TSMC reports quarterly earnings beat",
    expect: "new",
    via: "model",
    note: "同主题（TSMC）但不是同一件事",
  },
  {
    name: "无关标题：相似度低",
    existing: "Nvidia heads for $6 trillion value as chips rally",
    incoming: "Weekend football results and league table",
    expect: "new",
    via: "direct",
    note: "相似度低于候选阈值，直接新建",
  },
];

/** Headlines that must be classified relevant by the keyword rules alone. */
export const KEYWORD_RELEVANT: string[] = [
  "Nvidia heads for $6 trillion value as chips rally",
  "ASML's chip technology move threatens Besi shares, BofA says",
  "OpenAI in $30 billion round talks with BlackRock, UAE funds",
  "TSMC expands 2nm capacity in Arizona",
  "HBM supply tightens as AI accelerators ship in volume",
  "Samsung Electronics lifts foundry capex on EUV demand",
];

/** Headlines that must be classified irrelevant (or at least not relevant). */
export const KEYWORD_IRRELEVANT: string[] = [
  "Weekend football results and league table",
  "A new recipe for slow-roasted tomatoes",
  "Celebrity wedding photos from the weekend",
  "Today's horoscope for every star sign",
];

/**
 * Headlines the keyword rules deliberately leave undecided, so the model makes
 * the call. If a change makes these match a keyword, the model call would be
 * skipped and the sample should be reconsidered.
 */
export const KEYWORD_UNDECIDED: string[] = [
  "The surprising effects of Europe's heatwaves",
  "Inside the Toys R Us comeback",
  "What a top economist says about the future of work",
];
