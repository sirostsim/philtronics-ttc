/**
 * lib/xlsx-demand.js
 *
 * Dependency-free .xlsx reading (via Node's built-in zlib) and the push/pull
 * report maths for the KLA weekly order-book + priority-requirements sheets.
 * Kept db-free so it can be unit-tested against real export files.
 */
'use strict';

const zlib = require('zlib');

/* ----------------------------- XLSX reading (zlib) ----------------------------- */

// Pull one entry out of a .xlsx (a ZIP) by name, via the central directory so
// sizes/offsets are reliable. Returns the decompressed Buffer, or null.
function readZipEntry(buf, wantName) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  let cd = buf.readUInt32LE(eocd + 16);
  const total = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) break;
    const method   = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen  = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const cmtLen   = buf.readUInt16LE(cd + 32);
    const localOff = buf.readUInt32LE(cd + 42);
    const name     = buf.toString('utf8', cd + 46, cd + 46 + nameLen);
    if (name === wantName) {
      const lNameLen  = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }
    cd += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

function decodeXml(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

// Parse the first worksheet of an .xlsx buffer into { header, rows } where rows
// are objects keyed by the lower-cased header row.
function readSheet(buf) {
  const ssXml = readZipEntry(buf, 'xl/sharedStrings.xml');
  const shared = [];
  if (ssXml) {
    const ss = ssXml.toString('utf8');
    const re = /<si>([\s\S]*?)<\/si>/g; let m;
    while ((m = re.exec(ss))) {
      let t = ''; const tre = /<t[^>]*>([\s\S]*?)<\/t>/g; let tm;
      while ((tm = tre.exec(m[1]))) t += tm[1];
      shared.push(decodeXml(t));
    }
  }
  let sheet = readZipEntry(buf, 'xl/worksheets/sheet1.xml');
  if (!sheet) { for (let i = 1; i <= 20 && !sheet; i++) sheet = readZipEntry(buf, 'xl/worksheets/sheet' + i + '.xml'); }
  if (!sheet) return { header: [], rows: [] };
  const xml = sheet.toString('utf8');
  const colNum = ref => { const mm = ref.match(/^([A-Z]+)/); let n = 0; for (const c of mm[1]) n = n * 26 + (c.charCodeAt(0) - 64); return n; };
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g; let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = {}; let maxc = 0;
    const cRe = /<c r="([A-Z]+\d+)"(?:[^>]*?t="([^"]*)")?[^>]*>([\s\S]*?)<\/c>|<c r="([A-Z]+\d+)"[^>]*\/>/g; let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const ref = cm[1] || cm[4]; const t = cm[2]; const inner = cm[3] || '';
      const col = colNum(ref); if (col > maxc) maxc = col;
      let val = '';
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
      const im = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      if (t === 's' && vm) val = shared[+vm[1]] ?? '';
      else if ((t === 'inlineStr' || t === 'str') && im) val = im[1];
      else if (vm) val = vm[1];
      cells[col] = decodeXml(val);
    }
    const arr = []; for (let i = 1; i <= maxc; i++) arr.push(cells[i] ?? '');
    rows.push(arr);
  }
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const objs = rows.slice(1)
    .filter(r => r.some(c => c !== ''))
    .map(r => { const o = {}; header.forEach((h, i) => { o[h] = r[i] ?? ''; }); return o; });
  return { header, rows: objs };
}

// Excel serial date -> ISO. Null for blanks and the far-future "no date" sentinel.
function serialDate(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(+s);
  if (n <= 0 || n > 401768) return null;
  const iso = new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  return iso.slice(0, 4) > '2100' ? null : iso;
}
// Strip currency (£ = pound), commas and whitespace before parsing.
const numOf = s => { const n = parseFloat(String(s == null ? '' : s).replace(/[£,\s]/g, '')); return isNaN(n) ? 0 : n; };

function mapOrderBook(sheet) {
  return sheet.rows.map(o => ({
    poNumber:    String(o['purchasing document'] || '').trim(),
    poLine:      String(o['item'] || '').trim(),
    itemNumber:  String(o['part number'] || '').trim(),
    description: String(o['material description'] || '').trim(),
    requiredBy:  serialDate(o['required by']),
    dueDate:     serialDate(o['current due date']),
    orderedQty:  Math.round(numOf(o['ordered qty'])),
    balDueQty:   Math.round(numOf(o['bal due qty'])),
    value:       (o['line value'] != null && o['line value'] !== '') ? numOf(o['line value'])
                 : (o['value'] != null && o['value'] !== '' ? numOf(o['value']) : null),
    rework:      String(o['rework'] || '').trim() !== '',
  })).filter(r => r.itemNumber);
}

function mapPriority(sheet) {
  return sheet.rows.map(o => ({
    topDemand:  String(o['top demand'] || '').trim(),
    wo:         String(o['planned order/work order number'] || '').trim(),
    lineItem:   String(o['top demand line item'] || '').trim(),
    startDate:  serialDate(o['open planned/wo start date'] || o['start date']),
    itemNumber: String(o['material'] || '').trim(),
    description:String(o['material description'] || '').trim(),
    qty:        numOf(o['qty needed per slot']) || 1,
  })).filter(r => r.itemNumber);
}

