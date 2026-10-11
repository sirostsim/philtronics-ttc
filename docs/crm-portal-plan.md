# CRM / RFQ - Slim Phase 2 + Phase 3 (Customer Portal) Build Plan

Status: DRAFT for review. Builds on the completed Phase 1 (internal RFQ module).
See crm-rfq-spec.md (esp. section 8) and crm-rfq-phase1-plan.md.

This plan covers a **slim Phase 2** (email + the issue-quote step the portal needs)
and **Phase 3** (the external customer portal). Phase 3 is the first externally
facing surface on an internal shopfloor MES, so the security design leads.

Decisions locked with Simon:
- **Email first** (slim Phase 2) so invites + notifications are real, not manual.
- **Separate minimal portal bundle** - external users never load the internal SPA.

---

## 0. Threat model and non-negotiables

The app today assumes every logged-in user is internal and trusted. The portal
breaks that assumption, so these are hard rules, enforced in depth:

1. **Two separate identities.** External customers live in their own table
   (`portal_users`), NOT in `users`, and are NEVER in ROLE_HIERARCHY. An external
   session can never satisfy an internal `requireRole`/`hasRole` check because it
   is not a user at all from the internal app's point of view.
2. **Separate auth + cookie.** Portal login issues its own JWT in a distinct
   cookie (e.g. `ptoken`) with its own secret/claims. Internal `requireAuth` only
   accepts the internal cookie; portal `requirePortal` only accepts the portal
   cookie.
3. **Hard route split.**
   - Every existing `/api/*` route gets a global guard that **rejects any portal
     request outright** (defence even if a route forgot its own gate).
   - All external endpoints live under **`/api/portal/*`** and accept portal
     sessions only.
4. **Tenant scoping on every portal query.** Always filtered by the session's
   `customer_id`. A customer can only ever see their own data. No portal endpoint
   takes a customer id from the client.
5. **Server-side field filtering.** Portal responses are built by an allow-list
   serializer that emits ONLY customer-safe fields + `visibility='customer'`
   events/attachments + the published quote. Internal fields (build/insp/test
   minutes, Sage value, internal notes, assignees, other customers) are never in
   the payload - not merely hidden in the UI.
6. **Separate bundle.** The portal is its own small page under `/portal`, with its
   own JS; the internal SPA (`app-v2.js`) is never served to external users.
7. **Onboarding is invite-only.** No open self-registration. Philtronics invites a
   named contact; the invite is emailed; the contact sets a password. 2FA offered.
8. **Tests.** This phase stands up a minimal automated test harness for the
   scoping/guard logic (the bits where a bug = a data leak). Ties to the parked
   engineering-floor TODO (tests + branch protection) - recommended to enable
   branch protection on main before the portal goes live.

---

## Slim Phase 2 (prerequisite for the portal)

### P2.1 - Email
- `server/lib/email.js`: a lightweight sender via an HTTP API provider (Resend or
  SendGrid - no SMTP server; keeps Railway lean). Degrades gracefully if env vars
  are unset (logs instead of sending), like `r2.js`.
- Env (Railway app service, never committed): provider API key + a from-address.
- Events wired now: customer invite, password-set confirmation. (RFQ receipt /
  quote-issued notifications added in Phase 3 where they belong.)

### P2.2 - Issue quote / publish
- An **Issue quote** action on an RFQ (internal, manager+): stamps `quote_ref`,
  `quoted_value`, `quoted_at`, sets status `completed`, and records a
  `quote_issued` event with `visibility='customer'` (so the portal can show it).
- Defines exactly what a customer is allowed to see for a quoted RFQ: the quote
  value, reference, date, lead time note, and any customer-facing events.
- No PDF yet (the portal renders the quote inline); PDF is a later nicety.

---

## Phase 3 - Customer portal

### P3.1 - Identity, data model, the hard split  (migration 034)
- `portal_users`: id, customer_id (FK customers), email (unique), password_hash,
  full_name, totp_secret (nullable), is_active, last_login_at, created_by,
  created_at. NOT linked to `users`.
