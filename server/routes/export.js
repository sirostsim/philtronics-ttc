/**
 * routes/export.js – CSV export and stats (PostgreSQL version)
 */

'use strict';

const express = require('express');
const { stringify } = require('csv-stringify/sync');
const { query, queryOne } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('manager'));

function toLocalString(val) {
  if (!val) return '';
  return new Date(val).toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).replace(',', '');
}

// ─── GET /api/export/csv ──────────────────────────────────────────────────────
router.get('/csv', async (req, res) => {
  try {
    const { from, to, operatorId, itemNumber } = req.query;
    const conditions = [`t.status != 'cancelled'`];
    const params = [];
    let p = 1;

    if (from) { conditions.push(`t.started_at >= $${p++}`); params.push(new Date(from).toISOString()); }
    if (to)   {
      const e = new Date(to); e.setHours(23,59,59,999);
      conditions.push(`t.started_at <= $${p++}`); params.push(e.toISOString());
    }
    if (operatorId) { conditions.push(`t.operator_id = $${p++}`); params.push(operatorId); }
    if (itemNumber) { conditions.push(`t.item_number ILIKE $${p++}`); params.push(`%${itemNumber}%`); }

    const rows = await query(
      `SELECT t.item_number, t.operator_id, t.operator_name,
              t.started_at, t.completed_at, t.duration_seconds,
              t.time_check, t.workstation, t.wo_number, t.notes, t.status
       FROM timers t
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.started_at ASC`,
      params
    );

    const csvRows = rows.map(r => ({
      itemNumber:       r.item_number,
      operatorId:       r.operator_id,
      operatorName:     r.operator_name,
      startedAtUTC:     r.started_at ? new Date(r.started_at).toISOString() : '',
      startedAtLocal:   toLocalString(r.started_at),
      completedAtUTC:   r.completed_at ? new Date(r.completed_at).toISOString() : '',
      completedAtLocal: toLocalString(r.completed_at),
      durationSeconds:  r.duration_seconds != null ? r.duration_seconds : '',
      durationMinutes:  r.duration_seconds != null ? (r.duration_seconds / 60).toFixed(2) : '',
      timeCheck:        r.time_check ? 'Yes' : 'No',
      workstation:      r.workstation || '',
      woNumber:         r.wo_number || '',
      notes:            r.notes || '',
      status:           r.status,
    }));

    const csv = stringify(csvRows, {
      header: true,
      columns: [
        { key: 'itemNumber',       header: 'Item Number'          },
        { key: 'operatorId',       header: 'Operator ID'          },
        { key: 'operatorName',     header: 'Operator Name'        },
        { key: 'startedAtUTC',     header: 'Started At (UTC)'     },
        { key: 'startedAtLocal',   header: 'Started At (London)'  },
        { key: 'completedAtUTC',   header: 'Completed At (UTC)'   },
        { key: 'completedAtLocal', header: 'Completed At (London)'},
        { key: 'durationSeconds',  header: 'Duration (Seconds)'   },
        { key: 'durationMinutes',  header: 'Duration (Minutes)'   },
        { key: 'timeCheck',        header: 'Time Check'            },
        { key: 'workstation',      header: 'Workstation'           },
        { key: 'woNumber',         header: 'W/O Number'            },
        { key: 'notes',            header: 'Notes'                 },
        { key: 'status',           header: 'Status'                },
      ],
    });

    const filename = `philtronics-timings-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    console.error('Export error:', err.message);
    res.status(500).json({ error: 'Export failed.' });
  }
});

// ─── GET /api/export/stats ────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const { from, to, operatorId, itemNumber } = req.query;
    const conditions = [`status = 'completed'`];
    const params = [];
    let p = 1;

    if (from) { conditions.push(`started_at >= $${p++}`); params.push(new Date(from).toISOString()); }
    if (to)   {
      const e = new Date(to); e.setHours(23,59,59,999);
      conditions.push(`started_at <= $${p++}`); params.push(e.toISOString());
    }
    if (operatorId) { conditions.push(`operator_id = $${p++}`); params.push(operatorId); }
    if (itemNumber) { conditions.push(`item_number ILIKE $${p++}`); params.push(`%${itemNumber}%`); }

    const byItem = await query(
      `SELECT t.item_number,
              COUNT(*)::int                        AS count,
              ROUND(AVG(t.duration_seconds))::int  AS avg_seconds,
              MIN(t.duration_seconds)              AS min_seconds,
              MAX(t.duration_seconds)              AS max_seconds,
              -- Target time joined from target_times (null if not set)
              MAX(tt.hours * 3600 + tt.minutes * 60)::int AS target_seconds
       FROM timers t
       LEFT JOIN target_times tt ON tt.item_number = t.item_number
       WHERE ${conditions.join(' AND ')}
       GROUP BY t.item_number
       ORDER BY count DESC
       LIMIT 50`,
      params
    );

    const h24 = new Date(Date.now() - 24*3600*1000).toISOString();
    const d7  = new Date(Date.now() -  7*24*3600*1000).toISOString();

    const [r24] = await query(
      `SELECT COUNT(*)::int AS c FROM timers WHERE status='completed' AND started_at >= $1`, [h24]
    );
    const [r7] = await query(
      `SELECT COUNT(*)::int AS c FROM timers WHERE status='completed' AND started_at >= $1`, [d7]
    );
    const [ra] = await query(
      `SELECT COUNT(*)::int AS c FROM timers WHERE status='active'`
    );

    res.json({ byItem, total24h: r24.c, total7d: r7.c, activeCount: ra.c });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Could not load stats.' });
  }
});

// ─── GET /api/export/report/operators ────────────────────────────────────────
// Operator performance: jobs completed, avg time, vs target, overdue count
router.get('/report/operators', async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = [];
    let p = 1;
    const dateConditions = [`status = 'completed'`];
    if (from) { dateConditions.push(`started_at >= $${p++}`); params.push(new Date(from).toISOString()); }
    if (to)   { const e = new Date(to); e.setHours(23,59,59,999); dateConditions.push(`started_at <= $${p++}`); params.push(e.toISOString()); }

    const rows = await query(
      `SELECT
         t.operator_id,
         t.operator_name,
         COUNT(*)::int                                      AS jobs_completed,
         ROUND(AVG(t.duration_seconds))::int               AS avg_seconds,
         MIN(t.duration_seconds)                           AS min_seconds,
         MAX(t.duration_seconds)                           AS max_seconds,
         COUNT(CASE WHEN tt.hours IS NOT NULL
               AND t.duration_seconds > (tt.hours * 3600 + tt.minutes * 60)
               THEN 1 END)::int                            AS overdue_count,
         COUNT(CASE WHEN t.time_check = true THEN 1 END)::int AS time_check_count
       FROM timers t
       LEFT JOIN target_times tt ON tt.item_number = t.item_number
       WHERE ${dateConditions.join(' AND ')}
       GROUP BY t.operator_id, t.operator_name
       ORDER BY jobs_completed DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('Operator report error:', err.message);
    res.status(500).json({ error: 'Could not load operator report.' });
  }
});

