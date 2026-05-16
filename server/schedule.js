/**
 * schedule.js -- Working hours auto-pause/resume
 *
 * Working hours: 07:45 - 16:30 Mon-Fri, Europe/London timezone.
 * Runs every minute via setInterval.
 *
 * Railway cost note: ~1,440 lightweight DB queries/day.
 * Each query takes ~2ms and touches a small indexed table.
 * Estimated additional cost: negligible (<$0.01/month).
 */

'use strict';

const { query, queryOne } = require('./db');

const WORK_START = { hour: 7,  minute: 45 };
const WORK_END   = { hour: 16, minute: 30 };
const TZ         = 'Europe/London';

// Returns true if the current moment is within working hours (Mon-Fri only)
function isWorkingHours() {
  const now     = new Date();
  const london  = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: 'numeric', minute: 'numeric',
    weekday: 'short', hour12: false,
  }).formatToParts(now);

  const parts = {};
  london.forEach(p => { parts[p.type] = p.value; });

  const weekday = parts.weekday; // 'Mon', 'Tue', etc.
  if (['Sat', 'Sun'].includes(weekday)) return false;

  const h = parseInt(parts.hour,   10);
  const m = parseInt(parts.minute, 10);
  const nowMins  = h * 60 + m;
  const startMin = WORK_START.hour * 60 + WORK_START.minute;
  const endMin   = WORK_END.hour   * 60 + WORK_END.minute;

  return nowMins >= startMin && nowMins < endMin;
}

async function runSchedule() {
  try {
    const working = isWorkingHours();

    if (!working) {
      // Outside working hours -- pause all active timers that are not already paused
      // and were not manually paused (we don't want to overwrite a manual pause)
      const rows = await query(
        `SELECT id FROM timers
         WHERE status = 'active' AND paused_at IS NULL`,
        []
      );
      if (rows.length) {
        await query(
          `UPDATE timers SET
             paused_at    = NOW(),
             pause_reason = 'Outside working hours (07:45-16:30)',
             pause_type   = 'schedule',
             updated_at   = NOW()
           WHERE status = 'active' AND paused_at IS NULL`,
          []
        );
        console.log(`[schedule] Auto-paused ${rows.length} timer(s) -- outside working hours`);
      }
    } else {
      // Within working hours -- auto-resume any schedule-paused timers
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
        console.log(`[schedule] Auto-resumed ${rows.length} timer(s) -- within working hours`);
      }
    }
  } catch (err) {
    console.error('[schedule] Error:', err.message);
  }
}

function startSchedule() {
  console.log('[schedule] Working hours auto-pause/resume started (every 60s)');
  // Run immediately on startup to handle the current state
  runSchedule();
  // Then every 60 seconds
  return setInterval(runSchedule, 60 * 1000);
}

module.exports = { startSchedule };
