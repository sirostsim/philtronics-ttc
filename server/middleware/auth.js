/**
 * middleware/auth.js – JWT auth + RBAC (PostgreSQL async version)
 */

'use strict';

const jwt = require('jsonwebtoken');
const { queryOne } = require('../db');

const ROLE_HIERARCHY = {
  operator: 1, supervisor: 2, manager: 3, administrator: 4,
};

async function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    res.clearCookie('token');
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  try {
    const user = await queryOne(
      'SELECT * FROM users WHERE id = $1 AND is_active = TRUE', [payload.sub]
    );
    if (!user) {
      res.clearCookie('token');
      return res.status(401).json({ error: 'Account not found or disabled.' });
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    res.status(500).json({ error: 'Authentication error.' });
  }
}

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    if ((ROLE_HIERARCHY[req.user.role] || 0) < (ROLE_HIERARCHY[minRole] || 999)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    next();
  };
}

function hasRole(user, minRole) {
  return (ROLE_HIERARCHY[user.role] || 0) >= (ROLE_HIERARCHY[minRole] || 999);
}

module.exports = { requireAuth, requireRole, hasRole };