// ─── GET /api/export/report/trends ───────────────────────────────────────────
// Daily job counts and avg duration over time
router.get('/report/trends', async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = [];
    let p = 1;
    const dateConditions = [`status = 'completed'`];
    if (from) { dateConditions.push(`started_at >= $${p++}`); params.push(new Date(from).toISOString()); }
    if (to)   { const e = new Date(to); e.setHours(23,59,59,999); dateConditions.push(`started_at <= $${p++}`); params.push(e.toISOString()); }

    const rows = await query(
      `SELECT
         DATE(started_at AT TIME ZONE 'Europe/London') AS day,
         COUNT(*)::int                                 AS jobs_completed,
         ROUND(AVG(duration_seconds))::int             AS avg_seconds,
         COUNT(CASE WHEN tt.hours IS NOT NULL
               AND duration_seconds > (tt.hours * 3600 + tt.minutes * 60)
               THEN 1 END)::int                        AS overdue_count
       FROM timers t
       LEFT JOIN target_times tt ON tt.item_number = t.item_number
       WHERE ${dateConditions.join(' AND ')}
       GROUP BY DATE(started_at AT TIME ZONE 'Europe/London')
       ORDER BY day ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('Trends report error:', err.message);
    res.status(500).json({ error: 'Could not load trends report.' });
  }
});

// ─── GET /api/export/report/overdue ──────────────────────────────────────────
// Items and operators with the most overdue completions
router.get('/report/overdue', async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = [];
    let p = 1;
    const dateConditions = [
      `t.status = 'completed'`,
      `tt.hours IS NOT NULL`,
      `t.duration_seconds > (tt.hours * 3600 + tt.minutes * 60)`,
    ];
    if (from) { dateConditions.push(`t.started_at >= $${p++}`); params.push(new Date(from).toISOString()); }
    if (to)   { const e = new Date(to); e.setHours(23,59,59,999); dateConditions.push(`t.started_at <= $${p++}`); params.push(e.toISOString()); }

    const byItem = await query(
      `SELECT
         t.item_number,
         COUNT(*)::int                                                        AS overdue_count,
         ROUND(AVG(t.duration_seconds - (tt.hours * 3600 + tt.minutes * 60)))::int AS avg_overrun_seconds,
         MAX(t.duration_seconds - (tt.hours * 3600 + tt.minutes * 60))       AS max_overrun_seconds,
         MAX(tt.hours * 3600 + tt.minutes * 60)::int                         AS target_seconds
       FROM timers t
       JOIN target_times tt ON tt.item_number = t.item_number
       WHERE ${dateConditions.join(' AND ')}
       GROUP BY t.item_number
       ORDER BY overdue_count DESC
       LIMIT 10`,
      params
    );

    const byOperator = await query(
      `SELECT
         t.operator_name,
         COUNT(*)::int                                                        AS overdue_count,
         ROUND(AVG(t.duration_seconds - (tt.hours * 3600 + tt.minutes * 60)))::int AS avg_overrun_seconds
       FROM timers t
       JOIN target_times tt ON tt.item_number = t.item_number
       WHERE ${dateConditions.join(' AND ')}
       GROUP BY t.operator_id, t.operator_name
       ORDER BY overdue_count DESC
       LIMIT 10`,
      params
    );

    res.json({ byItem, byOperator });
  } catch (err) {
    console.error('Overdue report error:', err.message);
    res.status(500).json({ error: 'Could not load overdue report.' });
  }
});

// ─── GET /api/export/report/csv ──────────────────────────────────────────────
// Full reporting CSV with target comparison
router.get('/report/csv', async (req, res) => {
  try {
    const { from, to, operatorId, itemNumber } = req.query;
    const conditions = [`t.status = 'completed'`];
    const params = [];
    let p = 1;
    if (from) { conditions.push(`t.started_at >= $${p++}`); params.push(new Date(from).toISOString()); }
    if (to)   { const e = new Date(to); e.setHours(23,59,59,999); conditions.push(`t.started_at <= $${p++}`); params.push(e.toISOString()); }
    if (operatorId) { conditions.push(`t.operator_id = $${p++}`); params.push(operatorId); }
    if (itemNumber) { conditions.push(`t.item_number ILIKE $${p++}`); params.push(`%${itemNumber}%`); }

    const rows = await query(
      `SELECT t.item_number, t.operator_name, t.started_at, t.completed_at,
              t.duration_seconds, t.workstation, t.wo_number, t.time_check,
              (tt.hours * 3600 + tt.minutes * 60)::int AS target_seconds
       FROM timers t
       LEFT JOIN target_times tt ON tt.item_number = t.item_number
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.started_at DESC`,
      params
    );

    const csvRows = rows.map(r => {
      const target = r.target_seconds || null;
      const actual = r.duration_seconds;
      const delta  = target && actual ? actual - target : null;
      return {
        itemNumber:      r.item_number,
        operatorName:    r.operator_name,
        startedAt:       toLocalString(r.started_at),
        completedAt:     toLocalString(r.completed_at),
        durationSeconds: actual != null ? actual : '',
        durationMinutes: actual != null ? (actual / 60).toFixed(2) : '',
        targetSeconds:   target != null ? target : '',
        targetMinutes:   target != null ? (target / 60).toFixed(2) : '',
        deltaSeconds:    delta != null ? delta : '',
        deltaMinutes:    delta != null ? (delta / 60).toFixed(2) : '',
        vsTarget:        delta == null ? 'No target' : delta > 0 ? 'Over' : delta < 0 ? 'Under' : 'On target',
        workstation:     r.workstation || '',
        woNumber:        r.wo_number || '',
        timeCheck:       r.time_check ? 'Yes' : 'No',
      };
    });

    const csv = stringify(csvRows, {
      header: true,
      columns: [
        { key: 'itemNumber',      header: 'Item Number'        },
        { key: 'operatorName',    header: 'Operator'           },
        { key: 'startedAt',       header: 'Started At'         },
        { key: 'completedAt',     header: 'Completed At'       },
        { key: 'durationSeconds', header: 'Actual (Seconds)'   },
        { key: 'durationMinutes', header: 'Actual (Minutes)'   },
        { key: 'targetSeconds',   header: 'Target (Seconds)'   },
        { key: 'targetMinutes',   header: 'Target (Minutes)'   },
        { key: 'deltaSeconds',    header: 'Delta (Seconds)'    },
        { key: 'deltaMinutes',    header: 'Delta (Minutes)'    },
        { key: 'vsTarget',        header: 'vs Target'          },
        { key: 'workstation',     header: 'Workstation'        },
        { key: 'woNumber',        header: 'W/O Number'         },
        { key: 'timeCheck',       header: 'Time Check'         },
      ],
    });

    const filename = `philtronics-report-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    console.error('Report CSV error:', err.message);
    res.status(500).json({ error: 'Export failed.' });
  }
});

