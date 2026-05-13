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
              t.started_at, t.completed_at, t.duration_seconds, t.notes, t.status
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
        { key: 'notes',            header: 'Notes'                },
        { key: 'status',           header: 'Status'               },
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
      `SELECT item_number,
              COUNT(*)::int                        AS count,
              ROUND(AVG(duration_seconds))::int    AS avg_seconds,
              MIN(duration_seconds)                AS min_seconds,
              MAX(duration_seconds)                AS max_seconds
       FROM timers
       WHERE ${conditions.join(' AND ')}
       GROUP BY item_number
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

module.exports = router;
