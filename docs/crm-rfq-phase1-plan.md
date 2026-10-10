# CRM / RFQ - Phase 1 Build Plan (Internal RFQ module, MVP)

Companion to `crm-rfq-spec.md`. This breaks Phase 1 into sequenced, independently
reviewable steps (each a PR), internal-only, no external surface. Target: a
working replacement for the SharePoint "QuoteActions" list.

Conventions as ever: UK English, no em dashes, CRLF on server files, add new body
fields to `validate.js` (stripUnknown), deploy related files together, keep it
lean for Railway, one well-defined change per PR.

---

## Definition of done for Phase 1

A manager can, inside the Dashboard:
- See a filterable list of RFQs (status, customer, priority, assignee, part search).
- Open an RFQ: customer request fields, an activity feed, assignees, the internal
  time/quote fields, and status actions.
- Create an RFQ by hand (phone/email requests).
- Import the SharePoint export (the 661) and re-import later without duplicates.
- See turnaround reporting (days-to-complete, time-to-first-action, status counts).

No external/customer access, no email, no file uploads yet (those are Phase 2/3).

---

## Step 1 - Data layer and migrations  (PR 1)

**Migration 032** `032_crm_customers.sql`: `customers`, `customer_aliases`
(schemas per spec section 4.1 / 4.2). Tables start empty.

**Migration 033** `033_crm_rfqs.sql`: `rfqs`, `rfq_assignees`, `rfq_events`,
`rfq_attachments` (spec 4.3-4.6).

Notes:
- Customers are populated by the import and by the UI, not seeded in the
  migration (keeps the alias map editable in code; see Step 3). Empty tables are
  fine for a fresh module.
- `rfqs.external_source_id` is UNIQUE and nullable (native rows have none).
- Indexes: rfqs(customer_id), rfqs(status), rfqs(part_number),
  rfq_events(rfq_id), rfq_assignees(rfq_id), customer_aliases(alias).

Done when: migrations run clean on boot; tables + indexes exist.

---

## Step 2 - RFQ API (internal)  (PR 2)

`server/routes/rfq.js`, mounted at `/api/rfq`, `router.use(requireAuth,
requireRole('manager'))`.

Endpoints:
- `GET  /api/rfq` - list; query params: `status`, `customer`, `priority`,
  `assignee`, `q` (part/title search), paging. Returns summary rows.
- `GET  /api/rfq/:id` - full record + assignees + events + attachments.
- `POST /api/rfq` - create (generates `rfq_number`).
- `PATCH /api/rfq/:id` - update fields (status, times, quote fields, dates,
  assignees). A status change writes a `status_change` event.
- `POST /api/rfq/:id/events` - add an activity entry `{type, body, visibility}`.
- `GET  /api/rfq/report` - SLA + status summary (see Step 5).
- `GET  /api/customers` + `POST /api/customers` - list / add canonical customers.

Supporting:
- `validate.js`: `rfqCreate`, `rfqUpdate`, `rfqEvent`, `customerCreate` schemas
  (every field the routes read must be here or it is silently dropped).
- `rfq_number` generation: `RFQ-YYYY-NNNN`, N = next per calendar year. Compute as
  `max(suffix)+1` for the year inside the insert transaction (lean; no sequence
  object needed). CONFIRM the format.
- Times stored/accepted in minutes; UI shows hours.
- Assignees: `rfq_assignees` upserted from `{userId|name}` list.

Done when: CRUD + events + report verified against a seeded RFQ (headless script,
as with the push/pull lib).

---

## Step 3 - Import: the 661 + repeatable  (PR 3)

`server/lib/rfq-import.js` (db-free, unit-testable, like `lib/xlsx-demand.js`):
- Parse CSV and .xlsx (generalise the existing zlib xlsx reader for .xlsx; CSV is
  a small parser). Accept the SharePoint "Export to Excel" output.
- Map columns per spec section 6.1.
- Canonicalise customers via a **code-level alias map** (Appendix A of the spec):
  known alias -> canonical; unknown -> flagged for review (and created on commit).
- Parse `ActionComments` into `rfq_events` best-effort (split on newlines / dated
  prefixes); if a line will not parse cleanly, keep it as one internal event so
  nothing is lost.
- Dedupe on `external_source_id` = the SharePoint **Item ID** column.

Route `/api/rfq/import` (manager+, 12mb json like push-pull, base64 upload):
- `dryRun: true` returns a **preview**: counts of new / updated / unmatched
  customers / rows-with-warnings, plus a sample, WITHOUT writing.
- `dryRun: false` applies in one transaction: upsert customers/aliases, upsert
  rfqs by `external_source_id`, replace that rfq's imported events/assignees.
- Native (UI-created) rows have no `external_source_id` and are never touched.

Done when: dry-run against the real 661 file reports ~661 rows, 20 customers,
correct status/type/priority/time mapping; a second run reports 0 new (idempotent).
Verified with a headless test against the actual export (no DB needed for the
pure mapping; a seeded DB for the commit path).

---

## Step 4 - Dashboard UI: RFQ section  (PR 4)

Surface inside the Dashboard (`pageDashboard`, manager+) as a menu item, per the
spec. Add lightweight Dashboard sub-navigation; RFQ is one section.

Views (built with `el()`, `GET/POST/PATCH`, `openModal`, existing table/chip/
modal styles):
- **List** - filters (status/customer/priority/assignee), part search, status
  chips, sort by date-required / created; row -> detail.
- **Detail** - header (customer, part, status, priority, dates); customer request
  fields (read-mostly); internal panel (build/insp/test minutes as hours, quoted
  value, quote ref); **activity feed** with add-comment, change-status, assign;
  attachments list (display only in P1).
- **New RFQ** - form mirroring the customer form (staff keying in requests).
- **Import** - upload, preview (Step 3), confirm.

Done when: a manager can list/create/edit/advance RFQs and run an import, verified
in the browser preview where practical (and against the dummy environment).

---

## Step 5 - SLA reporting, polish, docs  (PR 5)

- Report view: turnaround (days-to-complete, time-to-first-action) by priority and
  customer; counts by status; open vs completed. Computed from timestamps.
  Printable, following the Order Book Summary pattern.
- Update `CLAUDE.md`: new migrations (032-033), the RFQ module (routes/rfq.js,
  lib/rfq-import.js, Dashboard placement, manager+), and the import.
- Tidy: empty states, loading, error handling.

Done when: report renders with real imported data; CLAUDE.md current.

---

## Cross-cutting decisions to lock before/at Step 2

1. **RFQ numbering**: `RFQ-YYYY-NNNN` (confirm, or derive from the quote number).
2. **Five display names** in spec Appendix A (Mono, SNC, PerkinElmer, Carbont,
   Soil Essentials) - final trading names for the alias map.
3. **Import source**: exports must include the **Item ID** column (confirmed
   present in the list schema) so re-import is idempotent.

## Testing note

Phase 1 is a good place to start a small unit-test harness for the pure pieces
(import field mapping, customer canonicalisation, `rfq_number` generation) -
mirrors how the push/pull lib was verified, and begins the test coverage the
external portal (Phase 3) will depend on. Ties to the engineering-floor TODO
(tests + branch protection).

## Sequencing

Five PRs, in order (each reviewable and mergeable on its own):
1. Migrations (data layer)
2. RFQ API + validation
3. Import (lib + route) with dry-run preview
4. Dashboard RFQ UI
5. SLA report + docs

Steps 1-3 are backend and independently testable; 4-5 are the UI and reporting.
