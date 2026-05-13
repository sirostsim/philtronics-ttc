/**
 * routes/auth.js – login, logout, /me
 */

'use strict';

const express    = require('express');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const db         = require('../db');
const { requireAuth }       = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');

const router = express.Router();

// Rate-limit login: configurable, default 10 per 15 min per IP
const loginLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              parseInt(process.env.LOGIN_RATE_LIMIT || '10', 10),
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many login attempts. Please wait 15 minutes.' },
  skipSuccessfulRequests: true,
});

const COOKIE_OPTS = {
  httpOnly:  true,
  sameSite:  'strict',
  secure:    process.env.NODE_ENV === 'production',
  maxAge:    8 * 60 * 60 * 1000, // 8 hours ms
};

// ─── POST /api/auth/login ────────────────────────────────────────────────────
router.post('/login', loginLimiter, validate(schemas.login), async (req, res) => {
  const { username, password } = req.body;

  const user = db.prepare(`
    SELECT * FROM users WHERE username = ? COLLATE NOCASE
  `).get(username);

  // Constant-time path: always hash-compare even if user not found
  const dummyHash = '$2b$12$invalidhashfortimingprotection0000000000000000000';
  const hash      = user ? user.password_hash : dummyHash;
  const match     = await bcrypt.compare(password, hash);

  if (!user || !match) {
    // Audit failed login (best-effort)
    if (user) {
      try {
        const { v4: uuidv4 } = require('uuid');
        db.prepare(`
          INSERT INTO audit_log (id, timer_id, action, performed_by, details)
          VALUES (?, NULL, 'login_fail', ?, ?)
        `).run(uuidv4(), user.id, JSON.stringify({ username }));
      } catch (_) {}
    }
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  if (!user.is_active) {
    return res.status(403).json({ error: 'Account is disabled. Contact your administrator.' });
  }

  const token = jwt.sign(
    { sub: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  res.cookie('token', token, COOKIE_OPTS);

  res.json({
    id:       user.id,
    username: user.username,
    fullName: user.full_name,
    role:     user.role,
  });
});

// ─── POST /api/auth/logout ───────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
  res.json({ ok: true });
});

// ─── GET /api/me ─────────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const u = req.user;

  // Check for any active timer for this user
  const active = db.prepare(`
    SELECT id, item_number, started_at FROM timers
    WHERE operator_id = ? AND status = 'active'
    LIMIT 1
  `).get(u.id);

  res.json({
    id:          u.id,
    username:    u.username,
    fullName:    u.full_name,
    role:        u.role,
    activeTimer: active || null,
  });
});

module.exports = router;
