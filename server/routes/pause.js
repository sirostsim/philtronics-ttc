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
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const ROLE_LEVEL = { operator: 1, supervisor: 2, manager: 3, administrator: 4, superuser: 5 };
function roleLevel(role) { return ROLE_LEVEL[role] || 0; }

// ── GET /api/pause/reasons ────────────────────────────────────────────────────
// The managed list of pause / unavailability reasons for the pause dialog.
// is_available = false means the time is excluded from productivity availability.
router.get('/reasons', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, label, is_available
       FROM availability_reasons
       WHERE is_active = TRUE
       ORDER BY sort_order, label`
    );
    res.json(rows.map(r => ({ id: r.id, label: r.label, isAvailable: r.is_available })));
  } catch (e) {
    // Table not present yet — return a safe default so the UI still works.
    res.json([
      { id: null, label: 'Break',                 isAvailable: true  },
      { id: null, label: 'Waiting for materials', isAvailable: true  },
      { id: null, label: 'Other',                 isAvailable: true  },
    ]);
  }
});

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
    const reasonId  = req.body.reasonId || null;

    await query(
      `UPDATE timers SET paused_at = NOW(), pause_reason = $1, pause_type = $2,
       updated_at = NOW(), updated_by = $3 WHERE id = $4`,
      [reason, pauseType, req.user.id, timer.id]
    );

    // If this pause reason is flagged non-available (training, meeting, absence,
    // etc.), open an unavailability period so the time is excluded from the
    // operator's available-time denominator in productivity. Available-but-idle
    // reasons (break, waiting for materials) record nothing — they still count.
    if (reasonId) {
      try {
        const ar = await queryOne(
          `SELECT id, label, is_available FROM availability_reasons WHERE id = $1`,
          [reasonId]
        );
        if (ar && ar.is_available === false) {
          await query(
            `INSERT INTO unavailability_periods
               (id, operator_id, reason_id, reason_label, started_at, source, timer_id, created_by)
             VALUES ($1, $2, $3, $4, NOW(), 'pause', $5, $6)`,
            [uuidv4(), timer.operator_id, ar.id, ar.label, timer.id, req.user.id]
          );
        }
      } catch (e) {
        // availability_reasons table may not exist yet on first deploy — non-fatal
        console.error('Unavailability record (pause) skipped:', e.message);
      }
    }

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

    // Close any open (pause-sourced) unavailability period for this timer.
    try {
      await query(
        `UPDATE unavailability_periods
         SET ended_at = NOW()
         WHERE timer_id = $1 AND source = 'pause' AND ended_at IS NULL`,
        [timer.id]
      );
    } catch (e) {
      console.error('Unavailability close (resume) skipped:', e.message);
    }

    // If the operator is choosing to work overtime, mark the timer with
    // overtime_override so the schedule won't auto-pause it again tonight.
    // The override is cleared at the start of the next working day.
    const isOvertimeOverride = req.body?.overtimeOverride === true;
    const newPauseType = isOvertimeOverride ? 'overtime_override' : null;
    const newPauseReason = isOvertimeOverride ? 'Operator overtime — override active until next working day' : null;

    if (isOvertimeOverride) {
      // Resume but leave a marker so the schedule skips this timer
      await query(
        `UPDATE timers SET
           total_paused_seconds = total_paused_seconds +
             EXTRACT(EPOCH FROM (NOW() - paused_at))::int,
           paused_at    = NULL,
           pause_reason = $1,
           pause_type   = $2,
           updated_at   = NOW(),
           updated_by   = $3
         WHERE id = $4`,
        [newPauseReason, newPauseType, req.user.id, timer.id]
      );
    } else {
      // Normal resume — clear all pause fields
      await query(
        `UPDATE timers SET
           total_paused_seconds = total_paused_seconds +
             EXTRACT(EPOCH FROM (NOW() - paused_at))::int,
           paused_at    = NULL,
           pause_reason = NULL,
           pause_type   = NULL,
           updated_at   = NOW(),
           updated_by   = $1
         WHERE id = $2`,
        [req.user.id, timer.id]
      );
    }

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
