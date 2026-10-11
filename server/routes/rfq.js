/**
 * routes/rfq.js
 *
 * CRM / RFQ module (Phase 1) internal API. Manager and above. CRUD for RFQs, an
 * activity feed (rfq_events), assignees, and a summary/SLA report. Pricing stays
 * in Sage; we capture build/inspection/test time (minutes) + a quoted value and
 * quote reference. See docs/crm-rfq-spec.md + docs/crm-rfq-phase1-plan.md.
 */
'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, getClient } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { parseCsv, mapRows } = require('../lib/rfq-import');

const router = express.Router();
router.use(requireAuth, requireRole('manager'));

const iso     = d => (d instanceof Date ? d.toISOString() : (d ? String(d) : null));
const isoDate = d => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null));
const daysBetween = (a, b) => (!a || !b) ? null : Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const emptyToNull = v => (v === '' ? null : v);

// Next RFQ number for a year prefix, given the current highest for that year.
// Pure, so it is unit-testable. e.g. nextRfqNumber('RFQ-2026-', 'RFQ-2026-0041') -> 'RFQ-2026-0042'.
function nextRfqNumber(prefix, lastRfqNumber) {
  let next = 1;
  if (lastRfqNumber) {
    const n = parseInt(String(lastRfqNumber).slice(prefix.length), 10);
    if (!isNaN(n)) next = n + 1;
  }
  return prefix + String(next).padStart(4, '0');
}

// Shape an rfqs row (optionally with assignees/events) for the client.
function fmtRfq(r, extra = {}) {
  const createdRef = r.source_created_at || r.created_at;
  const out = {
    id: r.id,
    rfqNumber: r.rfq_number,
    customerId: r.customer_id,
    customerName: r.customer_name || null,
    partNumber: r.part_number || null,
    partName: r.part_name || null,
    revision: r.revision || null,
    coNumber: r.co_number || null,
    quoteType: r.quote_type || null,
    priority: r.priority || null,
    dateRequiredBy: isoDate(r.date_required_by),
    freeIssue: r.free_issue,
    potentialUnitsAnnual: r.potential_units_annual,
    potentialRevenueAnnual: r.potential_revenue_annual != null ? Number(r.potential_revenue_annual) : null,
    requestComments: r.request_comments || null,
    contactEmail: r.contact_email || null,
    status: r.status,
    buildMinutes: r.build_minutes,
    inspectionMinutes: r.inspection_minutes,
    testMinutes: r.test_minutes,
    quotedValue: r.quoted_value != null ? Number(r.quoted_value) : null,
    quoteRef: r.quote_ref || null,
    quotedAt: isoDate(r.quoted_at),
    sageRef: r.sage_ref || null,
    sourceCreatedAt: iso(r.source_created_at),
    firstActionAt: iso(r.first_action_at),
    completedAt: iso(r.completed_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    // SLA metrics computed from timestamps (not stored).
    daysToComplete: daysBetween(createdRef, r.completed_at),
  };
  if (extra.assignees) out.assignees = extra.assignees.map(a => ({ userId: a.user_id || null, name: a.full_name || a.name || null }));
  if (extra.events) out.events = extra.events.map(e => ({
    id: e.id, type: e.type, body: e.body || null, visibility: e.visibility,
    authorName: e.full_name || e.author_name || null, createdAt: iso(e.created_at),
  }));
  return out;
}

// ── GET /api/rfq ── list with filters + paging ────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, customer, priority, assignee, q } = req.query;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const params = []; const where = [];
    if (status)   { params.push(status);   where.push(`r.status = $${params.length}`); }
    if (customer) { params.push(customer); where.push(`r.customer_id = $${params.length}`); }
    if (priority) { params.push(priority); where.push(`r.priority = $${params.length}`); }
    if (q) {
      params.push('%' + String(q).trim() + '%');
      where.push(`(r.part_number ILIKE $${params.length} OR r.part_name ILIKE $${params.length} OR r.rfq_number ILIKE $${params.length})`);
    }
    if (assignee) {
      params.push(assignee);
      where.push(`EXISTS (SELECT 1 FROM rfq_assignees a WHERE a.rfq_id = r.id AND a.user_id = $${params.length})`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(limit);  const limIdx = params.length;
    params.push(offset); const offIdx = params.length;
    const rows = await query(
      `SELECT r.*, c.name AS customer_name
         FROM rfqs r JOIN customers c ON c.id = r.customer_id
         ${whereSql}
         ORDER BY COALESCE(r.date_required_by, r.source_created_at::date, r.created_at::date) ASC NULLS LAST, r.created_at DESC
         LIMIT $${limIdx} OFFSET $${offIdx}`, params);

    const byRfq = {};
    const ids = rows.map(r => r.id);
    if (ids.length) {
      const asg = await query(
        `SELECT a.rfq_id, a.user_id, a.name, u.full_name
           FROM rfq_assignees a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.rfq_id = ANY($1)`, [ids]);
      for (const a of asg) (byRfq[a.rfq_id] = byRfq[a.rfq_id] || []).push(a);
    }
    res.json(rows.map(r => fmtRfq(r, { assignees: byRfq[r.id] || [] })));
  } catch (err) {
    console.error('GET /rfq error:', err.message);
    res.status(500).json({ error: 'Could not load RFQs.' });
  }
});

