/**
 * middleware/auth.js – JWT auth + RBAC
 */

'use strict';

const jwt = require('jsonwebtoken');
const { queryOne } = require('../db');

const ROLE_HIERARCHY = {
  operator: 1, supervisor: 2, manager: 3, administrator: 4, superuser: 5,
};

// Roles a given role is permitted to create/edit
// Superuser can create any role. Admin can create up to manager.
const CREATABLE_ROLES = {
  superuser:     ['operator','supervisor','manager','administrator','superuser'],
  administrator: ['operator','supervisor','manager'],
  manager:       [],
  supervisor:    [],
  operator:      [],
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

function canAssignRole(actorRole, targetRole) {
  return (CREATABLE_ROLES[actorRole] || []).includes(targetRole);
}

module.exports = { requireAuth, requireRole, hasRole, canAssignRole, ROLE_HIERARCHY, CREATABLE_ROLES };
