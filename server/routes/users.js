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

function safeUser(u) {
  return {
    id: u.id, username: u.username, fullName: u.full_name,
    role: u.role, isActive: u.is_active,
    createdAt: u.created_at, updatedAt: u.updated_at,
  };
}

// GET /api/users
router.get('/', async (req, res) => {
  try {
    const users = await query('SELECT * FROM users ORDER BY role, full_name');
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
    const { username, password, full_name, role } = req.body;
    const existing = await queryOne(
      'SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [username]
    );
    if (existing) return res.status(409).json({ error: 'Username already taken.' });

    const id   = uuidv4();
    const hash = await bcrypt.hash(password, ROUNDS());
    await query(
      `INSERT INTO users (id, username, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, username, hash, full_name, role]
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

    const { full_name, role, is_active } = req.body;
    await query(
      `UPDATE users
       SET full_name  = COALESCE($1, full_name),
           role       = COALESCE($2, role),
           is_active  = COALESCE($3, is_active),
           updated_at = NOW()
       WHERE id = $4`,
      [full_name ?? null, role ?? null, is_active ?? null, user.id]
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

module.exports = router;
