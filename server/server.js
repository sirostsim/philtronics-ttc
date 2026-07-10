/**
 * server.js – Philtronics Time-to-Complete (PostgreSQL version)
 */

'use strict';

require('dotenv').config();

const path          = require('path');
const express       = require('express');
const cookieParser  = require('cookie-parser');
const runMigrations = require('./migrations/runner');
const { query, queryOne } = require('./db');
const { requireAuth }     = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use('/api/avatars', express.json({ limit: '6mb' }));
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
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://pub-e170f0c1f48f4ebf9b7bf2adc7d8c0a9.r2.dev;"
  );
  next();
});

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/config',   require('./routes/config'));
app.use('/api/settings', require('./routes/settings'));

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
app.use('/api/avatars',  require('./routes/avatars'));
app.use('/api/targets',  require('./routes/targets'));
app.use('/api/time-checks', require('./routes/timechecks'));
app.use('/api/availability', require('./routes/availability'));
app.use('/api/admin/reasons', require('./routes/admin-reasons'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/pause',    require('./routes/pause'));
app.use('/api/dev-requests', require('./routes/dev-requests'));

// Item-master autocomplete
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
  .then(async () => {
    await seedSuperuser();
    await require('./settings').load(); // warm the per-instance settings cache
    const { startSchedule } = require('./schedule');
    startSchedule();
    app.listen(PORT, () => {
      console.log(`✅  Work Time running on port ${PORT}`);
      console.log(`    Environment : ${process.env.NODE_ENV || 'development'}`);
      console.log(`    Database    : PostgreSQL (${process.env.DATABASE_URL ? 'connected' : 'NO URL SET'})`);
    });
  })
  .catch(err => {
    console.error('❌  Failed to run migrations:', err.message);
    process.exit(1);
  });

async function seedSuperuser() {
  const username = process.env.SU_USERNAME;
  const password = process.env.SU_PASSWORD;
  const fullName = process.env.SU_FULL_NAME || 'SRS Support';

  if (!username || !password) {
    // No SU configured — skip silently (not required for existing deployments)
    return;
  }

  try {
    const { queryOne, query } = require('./db');
    const bcrypt = require('bcrypt');
    const { v4: uuidv4 } = require('uuid');

    const existing = await queryOne(
      `SELECT id FROM users WHERE role = 'superuser' AND LOWER(username) = LOWER($1)`,
      [username]
    );

    if (!existing) {
      const hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS || '12', 10));
      await query(
        `INSERT INTO users (id, username, password_hash, full_name, role, department, is_active)
         VALUES ($1, $2, $3, $4, 'superuser', 'Production', TRUE)
         ON CONFLICT (username) DO NOTHING`,
        [uuidv4(), username, hash, fullName]
      );
      console.log(`✅  Superuser account '${username}' created.`);
    } else {
      // Update password if it has changed
      const bcrypt = require('bcrypt');
      const su = await queryOne(`SELECT password_hash FROM users WHERE id = $1`, [existing.id]);
      const match = await bcrypt.compare(password, su.password_hash);
      if (!match) {
        const hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS || '12', 10));
        await query(
          `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
          [hash, existing.id]
        );
        console.log(`✅  Superuser '${username}' password updated from env.`);
      }
    }
  } catch (err) {
    console.error('⚠️  Superuser seed failed:', err.message);
  }
}

