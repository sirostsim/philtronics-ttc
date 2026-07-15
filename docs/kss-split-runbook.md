# KSS Work Time — Fork and Setup Runbook

How to split a standalone King Site Services (KSS) instance off the Philtronics
Work Time codebase: duplicate the repo, isolate all infrastructure, strip the
Philtronics specifics, and diverge. Written against the codebase as of the
critical-fix branch (PR #8).

This is a **hard fork** (deliberate: KSS diverges enough that it is not one
product with Philtronics). Future clients that share the feature set take the
shared-codebase / separate-database route instead, which this runbook does not
cover.

---

## 0. Prerequisites — do these before forking

- [ ] **Fork from a clean base.** The critical fixes (PR #8: C1, C2, C4, C5)
  must be merged into Philtronics `main` **and verified on a real database**
  first. Forking off unfixed `main` means fixing the same criticals twice, in
  two repos. This is the single most important ordering rule.
- [ ] Confirm the KSS decisions you need up front: product name, domain, brand
  colour, logo, the department list (or none), and the field model
  (KSS uses **Client + Job code** in place of Item Number / W/O Number).
- [ ] Have the KSS Cloudflare R2 bucket and a Railway account/project ready.

---

## 1. Duplicate the repository (keep history)

Use a clone-and-push to a **new** repo. Do **not** use GitHub's "Fork" button —
that is for contributing changes back upstream, the opposite of what you want.
Keep the history so shared core fixes can be cherry-picked during the early
window (see section 7).

```bash
# Clone Philtronics and re-point it at a new KSS repo
git clone https://github.com/sirostsim/philtronics-ttc.git kss-worktime
cd kss-worktime
git remote rename origin philtronics-upstream      # keep, for cherry-picking shared fixes
gh repo create sirostsim/kss-worktime --private --source=. --remote=origin
git push -u origin main
```

Keeping `philtronics-upstream` as a remote lets you `git cherry-pick <sha>` a
shared fix across while the two codebases are still close.

No Philtronics secrets are in the repo (`.env` is gitignored), so the history is
safe to carry. Client name in commit messages is not sensitive.

---

## 2. Provision KSS infrastructure — everything separate

Nothing is shared with Philtronics. Separate database, storage, domain, secrets.

- [ ] **New Railway project**, deploying the `kss-worktime` repo (Dockerfile
  builder, same as Philtronics).
- [ ] **New Postgres** service in that project (gives `DATABASE_URL`
  automatically).
- [ ] **New R2 bucket** (e.g. `kss-worktime-avatars`) with its own public URL.
- [ ] **New domain** (e.g. `kss-worktime.srscloud.co.uk`).
- [ ] **Environment variables** on the KSS app service — all fresh, none reused:

| Variable | Notes |
|---|---|
| `JWT_SECRET` | Generate a new 64-char hex. **Never reuse Philtronics'.** |
| `SU_USERNAME`, `SU_PASSWORD`, `SU_FULL_NAME` | KSS superuser (break-glass). See warning below. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | KSS Cloudflare creds |
| `R2_BUCKET` | e.g. `kss-worktime-avatars` |
| `R2_PUBLIC_BASE_URL` | KSS bucket public URL (`https://pub-....r2.dev`) |
| `NODE_ENV` | `production` |
| `BCRYPT_ROUNDS` | `12` |
| `LOGIN_RATE_LIMIT` | `10` |

> **Warning — `SU_USERNAME` and login validation.** `seedSuperuser()` in
> `server/server.js` inserts `SU_USERNAME` with **no validation**, but the login
> schema (`server/middleware/validate.js`) now requires
> `min(3).max(32).pattern(/^[A-Za-z0-9._-]+$/)`. If `SU_USERNAME` contains a
> space, an `@`, or is over 32 chars, the superuser can log in **never** (a 422
> at validation, before the password check). Pick a compliant username.

---

## 3. Strip the Philtronics-isms

The branding and working-hours values are already in the `config` table (seeded
by `016_settings_defaults.sql`), so those are **data**, changed either in that
seed file or via the in-app settings UI after deploy. Everything below is
**code / assets** that a fork must change directly.

### 3a. Brand assets (`public/`)
Replace the image files with KSS equivalents (keep the same filenames to avoid
touching markup, or rename and update references in `public/index.html`):
- [ ] `public/logo-transparent.png` (top bar + login logo)
- [ ] `public/philtronics-logo.png` (login footer credit)
- [ ] `public/favicon.ico`, `public/favicon-32.png`, `public/apple-touch-icon.png`

### 3b. Content Security Policy — R2 domain (**functional, do not skip**)
`server/server.js:31` hard-codes the Philtronics R2 bucket in `img-src`. Avatars
will be **blocked by the browser** until this is the KSS bucket domain.
- [ ] Replace `https://pub-e170f0c1f48f4ebf9b7bf2adc7d8c0a9.r2.dev` with the KSS
  bucket domain. **Better:** drive it from `process.env.R2_PUBLIC_BASE_URL` so it
  is never hard-coded again (worth doing in Philtronics too).

### 3c. TOTP issuer
`server/routes/totp.js:43` — `authenticator.keyuri(user.username, 'Work Time', secret)`.
The `'Work Time'` string is what shows in users' authenticator apps.
- [ ] Change to the KSS product name.

### 3d. Departments (hard-coded in ~6 places)
KSS has a different department model. These must all agree. Replace the list (or
remove departments entirely if KSS has none):
- [ ] `server/middleware/validate.js:90` — `department: Joi.string().valid('Production','Stores','Test and Inspection','PCB')`
- [ ] `server/routes/users.js:20` — `const DEPARTMENTS = [...]`
- [ ] `server/routes/users.js:206` — `const VALID_DEPTS = [...]`
- [ ] `public/app-v2.js:180` — `const DEPARTMENTS = [...]`
- [ ] `public/app-v2.js:181` — `const DEPT_SLUGS = {...}`
- [ ] `public/app-v2.js:1726` — "Valid departments:" help text (bulk upload)
- [ ] `public/app-v2.js` ~188-194 — the per-department **wall board page**
  definitions (`wb-prod`, `wb-stores`, `wb-testinsp`, `wb-pcb`, and the compact
  `wbc-*` variants). One nav page + section per department.
- [ ] `public/index.html` — the `<section id="page-*-wb">` wall board blocks
  (e.g. `page-testinsp-wb` at ~line 434) matching those page definitions.

### 3e. Text literals
- [ ] `server/server.js:122` — console banner "Work Time running" (cosmetic).
- [ ] `public/index.html` — `<title>` and logo `alt` text ("Philtronics", "Work Time").
- [ ] `public/app-v2.js` — any "Work Time" / "Philtronics" UI strings.
- [ ] `public/user-manual.html` — the whole manual is Philtronics-specific;
  rewrite or drop for KSS.
- [ ] `server/settings.js:27-29` — hard-coded fallback defaults
  (`'Europe/London'`, `'07:45'`, the per-day end times). The `config` seed
  overrides these, but set them to sane KSS fallbacks too.
- [ ] `server/migrations/016_settings_defaults.sql` — the seeded defaults
  (`brand_customer_name` = 'Philtronics Ltd', colour `#2e75b6`, hours/timezone,
  break minutes). Edit to KSS values so a fresh KSS database seeds correctly.

### 3f. Remove dead / Philtronics-only files
- [ ] `public/users.js` — 288 lines of **dead code** (nothing loads it; also
  carries the department literals). Delete it in the fork.
- [ ] `public/index-SRS-PC1.html` — a second Philtronics index variant
  (title "Philtronics – Time to Complete"). Decide: rebrand, or delete.

---

## 4. Field model — KSS Client + Job code (the deep change)

Philtronics jobs are identified by **Item Number + W/O Number + Route Card No.**
KSS wants **Client + Job code**. This is the biggest change because these fields
are woven through the schema, the forms, validation, scanning, the
assembly-resume/rework match, and the reports.

Touch points to work through with the agreed KSS spec:
- [ ] **Schema** — `timers` columns `item_number`, `wo_number`,
  `route_card_number`. For a fork, either repurpose/rename them via a new
  migration, or add `client` / `job_code` columns. Update `seed.js` sample data.
- [ ] **Start form** — `public/index.html` labels: `Item Number` (line ~137),
  `W/O Number` (~192), `Route Card No.` (~218), plus the Quantity/route-card row.
- [ ] **Frontend logic** — `public/app-v2.js`: the start payload, wallboard tile
  rendering, history/dashboard filters (`histItem` ~338, `dashItem` ~489).
- [ ] **Validation** — `server/middleware/validate.js` `itemNumberSchema` and the
  `startTimer` schema (field names, patterns, required/optional).
- [ ] **Reports** — `server/routes/export.js` groups and filters by these fields
  (assembly build times, RFT by W/O, CSV columns). This is where field renames
  bite hardest; review every report.
- [ ] **Assembly-resume / rework match** — `public/app-v2.js` matches a returning
  job by item + W/O + route card. Re-map to the KSS identity fields.
- [ ] **Scanning** — Item/Workstation/W/O are scannable; decide which KSS fields
  scan. Note: the **Route Card No. is deliberately not scannable at Philtronics**
  (handwritten on paperwork) — that rule is Philtronics-specific and likely does
  not apply to KSS.

The job-time calculation tweaks KSS mentioned are still unspecified; leave the
shared calculation in place and change it only once KSS gives a concrete spec.

---

## 5. Data — fresh start

- [ ] KSS deploys against an **empty** database. Migrations run on boot; the
  (now non-fatal) `seed.js` creates default users + sample items — edit these to
  KSS values or strip them.
- [ ] **Do not copy any Philtronics data.**
- [ ] Change all default passwords immediately, and set the real admin via the
  `SU_*` env vars (section 2).

---

## 6. Deploy and verify

- [ ] Push to KSS `main` → Railway builds the Dockerfile → migrations run on boot.
- [ ] Confirm the container boots and the `/` healthcheck passes.
- [ ] Log in as the KSS superuser.
- [ ] Smoke test: start a timer, stop it, start a multi-quantity run and stop it,
  open each wall board, run each report, upload an avatar (confirms the CSP /
  R2 domain is correct — a blocked image means 3b was missed).
- [ ] Confirm branding (name, colour, logo) shows correctly on login and top bar.

---

## 7. Ongoing — the porting window

For the first while, KSS and Philtronics share most of their code, so a core bug
fix in one is usually relevant to the other. Port shared fixes across by
cherry-pick while they are still close:

```bash
git fetch philtronics-upstream
git cherry-pick <commit-sha-of-the-shared-fix>
```

Keep a short note of which commits are shared-core vs KSS-specific. This porting
ability decays as KSS diverges and eventually is not worth it — that is expected,
and is the point of forking for divergence. Just do not assume zero coupling on
day one: the ability to port a critical fix across is worth preserving early.

---

## Appendix — Philtronics-ism inventory (quick reference)

| Item | Location | Type |
|---|---|---|
| R2 bucket domain in CSP | `server/server.js:31` | functional |
| TOTP issuer "Work Time" | `server/routes/totp.js:43` | branding |
| Console banner | `server/server.js:122` | cosmetic |
| Departments (validation) | `server/middleware/validate.js:90` | config-as-code |
| Departments (server) | `server/routes/users.js:20, 206` | config-as-code |
| Departments (frontend) | `public/app-v2.js:180-181, 1726` | config-as-code |
| Wall board pages/sections | `public/app-v2.js` ~188-194; `public/index.html` `page-*-wb` | config-as-code |
| Field labels | `public/index.html:137, 192, 218, 338, 489` | field model |
| Branding + hours defaults | `server/migrations/016_settings_defaults.sql`; `server/settings.js:27-29` | data / fallback |
| Brand assets | `public/logo-transparent.png`, `philtronics-logo.png`, favicons | assets |
| Dead code (delete) | `public/users.js` | cleanup |
| Alt index variant | `public/index-SRS-PC1.html` | decide |
| User manual | `public/user-manual.html` | rewrite/drop |

---

*Prepared by SRS Support. Reflects the Philtronics Work Time codebase at the
time of writing; re-check file line numbers before editing, as they shift.*
