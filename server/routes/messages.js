/**
 * routes/messages.js – Real-time operator messaging via Server-Sent Events
 *
 * GET  /api/messages/listen   – Operator connects, keeps SSE stream open
 * POST /api/messages/send     – Manager/admin sends a message to an operator
 *
 * SSE is a lightweight one-way push — no WebSockets needed.
 * The server only does work when a message is sent, not continuously.
 */

'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { queryOne } = require('../db');

const router = express.Router();

// In-memory map of operatorId -> SSE response object
// This is fine for a single-process app (Railway runs one instance)
const connections = new Map();

// ── GET /api/messages/listen ──────────────────────────────────────────────────
// Operator opens this connection on login. Kept alive until they navigate away.
router.get('/listen', requireAuth, (req, res) => {
  const userId = req.user.id;

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // prevent nginx buffering
  res.flushHeaders();

  // Send a comment to keep the connection alive and confirm it's open
  res.write(': connected\n\n');

  // Register this connection
  connections.set(userId, res);
  console.log(`SSE connected: ${req.user.username} (${userId}). Active: ${connections.size}`);

  // Heartbeat every 25s to prevent proxy/load-balancer timeouts
  const heartbeat = setInterval(() => {
    if (res.writableEnded) { clearInterval(heartbeat); return; }
    res.write(': heartbeat\n\n');
  }, 25000);

  // Clean up when the client disconnects
  req.on('close', () => {
    clearInterval(heartbeat);
    connections.delete(userId);
    console.log(`SSE disconnected: ${req.user.username}. Active: ${connections.size}`);
  });
});

// ── POST /api/messages/send ───────────────────────────────────────────────────
// Manager/admin sends a message to a specific operator.
router.post('/send', requireAuth, requireRole('supervisor'), async (req, res) => {
  try {
    const { operatorId, message } = req.body;

    if (!operatorId || !message || !message.trim()) {
      return res.status(400).json({ error: 'Operator and message are required.' });
    }
    if (message.trim().length > 500) {
      return res.status(400).json({ error: 'Message must be 500 characters or fewer.' });
    }

    // Verify operator exists
    const operator = await queryOne('SELECT id, full_name FROM users WHERE id = $1', [operatorId]);
    if (!operator) {
      return res.status(404).json({ error: 'Operator not found.' });
    }

    // Build SSE event payload — unnamed event so the frontend
    // addEventListener('message', ...) listener catches it correctly.
    // Named events (event: message\n) are ignored by the default listener.
    const payload = JSON.stringify({
      from:      req.user.full_name,
      fromRole:  req.user.role,
      message:   message.trim(),
      sentAt:    new Date().toISOString(),
    });

    // Push to operator if they are connected
    const conn = connections.get(operatorId);
    if (conn && !conn.writableEnded) {
      conn.write(`data: ${payload}\n\n`);
      res.json({ ok: true, delivered: true, operatorName: operator.full_name });
    } else {
      // Operator not currently connected — message not delivered
      res.json({ ok: true, delivered: false, operatorName: operator.full_name });
    }
  } catch (err) {
    console.error('Send message error:', err.message);
    res.status(500).json({ error: 'Could not send message.' });
  }
});

// ── GET /api/messages/online ──────────────────────────────────────────────────
// Returns list of currently connected operator IDs (for wallboard online indicator)
router.get('/online', requireAuth, requireRole('supervisor'), (req, res) => {
  res.json({ online: Array.from(connections.keys()) });
});

module.exports = router;