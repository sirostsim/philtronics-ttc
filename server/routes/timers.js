/**
 * routes/timers.js – timer CRUD with RBAC, audit, business rules
 */

'use strict';

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db');
const { requireAuth, hasRole } = require('../middleware/auth');
const { validate, schemas }    = require('../middleware/validate');

const router = express.Router();

// All timer routes require authentication
router.use(requireAuth);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeAudit(timerId, action, performedBy, reason, details) {
  db.prepare(`
    INSERT INTO audit_log (id, timer_id, action, performed_by, reason, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), timerId, action, performedBy, reason || null, details ? JSON.stringify(details) : null);
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
    notes:           t.notes,
    createdAt:       t.created_at,
  };
}

// ─── POST /api/timers/start ──────────────────────────────────────────────────
router.post('/start', validate(schemas.startTimer), (req, res) => {
  const { itemNumber, notes } = req.body;
  const user = req.user;

  // Prevent multiple active timers per operator
  const existing = db.prepare(`
    SELECT id FROM timers WHERE operator_id = ? AND status = 'active' LIMIT 1
  `).get(user.id);

  if (existing) {
    return res.status(409).json({
      error: 'You already have an active timer running. Stop it before starting a new one.',
      activeTimerId: existing.id,
    });
  }

  const id        = uuidv4();
  const startedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO timers (id, item_number, operator_id, operator_name, started_at, status, notes, created_by)
    VALUES (@id, @item_number, @operator_id, @operator_name, @started_at, 'active', @notes, @created_by)
  `).run({
    id,
    item_number:   itemNumber,
    operator_id:   user.id,
    operator_name: user.full_name,
    started_at:    startedAt,
    notes:         notes || null,
    created_by:    user.id,
  });

  const timer = db.prepare('SELECT * FROM timers WHERE id = ?').get(id);
  res.status(201).json(formatTimer(timer));
});

// ─── POST /api/timers/:id/stop ───────────────────────────────────────────────
router.post('/:id/stop', validate(schemas.stopTimer), (req, res) => {
  const user  = req.user;
  const timer = db.prepare('SELECT * FROM timers WHERE id = ?').get(req.params.id);

  if (!timer) return res.status(404).json({ error: 'Timer not found.' });
  if (timer.status !== 'active') return res.status(409).json({ error: 'Timer is not active.' });

  // Operators can only stop their own timers; Supervisor+ can stop any
  if (timer.operator_id !== user.id && !hasRole(user, 'supervisor')) {
    return res.status(403).json({ error: 'You cannot stop another operator\'s timer.' });
  }

  const completedAt      = new Date().toISOString();
  const startMs          = new Date(timer.started_at).getTime();
  const durationSeconds  = Math.round((Date.now() - startMs) / 1000);

  if (durationSeconds < 0) {
    return res.status(400).json({ error: 'Invalid timer state: negative duration.' });
  }

  const { notes } = req.body;

  db.prepare(`
    UPDATE timers
    SET completed_at = @completed_at,
        duration_seconds = @duration_seconds,
        status = 'completed',
        notes = COALESCE(@notes, notes),
        updated_at = datetime('now'),
        updated_by = @updated_by
    WHERE id = @id
  `).run({
    completed_at:     completedAt,
    duration_seconds: durationSeconds,
    notes:            notes || null,
    updated_by:       user.id,
    id:               timer.id,
  });

  const updated = db.prepare('SELECT * FROM timers WHERE id = ?').get(timer.id);
  res.json(formatTimer(updated));
});

