/**
 * routes/users.js – user management (Administrator only)
 */

'use strict';

const express  = require('express');
const bcrypt   = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, schemas }        = require('../middleware/validate');

const router = express.Router();

// All user management requires Administrator role
router.use(requireAuth, requireRole('administrator'));

const ROUNDS = () => parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

function safeUser(u) {
  return {
    id:        u.id,
    username:  u.username,
    fullName:  u.full_name,
    role:      u.role,
    isActive:  !!u.is_active,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
  };
}

// ─── GET /api/users ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const users = db.prepare(`
    SELECT * FROM users ORDER BY role, full_name
  `).all();
  res.json(users.map(safeUser));
});

// ─── GET /api/users/:id ──────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json(safeUser(user));
});

// ─── POST /api/users ─────────────────────────────────────────────────────────
router.post('/', validate(schemas.createUser), async (req, res) => {
  const { username, password, full_name, role } = req.body;

  const existing = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (existing) return res.status(409).json({ error: 'Username already taken.' });

  const id   = uuidv4();
  const hash = await bcrypt.hash(password, ROUNDS());

  db.prepare(`
    INSERT INTO users (id, username, password_hash, full_name, role)
    VALUES (@id, @username, @hash, @full_name, @role)
  `).run({ id, username, hash, full_name, role });

  const created = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.status(201).json(safeUser(created));
});

// ─── PATCH /api/users/:id ────────────────────────────────────────────────────
router.patch('/:id', validate(schemas.updateUser), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const { full_name, role, is_active } = req.body;

  db.prepare(`
    UPDATE users
    SET full_name  = COALESCE(@full_name,  full_name),
        role       = COALESCE(@role,       role),
        is_active  = COALESCE(@is_active,  is_active),
        updated_at = datetime('now')
    WHERE id = @id
  `).run({
    full_name: full_name   ?? null,
    role:      role        ?? null,
    is_active: is_active != null ? (is_active ? 1 : 0) : null,
    id:        user.id,
  });

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json(safeUser(updated));
});

// ─── POST /api/users/:id/reset-password ──────────────────────────────────────
router.post('/:id/reset-password', validate(schemas.resetPassword), async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const hash = await bcrypt.hash(req.body.password, ROUNDS());

  db.prepare(`
    UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
  `).run(hash, user.id);

  res.json({ ok: true, message: `Password reset for ${user.username}.` });
});

module.exports = router;