- `portal_invites`: id, customer_id, email, token (unique), role/label, expires_at,
  accepted_at, invited_by (users.id), created_at.
- Middleware:
  - `requirePortal` (portal cookie -> req.portalUser with customer_id).
  - `requireInternal` added to the internal API so a portal cookie is rejected
    there (applied globally to `/api/*` except `/api/portal/*` and auth).
- Portal auth routes `/api/portal/auth`: accept-invite (set password), login,
  logout, me, optional 2FA. Rate-limited.

### P3.2 - Portal API  (`/api/portal/*`, portal-scoped)
- `GET /api/portal/rfqs` - the customer's own RFQs (safe fields only).
- `GET /api/portal/rfqs/:id` - detail: customer fields + published quote +
  customer-visible events only. 404 if not this customer's RFQ.
- `POST /api/portal/rfqs` - submit a new RFQ (customer fields only; forced to
  their own customer_id; status `open`).
- `POST /api/portal/rfqs/:id/accept` and `/decline` - record the customer's
  decision (a customer-visible event + a status/flag).
- `POST /api/portal/rfqs/:id/messages` - customer-facing message thread.
- A single allow-list serializer is the only way RFQ data leaves to the portal.

### P3.3 - The portal bundle  (`public/portal/`)
- A small standalone page (its own index + JS + CSS), served at `/portal`, with:
  login / set-password, "My RFQs" list, RFQ detail (status, published quote,
  messages, accept/decline), and a "New RFQ" form. Philtronics-branded, minimal.
- No internal nav, no internal code.

### P3.4 - Admin-side invite management (internal)
- In the internal RFQ module: per-customer "Contacts" - invite a contact (creates
  a `portal_invite`, emails the link), list/revoke contacts, resend invite.
- Manager+ (or a dedicated capability if we want to limit who can grant external
  access - decision).

### P3.5 - Security review, tests, docs
- Automated tests for: the hard split (portal cookie rejected on `/api/*`;
  internal cookie rejected on `/api/portal/*`), tenant scoping (cannot read
  another customer's RFQ), and the serializer (no internal field leaks).
- A manual review pass against the section-0 rules.
- CLAUDE.md + spec updates; recommend branch protection on main.

---

## Sequencing (PRs, in order)

1. **P2.1** email lib (graceful-degrade) - no behaviour change if unconfigured.
2. **P2.2** issue-quote / publish step + customer-visible quote data.
3. **P3.1** portal identity + migration 034 + the hard split middleware + portal
   auth. (Backend; the split guard is the highest-risk change - reviewed closely.)
4. **P3.2** portal API with the allow-list serializer + scoping.
5. **P3.3** the portal bundle/UI.
6. **P3.4** admin invite management.
7. **P3.5** tests + security review + docs.

Backend + security first (1-4), then the portal UI (5), then admin tooling and
the review (6-7). Each PR is independently reviewable; nothing external is exposed
until P3.1-P3.2 land and are reviewed.

---

## Open decisions before building

1. **Email provider**: Resend or SendGrid (or an existing SRSCloud mailer)? Need
   the API key + from-address set on Railway (by Simon) before P2.1 is useful.
2. **Who can invite customers**: manager+ (simple) or a dedicated capability?
3. **Portal 2FA**: offer at launch, or add after? (Recommended: offer, not forced.)
4. **Accept/decline semantics**: does customer "accept" move the RFQ to a Won
   state we track, or just record acceptance? (We have no won/lost field yet - may
   add one.)
5. **Branch protection on main** before the portal is live (recommended).

---

## Risks

- The hard internal/external split is the make-or-break; it gets the most review
  and the automated guard tests.
- Railway lean tier: email is the main new external cost; portal traffic is low.
- This is a meaningfully larger surface than Phase 1 - expect it to span several
  PRs over more than one session.
