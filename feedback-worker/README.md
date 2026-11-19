# HomeFunds community feedback backend (not deployed)

This code powers the public feedback board at
`https://homefunds.signiswellfire.com/feedback.html`.
The website remains on **GitHub Pages**. The API runs separately on
**Cloudflare Workers + D1**, at `https://feedback-api.signiswellfire.com`.
No paid service, domain migration, or new Google OAuth scope is required.

## Privacy and safety

- The Android app only displays a dedicated HomeFunds website page. It does
  **not** transmit local cash accounts, household IDs, transaction history,
  Google account email, backups, or access tokens.
- User-supplied feedback can be published publicly after the owner reviews it.
- No email is required. A signed, secure HTTP-only cookie supports browser
  vote deduplication and stable anonymous author tags. Clearing cookies can
  reset the identity; vote totals are not verified unique people.
- Visitors self-confirm adult access. Posters accept Community Rules and Terms
  before submitting. Public items have **Report content** and **Block author**
  buttons. Blocking hides an anonymous author's posts in that browser.
  Reports remain private for owner review; no direct messages or comments.
- Each submission and vote requires **server-side validated Turnstile**.
  The Worker limits submits to 3/day and vote actions to 40/day per
  HMAC-hashed IP. Raw IPs are not stored by this application.
- Owner moderation is a private admin API, with the ADMIN_TOKEN stored only
  as a Cloudflare Worker secret; never expose it in a website file or Android.
- New feedback starts **pending**, never public immediately. Approved status
  values are `published`, `planned`, `in_progress` and `completed`.
  `hidden` and `pending` entries never appear in public responses.
- This API contains feedback text, anonymous author tags, categories,
  statuses, report/vote hashes, and rate-control hashes; no finance data.

## Setup — owner actions required

1. In the Cloudflare dashboard, create a **D1 database** named
   `homefunds-feedback`. Record its database ID.
2. Create a **Turnstile Managed widget** for
   `homefunds.signiswellfire.com`. Save its sitekey and secret key.
3. On a trusted machine with Node.js available, from this folder:

   ```sh
   cp wrangler.toml.example wrangler.toml
   # Edit only database_id in wrangler.toml.
   npx wrangler login
   npx wrangler d1 execute homefunds-feedback --remote --file=./schema.sql
   ```

4. Add the secrets using Wrangler interactive prompts (never add them to Git):

   ```sh
   npx wrangler secret put TURNSTILE_SECRET
   npx wrangler secret put VOTER_COOKIE_SECRET
   npx wrangler secret put RATE_LIMIT_SECRET
   npx wrangler secret put ADMIN_TOKEN
   ```

   Use separate cryptographically random values for each secret;
   `openssl rand -hex 32` can generate them. Keep a secure offline copy
   of the admin secret, but do **not** share it in this chat.

5. Deploy the Worker:

   ```sh
   npx wrangler deploy
   ```

6. In Workers & Pages > your Worker > Settings > Domains & Routes,
   add custom domain **`feedback-api.signiswellfire.com`**.
   It is a separate proxied Cloudflare service. **Do not change** the
   existing DNS-only CNAME for `homefunds.signiswellfire.com`.
7. Verify `https://feedback-api.signiswellfire.com/v1/health` returns
   `{"ready":true}`. Then set the public Turnstile sitekey in
   `feedback-config.js` and review the GitHub Pages preview.
8. Test the form, reporting, blocking, age-gate, terms consent,
   moderation, voting and Android WebView before merging.
   Finally deploy this website PR and the Android PR after both pass.

## Moderation without emails

Authenticate owner-only requests via the Authorization header. Set the secret
temporarily in a local shell variable rather than pasting it into a command
or putting it in a URL:

```sh
export HOMEFUNDS_FEEDBACK_ADMIN_TOKEN='COPY_FROM_YOUR_SECURE_PASSWORD_MANAGER'

curl -fsS \
  -H "Authorization: Bearer $HOMEFUNDS_FEEDBACK_ADMIN_TOKEN" \
  "https://feedback-api.signiswellfire.com/v1/admin/feedback?status=pending"

# Replace the feedback UUID with one returned by the pending list:
curl -fsS -X PUT \
  -H "Authorization: Bearer $HOMEFUNDS_FEEDBACK_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"published"}' \
  "https://feedback-api.signiswellfire.com/v1/admin/feedback/REPLACE_FEEDBACK_UUID"
```

To inspect reports of objectionable posts:

```sh
curl -fsS -H "Authorization: Bearer $HOMEFUNDS_FEEDBACK_ADMIN_TOKEN" \
  "https://feedback-api.signiswellfire.com/v1/admin/reports"
```

Allowed admin statuses: `pending`, `published`, `planned`,
`in_progress`, `completed`, `hidden`.
If you accidentally approve sensitive content, change to `hidden`.
For the first version, moderation is command-line only; there is **no**
unauthenticated admin dashboard.

## API contract

- `GET /v1/feedback?sort=top|new` — published suggestions, vote totals,
  and whether the current signed browser voted; no private fields.
- `POST /v1/feedback` — `title`, `details`, `category`,
  `acceptedTerms`, `adultConfirmed`, `turnstileToken`; returns HTTP 202 pending.
- `POST /v1/feedback/:id/vote` — `turnstileToken`; vote once per
  signed browser cookie.
- `DELETE /v1/feedback/:id/vote` — `turnstileToken`; undo own vote.
- `POST /v1/feedback/:id/report` — `reason` and `turnstileToken`;
  creates a private moderation report.
- `GET /v1/admin/reports` — owner only, report queue.
- `GET /v1/admin/feedback?status=pending` — owner only.
- `PUT /v1/admin/feedback/:id` — owner only, JSON `status`.

CORS is restricted to the HomeFunds website origin; accepted Turnstile
tokens must have that website hostname and action `feedback`.

## Acceptance tests before publishing

- Unconfigured website displays a clear unavailable message and does not
  pretend to accept suggestions.
- New post becomes pending; it cannot be viewed or voted on publicly until
  the owner approves it.
- Public list omits email, finance data, hashes, IPs, Google IDs and
  moderation-only fields.
- XSS attempts such as HTML and scripts remain inert text.
- Invalid or reused Turnstile token, wrong hostname or action is rejected.
- Duplicate voting from the same cookie cannot inflate the count, but
  clearing browser storage can reset identity (known MVP limitation).
- CORS blocks origins other than the HomeFunds website.
- Missing/incorrect admin token cannot approve or hide anything.
- Header, responsive layout, Back/Close behavior work in Android WebView.
- Public feedback does not interfere with GitHub Pages privacy/terms or
  Google Drive OAuth domain verification.
- Confirm Google Play UGC compliance: adult access, terms acceptance, ability
  to report and block publicly visible content/users, and timely moderation.
  Update the Play content rating and Data Safety answers as appropriate.
- Confirm consent/privacy notice and release legal text before production.

## Operational note

The hosting estimate is **S$0 at low usage**, subject to Cloudflare's free
tier limits and possible future policy changes. If those limits are reached,
submissions or queries may fail until limits reset. No purchase is authorized.
