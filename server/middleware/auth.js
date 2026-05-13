/**
 * middleware/auth.js
 * JWT authentication middleware and RBAC helpers.
 * Token is stored in an httpOnly cookie named 'token'.
 */

'use strict';

const jwt = require('jsonwebtoken');
const db  = require('../db');

const ROLE_HIERARCHY = {
  operator:      1,
  supervisor:    2,
  manager:       3,
  administrator: 4,
};

/**
 * requireAuth – verifies JWT cookie, attaches req.user
 */
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    res.clearCookie('token');
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  // Re-validate user still exists and is active
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(payload.sub);
  if (!user) {
    res.clearCookie('token');
    return res.status(401).json({ error: 'Account not found or disabled.' });
  }

  req.user = user;
  next();
}

/**
 * requireRole – factory; minRole is the minimum role level required.
 * Usage: requireRole('supervisor')
 */
function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    const userLevel = ROLE_HIERARCHY[req.user.role] || 0;
    const required  = ROLE_HIERARCHY[minRole]       || 999;
    if (userLevel < required) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    next();
  };
}

/**
 * hasRole – boolean check (for inline use inside route handlers)
 */
function hasRole(user, minRole) {
  const userLevel = ROLE_HIERARCHY[user.role]  || 0;
  const required  = ROLE_HIERARCHY[minRole]    || 999;
  return userLevel >= required;
}

module.exports = { requireAuth, requireRole, hasRole };