// ─── GET /api/export/productivity ────────────────────────────────────────────
// Returns per-operator productivity with optional daily breakdown.
// Available productive minutes per day (after breaks):
//   Mon–Thu: 07:45–16:30 minus 15m break, 30m lunch = 480 min
//   Fri:     07:45–13:00 minus 15m break             = 300 min
//   Sat/Sun: 0

const TZ = 'Europe/London';

function workDayMinutes(dateStr) {
  const dow = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: TZ })
    .format(new Date(dateStr + 'T12:00:00Z')).toLowerCase();
  if (dow === 'sat' || dow === 'sun') return 0;
  return dow === 'fri' ? 300 : 480;
}

function workDayWindow(dateStr) {
  const dow = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: TZ })
    .format(new Date(dateStr + 'T12:00:00Z')).toLowerCase();
  if (dow === 'sat' || dow === 'sun') return null;
  const endTime = dow === 'fri' ? '13:00' : '16:30';
  return {
    start: new Date(`${dateStr}T07:45:00`),
    end:   new Date(`${dateStr}T${endTime}:00`),
  };
}

function calcActiveSecondsForDay(timerList, dayStr) {
  const window = workDayWindow(dayStr);
  if (!window) return 0;
  const windowSecs = (window.end - window.start) / 1000;
  let secs = 0;
  for (const t of timerList) {
    const tStart = new Date(t.started_at);
    if (tStart.toISOString().slice(0,10) !== dayStr) continue;
    const tEnd   = t.completed_at ? new Date(t.completed_at) : new Date();
    const net    = t.status === 'completed' && t.duration_seconds != null
      ? t.duration_seconds
      : Math.max(0, (tEnd - tStart) / 1000 - (t.total_paused_seconds || 0));
    secs += Math.min(net, windowSecs);
  }
  return secs;
}

