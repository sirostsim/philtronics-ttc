/**
 * routes/push-pull.js
 *
 * Push/Pull: KLA sends two spreadsheets every Tuesday (a commercial order book
 * and a live priority-requirements demand list). This feature archives each
 * weekly upload as a snapshot and reports the week-over-week "push/pull": parts
 * KLA now needs sooner (pull-in) or later (push-out), plus new/dropped demand,
 * weighted by the order book's commercial value.
 *
 * Gated at manager and above (which includes the planner role). Per an explicit
 * decision, uploading here ALSO refreshes the live customer_orders that the
 * Planner reads, so managers uploading the weekly book keep the Planner current
 * (this is the one place a manager may write the order book; the Planner's own
 * uploader stays planner-write-only).
 *
 * .xlsx is parsed server-side using Node's built-in zlib (see lib/xlsx-demand):
 * the client base64-posts the two small files and the server unzips + reads them.
 */
'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, getClient } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { readSheet, mapOrderBook, mapPriority, computeReport } = require('../lib/xlsx-demand');

const router = express.Router();

// Authenticate first (populates req.user from the login cookie), then gate the
// whole feature at manager and above (which includes the planner role).
router.use(requireAuth, requireRole('manager'));

// GET /api/push-pull/customers -> distinct customers with snapshots
router.get('/customers', async (req, res) => {
  try {
    const rows = await query('SELECT DISTINCT customer FROM demand_snapshots ORDER BY customer ASC');
    res.json(rows.map(r => r.customer));
  } catch (err) {
    console.error('GET /push-pull/customers error:', err.message);
    res.status(500).json({ error: 'Could not load customers.' });
  }
});

// GET /api/push-pull/report?customer=KLA -> full push/pull report
router.get('/report', async (req, res) => {
  try {
    const customer = (req.query.customer || 'KLA').toString();
    const snaps = await query(
      `SELECT id, snapshot_date, order_lines_count, priority_lines_count, order_book_value
         FROM demand_snapshots WHERE customer = $1 ORDER BY snapshot_date ASC`, [customer]);
    if (!snaps.length) return res.json(computeReport(customer, [], [], []));
    const ids = snaps.map(s => s.id);
    const orderLines = await query(
      `SELECT snapshot_id, item_number, ordered_qty, line_value FROM snapshot_order_lines WHERE snapshot_id = ANY($1)`, [ids]);
    const priLines = await query(
      `SELECT snapshot_id, item_number, description, start_date, qty FROM snapshot_priority_lines WHERE snapshot_id = ANY($1)`, [ids]);
    res.json(computeReport(customer, snaps, orderLines, priLines));
  } catch (err) {
    console.error('GET /push-pull/report error:', err.message);
    res.status(500).json({ error: 'Could not build the push/pull report.' });
  }
});

// POST /api/push-pull/snapshot  { customer, snapshotDate, orderBookB64, priorityB64 }
// Stores a weekly snapshot of both sheets AND refreshes the live order book.
router.post('/snapshot', validate(schemas.pushPullSnapshot), async (req, res) => {
  const { customer, snapshotDate } = req.body;
  let orderRows, priRows;
  try {
    orderRows = mapOrderBook(readSheet(Buffer.from(req.body.orderBookB64, 'base64')));
    priRows   = mapPriority(readSheet(Buffer.from(req.body.priorityB64, 'base64')));
  } catch (err) {
    console.error('push-pull parse error:', err.message);
    return res.status(400).json({ error: 'Could not read the spreadsheets. Are both files the KLA .xlsx exports?' });
  }
  if (!orderRows.length) return res.status(400).json({ error: 'No order-book rows found (need a "Part Number" column).' });
  if (!priRows.length)   return res.status(400).json({ error: 'No priority-requirement rows found (need a "Material" column).' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM demand_snapshots WHERE customer = $1 AND snapshot_date = $2', [customer, snapshotDate]);
    const snapId = uuidv4();
    const obValue = orderRows.reduce((t, r) => t + (r.value || 0), 0);
    await client.query(
      `INSERT INTO demand_snapshots (id, customer, snapshot_date, order_lines_count, priority_lines_count, order_book_value, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [snapId, customer, snapshotDate, orderRows.length, priRows.length, obValue, req.user.id]);
    for (const r of orderRows) {
      await client.query(
        `INSERT INTO snapshot_order_lines (id, snapshot_id, po_number, po_line, item_number, description, required_by, due_date, ordered_qty, bal_due_qty, line_value, rework)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [uuidv4(), snapId, r.poNumber || null, r.poLine || null, r.itemNumber, r.description || null,
         r.requiredBy || null, r.dueDate || null, r.orderedQty, r.balDueQty, r.value != null ? r.value : null, r.rework]);
    }
    for (const r of priRows) {
      await client.query(
        `INSERT INTO snapshot_priority_lines (id, snapshot_id, top_demand, wo_number, line_item, start_date, item_number, description, qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uuidv4(), snapId, r.topDemand || null, r.wo || null, r.lineItem || null, r.startDate || null,
         r.itemNumber, r.description || null, r.qty]);
    }
    // Refresh the live order book the Planner reads (managers may do this here).
    await client.query('DELETE FROM customer_orders WHERE customer = $1', [customer]);
    for (const r of orderRows) {
      await client.query(
        `INSERT INTO customer_orders (id, customer, po_number, po_line, item_number, description, required_by, due_date, quantity, line_value, rework, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [uuidv4(), customer, r.poNumber || null, r.poLine || null, r.itemNumber, r.description || null,
         r.requiredBy || null, r.dueDate || null, r.balDueQty, r.value != null ? r.value : null, r.rework, req.user.id]);
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, customer, snapshotDate, orderLines: orderRows.length, priorityLines: priRows.length });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /push-pull/snapshot error:', err.message);
    res.status(500).json({ error: 'Could not save the snapshot.' });
  } finally {
    client.release();
  }
});

// DELETE /api/push-pull/snapshot?customer=&date=  (manager+; remove one week)
router.delete('/snapshot', async (req, res) => {
  try {
    const { customer, date } = req.query;
    if (!customer || !date) return res.status(400).json({ error: 'customer and date are required.' });
    const del = await query('DELETE FROM demand_snapshots WHERE customer = $1 AND snapshot_date = $2 RETURNING id', [customer, date]);
    res.json({ ok: true, removed: del.length });
  } catch (err) {
    console.error('DELETE /push-pull/snapshot error:', err.message);
    res.status(500).json({ error: 'Could not delete the snapshot.' });
  }
});

module.exports = router;
