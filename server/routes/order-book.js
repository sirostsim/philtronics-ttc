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

const router = express.Router();

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
