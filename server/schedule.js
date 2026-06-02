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

// Returns true if the current moment is within working hours
function isWorkingHours() {
  const now    = new Date();
  const london = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: 'numeric', minute: 'numeric',
    weekday: 'short', hour12: false,
  }).formatToParts(now);

  const parts = {};
  london.forEach(p => { parts[p.type] = p.value; });

  const weekday = parts.weekday;
  if (['Sat', 'Sun'].includes(weekday)) return false;

  const h       = parseInt(parts.hour,   10);
  const m       = parseInt(parts.minute, 10);
  const nowMins = h * 60 + m;
  const startMin = 7 * 60 + 45;  // 07:45
  const endMin   = weekday === 'Fri' ? 13 * 60 : 16 * 60 + 30; // Fri 13:00, else 16:30

  return nowMins >= startMin && nowMins < endMin;
}

// Returns true if we are at the start of a new working day
// Used to clear overnight overtime overrides
function isStartOfWorkingDay() {
  const now    = new Date();
  const london = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: 'numeric', minute: 'numeric',
    weekday: 'short', hour12: false,
  }).formatToParts(now);

  const parts = {};
  london.forEach(p => { parts[p.type] = p.value; });

  const weekday = parts.weekday;
  if (['Sat', 'Sun'].includes(weekday)) return false;

  const h = parseInt(parts.hour,   10);
  const m = parseInt(parts.minute, 10);
  // True for the 07:45 minute window (schedule runs every 60s)
  return h === 7 && m >= 45 && m < 46;
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
      // will auto-pause again at end of day if operator forgets to stop
      if (isStartOfWorkingDay()) {
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
