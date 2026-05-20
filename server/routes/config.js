/**
 * routes/config.js — site-wide configuration (key/value store)
 * GET  /api/config/:key       — any authenticated user
 * PUT  /api/config/:key       — administrator only
 */

'use strict';

const express = require('express');
const { query, queryOne } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const ALLOWED_KEYS = ['productivity_target_pct'];

// GET /api/config/:key
router.get('/:key', async (req, res) => {
  const { key } = req.params;
  if (!ALLOWED_KEYS.includes(key)) return res.status(404).json({ error: 'Unknown config key.' });
  try {
    const row = await queryOne('SELECT value FROM config WHERE key = $1', [key]);
    res.json({ key, value: row ? row.value : null });
  } catch (err) {
    res.status(500).json({ error: 'Could not read config.' });
  }
});

// PUT /api/config/:key  (admin only)
router.put('/:key', requireRole('administrator'), async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  if (!ALLOWED_KEYS.includes(key)) return res.status(404).json({ error: 'Unknown config key.' });
  if (value == null) return res.status(400).json({ error: 'Value is required.' });

  // Validate per key
  if (key === 'productivity_target_pct') {
    const n = parseInt(value, 10);
    if (isNaN(n) || n < 1 || n > 100) return res.status(400).json({ error: 'Target must be between 1 and 100.' });
  }

  try {
    await query(
      `INSERT INTO config (key, value, updated_at, updated_by) VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
      [key, String(value), req.user.id]
    );
    res.json({ key, value: String(value) });
  } catch (err) {
    res.status(500).json({ error: 'Could not update config.' });
  }
});

module.exports = router;