/* --------------------------- Push/Pull report maths --------------------------- */

const isoStr = d => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null));
const monthOf = iso => (iso ? iso.slice(0, 7) : null);
const daysBetween = (a, b) => (!a || !b) ? null : Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// Compute the full report from plain arrays (db-free, so it is unit-testable).
//   snaps:      [{ id, snapshot_date, order_lines_count, priority_lines_count, order_book_value }]  oldest first
//   orderLines: [{ snapshot_id, item_number, ordered_qty, line_value }]
//   priLines:   [{ snapshot_id, item_number, description, start_date, qty }]
function computeReport(customer, snaps, orderLines, priLines) {
  if (!snaps.length) return { customer, snapshots: [], perWeek: [], months: [], profile: [], transitions: [] };

  const unitVal = {};
  for (const s of snaps) for (const r of orderLines) {
    if (r.snapshot_id !== s.id) continue;
    const oq = Number(r.ordered_qty) || 0, v = r.line_value != null ? Number(r.line_value) : 0;
    if (oq > 0 && v > 0) unitVal[r.item_number] = v / oq;
  }
  const valOf = r => (Number(r.qty) || 0) * (unitVal[r.item_number] || 0);

  const bySnap = {}; const allMonths = new Set();
  for (const s of snaps) {
    const rows = priLines.filter(p => p.snapshot_id === s.id);
    const monthly = {}; const agg = {};
    for (const r of rows) {
      const iso = isoStr(r.start_date); const mk = monthOf(iso);
      if (mk) { allMonths.add(mk); monthly[mk] = (monthly[mk] || 0) + valOf(r); }
      if (!agg[r.item_number]) agg[r.item_number] = { part: r.item_number, desc: r.description, earliest: iso, totQty: 0 };
      const a = agg[r.item_number];
      a.totQty += Number(r.qty) || 0;
      if (iso && (!a.earliest || iso < a.earliest)) a.earliest = iso;
      if (!a.desc && r.description) a.desc = r.description;
    }
    bySnap[s.id] = { monthly, agg };
  }
  const months = [...allMonths].sort();

  const perWeek = snaps.map(s => ({
    id: s.id,
    week: isoStr(s.snapshot_date),
    orderBookValue: Math.round(Number(s.order_book_value) || 0),
    obLines: s.order_lines_count,
    demandSlots: s.priority_lines_count,
    demandQty: Math.round(priLines.filter(p => p.snapshot_id === s.id).reduce((t, r) => t + (Number(r.qty) || 0), 0)),
    demandValue: Math.round(priLines.filter(p => p.snapshot_id === s.id).reduce((t, r) => t + valOf(r), 0)),
  }));
  const profile = snaps.map(s => ({ week: isoStr(s.snapshot_date), values: months.map(m => Math.round(bySnap[s.id].monthly[m] || 0)) }));

  const transitions = [];
  for (let i = 1; i < snaps.length; i++) {
    const A = bySnap[snaps[i - 1].id].agg, B = bySnap[snaps[i].id].agg;
    const parts = new Set([...Object.keys(A), ...Object.keys(B)]);
    const movers = []; const sums = { pullIn: 0, pushOut: 0, added: 0, dropped: 0, qtyUp: 0, qtyDown: 0, pullInN: 0, pushOutN: 0, addedN: 0, droppedN: 0 };
    for (const p of parts) {
      const a = A[p], b = B[p]; const u = unitVal[p] || 0;
      if (!a && b) { sums.added += b.totQty * u; sums.addedN++; movers.push({ part: p, desc: b.desc, cat: 'added', shift: null, val: b.totQty * u, qty: b.totQty, from: null, to: b.earliest }); continue; }
      if (a && !b) { sums.dropped += a.totQty * u; sums.droppedN++; movers.push({ part: p, desc: a.desc, cat: 'dropped', shift: null, val: a.totQty * u, qty: a.totQty, from: a.earliest, to: null }); continue; }
      const shift = daysBetween(a.earliest, b.earliest); const qd = b.totQty - a.totQty; const v = b.totQty * u;
      if (shift != null && shift < 0) { sums.pullIn += v; sums.pullInN++; movers.push({ part: p, desc: b.desc, cat: 'pullIn', shift, val: v, qty: b.totQty, from: a.earliest, to: b.earliest }); }
      else if (shift != null && shift > 0) { sums.pushOut += v; sums.pushOutN++; movers.push({ part: p, desc: b.desc, cat: 'pushOut', shift, val: v, qty: b.totQty, from: a.earliest, to: b.earliest }); }
      if (qd > 0) sums.qtyUp += qd * u; else if (qd < 0) sums.qtyDown += qd * u;
    }
    movers.sort((m, n) => Math.abs(n.val) - Math.abs(m.val));
    transitions.push({ from: isoStr(snaps[i - 1].snapshot_date), to: isoStr(snaps[i].snapshot_date), sums, movers });
  }
  return { customer, snapshots: perWeek, perWeek, months, profile, transitions };
}

module.exports = { readSheet, mapOrderBook, mapPriority, serialDate, numOf, computeReport };
