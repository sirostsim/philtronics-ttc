/**
 * routes/avatars.js – user profile images (avatars)
 *
 * Separate from users.js because that router is gated at administrator level,
 * whereas avatar management is permitted for MANAGER and above.
 *
 * Flow: the client sends a base64-encoded image in a JSON body. The server
 * decodes it, validates it is a real image via sharp, resizes/compresses it to
 * a 256x256 JPEG (which also strips metadata), uploads it to Cloudflare R2, and
 * stores the resulting public URL on the user's avatar_url. Removing a photo
 * clears avatar_url and deletes the object from R2.
 *
 * Uploads are gated by a per-route body-size guard (avatars are small), so the
 * app-wide 64kb JSON limit is not raised globally.
 */

'use strict';

const express = require('express');
const sharp   = require('sharp');
const { query, queryOne } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const r2 = require('../r2');

const router = express.Router();

// Manager and above may manage avatars.
router.use(requireAuth, requireRole('manager'));

// Accept a larger JSON body ON THIS ROUTER ONLY (images are bigger than 64kb).
// ~4MB of base64 covers a generous source image; we compress it right down.
router.use(express.json({ limit: '4mb' }));

const MAX_BYTES = 3 * 1024 * 1024; // 3MB decoded source cap
const OUT_SIZE  = 256;

// POST /api/avatars/:userId  { image: "data:image/png;base64,...." | "<base64>" }
router.post('/:userId', async (req, res) => {
  try {
    if (!r2.isConfigured) {
      return res.status(503).json({ error: 'Image storage is not configured on this server.' });
    }

    const target = await queryOne('SELECT id, role, avatar_url FROM users WHERE id = $1', [req.params.userId]);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    // Managers/admins may not modify a superuser's avatar unless they are superuser.
    if (target.role === 'superuser' && req.user.role !== 'superuser') {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }

    let raw = req.body && req.body.image;
    if (!raw || typeof raw !== 'string') {
      return res.status(400).json({ error: 'No image provided.' });
    }
    // Strip an optional data-URL prefix.
    const comma = raw.indexOf(',');
    if (raw.startsWith('data:') && comma !== -1) raw = raw.slice(comma + 1);

    let buf;
    try { buf = Buffer.from(raw, 'base64'); }
    catch { return res.status(400).json({ error: 'Image could not be decoded.' }); }

    if (!buf || buf.length === 0) return res.status(400).json({ error: 'Image is empty.' });
    if (buf.length > MAX_BYTES) {
      return res.status(413).json({ error: 'Image is too large. Please use an image under 3MB.' });
    }

    // Decode + resize with sharp. If sharp cannot parse it, it is not a real
    // image (this is the actual type check — we do not trust any extension).
    let out;
    try {
      out = await sharp(buf)
        .rotate()                      // honour EXIF orientation
        .resize(OUT_SIZE, OUT_SIZE, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
    } catch {
      return res.status(400).json({ error: 'That file does not appear to be a valid image.' });
    }

    // Stable key per user so a new photo overwrites the old (no orphan files).
    // Cache-busting query param is added to the stored URL so browsers refresh.
    const key = `avatars/${target.id}.jpg`;
    const publicUrl = await r2.putObject(key, out, 'image/jpeg');

    await query('UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2', [publicUrl, target.id]);
    res.json({ ok: true, avatarUrl: publicUrl });
  } catch (err) {
    console.error('Avatar upload error:', err.message);
    res.status(500).json({ error: 'Could not upload image.' });
  }
});

// DELETE /api/avatars/:userId  – remove the photo, revert to initials.
router.delete('/:userId', async (req, res) => {
  try {
    const target = await queryOne('SELECT id, role, avatar_url FROM users WHERE id = $1', [req.params.userId]);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.role === 'superuser' && req.user.role !== 'superuser') {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }

    await query('UPDATE users SET avatar_url = NULL, updated_at = NOW() WHERE id = $1', [target.id]);
    // Best-effort delete of the stored object; ignore if storage is unavailable.
    if (r2.isConfigured && target.avatar_url) {
      try { await r2.deleteObject(`avatars/${target.id}.jpg`); } catch (e) { /* non-fatal */ }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Avatar remove error:', err.message);
    res.status(500).json({ error: 'Could not remove image.' });
  }
});

module.exports = router;
