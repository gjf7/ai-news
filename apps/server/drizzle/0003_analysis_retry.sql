-- Failed analyses used to be retried on every run with no limit: one event
-- whose evidence reliably breaks the model was re-billed 48 times a day
-- forever. Track attempts and a next-attempt time so a retry costs one
-- backoff window instead of a run, and stop after a few honest attempts.
ALTER TABLE events ADD COLUMN analysis_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN analysis_next_attempt_at INTEGER;

-- The candidate query filters on state and the retry clock.
CREATE INDEX events_analysis_retry_idx ON events (analysis_state, analysis_next_attempt_at);