router.get('/productivity', async (req, res) => {
  try {
    const { from, to, department, groupByDay } = req.query;
    const byDay = groupByDay === 'true';

    const fromDt = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const toDt   = to
      ? (() => { const d = new Date(to); d.setHours(23,59,59,999); return d; })()
      : new Date();

    // Get productivity target from config
    let targetPct = 80;
    try {
      const configRow = await queryOne(`SELECT value FROM config WHERE key = 'productivity_target_pct'`);
      if (configRow) targetPct = parseInt(configRow.value, 10);
    } catch (_) { /* config table not yet created — use default */ }

    // Build operator conditions
    const conditions = [`u.role = 'operator'`, `u.is_active = TRUE`];
    const params = [];
    let p = 1;
    if (department) { conditions.push(`u.department = $${p++}`); params.push(department); }

    const operators = await query(
      `SELECT u.id, u.full_name, u.department FROM users u
       WHERE ${conditions.join(' AND ')} ORDER BY u.full_name`,
      params
    );
    if (!operators.length) return res.json({ targetPct, operators: [] });

    // Get timers
    const opIds = operators.map(o => o.id);
    const timers = await query(
      `SELECT t.operator_id, t.started_at, t.completed_at, t.status,
              t.total_paused_seconds, t.duration_seconds
       FROM timers t
       WHERE t.operator_id = ANY($1)
         AND t.status IN ('completed','active','cancelled')
         AND t.started_at >= $2 AND t.started_at <= $3
       ORDER BY t.operator_id, t.started_at`,
      [opIds, fromDt.toISOString(), toDt.toISOString()]
    );

    const timersByOp = {};
    for (const t of timers) {
      if (!timersByOp[t.operator_id]) timersByOp[t.operator_id] = [];
      timersByOp[t.operator_id].push(t);
    }

    // Build working days list
    const days = [];
    let totalAvailableMins = 0;
    const cur = new Date(fromDt); cur.setHours(0,0,0,0);
    const endD = new Date(toDt);  endD.setHours(23,59,59,999);
    while (cur <= endD) {
      const ds = cur.toISOString().slice(0,10);
      const mins = workDayMinutes(ds);
      if (mins > 0) { days.push({ date: ds, availableMins: mins }); totalAvailableMins += mins; }
      cur.setDate(cur.getDate() + 1);
    }

    const result = operators.map(op => {
      const opTimers = timersByOp[op.id] || [];
      let totalActiveSeconds = 0;

      // Daily breakdown
      const daily = byDay ? days.map(({ date, availableMins }) => {
        const activeSecs = calcActiveSecondsForDay(opTimers, date);
        const activeMins = Math.round(activeSecs / 60);
        const pct = availableMins > 0 ? Math.min(100, Math.round(activeMins / availableMins * 100)) : 0;
        totalActiveSeconds += activeSecs;
        return {
          date,
          availableMins,
          activeMinutes: activeMins,
          productivityPct: pct,
          vsTarget: pct - targetPct,
        };
      }) : null;

      if (!byDay) {
        // Aggregate without daily breakdown
        for (const t of opTimers) {
          const ds = new Date(t.started_at).toISOString().slice(0,10);
          totalActiveSeconds += calcActiveSecondsForDay([t], ds);
        }
      }

      const totalActiveMins = Math.round(totalActiveSeconds / 60);
      const overallPct = totalAvailableMins > 0
        ? Math.min(100, Math.round(totalActiveMins / totalAvailableMins * 100))
        : 0;

      return {
        operatorId:            op.id,
        operatorName:          op.full_name,
        department:            op.department,
        activeMinutes:         totalActiveMins,
        activeHoursDisplay:    `${Math.floor(totalActiveMins/60)}h ${totalActiveMins%60}m`,
        availableMinutes:      totalAvailableMins,
        availableHoursDisplay: `${Math.floor(totalAvailableMins/60)}h ${totalAvailableMins%60}m`,
        productivityPct:       overallPct,
        vsTarget:              overallPct - targetPct,
        timerCount:            opTimers.length,
        targetPct,
        daily,
      };
    });

    res.json({
      targetPct,
      operators: result.sort((a,b) => b.productivityPct - a.productivityPct),
    });
  } catch (err) {
    console.error('Productivity error:', err.message);
    res.status(500).json({ error: 'Could not calculate productivity.' });
  }
});

