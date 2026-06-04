/**
 * routes/availability.js – Operator self-declared (non-job) unavailability
 *
 * Covers the gaps a paused timer cannot reach: late start, left early, or
 * training/meeting with no job running. The operator declares themselves
 * unavailable with a reason; the period is excluded from their productivity
 * denominator exactly like a non-available pause (same unavailability_periods
 * table, source = 'manual').
 *
 * GET  /api/availability/me        – my current open manual period (or null)
 * POST /api/availability/start     – begin a manual unavailable period
 * POST /api/availability/end       – end my current manual period
 *
 * Manager+ endpoints for the reason list live in routes/admin-reasons.js.
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/availability/me ──────────────────────────────────────────────────
// The caller's current open manual unavailability period, if any.
router.get('/me', async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT id, reason_label, started_at
       FROM unavailability_periods
       WHERE operator_id = $1 AND source = 'manual' AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json(row
      ? { active: true, id: row.id, reasonLabel: row.reason_label, startedAt: row.started_at }
      : { active: false });
  } catch (e) {
    res.json({ active: false });
  }
});

// ── POST /api/availability/start ──────────────────────────────────────────────
// Body: { reasonId }. Only non-available reasons make sense here.
router.post('/start', async (req, res) => {
  try {
    const reasonId = req.body.reasonId;
    if (!reasonId) return res.status(400).json({ error: 'A reason is required.' });

    const ar = await queryOne(
      `SELECT id, label, is_available FROM availability_reasons WHERE id = $1 AND is_active = TRUE`,
      [reasonId]
    );
    if (!ar) return res.status(404).json({ error: 'Reason not found.' });
    if (ar.is_available !== false) {
      return res.status(400).json({ error: 'That reason still counts as working time and cannot be used here.' });
    }

    // Guard: don't open a second overlapping manual period.
    const existing = await queryOne(
      `SELECT id FROM unavailability_periods
       WHERE operator_id = $1 AND source = 'manual' AND ended_at IS NULL`,
      [req.user.id]
    );
    if (existing) {
      return res.status(409).json({ error: 'You are already marked unavailable. End that first.' });
    }

    const id = uuidv4();
    await query(
      `INSERT INTO unavailability_periods
         (id, operator_id, reason_id, reason_label, started_at, source, created_by)
       VALUES ($1, $2, $3, $4, NOW(), 'manual', $2)`,
      [id, req.user.id, ar.id, ar.label]
    );
    res.json({ ok: true, id, reasonLabel: ar.label });
  } catch (err) {
    console.error('Availability start error:', err.message);
    res.status(500).json({ error: 'Could not mark you unavailable.' });
  }
});

// ── POST /api/availability/end ────────────────────────────────────────────────
router.post('/end', async (req, res) => {
  try {
    const result = await query(
      `UPDATE unavailability_periods SET ended_at = NOW()
       WHERE operator_id = $1 AND source = 'manual' AND ended_at IS NULL
       RETURNING id`,
      [req.user.id]
    );
    res.json({ ok: true, ended: result.length });
  } catch (err) {
    console.error('Availability end error:', err.message);
    res.status(500).json({ error: 'Could not update your status.' });
  }
});

module.exports = router;
