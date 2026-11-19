-- Upgrade the EXISTING Cloudflare D1 database in place.
-- Run exactly once before deploying the new Worker:
-- npx wrangler d1 execute homefunds-feedback --remote --file=./migrations/0001_submitter_name.sql
-- All existing records, votes, reports and IDs remain intact.
ALTER TABLE feedback ADD COLUMN submitter_name TEXT;
CREATE INDEX IF NOT EXISTS idx_feedback_author_recent
  ON feedback(author_tag, created_at DESC);
