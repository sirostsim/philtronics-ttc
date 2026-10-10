# CRM / RFQ Module - Specification and Phased Plan

Status: DRAFT for review. Owner: Simon Street. Last updated: 2026-10-10.

This document specifies a Customer Relationship Management (CRM) module for Work
Time, focused on Request For Quote (RFQ) management. It is a living design doc:
Phase 1 is scoped concretely; later phases are directional and will be detailed
as we approach them.

---

## 1. Background and goal

Philtronics receives quotation requests from customers. Today the flow is:

1. A customer completes a Microsoft Form ("SPTS - Philtronics - RFQ").
2. Power Automate writes the submission into a SharePoint list ("QuoteActions",
   site `/sites/CRMs`).
3. Internal staff work the list: assign it, add build/inspection/test times, log
   progress in a free-text comments field, record a Sage sales value, and mark it
   Completed (or Declined). A quote is sent back to the customer (a "QN####"
   reference, currently captured in the comments).

We want to replace this with an RFQ module inside Work Time, and later open a
limited external portal so customers can raise and track their own RFQs.

### Why inside Work Time (not a standalone CRM)

RFQ parts use the same item-number namespace as `target_times` and the order
book (e.g. `1070319-000`), and the RFQ process already captures build time. That
gives a real synergy: an RFQ build-time estimate can seed a part's target time,
and existing target times can inform an estimate. A standalone CRM could not do
this.

---

## 2. What the current data tells us (QuoteActions export, 661 records)

Analysis of the exported SharePoint list (`QuoteActions.csv`, 28 columns, 661
rows back to 2024) drove the design:

- **Already multi-customer.** SPTS (= KLA/SPTS Technologies) is ~91%, but there
  is a real tail of ~23 others: MONO, Fike, Bridmet, Rototherm, SNC,
  IQ Endoscopes, and more - 24 distinct names. Names are inconsistent
  (SPTS/Spts, BRIDMET / Bridmet / "BRIDMET LIMITED", Rototherm/ROTOTHERM) and
  need canonicalising to real customer records. **SPTS and KLA are the same
  customer.**
- **Flat workflow, not a rich pipeline.** `ActionStatus` is only ever: Open,
  Awaiting Response, Completed, PHILTRONICS DECLINED.
