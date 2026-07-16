'use strict';

/**
 * lib/planner-schedule.js -- pure forward scheduler for the Planner.
 *
 * Given a start date and the total required minutes for a planned job, walk
 * forward over calendar days consuming each working day's available minutes,
 * skipping non-working days, and return the date the work finishes.
 *
 * availableMinutesForDate(date) supplies the working minutes for a given Date
 * (0 on non-working days). In production this wraps
 * settings.productivityBaselineMinutes(settings, date); in tests it is a simple
 * stub, so this function needs no database and is unit-testable on its own.
 */

function plannedEndDate(startDateISO, totalMinutes, availableMinutesForDate, maxDays = 730) {
  const startDate = String(startDateISO).slice(0, 10);
  if (!(totalMinutes > 0)) return { endDate: startDate, workingDays: 0, truncated: false };

  let remaining   = totalMinutes;
  let workingDays = 0;
  // Noon UTC avoids weekday drift when the availability function resolves the
  // day-of-week in a local timezone.
  const d = new Date(startDate + 'T12:00:00Z');

  for (let i = 0; i < maxDays; i++) {
    const avail = availableMinutesForDate(d) || 0;
    if (avail > 0) {
      workingDays++;
      remaining -= avail;
      if (remaining <= 0) {
        return { endDate: d.toISOString().slice(0, 10), workingDays, truncated: false };
      }
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  // Work did not fit within the horizon (e.g. a wildly large estimate).
  return { endDate: d.toISOString().slice(0, 10), workingDays, truncated: true };
}

module.exports = { plannedEndDate };
