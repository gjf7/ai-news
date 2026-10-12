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
];

/** Display names keyed by blog key, for joining onto stored posts. */
export function blogNames(): Map<string, string> {
  return new Map(BLOGS.map((blog) => [blog.key, blog.name]));
}
