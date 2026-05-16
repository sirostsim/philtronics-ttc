/**
 * routes/messages.js – Real-time two-way messaging via Server-Sent Events
 *
 * GET  /api/messages/listen        – Any logged-in user opens an SSE stream
 * POST /api/messages/send          – Supervisor+ starts a conversation with an operator
 * POST /api/messages/reply         – Either side sends a message within a conversation
 * POST /api/messages/close         – Supervisor closes the conversation
 * GET  /api/messages/online        – Returns connected user IDs (presence dots)
 *
 * Conversations are ephemeral (in-memory only). If either party refreshes
 * the page the thread is gone — acceptable for a shopfloor comms tool.
 * Operators cannot initiate conversations, only reply within one started by
 * a supervisor. The server enforces this by validating conversationId ownership.
 */

'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { queryOne } = require('../db');
const crypto = require('crypto');

const router = express.Router();

// userId -> SSE response  (all roles connect here)
const connections = new Map();

// conversationId -> { supervisorId, operatorId, supervisorName, operatorName }
// Tracks live conversations so we can validate reply targets
const conversations = new Map();

function push(userId, payload) {
  const conn = connections.get(userId);
  if (conn && !conn.writableEnded) {
    conn.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  }
  return false;
}

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
    // Do NOT delete conversations here — a dropped SSE connection (e.g. brief
    // network blip, page background, element visibility change on Android) must
    // not destroy an active conversation. Only POST /close deletes conversations.
    console.log(`SSE disconnected: ${req.user.username}. Active: ${connections.size}`);
  });
});

// ── POST /api/messages/send ───────────────────────────────────────────────────
// Supervisor starts a new conversation with an operator.
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
      'SELECT id, full_name FROM users WHERE id = $1 AND is_active = TRUE', [operatorId]
    );
    if (!operator) return res.status(404).json({ error: 'Operator not found.' });

    // Create a new conversation record
    const conversationId = crypto.randomUUID();
    conversations.set(conversationId, {
      supervisorId:   req.user.id,
      supervisorName: req.user.full_name,
      operatorId:     operator.id,
      operatorName:   operator.full_name,
      startedAt:      new Date().toISOString(),
    });

    const payload = {
      type:           'message',
      conversationId,
      from:           req.user.full_name,
      fromId:         req.user.id,
      fromRole:       req.user.role,
      to:             operator.full_name,
      toId:           operator.id,
      message:        message.trim(),
      sentAt:         new Date().toISOString(),
    };

    const delivered = push(operatorId, payload);
    res.json({ ok: true, delivered, conversationId, operatorName: operator.full_name });

  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ error: 'Could not send message.' });
  }
});

// ── POST /api/messages/reply ──────────────────────────────────────────────────
// Either side sends a message within an existing conversation.
router.post('/reply', requireAuth, async (req, res) => {
  try {
    const { conversationId, message } = req.body;

    if (!conversationId || !message || !message.trim()) {
      return res.status(400).json({ error: 'Conversation ID and message are required.' });
    }
    if (message.trim().length > 500) {
      return res.status(400).json({ error: 'Message must be 500 characters or fewer.' });
    }

    const conv = conversations.get(conversationId);
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found or has been closed.' });
    }

    const userId = req.user.id;
    const isOperator    = userId === conv.operatorId;
    const isSupervisor  = userId === conv.supervisorId;

    if (!isOperator && !isSupervisor) {
      return res.status(403).json({ error: 'You are not part of this conversation.' });
    }

    // Determine who receives this reply
    const recipientId = isOperator ? conv.supervisorId : conv.operatorId;

    const payload = {
      type:           'reply',
      conversationId,
      from:           req.user.full_name,
      fromId:         userId,
      fromRole:       req.user.role,
      message:        message.trim(),
      sentAt:         new Date().toISOString(),
    };

    const delivered = push(recipientId, payload);
    res.json({ ok: true, delivered });

  } catch (err) {
    console.error('Reply error:', err.message);
    res.status(500).json({ error: 'Could not send reply.' });
  }
});

// ── POST /api/messages/close ──────────────────────────────────────────────────
// Supervisor closes the conversation. Sends a close signal to the operator.
router.post('/close', requireAuth, requireRole('supervisor'), (req, res) => {
  try {
    const { conversationId } = req.body;
    if (!conversationId) return res.status(400).json({ error: 'Conversation ID required.' });

    const conv = conversations.get(conversationId);
    if (!conv) return res.json({ ok: true }); // already gone

    if (conv.supervisorId !== req.user.id) {
      return res.status(403).json({ error: 'Only the conversation owner can close it.' });
    }

    // Notify the operator that the conversation is closed
    push(conv.operatorId, {
      type:           'close',
      conversationId,
      closedBy:       req.user.full_name,
      closedAt:       new Date().toISOString(),
    });

    conversations.delete(conversationId);
    res.json({ ok: true });

  } catch (err) {
    console.error('Close error:', err.message);
    res.status(500).json({ error: 'Could not close conversation.' });
  }
});

// ── GET /api/messages/online ──────────────────────────────────────────────────
router.get('/online', requireAuth, requireRole('supervisor'), (req, res) => {
  res.json({ online: Array.from(connections.keys()) });
});

module.exports = router;