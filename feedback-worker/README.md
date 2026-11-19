# HomeFunds Community Feedback — Operations

The existing public board runs at:
- https://homefunds.signiswellfire.com/feedback.html — user suggestions and voting
- https://feedback-api.signiswellfire.com — Cloudflare Worker + D1 backend
- https://homefunds.signiswellfire.com/admin.html — **NEW** browser-based owner moderation (after rollout)

Hosting: GitHub Pages for the website; Cloudflare Worker/D1 for the API. No new
financial-data server, domain or paid service is required.

## What's new in this upgrade

- Removes unnecessary **18+ age gate**; feedback is available without that
  blanket restriction. Terms acceptance, pre-publication moderation and
  public report/block controls remain mandatory.
- Admin can sign in directly on the website using the **existing ADMIN_TOKEN**
  saved in a password manager. No GitHub password or CLI needed for normal
  moderation. The backend converts the token into a signed 7-day
  `Secure; HttpOnly; SameSite=Strict` session cookie; it is not put in a
  browser URL or localStorage.
- Admin queue: pending/published/planned/in progress/completed/hidden, received
  timestamp, category, vote/report counts, anonymous author tag and optional
  name. Approve, change status, hide and permanently delete with confirmation.
- **Threaded discussions**: visitors can comment on published suggestions and
  reply once to a top-level comment. Community comments are pending until you
  approve them. Official replies posted from the admin dashboard appear as
  **HomeFunds Team** and are published immediately.
- Comment moderation queues: pending, published, hidden, and reported
  comments. Administrators can approve/hide/delete and respond officially.
  Comment-specific reporting and anonymous-author blocking are included.
  Visitor comments can optionally include a *public* display name; this is
  distinct from the private name on feature submissions.
- Optional submitter name is **visible to the admin only** (not public). It
  is provided voluntarily and **not verified**. Existing submissions have
  no name or Google identity; the system cannot reconstruct the person's
  real name from an anonymous browser tag.
- Identical feedback posted again from the same browser within ten minutes
  returns the existing item rather than creating another.
- The existing CLI authorization via `Authorization: Bearer` still works.

## Important — upgrade the existing D1 before deploying the new code

This upgrade uses a new nullable `submitter_name` column plus two new
tables (`feedback_comments` and `feedback_comment_reports`). All are
created by **one** non-destructive migration on the existing D1 database. Do **NOT** rerun `schema.sql` and do not
delete the D1 database, because it already contains published feedback and votes.

On Steam Deck in `/home/deck/Development/HomeFunds-feedback-site`:

```sh
# The original clone used --single-branch, so enable this remote branch.
git remote set-branches --add origin feature/website-admin-and-open-feedback
git fetch origin feature/website-admin-and-open-feedback
git switch -c feature/website-admin-and-open-feedback --track origin/feature/website-admin-and-open-feedback
cd feedback-worker

# Verify column is absent before migration.
npx wrangler d1 execute homefunds-feedback --remote \
  --command="PRAGMA table_info(feedback);"

# One-time, non-destructive migration (do not execute twice).
npx wrangler d1 execute homefunds-feedback --remote \
  --file=./migrations/0001_submitter_name.sql

# Verify the new field exists and current data was preserved.
npx wrangler d1 execute homefunds-feedback --remote \
  --command="SELECT id,title,status,submitter_name FROM feedback;"
```

The migration also creates indexes for comment moderation. It must be run
**only once** on the existing database: attempting the ALTER TABLE again will
produce a duplicate-column error. Check with `PRAGMA table_info(feedback)`
first. Back up the database before production modifications if you need a
rollback point.

`wrangler.toml` and the `.wrangler/` directory are intentionally untracked
and ignored. The local Worker configuration and custom domain remain intact
across branch switches; do not check secrets or private files into Git.

Once database migration is confirmed, deploy the new Worker:

```sh
npx wrangler deploy
```

Then verify the health and list endpoints, and test `admin.html` only after
the website branch is merged/published. **Do not merge the website branch
before deploying the new backend**, because the website UI calls the new
admin-session API and optional-name D1 column.

## How to sign in and moderate after deployment

