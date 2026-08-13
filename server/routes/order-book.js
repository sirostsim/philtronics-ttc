/**
 * routes/order-book.js -- imported customer order books.
 *
 * Upload (POST) replaces a customer's whole order book with the parsed rows
 * (planner role or superuser). The offering (GET) returns the items available to build: those
 * whose effective date -- Required By, falling back to Current Due Date -- is
 * within the shippable window, excluding rework lines and zero-balance rows.
 * The client does the messy SAP-export parsing; the server receives clean rows
 * (ISO dates or null) and stores them verbatim.
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, getClient } = require('../db');
const { requireAuth, requireRole, requirePlannerWrite } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const settings = require('../settings');
const { plannedEndDate } = require('../lib/planner-schedule');

const router = express.Router();

const isoOf = d => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null));
// req - exp, in whole days: positive = finishing early, negative = late.
const dayGap = (exp, req) => (!exp || !req) ? null : Math.round((Date.parse(req) - Date.parse(exp)) / 86400000);

// Shippable window: KLA lets us build and ship anything whose effective date is
// within this many days. It is used to LABEL lines (withinWindow), not to filter
// them - the planner sees the whole book so it can pull build-ahead work forward.
const WINDOW_DAYS = 56; // 8 weeks

// View is supervisor and above; upload/clear is the planner role or superuser.
router.use(requireAuth, requireRole('supervisor'));

// ── GET /api/order-book/customers ─────────────────────────────────────────────
// Distinct customers that have an order book loaded (for the picker).
router.get('/customers', async (req, res) => {
  try {
    const rows = await query('SELECT DISTINCT customer FROM customer_orders ORDER BY customer ASC');
    res.json(rows.map(r => r.customer));
  } catch (err) {
    console.error('GET /order-book/customers error:', err.message);
    res.status(500).json({ error: 'Could not load customers.' });
  }
});

// ── GET /api/order-book/offering ──────────────────────────────────────────────
// The whole order book, one row per order line, sorted by effective date (undated
// last). Each line is flagged withinWindow (inside the 8-week shippable window)
// so the client can highlight shippable work and mark the rest as build-ahead.
router.get('/offering', async (req, res) => {
  try {
    const customer = req.query.customer;
    const params = [];
    let customerClause = '';
    if (customer) { params.push(customer); customerClause = `AND co.customer = $${params.length}`; }

    const rows = await query(
      `SELECT co.id, co.customer, co.po_number, co.po_line, co.item_number, co.description,
              co.required_by, co.due_date, co.quantity, co.line_value, co.rework,
              COALESCE(co.required_by, co.due_date) AS effective_date,
              (tt.item_number IS NOT NULL)          AS has_target,
              tt.hours AS t_hours, tt.minutes AS t_minutes,
              COALESCE((
                SELECT SUM(pw.quantity) FROM planned_work pw
                WHERE pw.item_number = co.item_number
                  AND pw.wo_number IS NOT DISTINCT FROM co.po_number
                  AND pw.source_po_line IS NOT DISTINCT FROM co.po_line
              ), 0)                                 AS planned_qty
       FROM customer_orders co
       LEFT JOIN target_times tt ON tt.item_number = co.item_number
       WHERE co.rework = FALSE
         AND co.quantity > 0
         ${customerClause}
       ORDER BY COALESCE(co.required_by, co.due_date) ASC NULLS LAST, co.line_value DESC NULLS LAST`,
      params
    );

    const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null));
    const today  = new Date().toISOString().slice(0, 10);
    // The 8-week window is now a LABEL, not a filter: the whole order book is
    // returned so the planner can see (and pull forward) build-ahead work, with
    // each line flagged for whether it falls in the shippable window.
    const winEnd = new Date(Date.now() + WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
    res.json(rows.map(r => {
      const eff = iso(r.effective_date);
      const ordered   = r.quantity;
      const planned   = Number(r.planned_qty) || 0;
      const remaining = ordered - planned;
      return {
        id:             r.id,
        customer:       r.customer,
        poNumber:       r.po_number || null,
        poLine:         r.po_line || null,
        itemNumber:     r.item_number,
        description:    r.description || null,
        requiredBy:     iso(r.required_by),
        dueDate:        iso(r.due_date),
        effectiveDate:  eff,
        quantity:       ordered,            // ordered (Bal Due) quantity
        plannedQty:     planned,            // total already allocated to the planner
        remainingQty:   remaining,          // ordered - planned (negative = over-planned)
        fullyPlanned:   remaining <= 0,
        overPlanned:    planned > ordered,
        lineValue:      r.line_value != null ? Number(r.line_value) : null,
        hasTarget:      r.has_target,
        // Per-item target minutes (for backward scheduling on the planner); null when no target.
        perItemMinutes: r.has_target ? (r.t_hours * 60 + r.t_minutes) : null,
        overdue:        eff != null && eff < today,
        // In the 8-week shippable window? Undated lines are never in-window.
        withinWindow:   eff != null && eff <= winEnd,
      };
    }));
  } catch (err) {
    console.error('GET /order-book/offering error:', err.message);
    res.status(500).json({ error: 'Could not load the order book offering.' });
  }
});

// ── GET /api/order-book/report ── manager+ ────────────────────────────────────
// Data for the weekly "Order Book Summary" report sent to the customer: every
// open order line with its planned build-completion date (the latest finish of
// the planner jobs allocated to it), compared to the required date, with a
// status and value. The frontend renders this into the printable PDF report.
router.get('/report', requireRole('manager'), async (req, res) => {
  try {
    const customer = req.query.customer || 'KLA';
    const s = await settings.get();

    // Optional time fence: horizon = a week count (matches the planner's "Next X
    // weeks" selector) or 'all'. When a number, only lines whose effective date
    // falls within that window are reported (undated lines drop out).
    const horizon = String(req.query.horizon || 'all');
    const params = [customer];
    let horizonClause = '';
    if (/^\d+$/.test(horizon)) {
      params.push(parseInt(horizon, 10) * 7);
      // $n::int cast is required: "CURRENT_DATE + $n" is ambiguous (date + int vs
      // date + interval) and Postgres cannot infer an untyped parameter's type.
      horizonClause = `AND COALESCE(co.required_by, co.due_date) IS NOT NULL
                       AND COALESCE(co.required_by, co.due_date) <= CURRENT_DATE + $${params.length}::int`;
    }

    const orders = await query(
      `SELECT co.po_number, co.po_line, co.item_number, co.description,
              COALESCE(co.required_by, co.due_date) AS eff, co.quantity, co.line_value
         FROM customer_orders co
        WHERE co.customer = $1 AND co.rework = FALSE AND co.quantity > 0
          ${horizonClause}
        ORDER BY COALESCE(co.required_by, co.due_date) ASC NULLS LAST, co.line_value DESC NULLS LAST`,
      params
    );

    // Planner jobs for these items, with the target (or estimate) to size them.
    const items = [...new Set(orders.map(o => o.item_number))];
    const jobs = items.length ? await query(
      `SELECT p.item_number, p.wo_number, p.source_po_line, p.start_date, p.quantity,
              p.estimated_minutes, tt.hours AS t_hours, tt.minutes AS t_minutes
         FROM planned_work p LEFT JOIN target_times tt ON tt.item_number = p.item_number
        WHERE p.item_number = ANY($1)`, [items]) : [];

    // Each order line's expected completion = the LATEST finish of its jobs
    // (item + PO + PO-line), scheduled across working days. Also total planned qty.
    const baseline = d => settings.productivityBaselineMinutes(s, d);
    const byLine = {};
    for (const j of jobs) {
      const perItem = j.t_hours != null ? (j.t_hours * 60 + j.t_minutes)
        : (j.estimated_minutes != null ? j.estimated_minutes : null);
      const total = perItem != null ? perItem * j.quantity : null;
      const startISO = isoOf(j.start_date);
      const end = (total && total > 0) ? plannedEndDate(startISO, total, baseline).endDate : startISO;
      const key = j.item_number + '||' + (j.wo_number || '') + '||' + (j.source_po_line || '');
      const g = byLine[key] || (byLine[key] = { endDate: null, plannedQty: 0 });
      if (end && (!g.endDate || end > g.endDate)) g.endDate = end;
      g.plannedQty += j.quantity;
    }

    const lines = orders.map(o => {
      const key = o.item_number + '||' + (o.po_number || '') + '||' + (o.po_line || '');
      const g = byLine[key];
      const req = isoOf(o.eff);
      const exp = g ? g.endDate : null;
      let status = 'awaiting';
      if (exp) status = (!req || exp <= req) ? 'ontrack' : 'late';
      return {
        item:        o.item_number,
        description: o.description || null,
        po:          o.po_number || null,
        qty:         o.quantity,
        plannedQty:  g ? g.plannedQty : 0,
        requiredBy:  req,
        expected:    exp,
        varianceDays: dayGap(exp, req),   // + early, - late, null if either missing
        status,
        value:       o.line_value != null ? Number(o.line_value) : null,
      };
    });

    const summary = {
      openLines:      lines.length,
      committedValue: lines.reduce((t, l) => t + (l.value || 0), 0),
      onTrack:        lines.filter(l => l.status === 'ontrack').length,
      late:           lines.filter(l => l.status === 'late').length,
      awaiting:       lines.filter(l => l.status === 'awaiting').length,
    };
    res.json({ customer, horizon, generatedAt: new Date().toISOString().slice(0, 10), summary, lines });
  } catch (err) {
    console.error('GET /order-book/report error:', err.message);
    res.status(500).json({ error: 'Could not build the order book report.' });
  }
});

// ── POST /api/order-book ── planner/superuser ─────────────────────────────────
// Replace a customer's order book with the uploaded rows (one transaction).
router.post('/', requirePlannerWrite, validate(schemas.orderBookUpload), async (req, res) => {
  const { customer, rows } = req.body;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM customer_orders WHERE customer = $1', [customer]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO customer_orders
           (id, customer, po_number, po_line, item_number, description,
            required_by, due_date, quantity, line_value, rework, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          // Uppercase the item number to match target_times and planned_work
          // (both store it uppercased). Without this, the offering's target-time
          // join, planned-qty, drift and £ value matching silently miss whenever
          // the SAP export's case differs -- which makes target items look like
          // no-target items and defeats backward scheduling.
          uuidv4(), customer, r.poNumber || null, r.poLine || null,
          String(r.itemNumber).trim().toUpperCase(),
          r.description || null, r.requiredBy || null, r.dueDate || null,
          r.quantity, r.lineValue != null ? r.lineValue : null, !!r.rework, req.user.id,
        ]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, customer, imported: rows.length });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /order-book error:', err.message);
    res.status(500).json({ error: 'Could not import the order book.' });
  } finally {
    client.release();
  }
});

// ── POST /api/order-book/clear ── planner/superuser ── wipe one customer's order book
router.post('/clear', requirePlannerWrite, async (req, res) => {
  try {
    const customer = ((req.body && req.body.customer) || '').trim();
    if (!customer) return res.status(400).json({ error: 'A customer is required.' });
    const deleted = await query('DELETE FROM customer_orders WHERE customer = $1 RETURNING id', [customer]);
    const n = deleted.length;
    try {
      await query(
        `INSERT INTO audit_log (id, timer_id, action, performed_by, details)
         VALUES ($1, NULL, 'order_book_cleared', $2, $3)`,
        [uuidv4(), req.user.id, JSON.stringify({ customer, cleared: n })]
      );
    } catch (_) {}
    console.log(`[order-book] ${req.user.username || req.user.id} cleared ${customer} order book (${n} lines)`);
    res.json({ cleared: n, customer });
  } catch (err) {
    console.error('POST /order-book/clear error:', err.message);
    res.status(500).json({ error: 'Could not clear the order book.' });
  }
});

module.exports = router;
