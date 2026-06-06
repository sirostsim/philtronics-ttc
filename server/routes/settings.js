/**
 * routes/settings.js — per-instance configuration (WT-DESIGN-001).
 *
 * GET  /api/settings/public   — non-sensitive subset for the browser (no auth):
 *                               branding, enabled features, labels, thresholds.
 * GET  /api/settings          — full settings (manager+), for the settings screen.
 * PUT  /api/settings          — update one or more settings (administrator+).
 *
 * All values fall back to current Philtronics behaviour when unset, so an
 * instance that has overridden nothing behaves exactly as before.
 */

'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const settings = require('../settings');

const router = express.Router();

// Public branding/feature subset — used to theme the app and toggle features.
// No auth: the login screen needs the branding before anyone signs in.
router.get('/public', async (req, res) => {
  try {
    const s = await settings.get();
    res.json(settings.publicSubset(s));
  } catch (e) {
    // Fall back to defaults so the app still renders.
    res.json(settings.publicSubset(settings.DEFAULTS));
  }
});

// Full settings (manager+), for the internal settings screen.
router.get('/', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const s = await settings.get();
    res.json(s);
  } catch (e) {
    res.status(500).json({ error: 'Could not load settings.' });
  }
});

// Validation rules per key. Anything not listed is rejected.
const VALIDATORS = {
  brand_customer_name:  v => typeof v === 'string' && v.length <= 100,
  brand_primary_colour: v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v),
  brand_login_text:     v => typeof v === 'string' && v.length <= 300,
  brand_logo_url:       v => typeof v === 'string' && v.length <= 500,
  hours_timezone:       v => typeof v === 'string' && v.length <= 64,
  hours_start:          v => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v),
  hours_end_by_day:     v => v && typeof v === 'object',
  hours_break_minutes:  v => v && typeof v === 'object',
  productivity_target_pct:   v => Number.isInteger(+v) && +v >= 1 && +v <= 100,
  warning_threshold_pct:     v => Number.isInteger(+v) && +v >= 1 && +v <= 100,
  overdue_threshold_pct:     v => Number.isInteger(+v) && +v >= 1 && +v <= 200,
  no_target_warning_minutes: v => Number.isInteger(+v) && +v >= 1 && +v <= 1440,
  feature_time_check:   v => typeof v === 'boolean' || v === 'on' || v === 'off',
  feature_raised_hands: v => typeof v === 'boolean' || v === 'on' || v === 'off',
  feature_messaging:    v => typeof v === 'boolean' || v === 'on' || v === 'off',
  feature_availability: v => typeof v === 'boolean' || v === 'on' || v === 'off',
  feature_quality_rft:  v => typeof v === 'boolean' || v === 'on' || v === 'off',
  feature_two_factor:   v => typeof v === 'boolean' || v === 'on' || v === 'off',
  terminology:          v => v && typeof v === 'object',
};

const JSON_KEYS = new Set(['hours_end_by_day', 'hours_break_minutes', 'terminology']);
const BOOL_KEYS = new Set(['feature_time_check', 'feature_raised_hands', 'feature_messaging', 'feature_availability', 'feature_quality_rft', 'feature_two_factor']);

function serialise(key, value) {
  if (JSON_KEYS.has(key)) return JSON.stringify(value);
  if (BOOL_KEYS.has(key)) return (value === true || value === 'on') ? 'on' : 'off';
  return String(value);
}

// Update one or more settings. Body: { settings: { key: value, ... } }
// Keys that only a superuser may change: the commercial feature toggles and
// the security-sensitive 2FA setting. Operational keys (branding, thresholds)
// remain editable by administrators (the customer's own admin).
const SUPERUSER_ONLY_KEYS = new Set([
  'feature_time_check', 'feature_raised_hands', 'feature_messaging',
  'feature_availability', 'feature_quality_rft', 'feature_two_factor',
]);

router.put('/', requireAuth, requireRole('administrator'), async (req, res) => {
  const updates = req.body && req.body.settings;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'settings object is required.' });
  }
  const keys = Object.keys(updates);
  const isSuperuser = req.user.role === 'superuser';
  for (const k of keys) {
    if (!(k in VALIDATORS)) return res.status(400).json({ error: `Unknown setting: ${k}` });
    if (SUPERUSER_ONLY_KEYS.has(k) && !isSuperuser) {
      return res.status(403).json({ error: 'That setting can only be changed by a superuser.' });
    }
    if (!VALIDATORS[k](updates[k])) return res.status(400).json({ error: `Invalid value for ${k}` });
  }
  try {
    for (const k of keys) {
      await query(
        `INSERT INTO config (key, value, updated_at, updated_by) VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
        [k, serialise(k, updates[k]), req.user.id]
      );
    }
    settings.invalidate();
    const s = await settings.get();
    res.json(s);
  } catch (e) {
    console.error('Update settings error:', e.message);
    res.status(500).json({ error: 'Could not update settings.' });
  }
});

module.exports = router;
