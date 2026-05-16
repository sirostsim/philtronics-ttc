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

module.exports = router;