// ── GET /api/rfq/report ── summary + SLA (defined before /:id) ─────────────────
router.get('/report', async (req, res) => {
  try {
    const params = []; let where = '';
    if (req.query.customer) { params.push(req.query.customer); where = 'WHERE r.customer_id = $1'; }
    const rows = await query(
      `SELECT r.status, r.priority, r.source_created_at, r.created_at, r.first_action_at, r.completed_at,
              r.quoted_value, c.name AS customer_name
         FROM rfqs r JOIN customers c ON c.id = r.customer_id ${where}`, params);
    const statusCounts = {};
    let compSum = 0, compN = 0, ttfaSum = 0, ttfaN = 0, totalValue = 0;
    const byPriority = {};
    const byCustomer = {};
    for (const r of rows) {
      statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
      if (r.quoted_value != null) totalValue += Number(r.quoted_value);
      const cn = r.customer_name || 'Unknown';
      (byCustomer[cn] = byCustomer[cn] || { count: 0, value: 0 });
      byCustomer[cn].count++; if (r.quoted_value != null) byCustomer[cn].value += Number(r.quoted_value);
      const created = r.source_created_at || r.created_at;
      if (r.completed_at && created) {
        const d = daysBetween(created, r.completed_at);
        if (d != null) {
          compSum += d; compN++;
          const p = r.priority || 'none';
          (byPriority[p] = byPriority[p] || { n: 0, sum: 0 }); byPriority[p].n++; byPriority[p].sum += d;
        }
      }
      if (r.first_action_at && created) {
        const h = (Date.parse(r.first_action_at) - Date.parse(created)) / 3600000;
        if (h >= 0) { ttfaSum += h; ttfaN++; }
      }
    }
    const round1 = x => Math.round(x * 10) / 10;
    res.json({
      total: rows.length,
      statusCounts,
      openCount: statusCounts.open || 0,
      completedCount: statusCounts.completed || 0,
      totalQuotedValue: Math.round(totalValue),
      avgDaysToComplete: compN ? round1(compSum / compN) : null,
      avgHoursToFirstAction: ttfaN ? round1(ttfaSum / ttfaN) : null,
      byPriority: Object.fromEntries(Object.entries(byPriority).map(([p, v]) => [p, { count: v.n, avgDays: round1(v.sum / v.n) }])),
      byCustomer: Object.entries(byCustomer).map(([name, v]) => ({ name, count: v.count, value: Math.round(v.value) }))
        .sort((a, b) => b.count - a.count).slice(0, 12),
    });
  } catch (err) {
    console.error('GET /rfq/report error:', err.message);
    res.status(500).json({ error: 'Could not build the report.' });
  }
});

