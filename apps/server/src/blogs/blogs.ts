/**
 * Personally followed blogs.
 *
 * This is the one place to add or remove a blog: each entry is a display name
 * plus an RSS/Atom feed. Blogs are fetched on the same schedule as the news
 * sources but are otherwise fully separate — no filtering, clustering,
 * insights or notifications, and only the title and a link are shown.
 */

export type BlogDefinition = {
  /** Stable key; also the value stored in `blog_posts.blog_key`. */
  key: string;
  /** Display name shown in the tab. */
  name: string;
  /** RSS or Atom feed URL. */
  feed: string;
  /** Most recent items kept per fetch; defaults to DEFAULT_BLOG_LIMIT. */
  limit?: number;
};

/** Some feeds return their whole archive (Kent C. Dodds: 200+), so cap each. */
export const DEFAULT_BLOG_LIMIT = 50;

export const BLOGS: BlogDefinition[] = [
  { key: "coding-horror", name: "Coding Horror", feed: "https://blog.codinghorror.com/rss/" },
  { key: "julia-evans", name: "Julia Evans", feed: "https://jvns.ca/atom.xml" },
  { key: "lethain", name: "Lethain", feed: "https://lethain.com/feeds.xml" },
  { key: "kawabangga", name: "kawabangga", feed: "https://www.kawabangga.com/feed" },
  { key: "addy-osmani", name: "Addy Osmani", feed: "https://addyosmani.com/rss.xml" },
  { key: "overreacted", name: "Overreacted", feed: "https://overreacted.io/rss.xml" },
  { key: "jake-archibald", name: "Jake Archibald", feed: "https://jakearchibald.com/posts.rss" },
  { key: "kent-c-dodds", name: "Kent C. Dodds", feed: "https://kentcdodds.com/blog/rss.xml" },
  { key: "css-wizardry", name: "CSS Wizardry", feed: "https://feeds.feedburner.com/csswizardry" },
  { key: "catcoding", name: "CatCoding", feed: "https://catcoding.me/atom.xml" },
  { key: "tty8", name: "tty8", feed: "https://blog.tty8.org/feeds/all.rss" },
  { key: "joway", name: "Joway's Blog", feed: "https://blog.joway.io/index.xml" },
  { key: "susheng", name: "素生", feed: "http://z.arlmy.me/atom.xml" },
  { key: "demochen", name: "特立独行的异类", feed: "https://www.demochen.com/atom.xml" },
  { key: "haikebang", name: "骇客邦", feed: "https://haikebang.com/feed.xml" },
  { key: "tangwudi", name: "tangwudi", feed: "https://blog.tangwudi.com/feed" },
  { key: "yuanfan", name: "袁凡", feed: "https://yuanfan.rbind.io/index.xml" },
  { key: "sagasu", name: "Sagasu", feed: "https://www.sagasu.art/rss.xml" },
  { key: "taoshu", name: "涛叔", feed: "https://taoshu.in/feed.xml" },
  { key: "onevcat", name: "OneV's Den", feed: "http://onevcat.com/atom.xml" },
  // Homelab / 自建
  { key: "skywt", name: "SkyWT", feed: "https://skywt.net/rss.xml" },
  { key: "laoda", name: "我不是咕咕鸽", feed: "https://blog.laoda.de/feed.xml" },
  { key: "dallas", name: "Dallas", feed: "https://dallas.lu/feed/" },
  { key: "soha", name: "海上宫殿", feed: "https://soha.moe/feed/atom/" },
  { key: "yuanji", name: "元吉的博客", feed: "https://blog.yuanji.dev/feed/" },
  { key: "huizhou92", name: "huizhou92", feed: "https://huizhou92.com/rss/" },
  // Essay / 真实随笔
  { key: "tumutanzi", name: "土木坛子", feed: "https://tumutanzi.com/feed" },
  { key: "kaixin", name: "开心", feed: "https://kaix.in/feed/" },
  { key: "pinlyu", name: "频率", feed: "https://pinlyu.com/atom.xml" },
  { key: "yinji", name: "印记", feed: "https://yinji.org/feed.xml" },
  { key: "yipai", name: "胡一派", feed: "https://yipai.me/feed.xml" },
  {
    key: "legends-killer",
    name: "Legends-killer",
    feed: "https://www.legends-killer.cq.cn/rss.xml",
  },
];

/** Display names keyed by blog key, for joining onto stored posts. */
export function blogNames(): Map<string, string> {
  return new Map(BLOGS.map((blog) => [blog.key, blog.name]));
}
