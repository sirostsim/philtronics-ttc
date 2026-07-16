# Work Time (Philtronics Time-to-Complete) — Project Guide

This file gives Claude Code the context, conventions, and hard-won gotchas for this
codebase. Read it at the start of every session. Keep it current: when a new
convention or trap is discovered, add it here.

## What this is

Work Time is a shopfloor Manufacturing Execution System (MES) / time-tracker built
for Philtronics Ltd by Simon Street (SRS Support Limited). Shopfloor operators use
it daily to time jobs; supervisors and above manage, report, and configure.

Live site: https://pt-worktime.srscloud.co.uk
Repo: sirostsim/philtronics-ttc

## Stack and hosting

- Backend: Node.js / Express / PostgreSQL.
- Frontend: vanilla-JS single-page app (no framework). Main file public/app-v2.js
  is very large (~250k chars); public/index.html; public/styles.css.
- Hosting: Railway (hobby tier) via the SRSCloud platform, Docker-based
  (Dockerfile at repo root). Postgres is a separate Railway service.
- Object storage: Cloudflare R2 (S3-compatible), used for user profile avatars.
- Deploy model: push to a branch, review, merge to main; Railway auto-deploys on
  merge. Migrations run automatically on boot.

## Roles (lowest to highest)

operator -> supervisor -> manager -> administrator -> superuser

- hasRole(user, 'X') means "role X and above". Used server-side.
- requireRole('X') gates a route at "X and above".
- Frontend hasRole('X') checks the logged-in user against that minimum.
- superuser is seeded from env vars, not created through the UI.

## Critical conventions (do not violate)

- UK English throughout (code comments, docs, UI copy, marketing).
- No em dashes anywhere.
- CRLF line endings on server files must be preserved. When editing, keep the
  file's existing line endings; do not convert to LF.
- Deploy related files together. The single biggest source of trouble on this
  project has been files not making it into a commit/deploy (a missing helper, a
  stale frontend file, a one-line change left behind). When a change spans
  multiple files, commit them as one set and verify all are staged before pushing.
- Railway hobby tier: keep everything lean. Favour lightweight approaches,
  stateless request handling, and lazy loading. Avoid background workers and
  polling loops unless strictly necessary. Flag anything potentially costly.
- One well-defined feature or fix at a time; produce complete, working changes.

## Code facts and traps (these have bitten us)

- db.js query() returns the rows array directly (not { rows }). queryOne() returns
  a single row or null.
- validate.js uses Joi with stripUnknown: true and convert: true. UNKNOWN BODY
  FIELDS ARE SILENTLY DROPPED. Any new field a route needs MUST be added to the
  relevant schema in validate.js, or it will vanish before the handler sees it.
  This caused the department-save bug and would have silently killed the quantity
  and avatar features.
- CSS inputs are styled by TYPE selector in styles.css (input[type="text"],
  ["password"], ["date"], ["number"], textarea). If you add a new input type, add
  it to that rule or it renders as an unstyled white box.
- The [hidden] attribute can be overridden by an explicit display rule; if hiding
  something with hidden isn't working, check for a competing display:flex/one and
  use [hidden]{display:none!important} or matching specificity.
- Content Security Policy: server.js sets a CSP header. External resources
  (images, scripts, fonts) must be allow-listed in the right directive or the
  browser blocks them. Avatars from R2 required adding the R2 public domain to
  img-src. NOTE: Chart.js from cdnjs is currently blocked by script-src (charts
  page may not load) — a known outstanding issue; fix is adding
  https://cdnjs.cloudflare.com to script-src.
- Migrations are additive and run on boot. Latest migration number is 020
  (016 settings, 017 timer_quantity_runs, 018 dev_requests, 019 user_avatars,
  020 planned_work).
  008_add_pcb_department.sql is a deliberate no-op placeholder (SELECT 1).
- Frontend uses safe DOM construction via an el(tag, attrs, ...children) helper
  and esc() for escaping; prefer these over innerHTML. Other helpers: api(),
  GET/POST/PATCH/DELETE wrappers, toast(), openModal(title, bodyEl, footerEls),
  closeModal().
- Nav/pages are JS-driven: a PAGES map (each {id, label, minRole}), a topPages
  array for order, buildNav() renders the sidebar, and a dispatcher calls the
  page's load function. To add a page: add to PAGES, add to topPages, add a
  dispatch line, add the <section> in index.html, write the loader.

## Docker / sharp note

- The Dockerfile base image is node:20-slim (Debian/glibc). It was previously
  node:20-alpine, which broke the sharp image library (Alpine uses musl libc and
  sharp's prebuilt binaries need glibc). Do not switch back to alpine without
  handling sharp's native dependency.

## R2 (avatars) setup

- Env vars on the Railway APP service (not Postgres): R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (worktime-avatars),
  R2_PUBLIC_BASE_URL (https://pub-...r2.dev). Never commit these.
- server/r2.js is the S3-compatible helper (uses @aws-sdk/client-s3). It disables
  the feature gracefully if env vars are missing rather than crashing.
- Avatar upload route: server/routes/avatars.js, gated at manager and above,
  separate from users.js (which is administrator-gated). Image arrives as base64
  in JSON; sharp resizes to a 256x256 JPEG; stored at key avatars/<userId>.jpg;
  the clean public URL (no query string) is saved to users.avatar_url.
- server.js mounts a 6mb JSON parser for /api/avatars BEFORE the global 64kb
  parser, so uploads aren't rejected by the tight global limit.
- safeUser() in users.js must return avatarUrl: u.avatar_url so the frontend
  receives it. avatarEl(user, size) renders photo-or-initials and falls back to
  initials on image load error.

## Domain rules worth knowing

- Productivity uses the FULL, undivided timer duration. Never divide it by
  quantity. (Per-item build time is total/quantity; productivity is not.)
- Quantity runs: one timer covering N contiguous route cards expands on STOP into
  N real completed rows (cards R..R+N-1), each time total/N with the remainder on
  the first card so the sum reconciles exactly; all linked by a shared run_id;
  each row quantity=1 and independently reworkable. Server enforces that a
  multi-quantity run has an all-numeric route card.
- Dev Requests: a supervisor+ mini-forum. Only the superuser changes status or
  deletes; authors edit their own request and comments; one vote per user
  (self-votes allowed); the thread stays open in every status including declined.
- 2FA is intentionally offered to non-operators only; operators have no 2FA button.

## Workflow with Claude Code

- Work on a branch, review the diff, then merge to main (which auto-deploys).
- You (the human) control commits and Railway; do not assume access to Railway or
  its env vars.
- Before pushing a multi-file change, confirm every intended file is staged.
- After deploying, hard-refresh the browser (Ctrl+F5) for frontend changes.
- When practical, verify a change end-to-end before considering it done.
