/**
 * routes/users.js – user management
 */

'use strict';

const express  = require('express');
const bcrypt   = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../db');
const { requireAuth, requireRole, hasRole, canAssignRole } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');

const router = express.Router();

// All user management requires at minimum administrator
router.use(requireAuth, requireRole('administrator'));

const ROUNDS = () => parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const DEPARTMENTS = ['Production', 'Stores', 'Test and Inspection', 'PCB'];

function safeUser(u) {
  return {
    id:           u.id,
    username:     u.username,
    fullName:     u.full_name,
    role:         u.role,
    isActive:     u.is_active,
    department:   u.department || 'Production',
    totpEnabled:  !!u.totp_enabled,
    createdAt:    u.created_at,
    updatedAt:    u.updated_at,
  };
}

// GET /api/users
// Admins see everyone except superusers. Superusers see everyone.
router.get('/', async (req, res) => {
  try {
    const isSU = req.user.role === 'superuser';
    const rows = await query(
      isSU
        ? `SELECT * FROM users ORDER BY role, full_name`
        : `SELECT * FROM users WHERE role != 'superuser' ORDER BY department, role, full_name`
    );
    res.json(rows.map(safeUser));
  } catch (err) {
    res.status(500).json({ error: 'Could not load users.' });
  }
});

// GET /api/users/:id
router.get('/:id', async (req, res) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    // Admins cannot view superuser accounts
    if (user.role === 'superuser' && req.user.role !== 'superuser') {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    res.json(safeUser(user));
  } catch (err) {
    res.status(500).json({ error: 'Could not load user.' });
  }
});

// POST /api/users
router.post('/', validate(schemas.createUser), async (req, res) => {
  try {
    const { username, password, full_name, role, department } = req.body;

    // Enforce role assignment permissions
    if (!canAssignRole(req.user.role, role)) {
      return res.status(403).json({
        error: `Your role cannot create users with role '${role}'.`,
      });
    }

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
    const target = await queryOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    // Admins cannot edit superuser accounts
    if (target.role === 'superuser' && req.user.role !== 'superuser') {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }

    const { full_name, role, is_active, department } = req.body;

    // If role is being changed, enforce assignment permissions
    if (role && !canAssignRole(req.user.role, role)) {
      return res.status(403).json({
        error: `Your role cannot assign role '${role}'.`,
      });
    }

    // Prevent demoting/editing another superuser unless you're also a superuser
    if (target.role === 'superuser' && req.user.id !== target.id && req.user.role !== 'superuser') {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }

    const dept = department && DEPARTMENTS.includes(department) ? department : null;
    await query(
      `UPDATE users
       SET full_name  = COALESCE($1, full_name),
           role       = COALESCE($2, role),
           is_active  = COALESCE($3, is_active),
           department = COALESCE($4, department),
           updated_at = NOW()
       WHERE id = $5`,
      [full_name ?? null, role ?? null, is_active ?? null, dept, target.id]
    );
    const updated = await queryOne('SELECT * FROM users WHERE id = $1', [target.id]);
    res.json(safeUser(updated));
  } catch (err) {
    res.status(500).json({ error: 'Could not update user.' });
  }
});

// POST /api/users/:id/reset-password
router.post('/:id/reset-password', validate(schemas.resetPassword), async (req, res) => {
  try {
    const target = await queryOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.role === 'superuser' && req.user.role !== 'superuser') {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    const hash = await bcrypt.hash(req.body.password, ROUNDS());
    await query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, target.id]
    );
    res.json({ ok: true, message: `Password reset for ${target.username}.` });
  } catch (err) {
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

// POST /api/users/admin/cancel-stuck-timers
router.post('/admin/cancel-stuck-timers', async (req, res) => {
  try {
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