// ─── GET /api/export/productivity/csv ────────────────────────────────────────
router.get('/productivity/csv', async (req, res) => {
  try {
    const { from, to, department } = req.query;

    const fromDt = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const toDt   = to
      ? (() => { const d = new Date(to); d.setHours(23,59,59,999); return d; })()
      : new Date();

    let targetPct = 80;
    try {
      const configRow = await queryOne(`SELECT value FROM config WHERE key = 'productivity_target_pct'`);
      if (configRow) targetPct = parseInt(configRow.value, 10);
    } catch (_) { /* config table not yet created — use default */ }

    const conditions = [`u.role = 'operator'`, `u.is_active = TRUE`];
    const params = [];
    let p = 1;
    if (department) { conditions.push(`u.department = $${p++}`); params.push(department); }

    const operators = await query(
      `SELECT u.id, u.full_name, u.department FROM users u
       WHERE ${conditions.join(' AND ')} ORDER BY u.full_name`,
      params
    );
    if (!operators.length) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.send('\uFEFFNo operator data found.');
      return;
    }

    const opIds  = operators.map(o => o.id);
    const timers = await query(
      `SELECT t.operator_id, t.started_at, t.completed_at, t.status,
              t.total_paused_seconds, t.duration_seconds
       FROM timers t
       WHERE t.operator_id = ANY($1)
         AND t.status IN ('completed','active','cancelled')
         AND t.started_at >= $2 AND t.started_at <= $3
       ORDER BY t.operator_id, t.started_at`,
      [opIds, fromDt.toISOString(), toDt.toISOString()]
    );

    const timersByOp = {};
    for (const t of timers) {
      if (!timersByOp[t.operator_id]) timersByOp[t.operator_id] = [];
      timersByOp[t.operator_id].push(t);
    }

    // Build working days
    const days = [];
    let totalAvailableMins = 0;
    const cur = new Date(fromDt); cur.setHours(0,0,0,0);
    const endD = new Date(toDt);  endD.setHours(23,59,59,999);
    while (cur <= endD) {
      const ds   = cur.toISOString().slice(0,10);
      const mins = workDayMinutes(ds);
      if (mins > 0) { days.push({ date: ds, availableMins: mins }); totalAvailableMins += mins; }
      cur.setDate(cur.getDate() + 1);
    }

    // Build CSV rows — one row per operator per day, plus a summary row
    const csvRows = [];
    for (const op of operators) {
      const opTimers = timersByOp[op.id] || [];
      let totalActiveMins = 0;

      for (const { date, availableMins } of days) {
        const activeSecs = calcActiveSecondsForDay(opTimers, date);
        const activeMins = Math.round(activeSecs / 60);
        totalActiveMins += activeMins;
        const pct = availableMins > 0 ? Math.min(100, Math.round(activeMins / availableMins * 100)) : 0;
        const dow = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: TZ })
          .format(new Date(date + 'T12:00:00Z'));
        csvRows.push({
          operator:        op.full_name,
          department:      op.department || '',
          date,
          dayOfWeek:       dow,
          availableMins,
          availableHours:  (availableMins / 60).toFixed(2),
          activeMinutes:   activeMins,
          activeHours:     (activeMins / 60).toFixed(2),
          productivityPct: pct,
          targetPct,
          vsTargetPct:     pct - targetPct,
          status:          pct >= targetPct ? 'On Target' : pct >= targetPct * 0.7 ? 'Near Target' : 'Below Target',
        });
      }

      // Summary row for this operator
      const overallPct = totalAvailableMins > 0
        ? Math.min(100, Math.round(totalActiveMins / totalAvailableMins * 100))
        : 0;
      csvRows.push({
        operator:        op.full_name,
        department:      op.department || '',
        date:            'TOTAL',
        dayOfWeek:       '',
        availableMins:   totalAvailableMins,
        availableHours:  (totalAvailableMins / 60).toFixed(2),
        activeMinutes:   totalActiveMins,
        activeHours:     (totalActiveMins / 60).toFixed(2),
        productivityPct: overallPct,
        targetPct,
        vsTargetPct:     overallPct - targetPct,
        status:          overallPct >= targetPct ? 'On Target' : overallPct >= targetPct * 0.7 ? 'Near Target' : 'Below Target',
      });
    }

    const csv = stringify(csvRows, {
      header: true,
      columns: [
        { key: 'operator',        header: 'Operator'              },
        { key: 'department',      header: 'Department'            },
        { key: 'date',            header: 'Date'                  },
        { key: 'dayOfWeek',       header: 'Day'                   },
        { key: 'availableMins',   header: 'Available (Mins)'      },
        { key: 'availableHours',  header: 'Available (Hours)'     },
        { key: 'activeMinutes',   header: 'Active (Mins)'         },
        { key: 'activeHours',     header: 'Active (Hours)'        },
        { key: 'productivityPct', header: 'Productivity %'        },
        { key: 'targetPct',       header: 'Target %'              },
        { key: 'vsTargetPct',     header: 'vs Target %'           },
        { key: 'status',          header: 'Status'                },
      ],
    });

    const dateStr = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="productivity-${dateStr}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    console.error('Productivity CSV error:', err.message);
    res.status(500).json({ error: 'Export failed.' });
  }
});

