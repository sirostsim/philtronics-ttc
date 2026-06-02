/**
 * routes/timechecks.js – Time Check target-review workflow
 *
 * GET    /api/time-checks/pending        – Manager+ : list pending reviews
 * POST   /api/time-checks/:id/apply      – Manager+ : set item target from this run
 * POST   /api/time-checks/:id/dismiss    – Manager+ : dismiss this review
 *
 * A "review" is a completed Time Check timer whose tc_review_status = 'pending'.
 * Applying sets/updates the target_times row for the item (optionally with a
 * manager-adjusted time) and supersedes any other pending reviews for the same
 * item. All outcomes are written to the audit log.
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('manager'));

async function writeAudit(timerId, action, performedBy, reason, details) {
  await query(
    `INSERT INTO audit_log (id, timer_id, action, performed_by, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv4(), timerId, action, performedBy, reason || null, details ? JSON.stringify(details) : null]
  );
}

// ── GET /api/time-checks/pending ──────────────────────────────────────────────
// Pending reviews, newest first, with the item's current target for context.
router.get('/pending', async (req, res) => {
  try {
    const rows = await query(
      `SELECT t.id, t.item_number, t.operator_name, t.duration_seconds, t.completed_at,
              tt.hours AS target_hours, tt.minutes AS target_minutes
       FROM timers t
       LEFT JOIN target_times tt ON tt.item_number = t.item_number
       WHERE t.tc_review_status = 'pending'
       ORDER BY t.completed_at DESC`
    );
    res.json(rows.map(r => ({
      timerId:              r.id,
      itemNumber:           r.item_number,
      operatorName:         r.operator_name,
      measuredSeconds:      r.duration_seconds,
      completedAt:          r.completed_at,
      currentTargetSeconds: r.target_hours != null
                              ? (r.target_hours * 3600) + (r.target_minutes * 60)
                              : null,
    })));
  } catch (err) {
    console.error('GET /time-checks/pending error:', err.message);
    res.status(500).json({ error: 'Could not load Time Check reviews.' });
  }
});

// ── POST /api/time-checks/:id/apply ───────────────────────────────────────────
// Body: { hours, minutes } – the (possibly adjusted) time to set as the target.
router.post('/:id/apply', async (req, res) => {
  try {
    const timer = await queryOne(
      `SELECT * FROM timers WHERE id = $1`, [req.params.id]
    );
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    if (timer.tc_review_status !== 'pending') {
      return res.status(409).json({ error: 'This Time Check has already been reviewed.' });
    }

    const h = parseInt(req.body.hours, 10);
    const m = parseInt(req.body.minutes, 10);
    if (isNaN(h) || h < 0 || h > 99)  return res.status(400).json({ error: 'Hours must be between 0 and 99.' });
    if (isNaN(m) || m < 0 || m > 59)  return res.status(400).json({ error: 'Minutes must be between 0 and 59.' });
    if (h === 0 && m === 0)           return res.status(400).json({ error: 'Target time must be greater than zero.' });

    const appliedSeconds = (h * 3600) + (m * 60);
    const item   = timer.item_number;
    const userId = req.user.id;

    // Previous target (for the audit trail)
    const prev = await queryOne(
      `SELECT hours, minutes FROM target_times WHERE item_number = $1`, [item]
    );
    const previousTargetSeconds = prev ? (prev.hours * 3600) + (prev.minutes * 60) : null;

    // Upsert the target time (mirrors routes/targets.js)
    await query(
      `INSERT INTO target_times (id, item_number, hours, minutes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (item_number) DO UPDATE SET
         hours = EXCLUDED.hours, minutes = EXCLUDED.minutes,
         updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [uuidv4(), item, h, m, userId]
    );

    // Mark this review applied
    await query(
      `UPDATE timers
       SET tc_review_status = 'applied', tc_reviewed_by = $1,
           tc_reviewed_at = NOW(), tc_applied_seconds = $2
       WHERE id = $3`,
      [userId, appliedSeconds, timer.id]
    );

    // Supersede any other pending reviews for the same item — the target is now set.
    const superseded = await query(
      `UPDATE timers
       SET tc_review_status = 'superseded', tc_reviewed_by = $1, tc_reviewed_at = NOW()
       WHERE item_number = $2 AND tc_review_status = 'pending' AND id <> $3
       RETURNING id`,
      [userId, item, timer.id]
    );

    await writeAudit(timer.id, 'target_set_from_timecheck', userId, null, {
      itemNumber:            item,
      measuredSeconds:       timer.duration_seconds,
      appliedSeconds,
      previousTargetSeconds,
      adjusted:              appliedSeconds !== timer.duration_seconds,
      supersededCount:       superseded.rows.length,
    });

    res.json({ ok: true, itemNumber: item, appliedSeconds, supersededCount: superseded.rows.length });
  } catch (err) {
    console.error('POST /time-checks/apply error:', err.message);
    res.status(500).json({ error: 'Could not set the target time.' });
  }
});

// ── POST /api/time-checks/:id/dismiss ─────────────────────────────────────────
router.post('/:id/dismiss', async (req, res) => {
  try {
    const timer = await queryOne(`SELECT * FROM timers WHERE id = $1`, [req.params.id]);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    if (timer.tc_review_status !== 'pending') {
      return res.status(409).json({ error: 'This Time Check has already been reviewed.' });
    }

    await query(
      `UPDATE timers
       SET tc_review_status = 'dismissed', tc_reviewed_by = $1, tc_reviewed_at = NOW()
       WHERE id = $2`,
      [req.user.id, timer.id]
    );
    await writeAudit(timer.id, 'timecheck_dismissed', req.user.id, null, {
      itemNumber:      timer.item_number,
      measuredSeconds: timer.duration_seconds,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /time-checks/dismiss error:', err.message);
    res.status(500).json({ error: 'Could not dismiss the Time Check review.' });
  }
});

module.exports = router;
