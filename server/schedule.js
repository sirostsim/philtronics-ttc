/**
 * schedule.js -- Working hours auto-pause/resume
 *
 * Working hours: Mon-Thu 07:45-16:30, Fri 07:45-13:00, Europe/London timezone.
 * Runs every minute via setInterval.
 *
 * Overtime override: if an operator explicitly chooses to work overtime,
 * their timer is marked with pause_type = 'overtime_override'. The schedule
 * will not auto-pause these timers until the next working day starts.
 */

'use strict';

const { query, queryOne } = require('./db');

const TZ = 'Europe/London';
const settings = require('./settings');

// Returns true if the current moment is within working hours.
// Uses per-instance configured hours (falls back to Philtronics defaults).
function isWorkingHours() {
  const s = settings.peek();
  const now = new Date();
  const info = settings.workingDayInfo(s, now);
  if (!info.isWorkingDay) return false;

  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: info.timezone || TZ, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now).forEach(p => { parts[p.type] = p.value; });

  const nowMins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  return nowMins >= info.startMin && nowMins < info.endMin;
}

// Returns true if we are at the start of a new working day (the configured
// start minute). Used to clear overnight overtime overrides.
function isStartOfWorkingDay() {
  const s = settings.peek();
  const now = new Date();
  const info = settings.workingDayInfo(s, now);
  if (!info.isWorkingDay) return false;

  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: info.timezone || TZ, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now).forEach(p => { parts[p.type] = p.value; });

  const nowMins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  // True for the single minute at the configured start (schedule runs every 60s).
  return nowMins === info.startMin;
}

async function runSchedule() {
  try {
    const working = isWorkingHours();

    if (!working) {
      // Outside working hours — pause all active, unpaused timers
      // EXCEPT those the operator has explicitly marked as overtime override.
      const rows = await query(
        `SELECT id FROM timers
         WHERE status = 'active'
           AND paused_at IS NULL
           AND (pause_type IS DISTINCT FROM 'overtime_override')`,
        []
      );
      if (rows.length) {
        await query(
          `UPDATE timers SET
             paused_at    = NOW(),
             pause_reason = 'Outside working hours — tap Override to work overtime',
             pause_type   = 'schedule',
             updated_at   = NOW()
           WHERE status = 'active' AND paused_at IS NULL
             AND (pause_type IS DISTINCT FROM 'overtime_override')`,
          []
        );
        console.log(`[schedule] Auto-paused ${rows.length} timer(s) — outside working hours`);
      }

      // Close any operator-declared "unavailable" periods left open at end of
      // day, so a forgotten declaration doesn't bleed into the next day's
      // productivity. (Productivity clipping already bounds it to working hours.)
      try {
        const closed = await query(
          `UPDATE unavailability_periods SET ended_at = NOW()
           WHERE source = 'manual' AND ended_at IS NULL
           RETURNING id`,
          []
        );
        if (closed.length) {
          console.log(`[schedule] Auto-closed ${closed.length} open unavailable period(s) — end of day`);
        }
      } catch (e) { /* table may not exist yet — non-fatal */ }

      // Clear any forgotten standalone (no-job) raised hands at end of day.
      try {
        const lowered = await query(
          `UPDATE standalone_hands SET lowered_at = NOW() WHERE lowered_at IS NULL RETURNING id`,
          []
        );
        if (lowered.length) {
          console.log(`[schedule] Auto-cleared ${lowered.length} standalone hand(s) — end of day`);
        }
      } catch (e) { /* table may not exist yet — non-fatal */ }
    } else {
      // Within working hours — auto-resume any schedule-paused timers
      // Also clear any overtime_override flags at the start of the working day
      const rows = await query(
        `SELECT id FROM timers
         WHERE status = 'active'
           AND paused_at IS NOT NULL
           AND pause_type = 'schedule'`,
        []
      );
      if (rows.length) {
        await query(
          `UPDATE timers SET
             total_paused_seconds = total_paused_seconds +
               EXTRACT(EPOCH FROM (NOW() - paused_at))::int,
             paused_at    = NULL,
             pause_reason = NULL,
             pause_type   = NULL,
             updated_at   = NOW()
           WHERE status = 'active'
             AND paused_at IS NOT NULL
             AND pause_type = 'schedule'`,
          []
        );
        console.log(`[schedule] Auto-resumed ${rows.length} timer(s) — within working hours`);
      }

      // At start of working day, clear overtime_override flags so the schedule
      // will auto-pause again at end of day if operator forgets to stop.
      // An override timer is normally running (paused_at NULL), so this must not
      // filter on paused_at; the COALESCE keeps the arithmetic valid either way.
      if (isStartOfWorkingDay()) {
        await query(
          `UPDATE timers SET
             total_paused_seconds = total_paused_seconds +
               COALESCE(EXTRACT(EPOCH FROM (NOW() - paused_at))::int, 0),
             paused_at    = NULL,
             pause_reason = NULL,
             pause_type   = NULL,
             updated_at   = NOW()
           WHERE status = 'active'
             AND pause_type = 'overtime_override'`,
          []
        );
      }
    }
  } catch (err) {
    console.error('[schedule] Error:', err.message);
  }
}

function startSchedule() {
  console.log('[schedule] Working hours auto-pause/resume started (every 60s)');
  runSchedule();
  return setInterval(runSchedule, 60 * 1000);
}

module.exports = { startSchedule };
