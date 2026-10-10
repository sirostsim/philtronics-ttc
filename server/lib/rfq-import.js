/**
 * lib/rfq-import.js
 *
 * Parse + map the SharePoint "QuoteActions" export (CSV, or .xlsx rows) into RFQ
 * records for import. Db-free so it can be unit-tested against the real export.
 * See docs/crm-rfq-spec.md section 6 for the field mapping.
 */
'use strict';

const crypto = require('crypto');

// Canonicalisation map (spec Appendix A): lower-cased source name -> canonical.
const ALIAS_MAP = {
  'spts': 'SPTS (KLA)', 'kla': 'SPTS (KLA)',
  'mono': 'Mono',
  'fike': 'Fike',
  'bridmet': 'Bridmet', 'bridmet limited': 'Bridmet',
  'rototherm': 'Rototherm',
  'snc': 'SNC',
  'iq endoscopes': 'IQ Endoscopes',
  'control technologies uk': 'Control Technologies UK',
  'inspired gaming (uk) limited': 'Inspired Gaming (UK)',
  'drone evolution': 'Drone Evolution',
  'militec': 'Militec',
  'caresafe': 'CareSafe',
  'perkin elmer': 'PerkinElmer',
  'carbont': 'Carbont',
  'soil essentials ltd': 'Soil Essentials',
  'eft': 'EFT',
  'undalogic': 'Undalogic',
  'anm electronics': 'ANM Electronics',
  'tekever': 'Tekever',
  'steel rock technologies': 'Steel Rock Technologies',
};

function canonicalCustomer(raw) {
  const r = String(raw == null ? '' : raw).trim();
  const canonical = ALIAS_MAP[r.toLowerCase()] || null;
  return { raw: r, canonical, known: !!canonical };
}

// ── CSV parse (RFC4180-ish) ────────────────────────────────────────────────────
function parseCsv(text) {
  text = String(text == null ? '' : text).replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\r') { /* ignore */ }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0].map(h => String(h).trim());
  const objs = rows.slice(1)
    .filter(r => r.some(c => String(c).trim() !== ''))
    .map(r => { const o = {}; header.forEach((h, i) => { o[h] = r[i] != null ? r[i] : ''; }); return o; });
  return { header, rows: objs };
}

// Case-insensitive field getter for a row object.
function fielder(row) {
  const low = {};
  for (const k in row) low[String(k).trim().toLowerCase()] = row[k];
  return name => { const v = low[name]; return v == null ? '' : String(v).trim(); };
}

const numOf = s => { const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
const hoursToMinutes = s => { const n = numOf(s); return n == null ? null : Math.round(n * 60); };

// DD/MM/YYYY [HH:MM] (2- or 4-digit year) -> ISO. withTime keeps the time part.
function parseUkDate(s, withTime) {
  s = String(s == null ? '' : s).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  let [, d, mo, y, hh, mm] = m;
  y = y.length === 2 ? '20' + y : y;
  const pad = (x, n) => String(x).padStart(n, '0');
  const date = y + '-' + pad(mo, 2) + '-' + pad(d, 2);
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +y > 2100) return null;
  if (withTime && hh != null) return date + 'T' + pad(hh, 2) + ':' + pad(mm, 2) + ':00';
  return date;
}

function mapQuoteType(s) {
  const v = String(s || '').trim().toLowerCase();
  if (v === 'up rev' || v === 'up revision') return 'up_rev';
  if (v === 'rfq' || v === 'new quotation') return 'new';
  return v ? 'new' : null;   // default unknown non-blank to 'new'
}
function mapStatus(s) {
  const v = String(s || '').trim().toLowerCase();
  if (v === 'open') return 'open';
  if (v === 'awaiting response') return 'awaiting_response';
  if (v === 'completed') return 'completed';
  if (v.indexOf('declined') >= 0) return 'declined';
  return 'open';
}
function mapPriority(s) {
  const m = String(s || '').match(/priority\s*([ABC])/i) || String(s || '').match(/^([ABC])\b/i);
  return m ? m[1].toUpperCase() : null;
}
function mapFreeIssue(s) {
  const v = String(s || '').trim().toLowerCase();
  if (v === 'yes') return true;
  if (v === 'no') return false;
  return null;
}

// Split "1070319-000 REV AA" into { partNumber:'1070319-000', revision:'AA' }.
function splitTitle(title) {
  const t = String(title || '').trim();
  const m = t.match(/^(\S+)\s+(?:REV\s*)?([A-Z]{1,3}\d*)$/i);
  if (m) return { partNumber: m[1], revision: m[2].toUpperCase() };
  return { partNumber: t.split(/\s+/)[0] || t, revision: null };
}

