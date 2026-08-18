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
const { computeReport } = require('../lib/xlsx-demand');

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

    // Push/Pull impact: summarise the most recent week-over-week demand change
    // from the archived KLA snapshots, so the report can evidence to the customer
    // the effect their re-prioritisation has on our order book. Best-effort: with
    // fewer than two snapshots (or the feature unused) it is simply omitted.
    let pushPull = null;
    try {
      const snaps = await query(
        `SELECT id, snapshot_date, order_lines_count, priority_lines_count, order_book_value
           FROM demand_snapshots WHERE customer = $1 ORDER BY snapshot_date ASC`, [customer]);
      if (snaps.length >= 2) {
        const ids = snaps.map(s => s.id);
        const orderLines = await query(
          `SELECT snapshot_id, item_number, ordered_qty, line_value FROM snapshot_order_lines WHERE snapshot_id = ANY($1)`, [ids]);
        const priLines = await query(
          `SELECT snapshot_id, item_number, description, start_date, qty FROM snapshot_priority_lines WHERE snapshot_id = ANY($1)`, [ids]);
        const rep = computeReport(customer, snaps, orderLines, priLines);
        const t  = rep.transitions[rep.transitions.length - 1];
        const pw = rep.perWeek;
        if (t) {
          const obTo   = pw.length     ? pw[pw.length - 1].orderBookValue : 0;
          const obFrom = pw.length >= 2 ? pw[pw.length - 2].orderBookValue : 0;
          pushPull = {
            from: t.from, to: t.to,
            pullIn:  Math.round(t.sums.pullIn),  pullInN:  t.sums.pullInN,
            pushOut: Math.round(t.sums.pushOut), pushOutN: t.sums.pushOutN,
            added:   Math.round(t.sums.added),   addedN:   t.sums.addedN,
            dropped: Math.round(t.sums.dropped), droppedN: t.sums.droppedN,
            obValueFrom: Math.round(obFrom), obValueTo: Math.round(obTo), obValueDelta: Math.round(obTo - obFrom),
          };
        }
      }
    } catch (e) {
      if (!/relation .*(demand_snapshots|snapshot_).* does not exist/i.test(e.message)) {
        console.error('order-book report push/pull summary skipped:', e.message);
      }
    }

    res.json({ customer, horizon, generatedAt: new Date().toISOString().slice(0, 10), summary, pushPull, lines });
  } catch (err) {
    console.error('GET /order-book/report error:', err.message);
    res.status(500).json({ error: 'Could not build the order book report.' });
  }
});

