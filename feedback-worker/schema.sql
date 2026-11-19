-- Run with: npx wrangler d1 execute homefunds-feedback --remote --file=./schema.sql
-- No personal finance records, Google identities, access tokens or raw IP addresses.
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  author_tag TEXT NOT NULL,
  submitter_name TEXT,
  category TEXT NOT NULL CHECK(category IN ('feature', 'improvement', 'bug')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','published','planned','in_progress','completed','hidden')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_status_date
  ON feedback(status, created_at DESC);

CREATE TABLE IF NOT EXISTS votes (
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  voter_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (feedback_id, voter_hash)
);

CREATE INDEX IF NOT EXISTS idx_votes_feedback_id ON votes(feedback_id);

-- HMAC-derived bucket keys avoid storing raw IP addresses.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  hits INTEGER NOT NULL,
  day TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_day ON rate_limits(day);

-- Private moderation queue for user reports. Never shown to the public.
CREATE TABLE IF NOT EXISTS reports (
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  reporter_hash TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('privacy', 'abuse', 'spam', 'other')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (feedback_id, reporter_hash)
);
CREATE INDEX IF NOT EXISTS idx_reports_feedback ON reports(feedback_id);

-- Public discussion on approved feedback. Public readers see only published
-- comments. Ordinary users post pending comments; official admin replies
-- can publish immediately. The anonymous browser tag allows local blocking.
CREATE TABLE IF NOT EXISTS feedback_comments (
  id TEXT PRIMARY KEY NOT NULL,
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES feedback_comments(id) ON DELETE SET NULL,
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
