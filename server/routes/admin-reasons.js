/**
 * routes/admin-reasons.js – Manage the availability/pause reason list (Manager+)
 *
 * GET    /api/admin/reasons         – list all reasons (incl. inactive)
 * POST   /api/admin/reasons         – create a reason
 * PATCH  /api/admin/reasons/:id     – update label / is_available / sort / active
 *
 * Reasons are never hard-deleted (historic unavailability rows reference them);
 * deactivating with is_active = false simply hides them from the pickers.
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('manager'));

router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, label, is_available, sort_order, is_active
       FROM availability_reasons ORDER BY sort_order, label`
    );
    res.json(rows.map(r => ({
      id: r.id, label: r.label, isAvailable: r.is_available,
      sortOrder: r.sort_order, isActive: r.is_active,
    })));
  } catch (e) {
    console.error('List reasons error:', e.message);
    res.status(500).json({ error: 'Could not load reasons.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const label = (req.body.label || '').trim();
    const isAvailable = req.body.isAvailable === true;
    const sortOrder = Number.isInteger(req.body.sortOrder) ? req.body.sortOrder : 100;
    if (!label) return res.status(400).json({ error: 'A label is required.' });
    if (label.length > 60) return res.status(400).json({ error: 'Label must be 60 characters or fewer.' });

    const dupe = await queryOne(`SELECT id FROM availability_reasons WHERE LOWER(label) = LOWER($1)`, [label]);
    if (dupe) return res.status(409).json({ error: 'A reason with that label already exists.' });

    const id = 'avr_' + uuidv4().slice(0, 8);
    await query(
      `INSERT INTO availability_reasons (id, label, is_available, sort_order, is_active)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [id, label, isAvailable, sortOrder]
    );
    res.json({ ok: true, id });
  } catch (e) {
    console.error('Create reason error:', e.message);
    res.status(500).json({ error: 'Could not create reason.' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const existing = await queryOne(`SELECT * FROM availability_reasons WHERE id = $1`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Reason not found.' });

    const sets = [];
    const params = [];
    let p = 1;

    if (typeof req.body.label === 'string') {
      const label = req.body.label.trim();
      if (!label) return res.status(400).json({ error: 'Label cannot be empty.' });
      if (label.length > 60) return res.status(400).json({ error: 'Label must be 60 characters or fewer.' });
      const dupe = await queryOne(
        `SELECT id FROM availability_reasons WHERE LOWER(label) = LOWER($1) AND id <> $2`,
        [label, req.params.id]
      );
      if (dupe) return res.status(409).json({ error: 'Another reason already uses that label.' });
      sets.push(`label = $${p++}`); params.push(label);
    }
    if (typeof req.body.isAvailable === 'boolean') { sets.push(`is_available = $${p++}`); params.push(req.body.isAvailable); }
    if (Number.isInteger(req.body.sortOrder))      { sets.push(`sort_order = $${p++}`);  params.push(req.body.sortOrder); }
    if (typeof req.body.isActive === 'boolean')    { sets.push(`is_active = $${p++}`);   params.push(req.body.isActive); }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    params.push(req.params.id);
    await query(`UPDATE availability_reasons SET ${sets.join(', ')} WHERE id = $${p}`, params);
    res.json({ ok: true });
  } catch (e) {
    console.error('Update reason error:', e.message);
    res.status(500).json({ error: 'Could not update reason.' });
  }
});

module.exports = router;
