/**
 * routes/customers.js
 *
 * CRM canonical customer organisations (see docs/crm-rfq-spec.md). Manager and
 * above. Populated by the RFQ import and here. Distinct from the order book's
 * free-text `customer` string - this is the proper customer entity the RFQ
 * module (and later the external portal) hang off.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendEmail, layout, escapeHtml, publicBase } = require('../lib/email');
const { validate, schemas } = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth, requireRole('manager'));

// Compose + send the portal invite email (shared by create + resend).
async function sendInviteEmail(email, customerName, inviteUrl) {
  return sendEmail({
    to: email,
    subject: 'Your Philtronics customer portal invite',
    html: layout({
      title: 'Customer portal invite',
      bodyHtml: '<p>Philtronics has invited you to the ' + escapeHtml(customerName) + ' customer portal, where you can raise and track requests for quotation.</p><p>This link expires in 7 days.</p>',
      cta: { url: inviteUrl, label: 'Set your password' },
    }),
  });
}

function fmt(r) {
  return {
    id: r.id, name: r.name, code: r.code || null, isActive: r.is_active,
    notes: r.notes || null,
    rfqCount: r.rfq_count != null ? Number(r.rfq_count) : undefined,
  };
}

// GET /api/customers - list canonical customers with their RFQ counts
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT c.*, COUNT(r.id) AS rfq_count
         FROM customers c LEFT JOIN rfqs r ON r.customer_id = c.id
        GROUP BY c.id ORDER BY c.name ASC`);
    res.json(rows.map(fmt));
  } catch (err) {
    console.error('GET /customers error:', err.message);
    res.status(500).json({ error: 'Could not load customers.' });
  }
});

// POST /api/customers - add a canonical customer
router.post('/', validate(schemas.customerCreate), async (req, res) => {
  try {
    const { name, code, notes } = req.body;
    const dup = await query('SELECT id FROM customers WHERE LOWER(name) = LOWER($1)', [name]);
    if (dup.length) return res.status(409).json({ error: 'A customer with that name already exists.' });
    const id = uuidv4();
    await query(
      'INSERT INTO customers (id, name, code, notes, created_by) VALUES ($1,$2,$3,$4,$5)',
      [id, name, code || null, notes || null, req.user.id]);
    res.status(201).json({ id, name, code: code || null, isActive: true, notes: notes || null });
  } catch (err) {
    console.error('POST /customers error:', err.message);
    res.status(500).json({ error: 'Could not create the customer.' });
  }
});

// ── Customer portal invites (manager+) ────────────────────────────────────────
// Invite a customer contact to the external portal. We store only a HASH of the
// token; the raw token goes in the emailed link (and is returned once so the
// admin can copy the link if email is not configured).

// POST /api/customers/:id/invites { email, fullName }
router.post('/:id/invites', validate(schemas.customerInvite), async (req, res) => {
  try {
    const cust = await queryOne('SELECT id, name FROM customers WHERE id = $1', [req.params.id]);
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });
    const email = String(req.body.email).trim().toLowerCase();
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const id = uuidv4();
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await query(
      'INSERT INTO portal_invites (id, customer_id, email, full_name, token_hash, expires_at, invited_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, cust.id, email, (req.body.fullName || '').trim() || null, tokenHash, expires, req.user.id]);
    const inviteUrl = publicBase(req) + '/portal/accept?token=' + token;
    const sent = await sendInviteEmail(email, cust.name, inviteUrl);
    res.status(201).json({ id, email, inviteUrl, emailed: sent.sent });
  } catch (err) {
    console.error('POST /customers/:id/invites error:', err.message);
    res.status(500).json({ error: 'Could not create the invite.' });
  }
});

// GET /api/customers/:id/invites - list invites for a customer
router.get('/:id/invites', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, email, full_name, expires_at, accepted_at, created_at
         FROM portal_invites WHERE customer_id = $1 ORDER BY created_at DESC`, [req.params.id]);
    res.json(rows.map(r => ({
      id: r.id, email: r.email, fullName: r.full_name || null,
      expiresAt: r.expires_at, acceptedAt: r.accepted_at || null, createdAt: r.created_at,
      status: r.accepted_at ? 'accepted' : (new Date(r.expires_at) < new Date() ? 'expired' : 'pending'),
    })));
  } catch (err) {
    console.error('GET /customers/:id/invites error:', err.message);
    res.status(500).json({ error: 'Could not load invites.' });
  }
});

// DELETE /api/customers/:id/invites/:inviteId - revoke a pending invite
router.delete('/:id/invites/:inviteId', async (req, res) => {
  try {
    const del = await query('DELETE FROM portal_invites WHERE id = $1 AND customer_id = $2 RETURNING id', [req.params.inviteId, req.params.id]);
    res.json({ ok: true, removed: del.length });
  } catch (err) {
    console.error('DELETE /customers/:id/invites error:', err.message);
    res.status(500).json({ error: 'Could not revoke the invite.' });
  }
});

// POST /api/customers/:id/invites/:inviteId/resend - re-issue a pending invite.
// Only a hash of the token is stored, so resend mints a fresh token + new 7-day
// expiry and emails the new link (the previous link stops working).
router.post('/:id/invites/:inviteId/resend', async (req, res) => {
  try {
    const inv = await queryOne(
      'SELECT i.id, i.email, i.accepted_at, c.name AS customer_name FROM portal_invites i JOIN customers c ON c.id = i.customer_id WHERE i.id = $1 AND i.customer_id = $2',
      [req.params.inviteId, req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Invite not found.' });
    if (inv.accepted_at) return res.status(400).json({ error: 'This contact has already set up their account.' });
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await query('UPDATE portal_invites SET token_hash = $1, expires_at = $2 WHERE id = $3', [tokenHash, expires, inv.id]);
    const inviteUrl = publicBase(req) + '/portal/accept?token=' + token;
    const sent = await sendInviteEmail(inv.email, inv.customer_name, inviteUrl);
    res.json({ id: inv.id, email: inv.email, inviteUrl, emailed: sent.sent });
  } catch (err) {
    console.error('POST /customers/:id/invites/:inviteId/resend error:', err.message);
    res.status(500).json({ error: 'Could not resend the invite.' });
  }
});

module.exports = router;
