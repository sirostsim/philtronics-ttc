/**
 * routes/portal.js  (mounted at /api/portal)
 *
 * External customer-portal API. Phase 3 Step 1: authentication only (accept an
 * invite, log in, log out, me). Everything here is for EXTERNAL users and uses
 * requirePortal / the portal cookie; it never touches internal auth. Later steps
 * add the scoped RFQ endpoints. See docs/crm-portal-plan.md.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, getClient } = require('../db');
const { validate, schemas } = require('../middleware/validate');
const { requirePortal, signPortalToken, PORTAL_COOKIE, PORTAL_COOKIE_OPTS } = require('../middleware/portal-auth');

const router = express.Router();
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const DUMMY_HASH = '$2b$12$invalidhashfortimingprotection0000000000000000000';

// POST /api/portal/auth/accept-invite { token, password, fullName? }
router.post('/auth/accept-invite', validate(schemas.portalAcceptInvite), async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const inv = (await client.query('SELECT * FROM portal_invites WHERE token_hash = $1 FOR UPDATE', [sha256(req.body.token)])).rows[0];
    if (!inv || inv.accepted_at || new Date(inv.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This invite link is invalid or has expired.' });
    }
    const email = String(inv.email).trim().toLowerCase();
    const hash = await bcrypt.hash(req.body.password, 12);
    const name = (req.body.fullName && req.body.fullName.trim()) || inv.full_name || null;
    let pu = (await client.query('SELECT * FROM portal_users WHERE email = $1', [email])).rows[0];
    if (pu) {
      // Existing account for this email keeps its original customer binding (one
      // email = one portal account); we just (re)set the password.
      await client.query('UPDATE portal_users SET password_hash = $1, full_name = COALESCE($2, full_name), is_active = TRUE WHERE id = $3', [hash, name, pu.id]);
    } else {
      const id = uuidv4();
      await client.query('INSERT INTO portal_users (id, customer_id, email, password_hash, full_name, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, inv.customer_id, email, hash, name, inv.invited_by]);
      pu = { id, customer_id: inv.customer_id, email, full_name: name };
    }
    await client.query('UPDATE portal_invites SET accepted_at = NOW() WHERE id = $1', [inv.id]);
    await client.query('COMMIT');
    res.cookie(PORTAL_COOKIE, signPortalToken(pu), PORTAL_COOKIE_OPTS);
    res.json({ id: pu.id, email: pu.email, fullName: pu.full_name || null });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /portal/auth/accept-invite error:', err.message);
    res.status(500).json({ error: 'Could not accept the invite.' });
  } finally {
    client.release();
  }
});

// POST /api/portal/auth/login { email, password }
router.post('/auth/login', validate(schemas.portalLogin), async (req, res) => {
  try {
    const email = String(req.body.email).trim().toLowerCase();
    const pu = await queryOne('SELECT * FROM portal_users WHERE email = $1', [email]);
    const match = await bcrypt.compare(req.body.password, (pu && pu.password_hash) ? pu.password_hash : DUMMY_HASH);
    if (!pu || !pu.password_hash || !match) return res.status(401).json({ error: 'Invalid email or password.' });
    if (!pu.is_active) return res.status(403).json({ error: 'Account is disabled. Contact Philtronics.' });
    await query('UPDATE portal_users SET last_login_at = NOW() WHERE id = $1', [pu.id]).catch(() => {});
    res.cookie(PORTAL_COOKIE, signPortalToken(pu), PORTAL_COOKIE_OPTS);
    res.json({ id: pu.id, email: pu.email, fullName: pu.full_name || null });
  } catch (err) {
    console.error('POST /portal/auth/login error:', err.message);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

// POST /api/portal/auth/logout
router.post('/auth/logout', (req, res) => {
  res.clearCookie(PORTAL_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' });
  res.json({ ok: true });
});

// GET /api/portal/auth/me
router.get('/auth/me', requirePortal, async (req, res) => {
  try {
    const cust = await queryOne('SELECT name FROM customers WHERE id = $1', [req.portalUser.customerId]);
    res.json({ id: req.portalUser.id, email: req.portalUser.email, fullName: req.portalUser.fullName || null, customer: cust ? cust.name : null });
  } catch (err) {
    console.error('GET /portal/auth/me error:', err.message);
    res.status(500).json({ error: 'Could not load your profile.' });
  }
});

module.exports = router;
