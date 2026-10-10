/**
 * routes/customers.js
 *
 * CRM canonical customer organisations (see docs/crm-rfq-spec.md). Manager and
 * above. Populated by the RFQ import and here. Distinct from the order book's
 * free-text `customer` string - this is the proper customer entity the RFQ
 * module (and later the external portal) hang off.
 */
'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth, requireRole('manager'));

function fmt(r) {
  return {
    id: r.id, name: r.name, code: r.code || null, isActive: r.is_active,
    notes: r.notes || null,
    rfqCount: r.rfq_count != null ? Number(r.rfq_count) : undefined,
  };
}

// GET /api/customers - list canonical customers with their RFQ counts
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT c.*, COUNT(r.id) AS rfq_count
         FROM customers c LEFT JOIN rfqs r ON r.customer_id = c.id
        GROUP BY c.id ORDER BY c.name ASC`);
    res.json(rows.map(fmt));
  } catch (err) {
    console.error('GET /customers error:', err.message);
    res.status(500).json({ error: 'Could not load customers.' });
  }
});

// POST /api/customers - add a canonical customer
router.post('/', validate(schemas.customerCreate), async (req, res) => {
  try {
    const { name, code, notes } = req.body;
    const dup = await query('SELECT id FROM customers WHERE LOWER(name) = LOWER($1)', [name]);
    if (dup.length) return res.status(409).json({ error: 'A customer with that name already exists.' });
    const id = uuidv4();
    await query(
      'INSERT INTO customers (id, name, code, notes, created_by) VALUES ($1,$2,$3,$4,$5)',
      [id, name, code || null, notes || null, req.user.id]);
    res.status(201).json({ id, name, code: code || null, isActive: true, notes: notes || null });
  } catch (err) {
    console.error('POST /customers error:', err.message);
    res.status(500).json({ error: 'Could not create the customer.' });
  }
});

module.exports = router;
