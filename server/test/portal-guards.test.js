/**
 * test/portal-guards.test.js  (run from server/: `npm test`)
 *
 * Guards the internal/external security split (docs/crm-portal-plan.md section 0).
 * These are the bits where a regression would be a data leak, so they are tested.
 * No database needed: every assertion exercises a rejection that happens before
 * any query (JWT verify + a type check), so a dummy DATABASE_URL is enough to load
 * the modules.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-guard-tests';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://dummy:dummy@localhost:5432/dummy';

const assert = require('assert');
const jwt = require('jsonwebtoken');
const { rejectPortal, requirePortal, signPortalToken, PORTAL_COOKIE } = require('../middleware/portal-auth');
const { requireAuth } = require('../middleware/auth');

function mockRes() {
  const r = { _status: 200, _json: null, _cleared: [], _cookies: [] };
  r.status = c => { r._status = c; return r; };
  r.json = o => { r._json = o; return r; };
  r.clearCookie = n => { r._cleared.push(n); return r; };
  r.cookie = n => { r._cookies.push(n); return r; };
  return r;
}

(async () => {
  // rejectPortal: a portal-only session is refused on an internal route.
  {
    const res = mockRes(); let nexted = false;
    rejectPortal({ cookies: { ptoken: 'x' } }, res, () => { nexted = true; });
    assert.strictEqual(res._status, 403, 'portal-only cookie should 403 on internal');
    assert.ok(!nexted, 'should not call next()');
  }
  console.log('ok  - rejectPortal: portal-only cookie -> 403');

  // rejectPortal: an internal session passes.
  {
    let nexted = false;
    rejectPortal({ cookies: { token: 'x' } }, mockRes(), () => { nexted = true; });
    assert.ok(nexted, 'internal cookie should pass');
  }
  console.log('ok  - rejectPortal: internal cookie -> pass');

  // rejectPortal: both cookies -> pass (internal requireAuth resolves it).
  {
    let nexted = false;
    rejectPortal({ cookies: { token: 'x', ptoken: 'y' } }, mockRes(), () => { nexted = true; });
    assert.ok(nexted, 'both cookies should pass to requireAuth');
  }
  console.log('ok  - rejectPortal: both cookies -> pass');

  // rejectPortal: no cookies -> pass (requireAuth will 401 unauthenticated).
  {
    let nexted = false;
    rejectPortal({ cookies: {} }, mockRes(), () => { nexted = true; });
    assert.ok(nexted, 'no cookies should pass');
  }
  console.log('ok  - rejectPortal: no cookies -> pass');

  // signPortalToken: marks typ=portal and carries the tenant.
  const pt = signPortalToken({ id: 'p1', customer_id: 'c1' });
  const dec = jwt.verify(pt, process.env.JWT_SECRET);
  assert.strictEqual(dec.typ, 'portal');
  assert.strictEqual(dec.sub, 'p1');
  assert.strictEqual(dec.cid, 'c1');
  console.log('ok  - signPortalToken: typ=portal + sub + cid');

  // Internal requireAuth refuses a portal-typed token (before any DB lookup).
  {
    const res = mockRes(); let nexted = false;
    await requireAuth({ cookies: { token: pt } }, res, () => { nexted = true; });
    assert.strictEqual(res._status, 401, 'portal token must 401 on internal');
    assert.ok(!nexted);
  }
  console.log('ok  - requireAuth refuses a portal-typed token');

  // Portal requirePortal refuses an internal (non-portal) token (before DB).
  const internalTok = jwt.sign({ sub: 'u1', role: 'manager' }, process.env.JWT_SECRET);
  {
    const res = mockRes(); let nexted = false;
    await requirePortal({ cookies: { [PORTAL_COOKIE]: internalTok } }, res, () => { nexted = true; });
    assert.strictEqual(res._status, 401, 'internal token must 401 on portal');
    assert.ok(!nexted);
  }
  console.log('ok  - requirePortal refuses an internal token');

  // Portal requirePortal: no cookie -> 401.
  {
    const res = mockRes(); let nexted = false;
    await requirePortal({ cookies: {} }, res, () => { nexted = true; });
    assert.strictEqual(res._status, 401);
    assert.ok(!nexted);
  }
  console.log('ok  - requirePortal: no cookie -> 401');

  // The portal RFQ serializer must NEVER leak internal fields, whatever is on the row.
  const { portalRfq } = require('../routes/portal')._test;
  {
    const internalRow = {
      id: 'r1', rfq_number: 'RFQ-2026-0001', customer_id: 'c1', part_number: 'P1', status: 'open',
      build_minutes: 1200, inspection_minutes: 60, test_minutes: 30, sage_ref: 'SAGE-9',
      quoted_value: 9999.99, quote_ref: 'QN1', request_comments: 'please quote',
    };
    const out = portalRfq(internalRow);
    const json = JSON.stringify(out);
    const forbiddenKeys = ['build_minutes', 'buildMinutes', 'inspection_minutes', 'inspectionMinutes',
      'test_minutes', 'testMinutes', 'sage_ref', 'sageRef', 'assignees', 'customer_id', 'customerId', 'updated_by'];
    for (const k of forbiddenKeys) assert.ok(!(k in out), 'serializer must not expose key: ' + k);
    assert.ok(!json.includes('1200') && !json.includes('SAGE-9'), 'serializer must not leak internal values');
    assert.strictEqual(out.quote, null, 'quote hidden while not completed');
  }
  console.log('ok  - portalRfq serializer: no internal fields, quote hidden until completed');

  {
    const out = portalRfq({ id: 'r2', customer_id: 'c1', status: 'completed', quoted_value: 9962.02, quote_ref: 'QN1149', quoted_at: '2026-01-08' });
    assert.ok(out.quote && out.quote.value === 9962.02 && out.quote.reference === 'QN1149', 'quote shown once completed');
    assert.ok(!('build_minutes' in out) && !('sage_ref' in out), 'still no internal fields when completed');
  }
  console.log('ok  - portalRfq serializer: quote shown once completed, still no internal fields');

  console.log('\nALL PORTAL GUARD TESTS PASSED');
})().catch(err => { console.error('\nTEST FAILURE:', err.message, '\n', err.stack); process.exit(1); });
