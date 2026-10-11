/**
 * middleware/portal-auth.js
 *
 * Authentication for EXTERNAL customer-portal users, kept rigorously separate from
 * internal auth (middleware/auth.js). See docs/crm-portal-plan.md section 0.
 *
 * - Portal sessions use their own cookie ('ptoken') and a JWT marked typ:'portal'.
 * - requirePortal loads the portal user from portal_users (never `users`) and sets
 *   req.portalUser = { id, customerId, email, fullName }. customerId comes from the
 *   DB row, never the client, and is the ONLY tenant scope portal routes may use.
 * - rejectPortal is a belt-and-braces guard for internal routes: a request that
 *   carries a portal cookie but no internal cookie is refused outright, so a portal
 *   session can never reach an internal endpoint even if that route forgot its gate.
 * - Internal requireAuth additionally rejects any token marked typ:'portal'.
 */
'use strict';

const jwt = require('jsonwebtoken');
const { queryOne } = require('../db');

const PORTAL_COOKIE = 'ptoken';
const PORTAL_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure:   process.env.NODE_ENV === 'production',
  maxAge:   8 * 60 * 60 * 1000,
  path:     '/',
};

function signPortalToken(portalUser) {
  return jwt.sign(
    { sub: portalUser.id, cid: portalUser.customer_id, typ: 'portal' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

async function requirePortal(req, res, next) {
  const token = req.cookies && req.cookies[PORTAL_COOKIE];
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    res.clearCookie(PORTAL_COOKIE);
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
  if (payload.typ !== 'portal') {       // an internal token must never pass here
    res.clearCookie(PORTAL_COOKIE);
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  try {
    const pu = await queryOne('SELECT * FROM portal_users WHERE id = $1 AND is_active = TRUE', [payload.sub]);
    if (!pu) {
      res.clearCookie(PORTAL_COOKIE);
      return res.status(401).json({ error: 'Account not found or disabled.' });
    }
    // Tenant scope is taken from the DB record, not the token.
    req.portalUser = { id: pu.id, customerId: pu.customer_id, email: pu.email, fullName: pu.full_name };
    next();
  } catch (err) {
    console.error('Portal auth error:', err.message);
    res.status(500).json({ error: 'Authentication error.' });
  }
}

// Internal-route guard: a portal-only session may never reach an internal area.
// (A request with both cookies is left to the internal requireAuth to resolve.)
function rejectPortal(req, res, next) {
  const c = req.cookies || {};
  if (c[PORTAL_COOKIE] && !c.token) {
    return res.status(403).json({ error: 'Customer portal accounts cannot access this area.' });
  }
  next();
}

module.exports = { PORTAL_COOKIE, PORTAL_COOKIE_OPTS, signPortalToken, requirePortal, rejectPortal };
