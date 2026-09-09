/**
 * routes/my-work.js -- an operative's personal work board.
 *
 * Any authenticated user may call this; it returns ONLY the planned jobs assigned
 * to the calling user (via planned_work_assignees). Deliberately light: no order
 * book, no drift, no commercial value -- just the task info an operative needs.
 * The duration/end-date derivation matches the Planner (shared lib/planner-schedule).
 */

'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const settings = require('../settings');
const { plannedEndDate } = require('../lib/planner-schedule');

const router = express.Router();
router.use(requireAuth);

function isoDate(d) {
  if (d == null) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

// ── GET /api/my-work ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const s = await settings.get();
    const rows = await query(
      `SELECT p.*, tt.hours AS t_hours, tt.minutes AS t_minutes
       FROM planned_work_assignees a
       JOIN planned_work p ON p.id = a.planned_work_id
       LEFT JOIN target_times tt ON tt.item_number = p.item_number
       WHERE a.user_id = $1
       ORDER BY p.start_date ASC, p.created_at ASC`,
      [req.user.id]
    );
    const items = rows.map(r => {
      const hasTarget = r.t_hours != null;
      const perItem   = hasTarget
        ? (r.t_hours * 60 + r.t_minutes)
        : (r.estimated_minutes != null ? r.estimated_minutes : null);
      const source    = hasTarget ? 'target' : (r.estimated_minutes != null ? 'estimate' : 'none');
      const total     = perItem != null ? perItem * r.quantity : null;
      const startISO  = isoDate(r.start_date);
      let endDate = startISO, workingDays = 0;
      if (total != null && total > 0) {
        const span = plannedEndDate(startISO, total, d => settings.productivityBaselineMinutes(s, d));
        endDate = span.endDate;
        workingDays = span.workingDays;
      }
      return {
        id:             r.id,
        itemNumber:     r.item_number,
        woNumber:       r.wo_number || null,
        worksOrder:     r.works_order || null,
        startDate:      startISO,
        quantity:       r.quantity,
        department:     r.department || null,
        durationSource: source,
        totalMinutes:   total,
        endDate,
        workingDays,
      };
    });
    res.json({ items });
  } catch (err) {
    console.error('GET /my-work error:', err.message);
    res.status(500).json({ error: 'Could not load your work.' });
  }
});

module.exports = router;