// ─── GET /api/export/assembly-summary ────────────────────────────────────────
// Groups completed timers by item_number + wo_number + route_card_number
// Returns per-operator breakdown plus combined and elapsed totals
router.get('/assembly-summary', async (req, res) => {
  try {
    const { from, to, item, wo, rc } = req.query;
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30*24*60*60*1000);
    const toDate   = to   ? new Date(to)   : new Date();

    // Pull all completed timers in range that have at least a wo_number
    let sql = `
      SELECT
        t.id,
        t.item_number,
        t.wo_number,
        t.route_card_number,
        t.operator_id,
        t.operator_name,
        t.started_at,
        t.completed_at,
        t.duration_seconds,
        t.workstation,
        t.department
      FROM timers t
      WHERE t.status = 'completed'
        AND t.completed_at >= $1
        AND t.completed_at <= $2
        AND t.wo_number IS NOT NULL
    `;
    const params = [fromDate, toDate];

    if (item) { sql += ` AND t.item_number ILIKE $${params.length+1}`; params.push(`%${item}%`); }
    if (wo)   { sql += ` AND t.wo_number   ILIKE $${params.length+1}`; params.push(`%${wo}%`); }
    if (rc)   { sql += ` AND t.route_card_number ILIKE $${params.length+1}`; params.push(`%${rc}%`); }

    sql += ` ORDER BY t.item_number, t.wo_number, t.route_card_number, t.started_at`;

    const rows = await query(sql, params);

    // Group into assemblies keyed by item|wo|rc
    const assemblyMap = {};
    for (const r of rows) {
      const key = [
        r.item_number,
        r.wo_number,
        r.route_card_number || '',
      ].join('|||');

      if (!assemblyMap[key]) {
        assemblyMap[key] = {
          itemNumber:      r.item_number,
          woNumber:        r.wo_number,
          routeCardNumber: r.route_card_number || null,
          department:      r.department,
          operators:       [],
          records:         [],
        };
      }
      assemblyMap[key].records.push(r);
    }

    // For each assembly, calculate operator breakdown + totals
    const assemblies = Object.values(assemblyMap).map(a => {
      // Per-operator totals (an operator may have multiple stints)
      const opMap = {};
      for (const r of a.records) {
        if (!opMap[r.operator_id]) {
          opMap[r.operator_id] = {
            operatorId:   r.operator_id,
            operatorName: r.operator_name,
            workstation:  r.workstation,
            totalSeconds: 0,
            stints:       [],
          };
        }
        opMap[r.operator_id].totalSeconds += (r.duration_seconds || 0);
        opMap[r.operator_id].stints.push({
          startedAt:   r.started_at,
          completedAt: r.completed_at,
          seconds:     r.duration_seconds || 0,
        });
      }
      const operators = Object.values(opMap);

      // Combined time = sum of all operator durations (total operator-hours)
      const combinedSeconds = operators.reduce((s, o) => s + o.totalSeconds, 0);

      // Elapsed time = wall-clock from first start to last completion
      const allStarts = a.records.map(r => new Date(r.started_at).getTime());
      const allEnds   = a.records.map(r => r.completed_at ? new Date(r.completed_at).getTime() : null).filter(Boolean);
      const firstStart = allStarts.length  ? Math.min(...allStarts) : null;
      const lastEnd    = allEnds.length    ? Math.max(...allEnds)   : null;
      const elapsedSeconds = (firstStart && lastEnd) ? Math.round((lastEnd - firstStart) / 1000) : null;

      // Overlap = combined - elapsed (how many seconds operators worked simultaneously)
      const overlapSeconds = (elapsedSeconds !== null && combinedSeconds > elapsedSeconds)
        ? combinedSeconds - elapsedSeconds : 0;

      const fmt = s => {
        if (!s && s !== 0) return null;
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return h > 0
          ? `${h}h ${String(m).padStart(2,'0')}m`
          : `${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
      };

      return {
        itemNumber:              a.itemNumber,
        woNumber:                a.woNumber,
        routeCardNumber:         a.routeCardNumber,
        department:              a.department,
        operatorCount:           operators.length,
        operators:               operators.map(o => ({
          ...o,
          totalDisplay: fmt(o.totalSeconds),
          stints: o.stints.map(s => ({
            ...s,
            display: fmt(s.seconds),
          })),
        })),
        combinedSeconds,
        elapsedSeconds,
        overlapSeconds,
        combinedDisplay:         fmt(combinedSeconds),
        elapsedDisplay:          fmt(elapsedSeconds),
        overlapDisplay:          fmt(overlapSeconds),
        firstStart:              firstStart ? new Date(firstStart).toISOString() : null,
        lastEnd:                 lastEnd    ? new Date(lastEnd).toISOString()    : null,
        multiOperator:           operators.length > 1,
      };
    });

    // Sort: multi-operator first, then by item number
    assemblies.sort((a, b) => {
      if (b.multiOperator !== a.multiOperator) return b.multiOperator ? 1 : -1;
      return a.itemNumber.localeCompare(b.itemNumber);
    });

    res.json({ assemblies, total: assemblies.length });
  } catch (err) {
    console.error('Assembly summary error:', err.message);
    res.status(500).json({ error: 'Could not load assembly summary.' });
  }
});

// ─── GET /api/export/assembly-summary/csv ────────────────────────────────────
router.get('/assembly-summary/csv', async (req, res) => {
  try {
    // Re-use the same logic via internal fetch pattern
    const { from, to } = req.query;
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30*24*60*60*1000);
    const toDate   = to   ? new Date(to)   : new Date();

    const rows = await query(`
      SELECT
        t.item_number, t.wo_number, t.route_card_number,
        t.operator_name, t.started_at, t.completed_at,
        t.duration_seconds, t.workstation, t.department
      FROM timers t
      WHERE t.status = 'completed'
        AND t.completed_at >= $1 AND t.completed_at <= $2
        AND t.wo_number IS NOT NULL
      ORDER BY t.item_number, t.wo_number, t.route_card_number, t.started_at
    `, [fromDate, toDate]);

    const lines = [
      ['Item Number','W/O Number','Route Card','Operator','Department',
       'Workstation','Started At','Completed At','Duration (mins)'].join(','),
    ];
    for (const r of rows) {
      lines.push([
        r.item_number,
        r.wo_number,
        r.route_card_number || '',
        r.operator_name,
        r.department || '',
        r.workstation || '',
        r.started_at  ? new Date(r.started_at).toLocaleString('en-GB')  : '',
        r.completed_at? new Date(r.completed_at).toLocaleString('en-GB'): '',
        r.duration_seconds ? Math.round(r.duration_seconds / 60) : '',
      ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
    }

    const filename = `assembly-summary-${fromDate.toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\r\n'));
  } catch (err) {
    console.error('Assembly CSV error:', err.message);
    res.status(500).json({ error: 'Export failed.' });
  }
});

module.exports = router;
