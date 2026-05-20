/**
 * routes/export.js – CSV export and stats (PostgreSQL version)
 */

'use strict';

const express = require('express');
const { stringify } = require('csv-stringify/sync');
const { query } = require('../db');
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
// Returns per-operator productivity rate for a given date range.
// Available productive minutes per day (after breaks):
//   Mon–Thu: 07:45–16:30 minus 15m break, 30m lunch = 480 min
//   Fri:     07:45–13:00 minus 15m break             = 300 min
//   Sat/Sun: 0
// Productivity = (capped net active seconds) / (available seconds) * 100

const TZ = 'Europe/London';

function workDayMinutes(dateStr) {
  // dateStr: 'YYYY-MM-DD'
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: TZ })
    .format(d).toLowerCase();
  if (dow === 'sat' || dow === 'sun') return 0;
  if (dow === 'fri') return 300; // 5h after break
  return 480; // 8h after breaks Mon–Thu
}

function workDayWindow(dateStr) {
  // Returns { start, end } as UTC Date objects for the working window in Europe/London
  const dow = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: TZ })
    .format(new Date(dateStr + 'T12:00:00Z')).toLowerCase();
  if (dow === 'sat' || dow === 'sun') return null;
  const endTime = dow === 'fri' ? '13:00' : '16:30';
  // Build local time strings then parse as UTC-equivalent
  const start = new Date(`${dateStr}T07:45:00`);
  const end   = new Date(`${dateStr}T${endTime}:00`);
  // Adjust for London timezone offset (approximate — good enough for capping)
  return { start, end };
}

router.get('/productivity', async (req, res) => {
  try {
    const { from, to, department } = req.query;
    const conditions = [`u.role = 'operator'`, `u.is_active = TRUE`];
    const params = [];
    let p = 1;

    const fromDt = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const toDt   = to   ? (() => { const d = new Date(to); d.setHours(23,59,59,999); return d; })()
                        : new Date();

    if (department) { conditions.push(`u.department = $${p++}`); params.push(department); }

    // Get all operators
    const operators = await query(
      `SELECT u.id, u.full_name, u.department
       FROM users u
       WHERE ${conditions.join(' AND ')}
       ORDER BY u.full_name`,
      params
    );

    if (!operators.length) return res.json([]);

    // Get all timers for these operators in the date range
    const opIds = operators.map(o => o.id);
    const timers = await query(
      `SELECT t.operator_id, t.started_at, t.completed_at, t.status,
              t.total_paused_seconds, t.duration_seconds
       FROM timers t
       WHERE t.operator_id = ANY($1)
         AND t.status IN ('completed','active','cancelled')
         AND t.started_at >= $2
         AND t.started_at <= $3
       ORDER BY t.operator_id, t.started_at`,
      [opIds, fromDt.toISOString(), toDt.toISOString()]
    );

    // Group timers by operator
    const timersByOp = {};
    for (const t of timers) {
      if (!timersByOp[t.operator_id]) timersByOp[t.operator_id] = [];
      timersByOp[t.operator_id].push(t);
    }

    // Calculate available minutes across the date range
    let totalAvailableMinutes = 0;
    const days = [];
    const cur = new Date(fromDt);
    cur.setHours(0,0,0,0);
    const end = new Date(toDt);
    end.setHours(23,59,59,999);
    while (cur <= end) {
      const ds = cur.toISOString().slice(0,10);
      const mins = workDayMinutes(ds);
      if (mins > 0) { days.push(ds); totalAvailableMinutes += mins; }
      cur.setDate(cur.getDate() + 1);
    }

    const results = operators.map(op => {
      const opTimers = timersByOp[op.id] || [];
      let activeSeconds = 0;

      for (const t of opTimers) {
        const tStart   = new Date(t.started_at);
        const tEnd     = t.completed_at ? new Date(t.completed_at) : new Date();
        const netSecs  = t.status === 'completed' && t.duration_seconds != null
          ? t.duration_seconds
          : Math.max(0, (tEnd - tStart) / 1000 - (t.total_paused_seconds || 0));

        // Cap to working day window
        const dayStr = tStart.toISOString().slice(0,10);
        const window = workDayWindow(dayStr);
        if (!window) continue;
        const windowSecs = (window.end - window.start) / 1000;
        activeSeconds += Math.min(netSecs, windowSecs);
      }

      const activeMinutes      = Math.round(activeSeconds / 60);
      const productivityPct    = totalAvailableMinutes > 0
        ? Math.min(100, Math.round(activeMinutes / totalAvailableMinutes * 100))
        : 0;
      const activeHours        = Math.floor(activeMinutes / 60);
      const activeRemMins      = activeMinutes % 60;

      return {
        operatorId:           op.id,
        operatorName:         op.full_name,
        department:           op.department,
        activeMinutes,
        activeHoursDisplay:   `${activeHours}h ${activeRemMins}m`,
        availableMinutes:     totalAvailableMinutes,
        availableHoursDisplay:`${Math.floor(totalAvailableMinutes/60)}h ${totalAvailableMinutes%60}m`,
        productivityPct,
        timerCount:           opTimers.length,
      };
    });

    res.json(results.sort((a,b) => b.productivityPct - a.productivityPct));
  } catch (err) {
    console.error('Productivity error:', err.message);
    res.status(500).json({ error: 'Could not calculate productivity.' });
  }
});

module.exports = router;
