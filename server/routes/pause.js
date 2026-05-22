/**
 * routes/pause.js -- Timer pause/resume endpoints
 *
 * POST /api/pause/:timerId/pause   -- pause a timer
 * POST /api/pause/:timerId/resume  -- resume a timer
 *
 * Operators can pause/resume their own timers.
 * Supervisors+ can pause/resume any timer.
 */

'use strict';

const express = require('express');
const { query, queryOne } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const ROLE_LEVEL = { operator: 1, supervisor: 2, manager: 3, administrator: 4, superuser: 5 };
function roleLevel(role) { return ROLE_LEVEL[role] || 0; }

// ── POST /api/pause/:timerId/pause ────────────────────────────────────────────
router.post('/:timerId/pause', async (req, res) => {
  try {
    const timer = await queryOne(
      `SELECT * FROM timers WHERE id = $1 AND status = 'active'`,
      [req.params.timerId]
    );
    if (!timer) return res.status(404).json({ error: 'Active timer not found.' });

    // Operators can only pause their own timer
    if (roleLevel(req.user.role) < roleLevel('supervisor') &&
        timer.operator_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only pause your own timer.' });
    }

    if (timer.paused_at) {
      return res.status(409).json({ error: 'Timer is already paused.' });
    }

    const reason    = req.body.reason || 'Manual pause';
    const pauseType = req.body.pauseType || 'manual';

    await query(
      `UPDATE timers SET paused_at = NOW(), pause_reason = $1, pause_type = $2,
       updated_at = NOW(), updated_by = $3 WHERE id = $4`,
      [reason, pauseType, req.user.id, timer.id]
    );

    const updated = await queryOne('SELECT * FROM timers WHERE id = $1', [timer.id]);
    res.json(formatTimer(updated));
  } catch (err) {
    console.error('Pause error:', err.message);
    res.status(500).json({ error: 'Could not pause timer.' });
  }
});

// ── POST /api/pause/:timerId/resume ───────────────────────────────────────────
router.post('/:timerId/resume', async (req, res) => {
  try {
    const timer = await queryOne(
      `SELECT * FROM timers WHERE id = $1 AND status = 'active'`,
      [req.params.timerId]
    );
    if (!timer) return res.status(404).json({ error: 'Active timer not found.' });

    if (roleLevel(req.user.role) < roleLevel('supervisor') &&
        timer.operator_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only resume your own timer.' });
    }

    if (!timer.paused_at) {
      return res.status(409).json({ error: 'Timer is not paused.' });
    }

    // Accumulate paused time
    await query(
      `UPDATE timers SET
         total_paused_seconds = total_paused_seconds +
           EXTRACT(EPOCH FROM (NOW() - paused_at))::int,
         paused_at   = NULL,
         pause_reason = NULL,
         pause_type   = NULL,
         updated_at   = NOW(),
         updated_by   = $1
       WHERE id = $2`,
      [req.user.id, timer.id]
    );

    const updated = await queryOne('SELECT * FROM timers WHERE id = $1', [timer.id]);
    res.json(formatTimer(updated));
  } catch (err) {
    console.error('Resume error:', err.message);
    res.status(500).json({ error: 'Could not resume timer.' });
  }
});

function formatTimer(t) {
  const now = Date.now();
  const startedMs = new Date(t.started_at).getTime();
  const pausedMs  = t.paused_at ? new Date(t.paused_at).getTime() : now;
  const rawElapsed = Math.floor((pausedMs - startedMs) / 1000);
  const netElapsed = Math.max(0, rawElapsed - (t.total_paused_seconds || 0));
  return {
    id:                   t.id,
    itemNumber:           t.item_number,
    operatorId:           t.operator_id,
    operatorName:         t.operator_name,
    startedAt:            t.started_at,
    completedAt:          t.completed_at,
    durationSeconds:      t.duration_seconds,
    status:               t.status,
    isPaused:             !!t.paused_at,
    pausedAt:             t.paused_at,
    pauseReason:          t.pause_reason,
    pauseType:            t.pause_type,
    totalPausedSeconds:   t.total_paused_seconds || 0,
    netElapsedSeconds:    netElapsed,
    timeCheck:            !!t.time_check,
    workstation:          t.workstation,
    woNumber:             t.wo_number,
    targetSeconds:        t.target_hours != null
                            ? (t.target_hours * 3600) + (t.target_minutes * 60)
                            : null,
  };
}

module.exports = router;
