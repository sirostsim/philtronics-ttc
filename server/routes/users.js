/**
 * routes/users.js – user management (PostgreSQL version)
 */

'use strict';

const express  = require('express');
const bcrypt   = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, schemas }        = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth, requireRole('administrator'));

const ROUNDS = () => parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

const DEPARTMENTS = ['Production', 'Stores', 'Test and Inspection'];

function safeUser(u) {
  return {
    id: u.id, username: u.username, fullName: u.full_name,
    role: u.role, isActive: u.is_active,
    department: u.department || 'Production',
    totpEnabled: !!u.totp_enabled,
    createdAt: u.created_at, updatedAt: u.updated_at,
  };
}

// GET /api/users
router.get('/', async (req, res) => {
  try {
    const users = await query('SELECT * FROM users ORDER BY department, role, full_name');
    res.json(users.map(safeUser));
  } catch (err) {
    res.status(500).json({ error: 'Could not load users.' });
  }
});

// GET /api/users/:id
router.get('/:id', async (req, res) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json(safeUser(user));
  } catch (err) {
    res.status(500).json({ error: 'Could not load user.' });
  }
});

// POST /api/users
router.post('/', validate(schemas.createUser), async (req, res) => {
  try {
    const { username, password, full_name, role, department } = req.body;
    const dept = DEPARTMENTS.includes(department) ? department : 'Production';

    const existing = await queryOne(
      'SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [username]
    );
    if (existing) return res.status(409).json({ error: 'Username already taken.' });

    const id   = uuidv4();
    const hash = await bcrypt.hash(password, ROUNDS());
    await query(
      `INSERT INTO users (id, username, password_hash, full_name, role, department)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, username, hash, full_name, role, dept]
    );
    const created = await queryOne('SELECT * FROM users WHERE id = $1', [id]);
    res.status(201).json(safeUser(created));
  } catch (err) {
    console.error('Create user error:', err.message);
    res.status(500).json({ error: 'Could not create user.' });
  }
});

// PATCH /api/users/:id
router.patch('/:id', validate(schemas.updateUser), async (req, res) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const { full_name, role, is_active, department } = req.body;
    const dept = department && DEPARTMENTS.includes(department) ? department : null;
    await query(
      `UPDATE users
       SET full_name   = COALESCE($1, full_name),
           role        = COALESCE($2, role),
           is_active   = COALESCE($3, is_active),
           department  = COALESCE($4, department),
           updated_at  = NOW()
       WHERE id = $5`,
      [full_name ?? null, role ?? null, is_active ?? null, dept, user.id]
    );
    const updated = await queryOne('SELECT * FROM users WHERE id = $1', [user.id]);
    res.json(safeUser(updated));
  } catch (err) {
    res.status(500).json({ error: 'Could not update user.' });
  }
});

// POST /api/users/:id/reset-password
router.post('/:id/reset-password', validate(schemas.resetPassword), async (req, res) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const hash = await bcrypt.hash(req.body.password, ROUNDS());
    await query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, user.id]
    );
    res.json({ ok: true, message: `Password reset for ${user.username}.` });
  } catch (err) {
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

// POST /api/users/admin/cancel-stuck-timers
router.post('/admin/cancel-stuck-timers', async (req, res) => {
  try {
    const { v4: uuidv4 } = require('uuid');
    const reason = (req.body && req.body.reason) || 'Cancelled by administrator via emergency tool';
    const active = await query('SELECT * FROM timers WHERE status = $1', ['active']);
    if (active.length === 0) {
      return res.json({ ok: true, cancelled: 0, message: 'No active timers found.' });
    }
    for (const timer of active) {
      await query(
        'UPDATE timers SET status = $1, updated_at = NOW(), updated_by = $2 WHERE id = $3',
        ['cancelled', req.user.id, timer.id]
      );
      await query(
        'INSERT INTO audit_log (id, timer_id, action, performed_by, reason, details) VALUES ($1,$2,$3,$4,$5,$6)',
        [uuidv4(), timer.id, 'cancel', req.user.id, reason,
         JSON.stringify({ source: 'emergency_cancel', operator_id: timer.operator_id })]
      );
    }
    res.json({ ok: true, cancelled: active.length,
      message: active.length + ' stuck timer(s) cancelled successfully.' });
  } catch (err) {
    console.error('Cancel stuck timers error:', err.message);
    res.status(500).json({ error: 'Could not cancel timers.' });
  }
});

module.exports = router;
