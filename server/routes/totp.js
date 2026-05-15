/**
 * routes/totp.js – TOTP two-factor authentication
 *
 * Flow:
 *   1. POST /api/totp/setup   → generate secret + QR code (requires full auth)
 *   2. POST /api/totp/confirm → verify first code to enable TOTP
 *   3. POST /api/totp/verify  → verify code during mid-login challenge
 *   4. DELETE /api/totp/reset → admin resets another user's TOTP
 */

'use strict';

const express    = require('express');
const crypto     = require('crypto');
const { authenticator } = require('otplib');
const QRCode     = require('qrcode');
const { query, queryOne } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const ROLES_REQUIRING_TOTP = ['manager', 'administrator'];

// ── POST /api/totp/setup ─────────────────────────────────────────────────────
// Generates a new TOTP secret and QR code for the logged-in user.
// The secret is stored but TOTP is NOT enabled until they confirm a code.
router.post('/setup', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!ROLES_REQUIRING_TOTP.includes(user.role)) {
      return res.status(403).json({ error: 'Two-factor authentication is not required for your role.' });
    }

    const secret = authenticator.generateSecret();

    // Store secret (not yet enabled)
    await query(
      'UPDATE users SET totp_secret = $1, totp_enabled = FALSE WHERE id = $2',
      [secret, user.id]
    );

    // Generate QR code data URL
    const otpauth = authenticator.keyuri(user.username, 'Work Time', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth, {
      width: 240,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });

    res.json({ secret, qrDataUrl });
  } catch (err) {
    console.error('TOTP setup error:', err.message);
    res.status(500).json({ error: 'Could not generate two-factor setup.' });
  }
});

// ── POST /api/totp/confirm ───────────────────────────────────────────────────
// Verifies the first code after scanning the QR, then enables TOTP.
router.post('/confirm', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Please enter the 6-digit code from your authenticator app.' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user.totp_secret) {
      return res.status(400).json({ error: 'No setup in progress. Please start setup again.' });
    }
    if (user.totp_enabled) {
      return res.status(400).json({ error: 'Two-factor authentication is already enabled.' });
    }

    const valid = authenticator.verify({ token: code, secret: user.totp_secret });
    if (!valid) {
      return res.status(400).json({ error: 'Incorrect code. Check your authenticator app and try again.' });
    }

    await query('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [user.id]);
    res.json({ ok: true, message: 'Two-factor authentication enabled successfully.' });
  } catch (err) {
    console.error('TOTP confirm error:', err.message);
    res.status(500).json({ error: 'Could not enable two-factor authentication.' });
  }
});

// ── POST /api/totp/verify ────────────────────────────────────────────────────
// Called during login — verifies a TOTP code against a challenge token.
// Returns a full JWT cookie on success.
router.post('/verify', async (req, res) => {
  try {
    const { challengeToken, code } = req.body;
    if (!challengeToken || !code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Invalid request.' });
    }

    // Look up the challenge
    const challenge = await queryOne(
      `SELECT * FROM totp_challenges
       WHERE token = $1 AND expires_at > NOW()`,
      [challengeToken]
    );
    if (!challenge) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    // Get the user
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [challenge.user_id]);
    if (!user || !user.totp_enabled || !user.totp_secret) {
      return res.status(401).json({ error: 'Two-factor authentication not configured.' });
    }

    // Verify the code
    const valid = authenticator.verify({ token: code, secret: user.totp_secret });
    if (!valid) {
      return res.status(401).json({ error: 'Incorrect code. Please try again.' });
    }

    // Delete the used challenge (single-use)
    await query('DELETE FROM totp_challenges WHERE id = $1', [challenge.id]);

    // Also clean up any expired challenges while we're here
    await query('DELETE FROM totp_challenges WHERE expires_at < NOW()').catch(() => {});

    // Issue full JWT cookie
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { sub: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    const COOKIE_OPTS = {
      httpOnly: true,
      sameSite: 'strict',
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   8 * 60 * 60 * 1000,
    };
    res.cookie('token', token, COOKIE_OPTS);

    // Check for active timer
    const active = await queryOne(
      `SELECT id, item_number, started_at, workstation, wo_number, status
       FROM timers WHERE operator_id = $1 AND status = 'active' LIMIT 1`,
      [user.id]
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
      id: user.id, username: user.username,
      fullName: user.full_name, role: user.role,
      totpEnabled: true,   // they just passed TOTP — always true at this point
      activeTimer,
    });
  } catch (err) {
    console.error('TOTP verify error:', err.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ── DELETE /api/totp/reset/:userId ───────────────────────────────────────────
// Administrator resets another user's TOTP (e.g. lost phone).
router.delete('/reset/:userId', requireAuth, requireRole('administrator'), async (req, res) => {
  try {
    const target = await queryOne('SELECT * FROM users WHERE id = $1', [req.params.userId]);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    await query(
      'UPDATE users SET totp_secret = NULL, totp_enabled = FALSE WHERE id = $1',
      [target.id]
    );

    res.json({ ok: true, message: `Two-factor authentication reset for ${target.username}.` });
  } catch (err) {
    console.error('TOTP reset error:', err.message);
    res.status(500).json({ error: 'Could not reset two-factor authentication.' });
  }
});

module.exports = router;
module.exports.ROLES_REQUIRING_TOTP = ROLES_REQUIRING_TOTP;