- **The "process" is an action log.** `ActionComments` is a dated free-text
  journal (e.g. "DP 19/08/24 - Uploaded to sharepoint\nRQ 13/09/24 - Sent to
  SPTS QN1149"); `ActionBy` is one or more assignees ("Rachel Quinn;Sophie
  Richards"). We will model this as a structured, attributed activity feed.
- **No costing engine; pricing lives in Sage.** Component Costs is filled ~5% of
  the time; the real figure is `Sage Sales Cost` (~34%, e.g. "9,962.02"). We
  capture the time estimates + a final quoted value + the quote reference, and
  leave detailed costing to Sage (integration is a later phase).
- **Captured time estimates:** Build / Inspection / Test time (~38 / 34 / 18%
  filled, values like 20 / 3 / 8 - hours).
- **Dead columns** (0% filled): Purchase Concerns, Critical Concerns, Customer
  Feedback. Dropped.
- **SLA metrics already matter:** `Days to Complete` and `Time to First Action`.
  We will compute these natively from timestamps rather than store them.
- **QuoteTitle** is the part number plus revision (e.g. "1070319-000 REV AA").

Net effect: this is simpler than a classic CRM pipeline. It is a status +
assignees + activity log + a few time/value fields per RFQ, multi-customer, with
turnaround reporting.

---

## 3. Scope

### In scope (overall)
- Internal RFQ management replacing the SharePoint list.
- Multi-customer from day one, with canonical customer records.
- One-off import of the 661 records, plus a repeatable incremental import for the
  bedding-in period.
- A later external customer portal with strict tenant isolation.

### Non-goals / deferred
- **No costing/margin engine.** Pricing stays in Sage.
- **Sage integration is deferred** but designed-for (we store a quoted value, a
  quote reference, and a reserved `sage_ref`; Phase 4 adds the sync).
- **Email is Phase 2** (there is no email capability today).
- **The external portal is Phase 3** - deliberately last, as it is the first
  externally-facing surface and the highest risk.

---

## 4. Data model (Phase 1)

New tables. Migrations start at **032** (latest existing is 031). All additive.
Follows existing conventions: `db.query()` returns rows directly; UK English;
CRLF on server files.

### 4.1 `customers` (032)
Canonical customer organisations.

| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| name | TEXT NOT NULL UNIQUE | canonical display name, e.g. "SPTS (KLA)" |
| code | TEXT | short code, optional |
| is_active | BOOLEAN NOT NULL DEFAULT TRUE | |
| notes | TEXT | |
| created_at | TIMESTAMPTZ DEFAULT NOW() | |
| created_by | TEXT REFERENCES users(id) | |

### 4.2 `customer_aliases` (032)
Maps messy historical/source names to a canonical customer, so import is
deterministic and repeatable.

| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| customer_id | TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE | |
| alias | TEXT NOT NULL UNIQUE | lower-cased source name, e.g. "bridmet limited" |

The full seed mapping for the 24 historical source names (20 canonical
customers) is in **Appendix A**. Unknown names in a later import create a new
customer and are flagged in the import report for review.

### 4.3 `rfqs` (033)
One part-quote request (one part per RFQ, matching the form).

| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| rfq_number | TEXT UNIQUE | our ref, generated, e.g. `RFQ-2026-0042` |
| customer_id | TEXT NOT NULL REFERENCES customers(id) | |
| part_number | TEXT | item-number namespace; from QuoteTitle |
| part_name | TEXT | form "RFQ Part Name" |
| revision | TEXT | |
| co_number | TEXT | |
| quote_type | TEXT | 'new' or 'up_rev' |
| priority | TEXT | 'A' / 'B' / 'C' / null |
| date_required_by | DATE | |
| free_issue | BOOLEAN | nullable |
| potential_units_annual | INTEGER | sparse; kept for pipeline |
| potential_revenue_annual | NUMERIC(14,2) | sparse |
| request_comments | TEXT | customer's notes |
| contact_email | TEXT | from form / RequestedBy |
| status | TEXT NOT NULL DEFAULT 'open' | see section 5 |
| build_minutes | INTEGER | internal; from Build Time (hours*60) |
| inspection_minutes | INTEGER | internal |
| test_minutes | INTEGER | internal |
| quoted_value | NUMERIC(14,2) | internal; from Sage Sales Cost |
| quote_ref | TEXT | the QN#### reference |
| quoted_at | DATE | when the quote was issued |
| sage_ref | TEXT | reserved for Phase 4 Sage link |
| source_created_at | TIMESTAMPTZ | original SharePoint Created (for SLA/history) |
| first_action_at | TIMESTAMPTZ | first internal action (for SLA) |
| completed_at | TIMESTAMPTZ | status reached completed/declined |
| external_source_id | TEXT UNIQUE | dedupe key for re-import (see 6.3) |
| created_at | TIMESTAMPTZ DEFAULT NOW() | our record creation |
| created_by / updated_by | TEXT REFERENCES users(id) | |
| updated_at | TIMESTAMPTZ DEFAULT NOW() | |

Time estimates are stored in **minutes** (consistent with `target_times`), shown
as hours in the UI. SLA metrics (days-to-complete, time-to-first-action) are
computed from the timestamps, not stored.

### 4.4 `rfq_assignees` (033)
`ActionBy` can be several people. Many-to-many, with a text fallback for imported
names that do not match a Work Time user.

| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| rfq_id | TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE | |
| user_id | TEXT REFERENCES users(id) | null if imported-name-only |
| name | TEXT | display fallback, e.g. "Rachel Quinn" |

### 4.5 `rfq_events` (033)
The structured activity feed (replaces the free-text ActionComments blob). This
is also where the internal/shared boundary lives.

| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| rfq_id | TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE | |
| type | TEXT NOT NULL | 'comment' / 'status_change' / 'assignment' / 'quote_issued' / 'customer_message' |
| body | TEXT | |
| visibility | TEXT NOT NULL DEFAULT 'internal' | 'internal' or 'customer' |
| author_id | TEXT REFERENCES users(id) | null for imported |
| author_name | TEXT | fallback for imported entries |
| created_at | TIMESTAMPTZ DEFAULT NOW() | import preserves the journalled date |

### 4.6 `rfq_attachments` (033, basic in P1; files in P2)
| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| rfq_id | TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE | |
| kind | TEXT | 'build_package' / 'quote_pdf' / 'other' |
| filename | TEXT | |
| r2_key | TEXT | object key in R2 |
| content_type | TEXT | |
| size_bytes | INTEGER | |
| visibility | TEXT DEFAULT 'internal' | 'internal' / 'customer' |
| uploaded_by | TEXT REFERENCES users(id) | |
| created_at | TIMESTAMPTZ DEFAULT NOW() | |

---

## 5. Status workflow and visibility

Four statuses, matching current practice, with a customer-facing label and a
visibility rule for the eventual portal:

| internal status | meaning | customer-facing label (Phase 3) |
|---|---|---|
| `open` | received, being worked | "Received - in progress" |
| `awaiting_response` | Philtronics is waiting on the customer | "Awaiting your response" |
| `completed` | quote issued / done | "Quoted" (shows the published quote) |
| `declined` | Philtronics declined to quote | "Declined" (+ reason) |

- Transitions are free (any status to any status) with the change recorded as an
  `rfq_events` entry of type `status_change`. We do not over-constrain the flow;
  the audit trail is the control.
- **Issue quote** is a lightweight publish action: it stamps `quote_ref`,
  `quoted_value`, `quoted_at`, typically moves status to `completed`, and (in
  Phase 3) makes the quote visible to the customer. Internal fields (build/insp/
  test minutes, Sage value, internal events) are never shared.
- The internal/shared boundary is enforced by `visibility` on events and
  attachments, plus server-side field filtering for portal responses (see 8).

---

## 6. Import (the 661 + repeatable incremental)

A manager-only import screen that accepts the SharePoint "Export to Excel" output
(CSV or .xlsx). We already have a dependency-free `.xlsx` reader
(`server/lib/xlsx-demand.js`) that can be generalised; CSV is trivial.

### 6.1 Field mapping (QuoteActions -> rfqs)
| source column | target | transform |
|---|---|---|
| Customer | customer_id | lower-case -> `customer_aliases` -> customer; unknown -> create + flag |
| QuoteTitle | part_number (+ revision) | split trailing "REV xx"/rev token into `revision` if absent |
| Quote Type | quote_type | RFQ / New Quotation -> 'new'; Up Rev / Up Revision -> 'up_rev' |
| Priority | priority | "Priority A (1-2 Days)" -> 'A', etc.; blank -> null |
| DateRequiredBy | date_required_by | DD/MM/YYYY -> ISO |
| RequestComments | request_comments | as-is |
| RequestedBy | contact_email | as-is |
| ActionBy | rfq_assignees | split on ";"; match to users by name, else name-only |
| ActionStatus | status | Open->open, Awaiting Response->awaiting_response, Completed->completed, PHILTRONICS DECLINED->declined |
| ActionComments | rfq_events | split on newlines into dated entries (best-effort), visibility=internal |
| Build/Inspection/Test Time | *_minutes | hours * 60 (numeric) |
| Revision Number | revision | prefer this if present |
| CO Number | co_number | |
| Free Issue | free_issue | Yes/No -> bool; blank -> null |
| Potential Units / Revenue | potential_* | numeric |
| Sage Sales Cost | quoted_value | strip commas -> numeric |
| Created | source_created_at | DD/MM/YYYY HH:MM -> ISO |
| Completed Date | completed_at | |
| (QN#### in ActionComments) | quote_ref | best-effort regex extract |
| Purchase/Critical Concerns, Customer Feedback | - | dropped (always empty) |
| Days to Complete, Time to First Action | - | not stored; computed |

### 6.2 Flow
Upload -> parse -> **preview** (counts: new / updated / unmatched customers /
rows needing attention) -> confirm -> import in one transaction. The preview is
essential given the data quality.

### 6.3 Repeatable / idempotent re-import
During the bedding-in period, new SharePoint records must import without
duplicating existing ones. Dedupe on `external_source_id`:

- **Preferred:** re-export the list including the SharePoint **Item ID** column;
  use it as `external_source_id`. Clean and reliable.
- **Fallback (if no ID available):** a composite natural key hash of
  `Customer + QuoteTitle + Created` (the Created timestamp makes it stable).

On re-import, existing rows (same `external_source_id`) are updated in place;
new ones are inserted. Records created natively in Work Time (no source id) are
never touched by an import.

CONFIRMED: the SharePoint list schema export shows the list has a `Counter` (ID)
field, so a stable per-item key exists. The only requirement is that the export
we import **includes the ID column** (Export to Excel with ID, or the XMLDATA
`ows_ID`). We use it as `external_source_id`.

---

## 7. Internal UI (Phase 1)

**Placement (CONFIRMED):** the RFQ/CRM module is surfaced as a **menu item within
the Dashboard** (the existing manager+ landing screen, `pageDashboard`), not as a
new top-level nav entry. The Dashboard gains lightweight sub-navigation; RFQ is
one section. Built with the usual helpers (`el()`, `GET/POST/PATCH`, `openModal`).
The views below are the sections reached from there.

- **RFQ list / board** - table of RFQs; filter by status, customer, priority,
  assignee; search by part number; sort by date required / created. Status chips.
- **RFQ detail** - header (customer, part, status, priority, dates); customer
  request fields; internal section (build/insp/test minutes, quoted value, quote
  ref); the **activity feed** (add comment, change status, assign); attachments.
- **New RFQ** - internal entry form mirroring the customer form (so staff can key
  in phone/email requests).
- **Import** - the screen in section 6.
- **Reporting** - turnaround SLA (days to complete, time to first action) by
  priority and customer; counts by status; (pipeline value later). Printable,
  like the existing Order Book Summary.

### Internal access (CONFIRMED)
Phase 1: the RFQ module is visible to **manager and above** (same gate as the
Dashboard it lives in). If, in practice, estimating/sales staff who work RFQs are
not managers, we can later add a dedicated non-hierarchical capability (mirroring
the `planner` / `canPlanWrite` pattern) without changing the hierarchy. Not
needed for V1.

---

## 8. External customer portal (Phase 3) - architecture and security

This is the first externally-facing surface of an otherwise internal shopfloor
app, so it is deliberately last and gets the most care. Design principles
(stated now so Phase 1 does not paint us into a corner):

- **Hard internal/external split.** External users are a distinct user type bound
  to a `customer_id` (an `organisation`), deliberately **outside** the
  operator->superuser hierarchy. They are never "a low internal role".
- **Separate route namespace.** All external endpoints live under
  `/api/portal/*`. A global `requireInternal` guard is added to every existing
  `/api/*` route that **rejects external users outright** (many routes today are
  just `requireAuth` = any logged-in user; an external account must never reach
  those).
- **Tenant scoping on every query.** Portal queries are always filtered by the
  user's `customer_id`; a customer can only ever see their own RFQs.
- **Server-side field filtering.** Internal fields (build/insp/test minutes, Sage
  value, internal events/attachments) are stripped from portal responses, not
  merely hidden in the UI. Only `visibility='customer'` events/attachments and
  the published quote are returned.
- **Separate, minimal portal bundle.** External users do not load the internal
  SPA, so internal page code is never shipped to them. (Trade-off: more work than
  reusing the one SPA, but much safer. Decision in Phase 3.)
- **Invite-based onboarding.** Philtronics invites a customer contact by email;
  no open self-registration. 2FA available.
- **This phase needs the test suite + branch protection** from the engineering
  floor TODO - an external surface is where a regression becomes a data leak.

Portal capabilities (Phase 3): submit an RFQ, list/track own RFQs, see the
published quote, accept/decline, exchange customer-facing messages.

---

## 9. Email (Phase 2)

No email today. Add a lightweight provider via API (e.g. Resend or SendGrid - no
SMTP server, keeps Railway lean), gated behind env vars and degrading gracefully
if unset (like R2). Events: RFQ receipt confirmation, quote issued, accept/decline
acknowledgement, portal invites.

> ACTION: confirm whether SRSCloud already has a preferred email provider to use.

---

## 10. Sage integration (Phase 4, designed-for now)

Deferred, but we reserve `rfqs.sage_ref` and already store `quoted_value` and
`quote_ref`. Later options: push an issued quote / sales value to Sage, or pull
the Sage sales cost back in. Scoped when we get there.

---

## 11. Target-times synergy (Phase 4)

Because RFQ part numbers share the item namespace and we capture build time, we
can: offer to seed a part's `target_times` from an RFQ's build estimate; show an
existing target time when estimating; and compare estimated vs actual build time
once a part goes into production. A differentiator for keeping this in Work Time.

---

## 12. Phased plan

**Phase 1 - Internal RFQ module (MVP).** Delivers a working replacement for the
SharePoint list.
- Migrations 032-033: customers, customer_aliases, rfqs, rfq_assignees,
  rfq_events, rfq_attachments.
- Import: the 661 records + repeatable incremental import, with preview.
- Internal UI: list, detail (with activity feed, assignees, status, time/quote
  fields), new-RFQ form, import screen.
- Four-status workflow; SLA reporting.
- Access: manager+ (or a new capability - decision).
- No external access, no email.

**Phase 2 - Quote output, email, attachments.**
- Quote PDF (client-rendered, like Order Book Summary) and the issue-quote step.
- Email provider + notifications.
- Build-package / quote file uploads to R2.

**Phase 3 - Customer portal (external).**
- The hard internal/external split (section 8), org scoping, field filtering.
- Invite onboarding + 2FA; submit / track / accept / decline; customer messages.
- Test suite + branch protection in place first.

**Phase 4 - Integrations and CRM.**
- Sage integration; target-times synergy; pipeline/CRM reporting; contacts.

---

## 13. Decisions and open actions before Phase 1 build

Resolved:
- **Internal access:** manager and above for V1. (Section 7.)
- **Placement:** a menu item within the Dashboard, not a new top-level page.
- **Re-import key:** the list has a `Counter` (ID) field; we use it as
  `external_source_id`. Just include the ID column in the export. (Section 6.3.)
- **Customer canonicalisation:** drafted (Appendix A), pending a quick sign-off on
  a few display names.

Still open:
1. **A few canonical display names** in Appendix A (Mono, PerkinElmer spelling,
   SoilEssentials, SNC, Carbont) - confirm the correct trading names.
2. **RFQ numbering scheme:** confirm `RFQ-YYYY-NNNN` (or derive from an existing
   reference such as the quote number).
3. **Email provider** (Phase 2) and whether the external portal stays Phase 3.

---

## 14. Risks and constraints

- **External surface (Phase 3) is the biggest risk** - tenant isolation must be
  airtight; this is the strongest argument for the parked test suite.
- **Railway hobby tier:** keep it lean; the import processes a few hundred rows,
  which is fine; email and file storage are the main new cost considerations.
- **Migration data quality:** inconsistent customer names, free-text comments,
  sparse cost fields - handled by canonicalisation, best-effort event parsing,
  and a preview step.
- **Sage integration** (Phase 4) is the largest future unknown; kept out of the
  critical path.

---

## Appendix A - Customer canonicalisation mapping

Drafted from the 661-record export: 24 source names collapse to **20 canonical
customers**. Aliases are matched case-insensitively (stored lower-cased in
`customer_aliases`). Display names marked (confirm) are pending sign-off; the
alias matching is unaffected by the final display name.

| Canonical customer | Source aliases | Records |
|---|---|---|
| SPTS (KLA) | SPTS, Spts | 606 |
| Mono (confirm) | MONO | 18 |
| Fike | Fike | 8 |
| Bridmet | Bridmet, BRIDMET LIMITED, BRIDMET | 8 |
| Rototherm | Rototherm, ROTOTHERM | 4 |
| SNC (confirm) | SNC | 2 |
| IQ Endoscopes | IQ Endoscopes | 2 |
| Control Technologies UK | CONTROL TECHNOLOGIES UK | 1 |
| Inspired Gaming (UK) | INSPIRED GAMING (UK) LIMITED | 1 |
| Drone Evolution | Drone Evolution | 1 |
| Militec | Militec | 1 |
| CareSafe | CareSafe | 1 |
| PerkinElmer (confirm) | PERKIN ELMER | 1 |
| Carbont (confirm) | Carbont | 1 |
| Soil Essentials (confirm) | Soil Essentials Ltd | 1 |
| EFT | EFT | 1 |
| Undalogic | Undalogic | 1 |
| ANM Electronics | ANM Electronics | 1 |
| Tekever | Tekever | 1 |
| Steel Rock Technologies | STEEL ROCK TECHNOLOGIES | 1 |

Merges: SPTS + Spts; Bridmet + BRIDMET LIMITED + BRIDMET; Rototherm + ROTOTHERM.
All 661 records reconcile against this mapping.
