-- Upgrade the EXISTING Cloudflare D1 database in place.
-- Run exactly once before deploying the new Worker:
-- npx wrangler d1 execute homefunds-feedback --remote --file=./migrations/0001_submitter_name.sql
-- Includes the browser-admin optional name and moderated comment tables.
-- All existing records, votes, reports and IDs remain intact.
ALTER TABLE feedback ADD COLUMN submitter_name TEXT;
CREATE INDEX IF NOT EXISTS idx_feedback_author_recent
  ON feedback(author_tag, created_at DESC);

-- Public discussion on approved feedback. Public readers see only published
-- comments. Ordinary users post pending comments; official admin replies
-- can publish immediately. The anonymous browser tag allows local blocking.
CREATE TABLE IF NOT EXISTS feedback_comments (
  id TEXT PRIMARY KEY NOT NULL,
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES feedback_comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author_tag TEXT NOT NULL,
  author_display_name TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'published', 'hidden')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_feedback_status_created
  ON feedback_comments(feedback_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_status_created
  ON feedback_comments(status, created_at DESC);

-- Abuse reports for individual published discussion messages.
CREATE TABLE IF NOT EXISTS feedback_comment_reports (
  comment_id TEXT NOT NULL REFERENCES feedback_comments(id) ON DELETE CASCADE,
  reporter_hash TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('privacy', 'abuse', 'spam', 'other')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, reporter_hash)
);
CREATE INDEX IF NOT EXISTS idx_comment_reports_comment
  ON feedback_comment_reports(comment_id);
