-- Personal blogs are a read-only, separate world from the news pipeline: no
-- filtering, clustering, insights or notifications. Posts live in their own
-- table so nothing about the event model has to change.
CREATE TABLE blog_posts (
  id TEXT PRIMARY KEY,
  blog_key TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  published_at INTEGER,
  discovered_at INTEGER NOT NULL
);

CREATE INDEX blog_posts_blog_published_idx ON blog_posts (blog_key, published_at DESC);
