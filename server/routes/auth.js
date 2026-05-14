/**
 * routes/auth.js – login, logout, /me  (PostgreSQL version)
 */

'use strict';

const express   = require('express');
const bcrypt    = require('bcrypt');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { query, queryOne } = require('../db');
const { requireAuth }       = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
  skipSuccessfulRequests: true,
});

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure:   process.env.NODE_ENV === 'production',
  maxAge:   8 * 60 * 60 * 1000,
};

// ─── POST /api/auth/login ────────────────────────────────────────────────────
router.post('/login', loginLimiter, validate(schemas.login), async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await queryOne(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]
    );

    const dummyHash = '$2b$12$invalidhashfortimingprotection0000000000000000000';
    const hash      = user ? user.password_hash : dummyHash;
    const match     = await bcrypt.compare(password, hash);

    if (!user || !match) {
      if (user) {
        const { v4: uuidv4 } = require('uuid');
        await query(
          `INSERT INTO audit_log (id, timer_id, action, performed_by, details)
           VALUES ($1, NULL, 'login_fail', $2, $3)`,
          [uuidv4(), user.id, JSON.stringify({ username })]
        ).catch(() => {});
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
    res.json({ id: user.id, username: user.username, fullName: user.full_name, role: user.role });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─── POST /api/auth/logout ───────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
  res.json({ ok: true });
});

// ─── GET /api/me ─────────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const active = await queryOne(
      `SELECT id, item_number, started_at FROM timers
       WHERE operator_id = $1 AND status = 'active' LIMIT 1`,
      [u.id]
    );
    res.json({
      id: u.id, username: u.username, fullName: u.full_name,
      role: u.role, activeTimer: active || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load user data.' });
  }
});

module.exports = router;