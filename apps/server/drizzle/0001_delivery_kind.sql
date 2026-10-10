-- Distinguish the per-run threshold push from the daily digest so the digest
-- can be idempotent (at most one per window) and the activity page can label it.
ALTER TABLE deliveries ADD COLUMN kind TEXT NOT NULL DEFAULT 'refresh';

CREATE INDEX deliveries_kind_created_idx ON deliveries (kind, created_at);