// ── GET /api/rfq/:id ── full record ───────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const r = await queryOne(
      `SELECT r.*, c.name AS customer_name FROM rfqs r JOIN customers c ON c.id = r.customer_id WHERE r.id = $1`,
      [req.params.id]);
    if (!r) return res.status(404).json({ error: 'RFQ not found.' });
    const assignees = await query(
      `SELECT a.user_id, a.name, u.full_name FROM rfq_assignees a LEFT JOIN users u ON u.id = a.user_id WHERE a.rfq_id = $1`, [r.id]);
    const events = await query(
      `SELECT e.*, u.full_name FROM rfq_events e LEFT JOIN users u ON u.id = e.author_id WHERE e.rfq_id = $1 ORDER BY e.created_at ASC`, [r.id]);
    const attachments = await query(`SELECT * FROM rfq_attachments WHERE rfq_id = $1 ORDER BY created_at ASC`, [r.id]);
    const out = fmtRfq(r, { assignees, events });
    out.attachments = attachments.map(a => ({ id: a.id, kind: a.kind, filename: a.filename, visibility: a.visibility, createdAt: iso(a.created_at) }));
    res.json(out);
  } catch (err) {
    console.error('GET /rfq/:id error:', err.message);
    res.status(500).json({ error: 'Could not load the RFQ.' });
  }
});

