import type { FeedConfig } from "./rss.ts";

/**
 * Every feed-based source, matching the reference project's coverage. Adding a
 * source is a config entry here, not a new module.
 *
 * Sources that need bespoke parsing or an API live in their own module and are
 * registered in `registry.ts` instead.
 */
export const FEED_SOURCES: Record<string, FeedConfig> = {
  techcrunch: {
    publisher: "TechCrunch",
    feeds: ["https://techcrunch.com/category/artificial-intelligence/feed/"],
  },
  "the-verge": {
    publisher: "The Verge",
    feeds: ["https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"],
  },
  "mit-tech-review": {
    publisher: "MIT Technology Review",
    feeds: ["https://www.technologyreview.com/topic/artificial-intelligence/feed/"],
  },
  huggingface: {
    publisher: "Hugging Face",
    feeds: ["https://huggingface.co/blog/feed.xml"],
  },
  lobsters: {
    publisher: "Lobsters",
    feeds: ["https://lobste.rs/rss"],
    kind: "discussion",
  },
  "semi-engineering": {
    publisher: "Semiconductor Engineering",
    feeds: ["https://semiengineering.com/feed/"],
  },
  "ee-times": {
    publisher: "EE Times",
    feeds: ["https://www.eetimes.com/feed/"],
  },
  semiwiki: {
    publisher: "SemiWiki",
    feeds: ["https://semiwiki.com/feed/"],
  },
  "ieee-spectrum": {
    publisher: "IEEE Spectrum",
    feeds: ["https://spectrum.ieee.org/feeds/topic/semiconductors.rss"],
  },
  ft: {
    publisher: "Financial Times",
    feeds: [
      "https://www.ft.com/artificial-intelligence?format=rss",
      "https://www.ft.com/technology?format=rss",
      "https://www.ft.com/semiconductors?format=rss",
    ],
  },
  wsj: {
    publisher: "Wall Street Journal",
    // Public Dow Jones technology feed (RSSWSJD).
    feeds: ["https://feeds.content.dowjones.io/public/rss/RSSWSJD"],
  },
  economist: {
    publisher: "The Economist",
    feeds: ["https://www.economist.com/science-and-technology/rss.xml"],
  },
  reddit: {
    publisher: "Reddit",
    kind: "discussion",
    // Reddit blocks unauthenticated .json access (403); its Atom feeds work,
    // but unauthenticated RSS allows roughly one request per ~30s window, so
    // one subreddit is fetched per run and the rest follow on later runs.
    feeds: [
      "https://www.reddit.com/r/artificial/hot/.rss?limit=15",
      "https://www.reddit.com/r/MachineLearning/hot/.rss?limit=15",
      "https://www.reddit.com/r/OpenAI/hot/.rss?limit=15",
      "https://www.reddit.com/r/LocalLLaMA/hot/.rss?limit=15",
    ],
    feedsPerRun: 1,
  },
  bloomberg: {
    publisher: "Bloomberg",
    // Public topic feeds, each with a real <description> excerpt. These are
    // Bloomberg's own aggregator feeds (their robots.txt carries explicit
    // rules for Feedly and other readers), so no account or paywall workaround
    // is involved. The technology feed is the AI/chip-relevant one; industries
    // adds semiconductor and hardware coverage; markets carries US equity
    // coverage (S&P 500, Fed, Treasuries). See decisions.md D19.
    feeds: [
      "https://www.bloomberg.com/feeds/technology/news.rss",
      "https://www.bloomberg.com/feeds/industries/news.rss",
      "https://www.bloomberg.com/feeds/markets/news.rss",
    ],
  },
};
