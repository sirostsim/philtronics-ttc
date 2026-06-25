/**
 * routes/dev-requests.js – "Dev Requests" mini-forum (PostgreSQL version)
 *
 * Visibility: supervisor and above (operators never see it).
 * Status:     changed ONLY by the superuser.
 * Editing:    a request is editable by its author or the superuser; a comment
 *             is editable by its author or the superuser. The superuser may
 *             delete any request (moderation). The thread stays open in every
 *             status, including 'declined'.
 * Voting:     one vote per user per request; self-votes allowed; toggle on/off.
 */

'use strict';

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../db');
const { requireAuth, hasRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Every route here is supervisor-and-above. Operators are blocked outright.
router.use((req, res, next) => {
  if (!hasRole(req.user, 'supervisor')) {
    return res.status(403).json({ error: 'Dev Requests are available to supervisors and above.' });
  }
  next();
});

const STATUSES = ['requested', 'under_review', 'planned', 'in_progress', 'done', 'declined'];
const isSuperuser = (user) => user.role === 'superuser';

const TITLE_MAX = 160;
const BODY_MAX  = 8000;
const COMMENT_MAX = 4000;

function formatRequest(r, opts = {}) {
  return {
    id:             r.id,
    title:          r.title,
    body:           r.body,
    status:         r.status,
    authorId:       r.author_id,
    authorName:     r.author_name,
    createdAt:      r.created_at,
    updatedAt:      r.updated_at,
    lastActivityAt: r.last_activity_at,
    voteCount:      r.vote_count != null ? Number(r.vote_count) : 0,
    commentCount:   r.comment_count != null ? Number(r.comment_count) : 0,
    hasVoted:       !!r.has_voted,
    // Convenience flags so the UI can show/hide controls without re-deriving rules
    canEdit:        !!opts.canEdit,
    canChangeStatus:!!opts.canChangeStatus,
    canDelete:      !!opts.canDelete,
  };
}

function formatComment(c, user) {
  return {
    id:         c.id,
    requestId:  c.request_id,
    body:       c.body,
    authorId:   c.author_id,
    authorName: c.author_name,
    createdAt:  c.created_at,
    updatedAt:  c.updated_at,
    edited:     !!c.edited,
    canEdit:    user ? (c.author_id === user.id || isSuperuser(user)) : false,
  };
}

// ─── GET /api/dev-requests ────────────────────────────────────────────────────
// List all requests with vote + comment counts and whether the caller has voted.
// Sort: 'active' (default), 'top' (most votes), 'new'. Optional ?status= filter.
router.get('/', async (req, res) => {
  try {
    const user = req.user;
    const sort = String(req.query.sort || 'active');
    const statusFilter = req.query.status && STATUSES.includes(req.query.status)
      ? req.query.status : null;

    const params = [user.id];
    let where = '';
    if (statusFilter) { params.push(statusFilter); where = `WHERE r.status = $${params.length}`; }

    let orderBy = 'r.last_activity_at DESC';
    if (sort === 'top') orderBy = 'vote_count DESC, r.last_activity_at DESC';
    else if (sort === 'new') orderBy = 'r.created_at DESC';

    const rows = await query(
      `SELECT r.*,
              (SELECT COUNT(*) FROM dev_request_votes v WHERE v.request_id = r.id)        AS vote_count,
              (SELECT COUNT(*) FROM dev_request_comments c WHERE c.request_id = r.id)      AS comment_count,
              EXISTS (SELECT 1 FROM dev_request_votes v WHERE v.request_id = r.id AND v.user_id = $1) AS has_voted
         FROM dev_requests r
         ${where}
        ORDER BY ${orderBy}`,
      params
    );

    res.json(rows.map(r => formatRequest(r, {
      canEdit:         r.author_id === user.id || isSuperuser(user),
      canChangeStatus: isSuperuser(user),
      canDelete:       isSuperuser(user),
    })));
  } catch (err) {
    console.error('List dev requests error:', err.message);
    res.status(500).json({ error: 'Could not load dev requests.' });
  }
});

// ─── GET /api/dev-requests/:id ────────────────────────────────────────────────
// One request plus its comment thread.
router.get('/:id', async (req, res) => {
  try {
    const user = req.user;
    const r = await queryOne(
      `SELECT r.*,
              (SELECT COUNT(*) FROM dev_request_votes v WHERE v.request_id = r.id)   AS vote_count,
              (SELECT COUNT(*) FROM dev_request_comments c WHERE c.request_id = r.id) AS comment_count,
              EXISTS (SELECT 1 FROM dev_request_votes v WHERE v.request_id = r.id AND v.user_id = $1) AS has_voted
         FROM dev_requests r WHERE r.id = $2`,
      [user.id, req.params.id]
    );
    if (!r) return res.status(404).json({ error: 'Request not found.' });

    const comments = await query(
      `SELECT * FROM dev_request_comments WHERE request_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({
      ...formatRequest(r, {
        canEdit:         r.author_id === user.id || isSuperuser(user),
        canChangeStatus: isSuperuser(user),
        canDelete:       isSuperuser(user),
      }),
      comments: comments.map(c => formatComment(c, user)),
    });
  } catch (err) {
    console.error('Get dev request error:', err.message);
    res.status(500).json({ error: 'Could not load request.' });
  }
});

// ─── POST /api/dev-requests ───────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const user = req.user;
    const title = String(req.body.title || '').trim();
    const body  = String(req.body.body || '').trim();

    if (!title) return res.status(422).json({ error: 'A title is required.' });
    if (title.length > TITLE_MAX) return res.status(422).json({ error: `Title must be ${TITLE_MAX} characters or fewer.` });
    if (body.length > BODY_MAX)   return res.status(422).json({ error: `Description is too long (max ${BODY_MAX}).` });

    const id = uuidv4();
    await query(
      `INSERT INTO dev_requests (id, title, body, status, author_id, author_name)
       VALUES ($1, $2, $3, 'requested', $4, $5)`,
      [id, title, body, user.id, user.full_name]
    );
    const r = await queryOne('SELECT * FROM dev_requests WHERE id = $1', [id]);
    res.status(201).json(formatRequest(r, { canEdit: true, canChangeStatus: isSuperuser(user), canDelete: isSuperuser(user) }));
  } catch (err) {
    console.error('Create dev request error:', err.message);
    res.status(500).json({ error: 'Could not create request.' });
  }
});

// ─── PATCH /api/dev-requests/:id ──────────────────────────────────────────────
// Edit title/body: author or superuser only.
router.patch('/:id', async (req, res) => {
  try {
    const user = req.user;
    const r = await queryOne('SELECT * FROM dev_requests WHERE id = $1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    if (r.author_id !== user.id && !isSuperuser(user)) {
      return res.status(403).json({ error: 'Only the author or the superuser can edit this request.' });
    }

    const title = req.body.title != null ? String(req.body.title).trim() : r.title;
    const body  = req.body.body  != null ? String(req.body.body).trim()  : r.body;
    if (!title) return res.status(422).json({ error: 'A title is required.' });
    if (title.length > TITLE_MAX) return res.status(422).json({ error: `Title must be ${TITLE_MAX} characters or fewer.` });
    if (body.length > BODY_MAX)   return res.status(422).json({ error: `Description is too long (max ${BODY_MAX}).` });

    await query(
      `UPDATE dev_requests SET title = $1, body = $2, updated_at = NOW() WHERE id = $3`,
      [title, body, r.id]
    );
    const updated = await queryOne('SELECT * FROM dev_requests WHERE id = $1', [r.id]);
    res.json(formatRequest(updated, {
      canEdit: true, canChangeStatus: isSuperuser(user), canDelete: isSuperuser(user),
    }));
  } catch (err) {
    console.error('Edit dev request error:', err.message);
    res.status(500).json({ error: 'Could not edit request.' });
  }
});

// ─── PATCH /api/dev-requests/:id/status ───────────────────────────────────────
// Change status: SUPERUSER ONLY.
router.patch('/:id/status', async (req, res) => {
  try {
    const user = req.user;
    if (!isSuperuser(user)) {
      return res.status(403).json({ error: 'Only the superuser can change a request\'s status.' });
    }
    const status = String(req.body.status || '');
    if (!STATUSES.includes(status)) {
      return res.status(422).json({ error: 'Invalid status.' });
    }
    const r = await queryOne('SELECT * FROM dev_requests WHERE id = $1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Request not found.' });

    await query('UPDATE dev_requests SET status = $1, updated_at = NOW() WHERE id = $2', [status, r.id]);
    const updated = await queryOne('SELECT * FROM dev_requests WHERE id = $1', [r.id]);
    res.json(formatRequest(updated, { canEdit: true, canChangeStatus: true, canDelete: true }));
  } catch (err) {
    console.error('Status change error:', err.message);
    res.status(500).json({ error: 'Could not change status.' });
  }
});

// ─── DELETE /api/dev-requests/:id ─────────────────────────────────────────────
// Hard delete: SUPERUSER ONLY (moderation). Cascades to comments and votes.
router.delete('/:id', async (req, res) => {
  try {
    const user = req.user;
    if (!isSuperuser(user)) {
      return res.status(403).json({ error: 'Only the superuser can delete a request.' });
    }
    const r = await queryOne('SELECT id FROM dev_requests WHERE id = $1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    await query('DELETE FROM dev_requests WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete dev request error:', err.message);
    res.status(500).json({ error: 'Could not delete request.' });
  }
});

// ─── POST /api/dev-requests/:id/vote ──────────────────────────────────────────
// Toggle the caller's vote on/off. One vote per user per request.
router.post('/:id/vote', async (req, res) => {
  try {
    const user = req.user;
    const r = await queryOne('SELECT id FROM dev_requests WHERE id = $1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Request not found.' });

    const existing = await queryOne(
      'SELECT 1 FROM dev_request_votes WHERE request_id = $1 AND user_id = $2',
      [req.params.id, user.id]
    );
    if (existing) {
      await query('DELETE FROM dev_request_votes WHERE request_id = $1 AND user_id = $2', [req.params.id, user.id]);
    } else {
      await query('INSERT INTO dev_request_votes (request_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, user.id]);
    }
    const countRow = await queryOne('SELECT COUNT(*) AS n FROM dev_request_votes WHERE request_id = $1', [req.params.id]);
    res.json({ voteCount: Number(countRow.n), hasVoted: !existing });
  } catch (err) {
    console.error('Vote error:', err.message);
    res.status(500).json({ error: 'Could not register vote.' });
  }
});

// ─── POST /api/dev-requests/:id/comments ──────────────────────────────────────
router.post('/:id/comments', async (req, res) => {
  try {
    const user = req.user;
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(422).json({ error: 'A comment cannot be empty.' });
    if (body.length > COMMENT_MAX) return res.status(422).json({ error: `Comment is too long (max ${COMMENT_MAX}).` });

    const r = await queryOne('SELECT id FROM dev_requests WHERE id = $1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Request not found.' });

    const id = uuidv4();
    await query(
      `INSERT INTO dev_request_comments (id, request_id, body, author_id, author_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, req.params.id, body, user.id, user.full_name]
    );
    // New comment advances the request's activity timestamp (drives 'active' sort).
    await query('UPDATE dev_requests SET last_activity_at = NOW() WHERE id = $1', [req.params.id]);

    const c = await queryOne('SELECT * FROM dev_request_comments WHERE id = $1', [id]);
    res.status(201).json(formatComment(c, user));
  } catch (err) {
    console.error('Add comment error:', err.message);
    res.status(500).json({ error: 'Could not add comment.' });
  }
});

// ─── PATCH /api/dev-requests/:id/comments/:commentId ──────────────────────────
// Edit a comment: author or superuser only.
router.patch('/:id/comments/:commentId', async (req, res) => {
  try {
    const user = req.user;
    const c = await queryOne('SELECT * FROM dev_request_comments WHERE id = $1 AND request_id = $2',
      [req.params.commentId, req.params.id]);
    if (!c) return res.status(404).json({ error: 'Comment not found.' });
    if (c.author_id !== user.id && !isSuperuser(user)) {
      return res.status(403).json({ error: 'Only the author or the superuser can edit this comment.' });
    }
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(422).json({ error: 'A comment cannot be empty.' });
    if (body.length > COMMENT_MAX) return res.status(422).json({ error: `Comment is too long (max ${COMMENT_MAX}).` });

    await query(
      `UPDATE dev_request_comments SET body = $1, updated_at = NOW(), edited = TRUE WHERE id = $2`,
      [body, c.id]
    );
    const updated = await queryOne('SELECT * FROM dev_request_comments WHERE id = $1', [c.id]);
    res.json(formatComment(updated, user));
  } catch (err) {
    console.error('Edit comment error:', err.message);
    res.status(500).json({ error: 'Could not edit comment.' });
  }
});

// ─── DELETE /api/dev-requests/:id/comments/:commentId ─────────────────────────
// Delete a comment: author or superuser only.
router.delete('/:id/comments/:commentId', async (req, res) => {
  try {
    const user = req.user;
    const c = await queryOne('SELECT * FROM dev_request_comments WHERE id = $1 AND request_id = $2',
      [req.params.commentId, req.params.id]);
    if (!c) return res.status(404).json({ error: 'Comment not found.' });
    if (c.author_id !== user.id && !isSuperuser(user)) {
      return res.status(403).json({ error: 'Only the author or the superuser can delete this comment.' });
    }
    await query('DELETE FROM dev_request_comments WHERE id = $1', [c.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete comment error:', err.message);
    res.status(500).json({ error: 'Could not delete comment.' });
  }
});

module.exports = router;