// ── POST /api/rfq ── create ────────────────────────────────────────────────────
router.post('/', validate(schemas.rfqCreate), async (req, res) => {
  const b = req.body;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const cust = await client.query('SELECT id FROM customers WHERE id = $1', [b.customerId]);
    if (!cust.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Unknown customer.' }); }

    const prefix = 'RFQ-' + new Date().getFullYear() + '-';
    const last = await client.query(
      `SELECT rfq_number FROM rfqs WHERE rfq_number LIKE $1 ORDER BY rfq_number DESC LIMIT 1`, [prefix + '%']);
    const rfqNumber = nextRfqNumber(prefix, last.rows.length ? last.rows[0].rfq_number : null);

    const id = uuidv4();
    await client.query(
      `INSERT INTO rfqs (id, rfq_number, customer_id, part_number, part_name, revision, co_number, quote_type, priority,
         date_required_by, free_issue, potential_units_annual, potential_revenue_annual, request_comments, contact_email,
         status, build_minutes, inspection_minutes, test_minutes, quoted_value, quote_ref, quoted_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)`,
      [id, rfqNumber, b.customerId, emptyToNull(b.partNumber), emptyToNull(b.partName), emptyToNull(b.revision),
       emptyToNull(b.coNumber), b.quoteType || null, b.priority || null, b.dateRequiredBy || null,
       b.freeIssue != null ? b.freeIssue : null, b.potentialUnitsAnnual != null ? b.potentialUnitsAnnual : null,
       b.potentialRevenueAnnual != null ? b.potentialRevenueAnnual : null, emptyToNull(b.requestComments), emptyToNull(b.contactEmail),
       b.status || 'open', b.buildMinutes != null ? b.buildMinutes : null, b.inspectionMinutes != null ? b.inspectionMinutes : null,
       b.testMinutes != null ? b.testMinutes : null, b.quotedValue != null ? b.quotedValue : null, emptyToNull(b.quoteRef), b.quotedAt || null,
       req.user.id]);

    for (const a of (b.assignees || [])) {
      if (!a.userId && !a.name) continue;
      await client.query('INSERT INTO rfq_assignees (id, rfq_id, user_id, name) VALUES ($1,$2,$3,$4)',
        [uuidv4(), id, a.userId || null, a.name || null]);
    }
    await client.query(
      'INSERT INTO rfq_events (id, rfq_id, type, body, visibility, author_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv4(), id, 'status_change', 'RFQ created (status: ' + (b.status || 'open') + ')', 'internal', req.user.id]);

    await client.query('COMMIT');
    const joined = await queryOne(
      `SELECT r.*, c.name AS customer_name FROM rfqs r JOIN customers c ON c.id = r.customer_id WHERE r.id = $1`, [id]);
    res.status(201).json(fmtRfq(joined));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /rfq error:', err.message);
    res.status(500).json({ error: 'Could not create the RFQ.' });
  } finally {
    client.release();
  }
});

// ── PATCH /api/rfq/:id ── update ───────────────────────────────────────────────
const UPDATE_MAP = {
  customerId: 'customer_id', partNumber: 'part_number', partName: 'part_name', revision: 'revision',
  coNumber: 'co_number', quoteType: 'quote_type', priority: 'priority', dateRequiredBy: 'date_required_by',
  freeIssue: 'free_issue', potentialUnitsAnnual: 'potential_units_annual', potentialRevenueAnnual: 'potential_revenue_annual',
  requestComments: 'request_comments', contactEmail: 'contact_email', status: 'status', buildMinutes: 'build_minutes',
  inspectionMinutes: 'inspection_minutes', testMinutes: 'test_minutes', quotedValue: 'quoted_value',
  quoteRef: 'quote_ref', quotedAt: 'quoted_at',
};

router.patch('/:id', validate(schemas.rfqUpdate), async (req, res) => {
  const b = req.body;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const existing = (await client.query('SELECT * FROM rfqs WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!existing) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'RFQ not found.' }); }
    if (b.customerId) {
      const cust = await client.query('SELECT id FROM customers WHERE id = $1', [b.customerId]);
      if (!cust.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Unknown customer.' }); }
    }

    const sets = []; const params = [];
    for (const k in UPDATE_MAP) {
      if (Object.prototype.hasOwnProperty.call(b, k)) {
        params.push(emptyToNull(b[k])); sets.push(`${UPDATE_MAP[k]} = $${params.length}`);
      }
    }
    const statusChanged = b.status && b.status !== existing.status;
    if (statusChanged && (b.status === 'completed' || b.status === 'declined') && !existing.completed_at) {
      params.push(new Date().toISOString()); sets.push(`completed_at = $${params.length}`);
    }
    if (!existing.first_action_at) { params.push(new Date().toISOString()); sets.push(`first_action_at = $${params.length}`); }
    params.push(req.user.id); sets.push(`updated_by = $${params.length}`);
    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    await client.query(`UPDATE rfqs SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

    if (b.assignees) {
      await client.query('DELETE FROM rfq_assignees WHERE rfq_id = $1', [req.params.id]);
      for (const a of b.assignees) {
        if (!a.userId && !a.name) continue;
        await client.query('INSERT INTO rfq_assignees (id, rfq_id, user_id, name) VALUES ($1,$2,$3,$4)',
          [uuidv4(), req.params.id, a.userId || null, a.name || null]);
      }
    }
    if (statusChanged) {
      await client.query('INSERT INTO rfq_events (id, rfq_id, type, body, visibility, author_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [uuidv4(), req.params.id, 'status_change', 'Status: ' + existing.status + ' -> ' + b.status, 'internal', req.user.id]);
    }

    await client.query('COMMIT');
    const joined = await queryOne(
      `SELECT r.*, c.name AS customer_name FROM rfqs r JOIN customers c ON c.id = r.customer_id WHERE r.id = $1`, [req.params.id]);
    res.json(fmtRfq(joined));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('PATCH /rfq error:', err.message);
    res.status(500).json({ error: 'Could not update the RFQ.' });
  } finally {
    client.release();
  }
});

// ── POST /api/rfq/:id/events ── add an activity entry ──────────────────────────
router.post('/:id/events', validate(schemas.rfqEvent), async (req, res) => {
  try {
    const rfq = await queryOne('SELECT id, first_action_at FROM rfqs WHERE id = $1', [req.params.id]);
    if (!rfq) return res.status(404).json({ error: 'RFQ not found.' });
    const { type, body, visibility } = req.body;
    const id = uuidv4();
    await query('INSERT INTO rfq_events (id, rfq_id, type, body, visibility, author_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, req.params.id, type, body || null, visibility, req.user.id]);
    if (!rfq.first_action_at) await query('UPDATE rfqs SET first_action_at = NOW() WHERE id = $1 AND first_action_at IS NULL', [req.params.id]);
    const me = await queryOne('SELECT full_name FROM users WHERE id = $1', [req.user.id]);
    res.status(201).json({ id, type, body: body || null, visibility, authorName: me ? me.full_name : null, createdAt: new Date().toISOString() });
  } catch (err) {
    console.error('POST /rfq/:id/events error:', err.message);
    res.status(500).json({ error: 'Could not add the entry.' });
  }
});

// ── POST /api/rfq/import ── the 661 + repeatable incremental import ────────────
// Body: { csvText | xlsxB64, dryRun }. dryRun (default true) returns a preview and
// writes nothing; dryRun:false applies in one transaction. Idempotent on
// external_source_id (SharePoint Item ID, else a composite-key hash). Imported
// RFQs are source-owned: a re-import replaces their assignees + events.
router.post('/import', validate(schemas.rfqImport), async (req, res) => {
  let rowObjects;
  try {
    if (req.body.xlsxB64) {
      const { readSheet } = require('../lib/xlsx-demand');
      rowObjects = readSheet(Buffer.from(req.body.xlsxB64, 'base64')).rows;
    } else {
      rowObjects = parseCsv(req.body.csvText || '').rows;
    }
  } catch (e) {
    return res.status(400).json({ error: 'Could not read the file.' });
  }
  const parsed = mapRows(rowObjects);
  if (!parsed.total) return res.status(400).json({ error: 'No rows found. Expected the QuoteActions export (Customer / QuoteTitle columns).' });

  // De-duplicate within the file by external_source_id (last wins).
  const byKey = new Map();
  for (const r of parsed.rows) byKey.set(r.externalSourceId, r);
  const uniqueRows = [...byKey.values()];

  try {
    const keys = uniqueRows.map(r => r.externalSourceId);
    const existing = keys.length ? await query('SELECT external_source_id FROM rfqs WHERE external_source_id = ANY($1)', [keys]) : [];
    const existingSet = new Set(existing.map(r => r.external_source_id));
    const newCount = uniqueRows.filter(r => !existingSet.has(r.externalSourceId)).length;

    const preview = {
      rowsInFile: parsed.total,
      uniqueRecords: uniqueRows.length,
      collapsedByKey: parsed.total - uniqueRows.length,
      new: newCount,
      updated: uniqueRows.length - newCount,
      customers: Object.keys(parsed.customers).length,
      unknownCustomers: parsed.unknownCustomers,
      warningCount: parsed.warnings.length,
      usingItemId: keys.length ? keys[0].startsWith('sp:') : false,
      sample: uniqueRows.slice(0, 8).map(r => ({
        part: r.partNumber, customer: r.customerCanonical || r.customerRaw,
        status: r.status, quotedValue: r.quotedValue, buildMinutes: r.buildMinutes,
      })),
    };
    if (req.body.dryRun !== false) return res.json({ dryRun: true, preview });
  } catch (err) {
    console.error('POST /rfq/import preview error:', err.message);
    return res.status(500).json({ error: 'Could not read existing records.' });
  }

  // Commit.
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // Ensure customers + aliases.
    const wanted = {};
    for (const r of uniqueRows) { const name = r.customerCanonical || r.customerRaw || 'Unknown'; (wanted[name] = wanted[name] || new Set()).add(r.customerRaw.toLowerCase()); }
    const idByName = {};
    for (const name in wanted) {
      let row = (await client.query('SELECT id FROM customers WHERE LOWER(name) = LOWER($1)', [name])).rows[0];
      if (!row) { const cid = uuidv4(); await client.query('INSERT INTO customers (id, name, created_by) VALUES ($1,$2,$3)', [cid, name, req.user.id]); row = { id: cid }; }
      idByName[name] = row.id;
      for (const alias of wanted[name]) {
        await client.query('INSERT INTO customer_aliases (id, customer_id, alias) VALUES ($1,$2,$3) ON CONFLICT (alias) DO NOTHING', [uuidv4(), row.id, alias]);
      }
    }
    // Match imported assignee names to Work Time users where possible.
    const users = (await client.query('SELECT id, full_name FROM users')).rows;
    const userByName = {}; for (const u of users) userByName[String(u.full_name).trim().toLowerCase()] = u.id;

    let inserted = 0, updated = 0;
    for (const r of uniqueRows) {
      const customerId = idByName[r.customerCanonical || r.customerRaw || 'Unknown'];
      const vals = [customerId, r.partNumber, r.partName || null, r.revision, r.coNumber, r.quoteType, r.priority,
        r.dateRequiredBy, r.freeIssue, r.potentialUnitsAnnual, r.potentialRevenueAnnual, r.requestComments, r.contactEmail,
        r.status, r.buildMinutes, r.inspectionMinutes, r.testMinutes, r.quotedValue, r.quoteRef, r.quotedAt,
        r.sourceCreatedAt, r.firstActionAt, r.completedAt];
      const ex = (await client.query('SELECT id FROM rfqs WHERE external_source_id = $1', [r.externalSourceId])).rows[0];
      let rfqId;
      if (ex) {
        rfqId = ex.id;
        await client.query(
          `UPDATE rfqs SET customer_id=$1, part_number=$2, part_name=$3, revision=$4, co_number=$5, quote_type=$6, priority=$7,
             date_required_by=$8, free_issue=$9, potential_units_annual=$10, potential_revenue_annual=$11, request_comments=$12,
             contact_email=$13, status=$14, build_minutes=$15, inspection_minutes=$16, test_minutes=$17, quoted_value=$18,
             quote_ref=$19, quoted_at=$20, source_created_at=$21, first_action_at=$22, completed_at=$23, updated_by=$24, updated_at=NOW()
           WHERE id=$25`, [...vals, req.user.id, rfqId]);
        await client.query('DELETE FROM rfq_assignees WHERE rfq_id=$1', [rfqId]);
        await client.query('DELETE FROM rfq_events WHERE rfq_id=$1', [rfqId]);
        updated++;
      } else {
        rfqId = uuidv4();
        await client.query(
          `INSERT INTO rfqs (id, external_source_id, customer_id, part_number, part_name, revision, co_number, quote_type, priority,
             date_required_by, free_issue, potential_units_annual, potential_revenue_annual, request_comments, contact_email, status,
             build_minutes, inspection_minutes, test_minutes, quoted_value, quote_ref, quoted_at, source_created_at, first_action_at,
             completed_at, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$26)`,
          [rfqId, r.externalSourceId, ...vals, req.user.id]);
        inserted++;
      }
      for (const nm of r.assignees) {
        await client.query('INSERT INTO rfq_assignees (id, rfq_id, user_id, name) VALUES ($1,$2,$3,$4)',
          [uuidv4(), rfqId, userByName[nm.toLowerCase()] || null, nm]);
      }
      for (const e of r.events) {
        await client.query('INSERT INTO rfq_events (id, rfq_id, type, body, visibility, author_name, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [uuidv4(), rfqId, 'comment', e.body, 'internal', e.authorName || null, e.at || r.sourceCreatedAt || new Date().toISOString()]);
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, inserted, updated, customers: Object.keys(wanted).length });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /rfq/import commit error:', err.message);
    res.status(500).json({ error: 'Could not import the records.' });
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports._test = { nextRfqNumber, fmtRfq };
