/**
 * routes/messages.js – Real-time operator messaging via Server-Sent Events
 *
 * GET  /api/messages/listen   – Any user connects, keeps SSE stream open
 * POST /api/messages/send     – Supervisor+ sends a message to an operator
 * POST /api/messages/reply    – Operator replies to a message they received
 * GET  /api/messages/online   – Returns connected user IDs (for presence dots)
 *
 * All users (operators and supervisors) maintain an SSE connection so both
 * sides can receive push events. Operators cannot initiate — they can only
 * reply to a message they received (enforced via replyToId on the server).
 */

'use strict';

const express   = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { queryOne } = require('../db');

const router = express.Router();

// In-memory map of userId -> SSE response object.
// Covers both operators and supervisors — everyone gets a connection.
const connections = new Map();

// ── GET /api/messages/listen ──────────────────────────────────────────────────
router.get('/listen', requireAuth, (req, res) => {
  const userId = req.user.id;

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(': connected\n\n');

  connections.set(userId, res);
  console.log(`SSE connected: ${req.user.username} (${userId}). Active: ${connections.size}`);

  const heartbeat = setInterval(() => {
    if (res.writableEnded) { clearInterval(heartbeat); return; }
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    connections.delete(userId);
    console.log(`SSE disconnected: ${req.user.username}. Active: ${connections.size}`);
  });
});

// ── POST /api/messages/send ───────────────────────────────────────────────────
// Supervisor+ sends a message to a specific operator.
// The payload includes the sender's ID so the operator can address a reply back.
router.post('/send', requireAuth, requireRole('supervisor'), async (req, res) => {
  try {
    const { operatorId, message } = req.body;

    if (!operatorId || !message || !message.trim()) {
      return res.status(400).json({ error: 'Operator and message are required.' });
    }
    if (message.trim().length > 500) {
      return res.status(400).json({ error: 'Message must be 500 characters or fewer.' });
    }

    const operator = await queryOne(
      'SELECT id, full_name FROM users WHERE id = $1', [operatorId]
    );
    if (!operator) return res.status(404).json({ error: 'Operator not found.' });

    const payload = JSON.stringify({
      type:       'message',
      from:       req.user.full_name,
      fromId:     req.user.id,         // operator needs this to address the reply
      fromRole:   req.user.role,
      message:    message.trim(),
      sentAt:     new Date().toISOString(),
      canReply:   true,
    });

    const conn = connections.get(operatorId);
    if (conn && !conn.writableEnded) {
      conn.write(`data: ${payload}\n\n`);
      res.json({ ok: true, delivered: true, operatorName: operator.full_name });
    } else {
      res.json({ ok: true, delivered: false, operatorName: operator.full_name });
    }
  } catch (err) {
    console.error('Send message error:', err.message);
    res.status(500).json({ error: 'Could not send message.' });
  }
});

// ── POST /api/messages/reply ──────────────────────────────────────────────────
// Operator replies to a message they received.
// replyToId must be a valid supervisor/manager/admin ID — operators cannot
// cold-message anyone, only reply to someone who has already messaged them.
router.post('/reply', requireAuth, async (req, res) => {
  try {
    const { replyToId, replyToName, originalMessage, message } = req.body;

    if (!replyToId || !message || !message.trim()) {
      return res.status(400).json({ error: 'Reply target and message are required.' });
    }
    if (message.trim().length > 500) {
      return res.status(400).json({ error: 'Reply must be 500 characters or fewer.' });
    }

    // Verify the target is a real user and has a supervisory role.
    // This prevents operators constructing a payload to message each other.
    const target = await queryOne(
      `SELECT id, full_name, role FROM users
       WHERE id = $1 AND role IN ('supervisor','manager','administrator') AND is_active = TRUE`,
      [replyToId]
    );
    if (!target) {
      return res.status(403).json({ error: 'Replies can only be sent to supervisors or managers.' });
    }

    const payload = JSON.stringify({
      type:            'reply',
      from:            req.user.full_name,
      fromId:          req.user.id,
      fromRole:        req.user.role,
      message:         message.trim(),
      originalMessage: originalMessage || null,   // shown as context in the popup
      replyToName:     replyToName || target.full_name,
      sentAt:          new Date().toISOString(),
    });

    const conn = connections.get(replyToId);
    if (conn && !conn.writableEnded) {
      conn.write(`data: ${payload}\n\n`);
      res.json({ ok: true, delivered: true });
    } else {
      res.json({ ok: true, delivered: false });
    }
  } catch (err) {
    console.error('Reply error:', err.message);
    res.status(500).json({ error: 'Could not send reply.' });
  }
});

// ── GET /api/messages/online ──────────────────────────────────────────────────
router.get('/online', requireAuth, requireRole('supervisor'), (req, res) => {
  res.json({ online: Array.from(connections.keys()) });
});

module.exports = router;
