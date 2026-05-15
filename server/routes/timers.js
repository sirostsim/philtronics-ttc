/**
 * routes/timers.js – timer CRUD (PostgreSQL version)
 */

'use strict';

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../db');
const { requireAuth, hasRole } = require('../middleware/auth');
const { validate, schemas }    = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth);

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function writeAudit(timerId, action, performedBy, reason, details) {
  await query(
    `INSERT INTO audit_log (id, timer_id, action, performed_by, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv4(), timerId, action, performedBy, reason || null, details ? JSON.stringify(details) : null]
  );
}

function formatTimer(t) {
  return {
    id:              t.id,
    itemNumber:      t.item_number,
    operatorId:      t.operator_id,
    operatorName:    t.operator_name,
    startedAt:       t.started_at,
    completedAt:     t.completed_at,
    durationSeconds: t.duration_seconds,
    status:          t.status,
    timeCheck:       !!t.time_check,
    workstation:     t.workstation,
    woNumber:        t.wo_number,
    notes:           t.notes,
    createdAt:       t.created_at,
    // Target time joined from target_times table (null if not set)
    targetSeconds:   t.target_hours != null
                       ? (t.target_hours * 3600) + (t.target_minutes * 60)
                       : null,
    targetHours:     t.target_hours   != null ? t.target_hours   : null,
    targetMinutes:   t.target_minutes != null ? t.target_minutes : null,
  };
}

// ─── POST /api/timers/start ───────────────────────────────────────────────────
router.post('/start', validate(schemas.startTimer), async (req, res) => {
  try {
    const { itemNumber, timeCheck, workstation, woNumber } = req.body;
    const user = req.user;

    const existing = await queryOne(
      `SELECT id FROM timers WHERE operator_id = $1 AND status = 'active' LIMIT 1`,
      [user.id]
    );
    if (existing) {
      return res.status(409).json({
        error: 'You already have an active timer running. Stop it before starting a new one.',
        activeTimerId: existing.id,
      });
    }

    const id        = uuidv4();
    const startedAt = new Date().toISOString();

    await query(
      `INSERT INTO timers (id, item_number, operator_id, operator_name, started_at, status, time_check, workstation, wo_number, created_by)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9)`,
      [id, itemNumber, user.id, user.full_name, startedAt, timeCheck || false, workstation || null, woNumber || null, user.id]
    );

    const timer = await queryOne('SELECT * FROM timers WHERE id = $1', [id]);
    res.status(201).json(formatTimer(timer));
  } catch (err) {
    // Unique constraint violation = race condition, two starts at same time
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already have an active timer running.' });
    }
    console.error('Start timer error:', err.message);
    res.status(500).json({ error: 'Could not start timer. Please try again.' });
  }
});

// ─── POST /api/timers/:id/stop ────────────────────────────────────────────────
router.post('/:id/stop', validate(schemas.stopTimer), async (req, res) => {
  try {
    const user  = req.user;
    const timer = await queryOne('SELECT * FROM timers WHERE id = $1', [req.params.id]);

    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    if (timer.status !== 'active') return res.status(409).json({ error: 'Timer is not active.' });
    if (timer.operator_id !== user.id && !hasRole(user, 'supervisor')) {
      return res.status(403).json({ error: "You cannot stop another operator's timer." });
    }

    const completedAt     = new Date().toISOString();
    const durationSeconds = Math.max(0, Math.round(
      (Date.now() - new Date(timer.started_at).getTime()) / 1000
    ));
    const { notes } = req.body;

    await query(
      `UPDATE timers
       SET completed_at = $1, duration_seconds = $2, status = 'completed',
           notes = COALESCE($3, notes), updated_at = NOW(), updated_by = $4
       WHERE id = $5`,
      [completedAt, durationSeconds, notes || null, user.id, timer.id]
    );

    const updated = await queryOne('SELECT * FROM timers WHERE id = $1', [timer.id]);
    res.json(formatTimer(updated));
  } catch (err) {
    console.error('Stop timer error:', err.message);
    res.status(500).json({ error: 'Could not stop timer. Please try again.' });
  }
});

// ─── POST /api/timers/:id/cancel ──────────────────────────────────────────────
router.post('/:id/cancel', validate(schemas.cancelTimer), async (req, res) => {
  try {
    const user  = req.user;
    const timer = await queryOne('SELECT * FROM timers WHERE id = $1', [req.params.id]);

    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    if (timer.status !== 'active') return res.status(409).json({ error: 'Timer is not active.' });

    const { reason } = req.body;
    const ageSeconds = Math.round((Date.now() - new Date(timer.started_at).getTime()) / 1000);

    if (ageSeconds > 60) {
      if (!hasRole(user, 'supervisor')) {
        return res.status(403).json({
          error: 'Timer is older than 60 seconds. Only a Supervisor or above can cancel it.',
        });
      }
    } else {
      if (timer.operator_id !== user.id && !hasRole(user, 'supervisor')) {
        return res.status(403).json({ error: "You cannot cancel another operator's timer." });
      }
    }

    await query(
      `UPDATE timers SET status = 'cancelled', updated_at = NOW(), updated_by = $1 WHERE id = $2`,
      [user.id, timer.id]
    );
    await writeAudit(timer.id, 'cancel', user.id, reason, { ageSeconds });

    res.json({ ok: true, timerId: timer.id });
  } catch (err) {
    console.error('Cancel timer error:', err.message);
    res.status(500).json({ error: 'Could not cancel timer. Please try again.' });
  }
});

// ─── PATCH /api/timers/:id ────────────────────────────────────────────────────
router.patch('/:id', validate(schemas.adjustTimer), async (req, res) => {
  if (!hasRole(req.user, 'supervisor')) {
    return res.status(403).json({ error: 'Only Supervisors and above can adjust timers.' });
  }
  try {
    const timer = await queryOne(
      `SELECT t.*, tt.hours AS target_hours, tt.minutes AS target_minutes
       FROM timers t
       LEFT JOIN target_times tt ON tt.item_number = t.item_number
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });

    const { startedAt, completedAt, reason, notes } = req.body;
    const newStart = startedAt   ? new Date(startedAt).toISOString()   : timer.started_at;
    const newEnd   = completedAt ? new Date(completedAt).toISOString() : timer.completed_at;

    let durationSeconds = timer.duration_seconds;
    if (newStart && newEnd) {
      durationSeconds = Math.round((new Date(newEnd) - new Date(newStart)) / 1000);
      if (durationSeconds < 0) {
        return res.status(400).json({ error: 'Adjusted times would produce a negative duration.' });
      }
    }

    const changes = {};
    if (startedAt)   changes.started_at   = { from: timer.started_at,   to: newStart };
    if (completedAt) changes.completed_at = { from: timer.completed_at, to: newEnd   };
    if (notes)       changes.notes        = { from: timer.notes,        to: notes    };

    await query(
      `UPDATE timers
       SET started_at = $1, completed_at = $2, duration_seconds = $3,
           notes = COALESCE($4, notes), updated_at = NOW(), updated_by = $5
       WHERE id = $6`,
      [newStart, newEnd, durationSeconds, notes || null, req.user.id, timer.id]
    );
    await writeAudit(timer.id, 'adjust', req.user.id, reason, changes);

    const updated = await queryOne('SELECT * FROM timers WHERE id = $1', [timer.id]);
    res.json(formatTimer(updated));
  } catch (err) {
    console.error('Adjust timer error:', err.message);
    res.status(500).json({ error: 'Could not adjust timer.' });
  }
});