// ─── POST /api/timers/:id/cancel ─────────────────────────────────────────────
router.post('/:id/cancel', validate(schemas.cancelTimer), (req, res) => {
  const user  = req.user;
  const timer = db.prepare('SELECT * FROM timers WHERE id = ?').get(req.params.id);

  if (!timer) return res.status(404).json({ error: 'Timer not found.' });
  if (timer.status !== 'active') return res.status(409).json({ error: 'Timer is not active.' });

  const { reason } = req.body;
  const ageSeconds = Math.round((Date.now() - new Date(timer.started_at).getTime()) / 1000);

  // Within 60 s: operator can cancel their own; Supervisor+ can cancel any
  // After  60 s: only Supervisor+ can cancel (with mandatory reason already required by schema)
  if (ageSeconds > 60) {
    if (!hasRole(user, 'supervisor')) {
      return res.status(403).json({
        error: 'Timer is older than 60 seconds. Only a Supervisor or above can cancel it.',
      });
    }
  } else {
    // Within 60 s – operator can only cancel their own
    if (timer.operator_id !== user.id && !hasRole(user, 'supervisor')) {
      return res.status(403).json({ error: 'You cannot cancel another operator\'s timer.' });
    }
  }

  db.prepare(`
    UPDATE timers
    SET status = 'cancelled', updated_at = datetime('now'), updated_by = @updated_by
    WHERE id = @id
  `).run({ updated_by: user.id, id: timer.id });

  writeAudit(timer.id, 'cancel', user.id, reason, { ageSeconds });

  res.json({ ok: true, timerId: timer.id });
});

// ─── PATCH /api/timers/:id – adjust times (Supervisor+) ─────────────────────
router.patch('/:id', validate(schemas.adjustTimer), (req, res) => {
  if (!hasRole(req.user, 'supervisor')) {
    return res.status(403).json({ error: 'Only Supervisors and above can adjust timers.' });
  }

  const timer = db.prepare('SELECT * FROM timers WHERE id = ?').get(req.params.id);
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
  if (startedAt)   changes.started_at    = { from: timer.started_at,    to: newStart };
  if (completedAt) changes.completed_at  = { from: timer.completed_at,  to: newEnd };
  if (notes)       changes.notes         = { from: timer.notes,         to: notes };

  db.prepare(`
    UPDATE timers
    SET started_at = @started_at,
        completed_at = @completed_at,
        duration_seconds = @duration_seconds,
        notes = COALESCE(@notes, notes),
        updated_at = datetime('now'),
        updated_by = @updated_by
    WHERE id = @id
  `).run({
    started_at:       newStart,
    completed_at:     newEnd,
    duration_seconds: durationSeconds,
    notes:            notes || null,
    updated_by:       req.user.id,
    id:               timer.id,
  });

  writeAudit(timer.id, 'adjust', req.user.id, reason, changes);

  const updated = db.prepare('SELECT * FROM timers WHERE id = ?').get(timer.id);
  res.json(formatTimer(updated));
});

// ─── GET /api/timers ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const user = req.user;
  const { from, to, operatorId, itemNumber, status, limit = 200 } = req.query;

  // Operators see only their own data
  const isSupervisorPlus = hasRole(user, 'supervisor');

  const conditions = [];
  const params     = [];

  if (!isSupervisorPlus) {
    conditions.push('t.operator_id = ?');
    params.push(user.id);
  } else if (operatorId) {
    conditions.push('t.operator_id = ?');
    params.push(operatorId);
  }

  if (from) {
    conditions.push("t.started_at >= ?");
    params.push(new Date(from).toISOString());
  }
  if (to) {
    conditions.push("t.started_at <= ?");
    params.push(new Date(to).toISOString());
  }
  if (itemNumber) {
    conditions.push("t.item_number LIKE ? COLLATE NOCASE");
    params.push(`%${itemNumber}%`);
  }
  if (status) {
    conditions.push("t.status = ?");
    params.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows  = db.prepare(`
    SELECT t.*, u.username
    FROM timers t
    LEFT JOIN users u ON u.id = t.operator_id
    ${where}
    ORDER BY t.started_at DESC
    LIMIT ?
  `).all([...params, Math.min(parseInt(limit, 10) || 200, 1000)]);

  res.json(rows.map(formatTimer));
});

// ─── GET /api/timers/:id ─────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const timer = db.prepare('SELECT * FROM timers WHERE id = ?').get(req.params.id);
  if (!timer) return res.status(404).json({ error: 'Timer not found.' });

  // Operators can only see own timers
  if (!hasRole(req.user, 'supervisor') && timer.operator_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  // Include audit trail for Supervisor+
  let auditTrail = [];
  if (hasRole(req.user, 'supervisor')) {
    auditTrail = db.prepare(`
      SELECT a.*, u.full_name as actor_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.performed_by
      WHERE a.timer_id = ?
      ORDER BY a.created_at DESC
    `).all(timer.id);
  }

  res.json({ ...formatTimer(timer), auditTrail });
});

module.exports = router;