// ── GET /api/order-book/upload-impact ── manager+ ─────────────────────────────
// Compares the two most recent archived order-book snapshots (from the weekly
// Push/Pull upload) to evidence what the latest upload changed in the available
// work, and how much SCHEDULED build value (order lines that carry planner jobs)
// it disturbs. Returns null when there are fewer than two snapshots. Feeds the
// internal planning report.
router.get('/upload-impact', requireRole('manager'), async (req, res) => {
  try {
    const customer = req.query.customer || 'KLA';
    const snaps = await query(
      `SELECT id, snapshot_date FROM demand_snapshots WHERE customer = $1 ORDER BY snapshot_date DESC LIMIT 2`, [customer]);
    if (snaps.length < 2) return res.json(null);
    const [cur, prev] = snaps;
    const cols = 'item_number, po_number, po_line, description, bal_due_qty, line_value, COALESCE(required_by, due_date) AS eff';
    const curLines  = await query(`SELECT ${cols} FROM snapshot_order_lines WHERE snapshot_id = $1`, [cur.id]);
    const prevLines = await query(`SELECT ${cols} FROM snapshot_order_lines WHERE snapshot_id = $1`, [prev.id]);

    const keyOf = r => r.item_number + '||' + (r.po_number || '') + '||' + (r.po_line || '');
    const curMap = {}, prevMap = {};
    for (const r of curLines)  curMap[keyOf(r)]  = r;
    for (const r of prevLines) prevMap[keyOf(r)] = r;

    const added = [], removed = [], changed = [];
    for (const k of new Set([...Object.keys(curMap), ...Object.keys(prevMap)])) {
      const c = curMap[k], p = prevMap[k];
      const cv = c && c.line_value != null ? Number(c.line_value) : 0;
      const pv = p && p.line_value != null ? Number(p.line_value) : 0;
      if (c && !p)      added.push({ key: k, item: c.item_number, po: c.po_number, description: c.description, value: cv, qty: c.bal_due_qty });
      else if (!c && p) removed.push({ key: k, item: p.item_number, po: p.po_number, description: p.description, value: pv, qty: p.bal_due_qty, unit: (p.bal_due_qty > 0 ? pv / p.bal_due_qty : 0) });
      else if (c && p) {
        const qd = (c.bal_due_qty || 0) - (p.bal_due_qty || 0);
        const vd = cv - pv;
        const dateMoved = isoOf(c.eff) !== isoOf(p.eff);
        if (qd !== 0 || Math.abs(vd) > 0.005 || dateMoved)
          changed.push({ key: k, item: c.item_number, po: c.po_number, description: c.description, fromQty: p.bal_due_qty, toQty: c.bal_due_qty, valueDelta: vd, dateFrom: isoOf(p.eff), dateTo: isoOf(c.eff), unit: (c.bal_due_qty > 0 ? cv / c.bal_due_qty : 0) });
      }
    }
    added.sort((a, b) => b.value - a.value);
    removed.sort((a, b) => b.value - a.value);
    changed.sort((a, b) => Math.abs(b.valueDelta) - Math.abs(a.valueDelta));

    // Planned-value impact: which of the removed/changed lines carry planner jobs,
    // and how much scheduled build value (order value x planned share) they hold.
    let planned = { disturbedValue: 0, disturbedN: 0, lines: [] };
    const items = [...new Set([...removed, ...changed].map(a => a.item))];
    if (items.length) {
      const jobs = await query(
        `SELECT item_number, wo_number, source_po_line, SUM(quantity) AS planned_qty
           FROM planned_work WHERE item_number = ANY($1)
          GROUP BY item_number, wo_number, source_po_line`, [items]);
      const plannedByKey = {};
      for (const j of jobs) plannedByKey[j.item_number + '||' + (j.wo_number || '') + '||' + (j.source_po_line || '')] = Number(j.planned_qty) || 0;
      const affected = [];
      for (const a of removed) {
        const pq = plannedByKey[a.key]; if (!pq) continue;
        affected.push({ item: a.item, po: a.po, description: a.description, change: 'removed', plannedQty: pq, plannedValue: Math.round((a.unit || 0) * pq) });
      }
      for (const a of changed) {
        const pq = plannedByKey[a.key]; if (!pq) continue;
        const change = a.toQty < a.fromQty ? 'reduced' : (a.dateFrom !== a.dateTo ? 'rescheduled' : 'changed');
        affected.push({ item: a.item, po: a.po, description: a.description, change, plannedQty: pq, plannedValue: Math.round((a.unit || 0) * pq), dateFrom: a.dateFrom, dateTo: a.dateTo });
      }
      affected.sort((x, y) => y.plannedValue - x.plannedValue);
      planned = { disturbedValue: affected.reduce((t, l) => t + l.plannedValue, 0), disturbedN: affected.length, lines: affected.slice(0, 15) };
    }

    const addedValue   = Math.round(added.reduce((t, a) => t + a.value, 0));
    const removedValue = Math.round(removed.reduce((t, a) => t + a.value, 0));
    const changedDelta = Math.round(changed.reduce((t, a) => t + a.valueDelta, 0));
    res.json({
      from: isoOf(prev.snapshot_date), to: isoOf(cur.snapshot_date),
      order: {
        added:   { count: added.length,   value: addedValue,   lines: added.slice(0, 12) },
        removed: { count: removed.length, value: removedValue, lines: removed.slice(0, 12) },
        changed: { count: changed.length, valueDelta: changedDelta, lines: changed.slice(0, 12) },
        netDelta: addedValue - removedValue + changedDelta,
      },
      planned,
    });
  } catch (e) {
    if (/relation .*(demand_snapshots|snapshot_).* does not exist/i.test(e.message)) return res.json(null);
    console.error('GET /order-book/upload-impact error:', e.message);
    res.status(500).json({ error: 'Could not compute the upload impact.' });
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
