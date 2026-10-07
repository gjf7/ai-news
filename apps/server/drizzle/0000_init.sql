-- Initial schema. Timestamps are UTC milliseconds (INTEGER).
-- See docs/architecture.md "数据模型" and decisions.md D14/D15.

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  default_topics TEXT NOT NULL DEFAULT '[]',
  analyze INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',
  status_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  topics TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'news',
  first_seen_at INTEGER NOT NULL,
  last_article_at INTEGER NOT NULL,
  effective_time INTEGER NOT NULL,
  hot_score INTEGER NOT NULL DEFAULT 0,
  latest_insight_id TEXT,
  analysis_state TEXT NOT NULL DEFAULT 'pending',
  analysis_error TEXT,
  analysis_run_id TEXT,
  importance INTEGER,
  notification_revision INTEGER NOT NULL DEFAULT 0,
  revision_bumped_run_id TEXT,
  notified_revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  CONSTRAINT events_notified_revision_check CHECK (notified_revision <= notification_revision),
  CONSTRAINT events_analysis_state_check
    CHECK (analysis_state IN ('pending', 'ok', 'failed', 'skipped')),
  -- The latest insight must belong to this event. Forward reference is fine:
  -- SQLite resolves foreign keys lazily, and the constraint passes while
  -- latest_insight_id is NULL.
  CONSTRAINT events_latest_insight_fk
    FOREIGN KEY (latest_insight_id, id) REFERENCES insights (id, event_id)
);

CREATE INDEX events_effective_time_idx ON events (effective_time DESC, id DESC);
CREATE INDEX events_updated_at_idx ON events (updated_at);

CREATE TABLE insights (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  scope TEXT NOT NULL,
  output TEXT NOT NULL,
  evidence TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX insights_event_input_hash_unique ON insights (event_id, input_hash);
CREATE UNIQUE INDEX insights_id_event_id_unique ON insights (id, event_id);

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  publisher TEXT NOT NULL,
  title TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  published_at INTEGER,
  discovered_at INTEGER NOT NULL,
  scope TEXT NOT NULL,
  excerpt TEXT,
  relevance TEXT NOT NULL DEFAULT 'pending',
  topics TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'news',
  event_id TEXT REFERENCES events (id) ON DELETE SET NULL,
  community_score INTEGER,
  CONSTRAINT articles_relevance_check CHECK (relevance IN ('pending', 'relevant', 'irrelevant')),
  CONSTRAINT articles_scope_check CHECK (scope IN ('headline', 'excerpt'))
);

CREATE INDEX articles_event_id_idx ON articles (event_id);
CREATE INDEX articles_discovered_at_idx ON articles (discovered_at);

CREATE TABLE article_sources (
  article_id TEXT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  external_id TEXT,
  discovery_url TEXT,
  PRIMARY KEY (article_id, source_id)
);

CREATE UNIQUE INDEX article_sources_source_external_unique
  ON article_sources (source_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE refresh_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  slot INTEGER,
  state TEXT NOT NULL DEFAULT 'queued',
  active_slot INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  progress TEXT,
  result TEXT,
  error TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  CONSTRAINT refresh_runs_state_check
    CHECK (state IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  -- state and active_slot must agree, so no UPDATE can desynchronise them.
  CONSTRAINT refresh_runs_active_slot_check
    CHECK ((state IN ('queued', 'running')) = (active_slot IS NOT NULL))
);

CREATE UNIQUE INDEX one_active_run ON refresh_runs (active_slot) WHERE active_slot IS NOT NULL;
CREATE INDEX refresh_runs_queued_idx ON refresh_runs (state, queued_at);

CREATE TABLE source_runs (
  run_id TEXT NOT NULL REFERENCES refresh_runs (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending',
  fetched INTEGER NOT NULL DEFAULT 0,
  new_articles INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  finished_at INTEGER,
  PRIMARY KEY (run_id, source_id)
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES refresh_runs (id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  items TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  message_id TEXT,
  last_error TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  CONSTRAINT deliveries_state_check CHECK (state IN ('pending', 'sent', 'failed'))
);

CREATE INDEX deliveries_state_next_attempt_idx ON deliveries (state, next_attempt_at);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
