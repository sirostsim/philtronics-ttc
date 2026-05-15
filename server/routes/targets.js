/**
 * routes/targets.js – Target time management
 * Available to managers and administrators only.
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// All routes require manager or above
router.use(requireAuth);
router.use(requireRole('manager'));

// ── GET /api/targets ─────────────────────────────────────────────────────────
// Returns all target times ordered by item number
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, item_number, hours, minutes, updated_at, updated_by
       FROM target_times
       ORDER BY item_number ASC`
    );
    res.json(rows.map(formatTarget));
  } catch (err) {
    console.error('GET /targets error:', err.message);
    res.status(500).json({ error: 'Could not load target times.' });
  }
});

// ── GET /api/targets/:itemNumber ─────────────────────────────────────────────
router.get('/:itemNumber', async (req, res) => {
  try {
    const row = await queryOne(
      'SELECT * FROM target_times WHERE item_number = $1',
      [req.params.itemNumber]
    );
    if (!row) return res.status(404).json({ error: 'No target time for this item.' });
    res.json(formatTarget(row));
  } catch (err) {
    res.status(500).json({ error: 'Could not load target time.' });
  }
});

// ── POST /api/targets ────────────────────────────────────────────────────────
// Create or update (upsert) a target time for an item number
router.post('/', async (req, res) => {
  try {
    const { itemNumber, hours, minutes } = req.body;
    if (!itemNumber || typeof itemNumber !== 'string') {
      return res.status(400).json({ error: 'Item Number is required.' });
    }
    if (!/^[A-Za-z0-9\-_]{1,40}$/.test(itemNumber.trim())) {
      return res.status(400).json({ error: 'Item Number contains invalid characters.' });
    }
    const h = parseInt(hours, 10);
    const m = parseInt(minutes, 10);
    if (isNaN(h) || h < 0 || h > 99) {
      return res.status(400).json({ error: 'Hours must be between 0 and 99.' });
    }
    if (isNaN(m) || m < 0 || m > 59) {
      return res.status(400).json({ error: 'Minutes must be between 0 and 59.' });
    }
    if (h === 0 && m === 0) {
      return res.status(400).json({ error: 'Target time must be greater than zero.' });
    }

    const userId = req.user.id;
    const item   = itemNumber.trim().toUpperCase();

    // Upsert — insert or update if item number already exists
    const row = await queryOne(
      `INSERT INTO target_times (id, item_number, hours, minutes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (item_number) DO UPDATE SET
         hours      = EXCLUDED.hours,
         minutes    = EXCLUDED.minutes,
         updated_at = NOW(),
         updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [uuidv4(), item, h, m, userId]
    );

    res.json(formatTarget(row));
  } catch (err) {
    console.error('POST /targets error:', err.message);
    res.status(500).json({ error: 'Could not save target time.' });
  }
});

// ── DELETE /api/targets/:itemNumber ──────────────────────────────────────────
router.delete('/:itemNumber', async (req, res) => {
  try {
    await query(
      'DELETE FROM target_times WHERE item_number = $1',
      [req.params.itemNumber]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete target time.' });
  }
});

function formatTarget(t) {
  return {
    id:         t.id,
    itemNumber: t.item_number,
    hours:      t.hours,
    minutes:    t.minutes,
    totalSeconds: (t.hours * 3600) + (t.minutes * 60),
    updatedAt:  t.updated_at,
  };
}

module.exports = router;
