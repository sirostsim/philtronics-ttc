/**
 * routes/order-book.js -- imported customer order books.
 *
 * Upload (POST) replaces a customer's whole order book with the parsed rows
 * (manager+). The offering (GET) returns the items available to build: those
 * whose effective date -- Required By, falling back to Current Due Date -- is
 * within the shippable window, excluding rework lines and zero-balance rows.
 * The client does the messy SAP-export parsing; the server receives clean rows
 * (ISO dates or null) and stores them verbatim.
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, getClient } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');

const router = express.Router();

// Shippable window: items requested (or due) within this many days may be built.
const WINDOW_DAYS = 56; // 8 weeks

// View is supervisor and above; upload is manager and above.
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
// Items available to build within the window, one row per order line.
router.get('/offering', async (req, res) => {
  try {
    const customer = req.query.customer;
    const params = [WINDOW_DAYS];
    let customerClause = '';
    if (customer) { params.push(customer); customerClause = `AND co.customer = $${params.length}`; }

    const rows = await query(
      `SELECT co.id, co.customer, co.po_number, co.po_line, co.item_number, co.description,
              co.required_by, co.due_date, co.quantity, co.line_value, co.rework,
              COALESCE(co.required_by, co.due_date) AS effective_date,
              (tt.item_number IS NOT NULL)          AS has_target,
              EXISTS (
                SELECT 1 FROM planned_work pw
                WHERE pw.item_number = co.item_number
                  AND pw.wo_number IS NOT DISTINCT FROM co.po_number
              )                                     AS already_planned
       FROM customer_orders co
       LEFT JOIN target_times tt ON tt.item_number = co.item_number
       WHERE co.rework = FALSE
         AND co.quantity > 0
         AND COALESCE(co.required_by, co.due_date) IS NOT NULL
         AND COALESCE(co.required_by, co.due_date) <= (CURRENT_DATE + ($1 || ' days')::interval)
         ${customerClause}
       ORDER BY COALESCE(co.required_by, co.due_date) ASC, co.line_value DESC NULLS LAST`,
      params
    );

    const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null));
    const today = new Date().toISOString().slice(0, 10);
    res.json(rows.map(r => {
      const eff = iso(r.effective_date);
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
        quantity:       r.quantity,
        lineValue:      r.line_value != null ? Number(r.line_value) : null,
        hasTarget:      r.has_target,
        alreadyPlanned: r.already_planned,
        overdue:        eff != null && eff < today,
      };
    }));
  } catch (err) {
    console.error('GET /order-book/offering error:', err.message);
    res.status(500).json({ error: 'Could not load the order book offering.' });
  }
});

// ── POST /api/order-book ── manager+ ──────────────────────────────────────────
// Replace a customer's order book with the uploaded rows (one transaction).
router.post('/', requireRole('manager'), validate(schemas.orderBookUpload), async (req, res) => {
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
          uuidv4(), customer, r.poNumber || null, r.poLine || null, r.itemNumber,
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

module.exports = router;
