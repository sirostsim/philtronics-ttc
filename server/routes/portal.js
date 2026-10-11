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

// ── Scoped RFQ API (requirePortal; always scoped to the session's customer) ────

const isoD = d => (d instanceof Date ? d.toISOString() : (d ? String(d) : null));
const isoDate = d => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null));

// THE single allow-list serializer: the only way RFQ data leaves to the portal.
// It emits ONLY customer-safe fields by construction - never build/inspection/test
// time, Sage refs, assignees, internal notes, or anything from another customer.
// The quote is surfaced only once the RFQ is completed (i.e. a quote was issued).
function portalRfq(r, extra = {}) {
  const issued = r.status === 'completed';
  const out = {
    id: r.id,
    reference: r.rfq_number || r.quote_ref || null,
    partNumber: r.part_number || null,
    partName: r.part_name || null,
    revision: r.revision || null,
    coNumber: r.co_number || null,
    quoteType: r.quote_type || null,
    priority: r.priority || null,
    dateRequiredBy: isoDate(r.date_required_by),
    freeIssue: r.free_issue,
    potentialUnitsAnnual: r.potential_units_annual,
    potentialRevenueAnnual: r.potential_revenue_annual != null ? Number(r.potential_revenue_annual) : null,
    requestComments: r.request_comments || null,
    status: r.status,
    submittedAt: isoD(r.source_created_at || r.created_at),
    quote: issued ? {
      value: r.quoted_value != null ? Number(r.quoted_value) : null,
      reference: r.quote_ref || null,
      date: isoDate(r.quoted_at),
    } : null,
  };
  if (extra.events) out.events = extra.events.map(e => ({
    type: e.type, body: e.body || null, authorName: e.author_name || 'Philtronics', createdAt: isoD(e.created_at),
  }));
  return out;
}

// GET /api/portal/rfqs - the signed-in customer's own RFQs.
router.get('/rfqs', requirePortal, async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM rfqs WHERE customer_id = $1
        ORDER BY COALESCE(date_required_by, source_created_at::date, created_at::date) DESC NULLS LAST, created_at DESC
        LIMIT 500`, [req.portalUser.customerId]);
    res.json(rows.map(r => portalRfq(r)));
  } catch (err) {
    console.error('GET /portal/rfqs error:', err.message);
    res.status(500).json({ error: 'Could not load your RFQs.' });
  }
});

// GET /api/portal/rfqs/:id - detail (own RFQ only; customer-visible events only).
router.get('/rfqs/:id', requirePortal, async (req, res) => {
  try {
    const r = await queryOne('SELECT * FROM rfqs WHERE id = $1 AND customer_id = $2', [req.params.id, req.portalUser.customerId]);
    if (!r) return res.status(404).json({ error: 'RFQ not found.' });
    const events = await query(
      `SELECT type, body, author_name, created_at FROM rfq_events WHERE rfq_id = $1 AND visibility = 'customer' ORDER BY created_at ASC`, [r.id]);
    res.json(portalRfq(r, { events }));
  } catch (err) {
    console.error('GET /portal/rfqs/:id error:', err.message);
    res.status(500).json({ error: 'Could not load the RFQ.' });
  }
});

// POST /api/portal/rfqs - submit a new RFQ (forced to the session's customer).
router.post('/rfqs', requirePortal, validate(schemas.portalRfqCreate), async (req, res) => {
  const b = req.body;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const prefix = 'RFQ-' + new Date().getFullYear() + '-';
    const last = (await client.query(`SELECT rfq_number FROM rfqs WHERE rfq_number LIKE $1 ORDER BY rfq_number DESC LIMIT 1`, [prefix + '%'])).rows[0];
    let n = 1; if (last) { const v = parseInt(String(last.rfq_number).slice(prefix.length), 10); if (!isNaN(v)) n = v + 1; }
    const rfqNumber = prefix + String(n).padStart(4, '0');
    const id = uuidv4();
    await client.query(
      `INSERT INTO rfqs (id, rfq_number, customer_id, part_number, part_name, revision, co_number, quote_type, priority,
         date_required_by, free_issue, potential_units_annual, potential_revenue_annual, request_comments, contact_email, status,
         first_action_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'open',NULL)`,
      [id, rfqNumber, req.portalUser.customerId, b.partNumber || null, b.partName || null, b.revision || null, b.coNumber || null,
       b.quoteType || null, b.priority || null, b.dateRequiredBy || null, b.freeIssue != null ? b.freeIssue : null,
       b.potentialUnitsAnnual != null ? b.potentialUnitsAnnual : null, b.potentialRevenueAnnual != null ? b.potentialRevenueAnnual : null,
       (b.requestComments || '').trim() || null, req.portalUser.email]);
    await client.query(
      `INSERT INTO rfq_events (id, rfq_id, type, body, visibility, author_name) VALUES ($1,$2,'customer_message',$3,'customer',$4)`,
      [uuidv4(), id, 'RFQ submitted via the customer portal.', req.portalUser.fullName || req.portalUser.email]);
    await client.query('COMMIT');
    const r = await queryOne('SELECT * FROM rfqs WHERE id = $1', [id]);
    res.status(201).json(portalRfq(r));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /portal/rfqs error:', err.message);
    res.status(500).json({ error: 'Could not submit the RFQ.' });
  } finally {
    client.release();
  }
});

// POST /api/portal/rfqs/:id/messages - add a customer-facing message.
router.post('/rfqs/:id/messages', requirePortal, validate(schemas.portalRfqMessage), async (req, res) => {
  try {
    const r = await queryOne('SELECT id FROM rfqs WHERE id = $1 AND customer_id = $2', [req.params.id, req.portalUser.customerId]);
    if (!r) return res.status(404).json({ error: 'RFQ not found.' });
    await query(
      `INSERT INTO rfq_events (id, rfq_id, type, body, visibility, author_name) VALUES ($1,$2,'customer_message',$3,'customer',$4)`,
      [uuidv4(), r.id, req.body.body, req.portalUser.fullName || req.portalUser.email]);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('POST /portal/rfqs/:id/messages error:', err.message);
    res.status(500).json({ error: 'Could not send the message.' });
  }
});

// POST /api/portal/rfqs/:id/accept and /decline - record the customer's decision
// on an issued quote (a customer-visible event; a won/lost field is a later step).
function decisionHandler(word) {
  return async (req, res) => {
    try {
      const r = await queryOne('SELECT id, status FROM rfqs WHERE id = $1 AND customer_id = $2', [req.params.id, req.portalUser.customerId]);
      if (!r) return res.status(404).json({ error: 'RFQ not found.' });
      if (r.status !== 'completed') return res.status(409).json({ error: 'This RFQ has not been quoted yet.' });
      await query(
        `INSERT INTO rfq_events (id, rfq_id, type, body, visibility, author_name) VALUES ($1,$2,'customer_message',$3,'customer',$4)`,
        [uuidv4(), r.id, 'Customer ' + word + ' the quote.', req.portalUser.fullName || req.portalUser.email]);
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /portal/rfqs/:id/' + word + ' error:', err.message);
      res.status(500).json({ error: 'Could not record your decision.' });
    }
  };
}
router.post('/rfqs/:id/accept', requirePortal, decisionHandler('accepted'));
router.post('/rfqs/:id/decline', requirePortal, decisionHandler('declined'));

module.exports = router;
module.exports._test = { portalRfq };
