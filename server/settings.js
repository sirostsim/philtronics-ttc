/**
 * settings.js — central per-instance configuration loader (WT-DESIGN-001).
 *
 * Single source for every configurable value. Reads the config key/value store
 * and returns typed settings, falling back to the CURRENT Philtronics behaviour
 * as the default for every key. An instance that has overridden nothing behaves
 * exactly as the system did before the configuration layer existed.
 *
 * Values are cached in memory and refreshed on a short interval (and on demand
 * via invalidate()), so hot paths (the 60s schedule tick, productivity reports)
 * don't hit the database every call.
 */

'use strict';

const { query } = require('./db');

// ── Defaults: the current Philtronics specification ──────────────────────────
// These mirror migration 016 exactly. They are also the safety net if a key is
// somehow missing from the database.
const DEFAULTS = {
  brand_customer_name: 'Philtronics Ltd',
  brand_primary_colour: '#2e75b6',
  brand_login_text: '',
  brand_logo_url: '',

  hours_timezone: 'Europe/London',
  hours_start: '07:45',
  hours_end_by_day: { mon: '16:30', tue: '16:30', wed: '16:30', thu: '16:30', fri: '13:00', sat: null, sun: null },
  hours_break_minutes: { mon: 45, tue: 45, wed: 45, thu: 45, fri: 15, sat: 0, sun: 0 },

  productivity_target_pct: 80,
  warning_threshold_pct: 80,
  overdue_threshold_pct: 100,
  no_target_warning_minutes: 120,

  feature_time_check: true,
  feature_raised_hands: true,
  feature_messaging: true,
  feature_availability: true,
  feature_quality_rft: true,
  feature_two_factor: true,

  terminology: {},
};

// Keys whose stored string value is JSON.
const JSON_KEYS = new Set(['hours_end_by_day', 'hours_break_minutes', 'terminology']);
// Keys whose stored string value is an integer.
const INT_KEYS = new Set(['productivity_target_pct', 'warning_threshold_pct', 'overdue_threshold_pct', 'no_target_warning_minutes']);
// Keys whose stored string value is an on/off boolean.
const BOOL_KEYS = new Set(['feature_time_check', 'feature_raised_hands', 'feature_messaging', 'feature_availability', 'feature_quality_rft', 'feature_two_factor']);

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // JS getDay() order

let _cache = null;
let _loadedAt = 0;
const TTL_MS = 30 * 1000;

function _coerce(key, raw) {
  if (raw == null) return DEFAULTS[key];
  try {
    if (JSON_KEYS.has(key)) return JSON.parse(raw);
    if (INT_KEYS.has(key))  { const n = parseInt(raw, 10); return isNaN(n) ? DEFAULTS[key] : n; }
    if (BOOL_KEYS.has(key)) return String(raw).toLowerCase() === 'on' || raw === 'true';
    return raw;
  } catch (_) {
    return DEFAULTS[key];
  }
}

// Load all settings from the store, merged over defaults. Safe if the config
// table or some keys are missing (returns defaults).
async function load() {
  const settings = { ...DEFAULTS };
  try {
    const rows = await query('SELECT key, value FROM config');
    const byKey = {};
    for (const r of rows) byKey[r.key] = r.value;
    for (const key of Object.keys(DEFAULTS)) {
      if (key in byKey) settings[key] = _coerce(key, byKey[key]);
    }
  } catch (_) {
    // config table not present yet — defaults already in place.
  }
  _cache = settings;
  _loadedAt = Date.now();
  return settings;
}

// Cached getter for all settings.
async function get() {
  if (_cache && (Date.now() - _loadedAt) < TTL_MS) return _cache;
  return load();
}

// Synchronous access to the last-loaded cache (or defaults if never loaded).
// Useful where an async call isn't convenient; prefer get() on hot paths after
// an initial warm-up.
function peek() {
  return _cache || { ...DEFAULTS };
}

function invalidate() { _cache = null; _loadedAt = 0; }

// ── Derived helpers ──────────────────────────────────────────────────────────

// Working-day info for a given JS Date (or now), using configured hours.
// Returns { isWorkingDay, startMin, endMin, breakMinutes, timezone } where
// startMin/endMin are minutes-from-midnight in the configured timezone.
function workingDayInfo(settings, date = new Date()) {
  const tz = settings.hours_timezone || DEFAULTS.hours_timezone;
  const dow = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: tz })
    .format(date).toLowerCase().slice(0, 3); // mon, tue, ...
  const endStr = (settings.hours_end_by_day || {})[dow];
  if (!endStr) return { isWorkingDay: false, startMin: 0, endMin: 0, breakMinutes: 0, timezone: tz };
  const [sh, sm] = (settings.hours_start || '07:45').split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  const brk = (settings.hours_break_minutes || {})[dow] || 0;
  return {
    isWorkingDay: true,
    startMin: sh * 60 + sm,
    endMin: eh * 60 + em,
    breakMinutes: brk,
    timezone: tz,
  };
}

// Productivity baseline (available minutes) for a given date: the clock window
// minus the break/lunch allowance. Replaces the hard-coded 480 / 300.
function productivityBaselineMinutes(settings, date = new Date()) {
  const info = workingDayInfo(settings, date);
  if (!info.isWorkingDay) return 0;
  return Math.max(0, (info.endMin - info.startMin) - info.breakMinutes);
}

// The public-safe subset sent to the browser (no internal-only values here, but
// everything here is already non-sensitive).
function publicSubset(settings) {
  return {
    customerName: settings.brand_customer_name,
    primaryColour: settings.brand_primary_colour,
    loginText: settings.brand_login_text,
    logoUrl: settings.brand_logo_url,
    terminology: settings.terminology || {},
    features: {
      timeCheck: settings.feature_time_check,
      raisedHands: settings.feature_raised_hands,
      messaging: settings.feature_messaging,
      availability: settings.feature_availability,
      qualityRft: settings.feature_quality_rft,
      twoFactor: settings.feature_two_factor,
    },
    thresholds: {
      warningPct: settings.warning_threshold_pct,
      overduePct: settings.overdue_threshold_pct,
      noTargetWarningMinutes: settings.no_target_warning_minutes,
      productivityTargetPct: settings.productivity_target_pct,
    },
  };
}

module.exports = {
  DEFAULTS,
  load,
  get,
  peek,
  invalidate,
  workingDayInfo,
  productivityBaselineMinutes,
  publicSubset,
  DAY_KEYS,
};
