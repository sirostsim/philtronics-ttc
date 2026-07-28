/**
 * routes/planner.js -- forward work planning board.
 *
 * View (GET) is supervisor and above; create/update/delete is manager and above.
 * Duration is derived at read time: if the item has a target time the required
 * duration is target x quantity, otherwise the stored per-item estimate is used.
 * The end date for the Gantt is computed from the required minutes spread across
 * working days (see lib/planner-schedule).
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const settings = require('../settings');
const { plannedEndDate, plannedStartDate } = require('../lib/planner-schedule');

const router = express.Router();

// Everyone here is at least a supervisor; writes additionally require manager.
router.use(requireAuth, requireRole('supervisor'));

function startISOof(row) {
  return row.start_date instanceof Date
    ? row.start_date.toISOString().slice(0, 10)
    : String(row.start_date).slice(0, 10);
}

function isoDate(d) {
  if (d == null) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

// Compare an order-linked planned job to the CURRENT order book (lines keyed by
// "item||PO") and report drift. Matching key is item + PO + the required-date
// snapshot taken when the job was planned.
//   same date still present  -> unchanged (but check quantity)
//   date gone, item+PO still ordered -> requirement moved
//   no lines for item+PO at all      -> removed from the current order book
// ordersByKey undefined => skip drift entirely (e.g. the POST/PATCH response).
function computeDrift(row, ordersByKey) {
  const src = isoDate(row.source_required_by);
  if (!ordersByKey) return { drift: null, currentRequiredBy: src };
  if (!src || !row.wo_number) return { drift: null, currentRequiredBy: null };
  const lines = ordersByKey[row.item_number + '||' + row.wo_number] || [];
  if (!lines.length) return { drift: { type: 'removed', wasRequired: src }, currentRequiredBy: null };
  const exact = lines.find(l => l.eff === src);
  if (exact) {
    if (exact.qty !== row.quantity) {
      return { drift: { type: 'qty_changed', fromQty: row.quantity, toQty: exact.qty }, currentRequiredBy: src };
    }
    return { drift: null, currentRequiredBy: src };
  }
  const earliest = lines.map(l => l.eff).filter(Boolean).sort()[0] || null;
  return { drift: { type: 'date_moved', wasRequired: src, nowRequired: earliest }, currentRequiredBy: earliest };
}

// Shape a joined planned_work + target_times row for the client, deriving the
// required duration, the working-hours-aware end date, and any order-book drift.
function formatRow(row, s, ordersByKey) {
  const hasTarget = row.t_hours != null;
  const perItem   = hasTarget
    ? (row.t_hours * 60 + row.t_minutes)
    : (row.estimated_minutes != null ? row.estimated_minutes : null);
  const source    = hasTarget ? 'target' : (row.estimated_minutes != null ? 'estimate' : 'none');
  const total     = perItem != null ? perItem * row.quantity : null;
  const startISO  = startISOof(row);

  let endDate = startISO, workingDays = 0;
  if (total != null && total > 0) {
    const span = plannedEndDate(startISO, total, d => settings.productivityBaselineMinutes(s, d));
    endDate = span.endDate;
    workingDays = span.workingDays;
  }

  const { drift, currentRequiredBy } = computeDrift(row, ordersByKey);

  return {
    id:               row.id,
    itemNumber:       row.item_number,
    woNumber:         row.wo_number || null,
    startDate:        startISO,
    quantity:         row.quantity,
    department:       row.department || null,
    hasTarget,
    durationSource:   source,
    perItemMinutes:   perItem,
    totalMinutes:     total,
    estimatedMinutes: row.estimated_minutes,
    endDate,
    workingDays,
    sourceRequiredBy: isoDate(row.source_required_by),
    currentRequiredBy,
    drift,
    updatedAt:        row.updated_at,
  };
}

const JOIN_SQL =
  `SELECT p.*, tt.hours AS t_hours, tt.minutes AS t_minutes
   FROM planned_work p
   LEFT JOIN target_times tt ON tt.item_number = p.item_number`;

// Combine the request's estimate fields (hours + minutes) into total minutes,
// or null if none/zero given.
function estimateFromBody(b) {
  if (b.estimatedHours == null && b.estimatedMinutes == null) return null;
  const mins = (parseInt(b.estimatedHours, 10) || 0) * 60 + (parseInt(b.estimatedMinutes, 10) || 0);
  return mins > 0 ? mins : null;
}

// ── GET /api/planner/suggest-start ────────────────────────────────────────────
// MRP-style backward schedule: given a required (finish) date and the total
// required minutes, return the latest start date that still finishes on time.
// Used by the add form to default a start when planning an order-book item.
router.get('/suggest-start', async (req, res) => {
  try {
    const required = String(req.query.required || '');
    const minutes  = parseInt(req.query.minutes, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(required) || !(minutes > 0)) {
      return res.status(400).json({ error: 'A required date (YYYY-MM-DD) and positive minutes are needed.' });
    }
    const s = await settings.get();
    const span = plannedStartDate(required, minutes, d => settings.productivityBaselineMinutes(s, d));
    res.json({ startDate: span.startDate, workingDays: span.workingDays });
  } catch (err) {
    console.error('GET /planner/suggest-start error:', err.message);
    res.status(500).json({ error: 'Could not compute a suggested start.' });
  }
});

// ── GET /api/planner ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const s = await settings.get();
    const params = [];
    let where = '';
    if (req.query.department) { params.push(req.query.department); where = `WHERE p.department = $1`; }
    const rows = await query(
      `${JOIN_SQL} ${where} ORDER BY p.start_date ASC, p.created_at ASC`,
      params
    );

    // Drift: for the items on the board, fetch the CURRENT order lines and key
    // them by item||PO so each planned job can be compared to live demand.
    const items = [...new Set(rows.map(r => r.item_number))];
    const ordersByKey = {};
    if (items.length) {
      const orders = await query(
        `SELECT item_number, po_number, COALESCE(required_by, due_date) AS eff, quantity
         FROM customer_orders WHERE item_number = ANY($1) AND rework = FALSE`,
        [items]
      );
      for (const o of orders) {
        const key = o.item_number + '||' + (o.po_number || '');
        (ordersByKey[key] = ordersByKey[key] || []).push({ eff: isoDate(o.eff), qty: o.quantity });
      }
    }
    res.json(rows.map(r => formatRow(r, s, ordersByKey)));
  } catch (err) {
    console.error('GET /planner error:', err.message);
    res.status(500).json({ error: 'Could not load the planner.' });
  }
});

// ── POST /api/planner ── manager+ ─────────────────────────────────────────────
router.post('/', requireRole('manager'), validate(schemas.plannedWork), async (req, res) => {
  try {
    const b = req.body;
    const item = String(b.itemNumber).trim().toUpperCase();
    const estimate = estimateFromBody(b);
    const target = await queryOne('SELECT hours FROM target_times WHERE item_number = $1', [item]);
    if (!target && estimate == null) {
      return res.status(400).json({ error: 'This item has no target time, so an estimated time is required.' });
    }
    const id = uuidv4();
    await query(
      `INSERT INTO planned_work
         (id, item_number, wo_number, start_date, quantity, estimated_minutes, department,
          source_required_by, source_po_line, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [id, item, b.woNumber || null, b.startDate, b.quantity, estimate, b.department || null,
       b.sourceRequiredBy || null, b.sourcePoLine || null, req.user.id]
    );
    const s = await settings.get();
    const joined = await queryOne(`${JOIN_SQL} WHERE p.id = $1`, [id]);
    res.status(201).json(formatRow(joined, s));
  } catch (err) {
    console.error('POST /planner error:', err.message);
    res.status(500).json({ error: 'Could not add planned work.' });
  }
});

// ── PATCH /api/planner/:id ── manager+ ────────────────────────────────────────
router.patch('/:id', requireRole('manager'), validate(schemas.plannedWorkUpdate), async (req, res) => {
  try {
    const existing = await queryOne('SELECT * FROM planned_work WHERE id = $1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Planned item not found.' });

    const b = req.body;
    const item      = b.itemNumber ? String(b.itemNumber).trim().toUpperCase() : existing.item_number;
    const woNumber  = b.woNumber   !== undefined ? (b.woNumber || null)   : existing.wo_number;
    const startDate = b.startDate  || startISOof(existing);
    const quantity  = b.quantity   != null ? b.quantity : existing.quantity;
    const department = b.department !== undefined ? (b.department || null) : existing.department;
    // Estimate: recompute only if either estimate field was supplied.
    const estimate  = (b.estimatedHours != null || b.estimatedMinutes != null)
      ? estimateFromBody(b)
      : existing.estimated_minutes;

    const target = await queryOne('SELECT hours FROM target_times WHERE item_number = $1', [item]);
    if (!target && estimate == null) {
      return res.status(400).json({ error: 'This item has no target time, so an estimated time is required.' });
    }

    await query(
      `UPDATE planned_work
         SET item_number=$1, wo_number=$2, start_date=$3, quantity=$4,
             estimated_minutes=$5, department=$6, updated_at=NOW(), updated_by=$7
       WHERE id=$8`,
      [item, woNumber, startDate, quantity, estimate, department, req.user.id, req.params.id]
    );
    const s = await settings.get();
    const joined = await queryOne(`${JOIN_SQL} WHERE p.id = $1`, [req.params.id]);
    res.json(formatRow(joined, s));
  } catch (err) {
    console.error('PATCH /planner error:', err.message);
    res.status(500).json({ error: 'Could not update planned work.' });
  }
});

// ── DELETE /api/planner/:id ── manager+ ───────────────────────────────────────
router.delete('/:id', requireRole('manager'), async (req, res) => {
  try {
    await query('DELETE FROM planned_work WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /planner error:', err.message);
    res.status(500).json({ error: 'Could not delete planned work.' });
  }
});

// ── POST /api/planner/clear ── manager+ ── wipe the ENTIRE planner (destructive)
router.post('/clear', requireRole('manager'), async (req, res) => {
  try {
    const deleted = await query('DELETE FROM planned_work RETURNING id');
    const n = deleted.length;
    try { await writeAudit(null, 'planner_cleared', req.user.id, 'clear all', { cleared: n }); } catch (_) {}
    console.log(`[planner] ${req.user.username || req.user.id} cleared the planner (${n} jobs)`);
    res.json({ cleared: n });
  } catch (err) {
    console.error('POST /planner/clear error:', err.message);
    res.status(500).json({ error: 'Could not clear the planner.' });
  }
});

module.exports = router;
