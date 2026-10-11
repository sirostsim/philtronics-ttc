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

  console.log('\nALL PORTAL GUARD TESTS PASSED');
})().catch(err => { console.error('\nTEST FAILURE:', err.message, '\n', err.stack); process.exit(1); });