1. Visit `https://homefunds.signiswellfire.com/admin.html`.
2. Paste the **same HomeFunds Feedback Admin Token** previously used in
   Konsole. Use a password manager so you don't have to type it every time.
3. Review pending posts, choose **Approve & publish**, change status or hide.
4. For approved suggestions, use **Post an official HomeFunds response** to
   reply without leaving the admin page; official responses publish immediately.
5. Under **Comments awaiting approval**, review visitor comments and approve
   or hide them. Under **Reported comments**, moderate reported discussion.
   You can also reply to an approved top-level visitor comment.
6. Use **Delete permanently** only when you want to erase a suggestion
   and all its comments/votes/reports, or an individual comment; hidden is
   better for reversible moderation.
7. Sign out when done.

Never share the ADMIN_TOKEN or put it in a GitHub file. The page itself is
public HTML, but its underlying moderation data and actions are protected
by the server's administrator token/session and allowed-site-origin checks.

## Privacy and Google Play user-generated-content requirements

- This system does not transmit Google OAuth tokens, financial accounts,
  transaction details or Drive backup contents from HomeFunds.
- Optional names are stored in Cloudflare D1, visible only to the owner.
  Public listing does not return them.
- Report, block, terms acceptance, Turnstile validation, rate-limiting and
  pending-by-default moderation remain active.
- A browser-signed cookie supports best-effort vote uniqueness; resetting
  cookies can reset anonymous identity. It is not proof of one human user.
- Review Google Play's UGC, target-audience/content rating and Data Safety
  disclosures before merging Android PR #34.
- Admin session cookies are `HttpOnly; Secure; SameSite=Strict`, scoped to
  the API's `/v1/admin` path, and expire after seven days.
- CLI owner calls do not require a session cookie and continue accepting the
  Bearer admin token. Browser cookie-authenticated operations require the
  exact HomeFunds website Origin.

## API contract

Public:
- `GET /v1/feedback?sort=top|new`
- `POST /v1/feedback`: `title`, `details`, `category`,
  optional `submitterName`, `acceptedTerms:true`, `turnstileToken`.
- `POST|DELETE /v1/feedback/:id/vote`
- `POST /v1/feedback/:id/report`
- `GET /v1/feedback/:id/comments`: publicly approved replies only.
- `POST /v1/feedback/:id/comments`: visitor comment awaiting moderation;
  body, optional public displayName, optional parentId, acceptedTerms:true,
  Turnstile token.
- `POST /v1/feedback/:id/comments/:commentId/report`: report a comment.

Private:
- `POST /v1/admin/session`: `{token}` sets admin session cookie.
- `GET /v1/admin/session`: verifies current browser session.
- `DELETE /v1/admin/session`: logs out.
- `GET /v1/admin/feedback?status=pending`: owner queue.
- `GET /v1/admin/reports`: private report queue.
- `PUT /v1/admin/feedback/:id`: change status.
- `DELETE /v1/admin/feedback/:id`: permanently delete post and child records.
- `POST /v1/admin/feedback/:id/comments`: publish official HomeFunds Team reply.
- `GET /v1/admin/comments?status=pending|published|hidden`: moderation queue.
- `GET /v1/admin/comment-reports`: reported visitor comments.
- `PUT /v1/admin/comments/:id`: approve or hide comment.
- `DELETE /v1/admin/comments/:id`: permanently delete comment.

## Regression / release checklist

1. Confirm existing published suggestions and vote totals survive the D1
   migration and Worker redeploy.
2. Invalid token → no cookie; successful token → HttpOnly session; logout →
   cookie deleted; foreign-origin cookie requests denied.
3. No public feedback endpoint exposes optional submitter names, account data,
   admin reports or session secrets.
4. Review old anonymous submissions (name displays Anonymous and timestamp).
5. Submit with optional name; confirm it is visible only to admin. Submit
   without name; confirm that remains possible without any 18+ prompt.
6. Approve, change status, hide, delete; confirm reported items and votes
   behave correctly. Test visitor discussions, 1-level replies, approvals,
   official HomeFunds Team replies, comments privacy, report/block controls,
   and deletion cascades. Non-approved comments must not appear publicly.
7. Confirm current mobile/Android WebView feedback experience still works,
   and Terms/report/block remain available.
8. Publish the website via reviewed PR only after the backend passes.