// ─── GET /api/timers ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const user = req.user;
    const { from, to, operatorId, itemNumber, status, limit = 200 } = req.query;
    const isSupervisorPlus = hasRole(user, 'supervisor');

    const conditions = [];
    const params     = [];
    let   p          = 1;

    if (!isSupervisorPlus) {
      conditions.push(`t.operator_id = $${p++}`);
      params.push(user.id);
    } else if (operatorId) {
      conditions.push(`t.operator_id = $${p++}`);
      params.push(operatorId);
    }
    if (from) { conditions.push(`t.started_at >= $${p++}`); params.push(new Date(from).toISOString()); }
    if (to)   { conditions.push(`t.started_at <= $${p++}`); params.push(new Date(to).toISOString()); }
    if (itemNumber) {
      conditions.push(`t.item_number ILIKE $${p++}`);
      params.push(`%${itemNumber}%`);
    }
    if (status) { conditions.push(`t.status = $${p++}`); params.push(status); }

    const where    = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rowLimit = Math.min(parseInt(limit, 10) || 200, 1000);
    params.push(rowLimit);

    const rows = await query(
      `SELECT t.*, u.username,
              tt.hours AS target_hours, tt.minutes AS target_minutes
       FROM timers t
       LEFT JOIN users u ON u.id = t.operator_id
       LEFT JOIN target_times tt ON tt.item_number = t.item_number
       ${where}
       ORDER BY t.started_at DESC
       LIMIT $${p}`,
      params
    );

    res.json(rows.map(formatTimer));
  } catch (err) {
    console.error('List timers error:', err.message);
    res.status(500).json({ error: 'Could not load timers.' });
  }
});

// ─── GET /api/timers/:id ──────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const timer = await queryOne('SELECT * FROM timers WHERE id = $1', [req.params.id]);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });
    if (!hasRole(req.user, 'supervisor') && timer.operator_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    let auditTrail = [];
    if (hasRole(req.user, 'supervisor')) {
      auditTrail = await query(
        `SELECT a.*, u.full_name AS actor_name FROM audit_log a
         LEFT JOIN users u ON u.id = a.performed_by
         WHERE a.timer_id = $1 ORDER BY a.created_at DESC`,
        [timer.id]
      );
    }
    res.json({ ...formatTimer(timer), auditTrail });
  } catch (err) {
    res.status(500).json({ error: 'Could not load timer.' });
  }
});


// ─── DELETE /api/timers/:id ── Administrator only ─────────────────────────────
router.delete('/:id', async (req, res) => {
  if (!hasRole(req.user, 'administrator')) {
    return res.status(403).json({ error: 'Only Administrators can delete timer records.' });
  }
  try {
    const timer = await queryOne('SELECT * FROM timers WHERE id = $1', [req.params.id]);
    if (!timer) return res.status(404).json({ error: 'Timer not found.' });

    // Delete audit log entries for this timer first (foreign key)
    await query('DELETE FROM audit_log WHERE timer_id = $1', [timer.id]);
    // Delete the timer
    await query('DELETE FROM timers WHERE id = $1', [timer.id]);

    res.json({ ok: true, message: 'Timer record deleted.' });
  } catch (err) {
    console.error('Delete timer error:', err.message);
    res.status(500).json({ error: 'Could not delete timer.' });
  }
});

module.exports = router;