function extractQuoteRef(text) {
  const m = String(text || '').match(/QN\s?\d+/i);
  return m ? m[0].replace(/\s+/g, '').toUpperCase() : null;
}

// ActionComments journal -> [{ at, authorName, body }]. Best-effort; never loses a line.
function parseEvents(actionComments, fallbackAt) {
  const out = [];
  const lines = String(actionComments || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([A-Za-z]{1,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-:]\s*(.*)$/);
    if (m) out.push({ at: parseUkDate(m[2], false) ? parseUkDate(m[2], true) || parseUkDate(m[2]) : fallbackAt, authorName: m[1].toUpperCase(), body: m[3] || line });
    else out.push({ at: fallbackAt, authorName: null, body: line });
  }
  return out;
}

function externalId(get, customerRaw, title, createdRaw) {
  const id = get('id') || get('item id') || get('item_id');
  if (id) return 'sp:' + id;
  const composite = [customerRaw, title, createdRaw].join('|');
  return 'ck:' + crypto.createHash('sha1').update(composite).digest('hex').slice(0, 16);
}

function mapRow(row) {
  const get = fielder(row);
  const customerRaw = get('customer');
  const cc = canonicalCustomer(customerRaw);
  const title = get('quotetitle') || get('title');
  const split = splitTitle(title);
  const createdRaw = get('created');
  const sourceCreatedAt = parseUkDate(createdRaw, true);
  const actionComments = get('actioncomments');
  const events = parseEvents(actionComments, sourceCreatedAt);
  const earliestEventAt = events.map(e => e.at).filter(Boolean).sort()[0] || null;
  const assignees = String(get('actionby') || '').split(';').map(s => s.trim()).filter(Boolean);
  return {
    externalSourceId: externalId(get, customerRaw, title, createdRaw),
    customerRaw: cc.raw, customerCanonical: cc.canonical, customerKnown: cc.known,
    partNumber: split.partNumber || null,
    revision: (get('revision number') || split.revision || '').trim() || null,
    coNumber: get('co number') || null,
    quoteType: mapQuoteType(get('quote type')),
    priority: mapPriority(get('priority')),
    dateRequiredBy: parseUkDate(get('daterequiredby'), false),
    freeIssue: mapFreeIssue(get('free issue')),
    potentialUnitsAnnual: numOf(get('potential units')) != null ? Math.round(numOf(get('potential units'))) : null,
    potentialRevenueAnnual: numOf(get('potential revenue')),
    requestComments: get('requestcomments') || null,
    contactEmail: get('requestedby') || null,
    status: mapStatus(get('actionstatus')),
    buildMinutes: hoursToMinutes(get('build time')),
    inspectionMinutes: hoursToMinutes(get('inspection time')),
    testMinutes: hoursToMinutes(get('test time')),
    quotedValue: numOf(get('sage sales cost')),
    quoteRef: extractQuoteRef(actionComments),
    quotedAt: parseUkDate(get('completed date'), false),
    sourceCreatedAt,
    firstActionAt: earliestEventAt,
    completedAt: parseUkDate(get('completed date'), true),
    assignees,
    events,
  };
}

// Map an array of row-objects (from parseCsv or the xlsx reader) to RFQ records,
// with a summary of customers / unknowns / warnings for the preview.
function mapRows(rowObjects) {
  const rows = [];
  const customers = {};          // canonicalName -> Set(rawLower)
  const unknown = new Set();
  const warnings = [];
  for (const ro of (rowObjects || [])) {
    const g = fielder(ro);
    if (!g('customer') && !(g('quotetitle') || g('title'))) continue;   // skip blank/non-data rows
    const m = mapRow(ro);
    const name = m.customerCanonical || m.customerRaw || 'Unknown';
    (customers[name] = customers[name] || new Set()).add(m.customerRaw.toLowerCase());
    if (!m.customerKnown && m.customerRaw) unknown.add(m.customerRaw);
    if (!m.partNumber) warnings.push('Row for "' + m.customerRaw + '" has no part number/title');
    rows.push(m);
  }
  return {
    total: rows.length,
    rows,
    customers,
    unknownCustomers: [...unknown],
    warnings,
  };
}

module.exports = {
  ALIAS_MAP, canonicalCustomer, parseCsv, mapRows, mapRow,
  _helpers: { numOf, hoursToMinutes, parseUkDate, mapQuoteType, mapStatus, mapPriority, mapFreeIssue, splitTitle, extractQuoteRef, parseEvents },
};
