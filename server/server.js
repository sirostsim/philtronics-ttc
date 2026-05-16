/**
 * server.js – Philtronics Time-to-Complete (PostgreSQL version)
 */

'use strict';

require('dotenv').config();

const path         = require('path');
const express      = require('express');
const cookieParser = require('cookie-parser');
const runMigrations = require('./migrations/runner');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;"
  );
  next();
});

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));

// /api/me — the frontend calls this path directly after login
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const active = await queryOne(
      `SELECT id, item_number, started_at, workstation, wo_number, status FROM timers
       WHERE operator_id = $1 AND status = 'active' LIMIT 1`,
      [u.id]
    );
    const activeTimer = active ? {
      id:          active.id,
      itemNumber:  active.item_number,
      startedAt:   active.started_at,
      workstation: active.workstation,
      woNumber:    active.wo_number,
      status:      active.status,
    } : null;
    res.json({
      id: u.id, username: u.username, fullName: u.full_name,
      role: u.role, totpEnabled: !!u.totp_enabled, activeTimer,
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load user data.' });
  }
});
app.use('/api/totp',     require('./routes/totp'));
app.use('/api/timers',   require('./routes/timers'));
app.use('/api/export',   require('./routes/export'));
app.use('/api/users',    require('./routes/users'));
app.use('/api/targets',  require('./routes/targets'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/pause',    require('./routes/pause'));

// Item-master autocomplete
const { query }       = require('./db');
const { requireAuth } = require('./middleware/auth');

app.get('/api/items', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const rows = await query(
      `SELECT item_number, description FROM item_master
       WHERE is_active = TRUE AND item_number ILIKE $1
       ORDER BY item_number LIMIT 20`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Could not load items.' });
  }
});

// ─── Static frontend ──────────────────────────────────────────────────────────
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found.' });
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ─── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({
    error: 'An unexpected server error occurred.',
    ...(process.env.NODE_ENV !== 'production' && { detail: err.message }),
  });
});

// ─── Boot: run migrations then start listening ────────────────────────────────
runMigrations()
  .then(() => {
    const { startSchedule } = require('./schedule');
    startSchedule();
    app.listen(PORT, () => {
      console.log(`✅  Philtronics Time-to-Complete running on port ${PORT}`);
      console.log(`    Environment : ${process.env.NODE_ENV || 'development'}`);
      console.log(`    Database    : PostgreSQL (${process.env.DATABASE_URL ? 'connected' : 'NO URL SET'})`);
    });
  })
  .catch(err => {
    console.error('❌  Failed to run migrations:', err.message);
    process.exit(1);
  });
