/**
 * server.js – Philtronics Time-to-Complete
 * Express server: serves static frontend + REST API.
 */

'use strict';

require('dotenv').config();

const path         = require('path');
const express      = require('express');
const cookieParser = require('cookie-parser');

// ─── Run migrations on startup ───────────────────────────────────────────────
require('./migrations/runner');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Core middleware ─────────────────────────────────────────────────────────
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Relaxed CSP: allows inline scripts/styles for the vanilla-JS single-page app
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;"
  );
  next();
});

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',   require('./routes/auth'));
app.use('/api/timers', require('./routes/timers'));
app.use('/api/export', require('./routes/export'));
app.use('/api/users',  require('./routes/users'));

// Item-master autocomplete (no separate router needed)
const db = require('./db');
const { requireAuth } = require('./middleware/auth');

app.get('/api/items', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  const rows = db.prepare(`
    SELECT item_number, description FROM item_master
    WHERE is_active = 1
      AND item_number LIKE ? COLLATE NOCASE
    ORDER BY item_number
    LIMIT 20
  `).all(`%${q}%`);
  res.json(rows);
});

// ─── Serve static frontend ────────────────────────────────────────────────────
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// SPA fallback – any non-API route returns index.html
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found.' });
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ─── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isDev = process.env.NODE_ENV !== 'production';
  console.error('[ERROR]', err.message);
  res.status(500).json({
    error: 'An unexpected server error occurred.',
    ...(isDev && { detail: err.message }),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  Philtronics Time-to-Complete running on port ${PORT}`);
  console.log(`    Environment : ${process.env.NODE_ENV || 'development'}`);
  console.log(`    Database    : ${process.env.DB_PATH || './data/philtronics.db'}`);
});
