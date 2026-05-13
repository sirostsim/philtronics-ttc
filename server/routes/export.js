/**
 * routes/export.js – CSV export (Manager+)
 */

'use strict';

const express   = require('express');
const { stringify } = require('csv-stringify/sync');
const db        = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('manager'));

// Format UTC ISO string to Europe/London display
function toLocalString(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleString('en-GB', {
    timeZone:     'Europe/London',
    year:         'numeric',
    month:        '2-digit',
    day:          '2-digit',
    hour:         '2-digit',
    minute:       '2-digit',
    second:       '2-digit',
    hour12:       false,
  }).replace(',', '');
}

// ─── GET /api/export/csv ─────────────────────────────────────────────────────
router.get('/csv', (req, res) => {
  const { from, to, operatorId, itemNumber } = req.query;

  const conditions = ["t.status != 'cancelled'"];
  const params     = [];

  if (from) {
    conditions.push("t.started_at >= ?");
    params.push(new Date(from).toISOString());
  }
  if (to) {
    // Include the full end day
    const endDate = new Date(to);
    endDate.setHours(23, 59, 59, 999);
    conditions.push("t.started_at <= ?");
    params.push(endDate.toISOString());
  }
  if (operatorId) {
    conditions.push("t.operator_id = ?");
    params.push(operatorId);
  }
  if (itemNumber) {
    conditions.push("t.item_number LIKE ? COLLATE NOCASE");
    params.push(`%${itemNumber}%`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT
      t.item_number,
      t.operator_id,
      t.operator_name,
      t.started_at,
      t.completed_at,
      t.duration_seconds,
      t.notes,
      t.status
    FROM timers t
    ${where}
    ORDER BY t.started_at ASC
  `).all(params);

  const csvRows = rows.map(r => ({
    itemNumber:       r.item_number,
    operatorId:       r.operator_id,
    operatorName:     r.operator_name,
    startedAtUTC:     r.started_at,
    startedAtLocal:   toLocalString(r.started_at),
    completedAtUTC:   r.completed_at || '',
    completedAtLocal: toLocalString(r.completed_at),
    durationSeconds:  r.duration_seconds != null ? r.duration_seconds : '',
    durationMinutes:  r.duration_seconds != null ? (r.duration_seconds / 60).toFixed(2) : '',
    notes:            r.notes || '',
    status:           r.status,
  }));

  const csv = stringify(csvRows, {
    header: true,
    columns: [
      { key: 'itemNumber',       header: 'Item Number'         },
      { key: 'operatorId',       header: 'Operator ID'         },
      { key: 'operatorName',     header: 'Operator Name'       },
      { key: 'startedAtUTC',     header: 'Started At (UTC)'    },
      { key: 'startedAtLocal',   header: 'Started At (London)' },
      { key: 'completedAtUTC',   header: 'Completed At (UTC)'  },
      { key: 'completedAtLocal', header: 'Completed At (London)'},
      { key: 'durationSeconds',  header: 'Duration (Seconds)'  },
      { key: 'durationMinutes',  header: 'Duration (Minutes)'  },
      { key: 'notes',            header: 'Notes'               },
      { key: 'status',           header: 'Status'              },
    ],
  });

  const filename = `philtronics-timings-${new Date().toISOString().slice(0,10)}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csv); // BOM for Excel
});

// ─── GET /api/export/stats ───────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const { from, to, operatorId, itemNumber } = req.query;

  const conditions = ["status = 'completed'"];
  const params     = [];

  if (from) { conditions.push("started_at >= ?"); params.push(new Date(from).toISOString()); }
  if (to)   {
    const e = new Date(to); e.setHours(23,59,59,999);
    conditions.push("started_at <= ?"); params.push(e.toISOString());
  }
  if (operatorId)  { conditions.push("operator_id = ?");           params.push(operatorId); }
  if (itemNumber)  { conditions.push("item_number LIKE ? COLLATE NOCASE"); params.push(`%${itemNumber}%`); }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const byItem = db.prepare(`
    SELECT
      item_number,
      COUNT(*)                     AS count,
      AVG(duration_seconds)        AS avg_seconds,
      MIN(duration_seconds)        AS min_seconds,
      MAX(duration_seconds)        AS max_seconds
    FROM timers
    ${where}
    GROUP BY item_number
    ORDER BY count DESC
    LIMIT 50
  `).all(params);

  // Last 24 h / 7 d totals
  const now = new Date().toISOString();
  const h24 = new Date(Date.now() - 24*3600*1000).toISOString();
  const d7  = new Date(Date.now() - 7*24*3600*1000).toISOString();

  const total24h = db.prepare(`SELECT COUNT(*) AS c FROM timers WHERE status='completed' AND started_at >= ?`).get(h24).c;
  const total7d  = db.prepare(`SELECT COUNT(*) AS c FROM timers WHERE status='completed' AND started_at >= ?`).get(d7).c;

  // Active timers
  const active = db.prepare(`SELECT COUNT(*) AS c FROM timers WHERE status='active'`).get().c;

  res.json({ byItem, total24h, total7d, activeCount: active });
});

module.exports = router;
