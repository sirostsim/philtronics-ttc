/* portal.js - Philtronics customer portal (standalone external bundle).
 *
 * A tiny vanilla-JS app for external customer contacts. It talks ONLY to
 * /api/portal/* (the portal-scoped API behind the hard internal/external split)
 * and loads none of the internal SPA. UK English, no em dashes.
 *
 * Views: login, accept-invite (set password), list (My RFQs), detail, new.
 */
'use strict';

(function () {
  var ROOT = document.getElementById('portal-root');
  var LOGO = '/philtronics-logo.png';

  // ── State ──────────────────────────────────────────────────────────────
  var S = { me: null, rfqs: null, current: null };

  // ── Tiny DOM helper ──────────────────────────────────────────────────────
  function el(tag, attrs) {
    var e = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'className') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) { c.forEach(function (x) { if (x != null && x !== false) e.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); }); }
      else e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function mount(node) { clear(ROOT); ROOT.className = ''; ROOT.appendChild(node); }

  // ── API wrapper (cookie-based; same-origin) ──────────────────────────────
  function api(method, path, body) {
    return fetch('/api/portal' + path, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var err = new Error(data.error || ('Request failed (' + r.status + ')')); err.status = r.status; throw err; }
        return data;
      });
    });
  }

  // ── Formatting ────────────────────────────────────────────────────────────
  var gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
  function money(n) { return (n == null) ? '–' : gbp.format(n); }
  function dmy(iso) {
    if (!iso) return '–';
    var s = String(iso).slice(0, 10), p = s.split('-');
    return (p.length === 3) ? (p[2] + '/' + p[1] + '/' + p[0]) : s;
  }
  function dmyTime(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return dmy(iso);
    return dmy(iso) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  var STATUS = {
    open:              { label: 'Open',              cls: 'p-badge-open' },
    awaiting_response: { label: 'Awaiting response', cls: 'p-badge-awaiting' },
    completed:         { label: 'Quoted',            cls: 'p-badge-completed' },
    declined:          { label: 'Declined',          cls: 'p-badge-declined' },
  };
  function statusBadge(s) {
    var m = STATUS[s] || { label: s || 'Unknown', cls: 'p-badge-open' };
    return el('span', { className: 'p-badge ' + m.cls, text: m.label });
  }
  function quoteTypeLabel(t) { return t === 'new' ? 'New quotation' : (t === 'up_rev' ? 'Up-rev' : '–'); }

  function alertBox(kind, msg) { return el('div', { className: 'p-alert ' + (kind === 'ok' ? 'p-alert-ok' : 'p-alert-err'), text: msg }); }

  // ── Top bar (authenticated pages) ─────────────────────────────────────────
  function topbar() {
    return el('div', { className: 'p-topbar' },
      el('img', { src: LOGO, alt: 'Philtronics', onerror: function () { this.style.display = 'none'; } }),
      el('span', { className: 'p-title', text: 'Customer Portal' }),
      S.me && S.me.customer ? el('span', { className: 'p-cust', text: S.me.customer }) : null,
      el('span', { className: 'p-spacer' }),
      el('button', { className: 'p-btn p-btn-sm', onclick: doLogout }, 'Log out')
    );
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  function viewLogin(msg) {
    var errSlot = el('div');
    var email = el('input', { type: 'email', id: 'p-email', autocomplete: 'username', required: true });
    var pass = el('input', { type: 'password', id: 'p-pass', autocomplete: 'current-password', required: true });
    var btn = el('button', { className: 'p-btn p-btn-primary p-btn-full', type: 'submit' }, 'Log in');

    var form = el('form', { onsubmit: function (e) {
      e.preventDefault();
      clear(errSlot);
      btn.disabled = true; btn.textContent = 'Logging in…';
      api('POST', '/auth/login', { email: email.value.trim(), password: pass.value })
        .then(function () { return boot(); })
        .catch(function (err) { btn.disabled = false; btn.textContent = 'Log in'; errSlot.appendChild(alertBox('err', err.message)); });
    } },
      el('div', { className: 'p-field' }, el('label', { for: 'p-email' }, 'Email'), email),
      el('div', { className: 'p-field' }, el('label', { for: 'p-pass' }, 'Password'), pass),
      btn
    );

    mount(el('div', { className: 'p-auth' },
      el('img', { className: 'p-auth-logo', src: LOGO, alt: 'Philtronics', onerror: function () { this.style.display = 'none'; } }),
      el('div', { className: 'p-card' },
        el('h1', null, 'Customer Portal'),
        el('p', { className: 'p-sub' }, 'Sign in to raise and track your requests for quotation.'),
        msg ? alertBox('ok', msg) : null,
        errSlot,
        form
      )
    ));
  }

  // ── Accept invite (set password) ──────────────────────────────────────────
  function viewAccept(token) {
    var errSlot = el('div');
    var name = el('input', { type: 'text', id: 'p-name', autocomplete: 'name' });
    var pass = el('input', { type: 'password', id: 'p-pass', autocomplete: 'new-password', required: true, minlength: '8' });
    var pass2 = el('input', { type: 'password', id: 'p-pass2', autocomplete: 'new-password', required: true, minlength: '8' });
    var btn = el('button', { className: 'p-btn p-btn-primary p-btn-full', type: 'submit' }, 'Set password and continue');

    var form = el('form', { onsubmit: function (e) {
      e.preventDefault();
      clear(errSlot);
      if (pass.value !== pass2.value) { errSlot.appendChild(alertBox('err', 'The two passwords do not match.')); return; }
      if (pass.value.length < 8) { errSlot.appendChild(alertBox('err', 'Password must be at least 8 characters.')); return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      api('POST', '/auth/accept-invite', { token: token, password: pass.value, fullName: name.value.trim() || undefined })
        .then(function () { history.replaceState(null, '', '/portal'); return boot(); })
        .catch(function (err) { btn.disabled = false; btn.textContent = 'Set password and continue'; errSlot.appendChild(alertBox('err', err.message)); });
    } },
      el('div', { className: 'p-field' }, el('label', { for: 'p-name' }, 'Your name'), name),
      el('div', { className: 'p-field' }, el('label', { for: 'p-pass' }, el('span', null, 'Password '), el('span', { className: 'p-req' }, '*')), pass),
      el('div', { className: 'p-field' }, el('label', { for: 'p-pass2' }, el('span', null, 'Confirm password '), el('span', { className: 'p-req' }, '*')), pass2),
      btn
    );

    mount(el('div', { className: 'p-auth' },
      el('img', { className: 'p-auth-logo', src: LOGO, alt: 'Philtronics', onerror: function () { this.style.display = 'none'; } }),
      el('div', { className: 'p-card' },
        el('h1', null, 'Welcome'),
        el('p', { className: 'p-sub' }, 'Set a password to activate your portal account.'),
        errSlot,
        form
      )
    ));
  }

  // ── List (My RFQs) ─────────────────────────────────────────────────────────
  function viewList() {
    var body;
    if (!S.rfqs || !S.rfqs.length) {
      body = el('div', { className: 'p-empty' },
        el('p', null, 'You have no requests for quotation yet.'),
        el('button', { className: 'p-btn p-btn-primary', onclick: viewNew }, 'Raise your first RFQ'));
    } else {
      body = el('div', { className: 'p-list' }, S.rfqs.map(function (r) {
        return el('button', { className: 'p-item', onclick: function () { openDetail(r.id); } },
          el('div', { className: 'p-item-top' },
            el('span', { className: 'p-item-ref', text: r.reference || '(no reference)' }),
            statusBadge(r.status),
            r.priority ? el('span', { className: 'p-prio p-muted', text: 'Priority ' + r.priority }) : null),
          el('div', { className: 'p-item-part', text: [r.partNumber, r.partName].filter(Boolean).join(' – ') || '–' }),
          el('div', { className: 'p-item-meta' },
            el('span', null, 'Type: ' + quoteTypeLabel(r.quoteType)),
            el('span', null, 'Required by: ' + dmy(r.dateRequiredBy)),
            el('span', null, 'Submitted: ' + dmy(r.submittedAt)),
            r.quote ? el('span', null, 'Quoted: ' + money(r.quote.value)) : null));
      }));
    }

    mount(el('div', null,
      topbar(),
      el('div', { className: 'p-wrap' },
        el('div', { className: 'p-head' },
          el('h2', null, 'My RFQs'),
          el('span', { className: 'p-spacer' }),
          el('button', { className: 'p-btn p-btn-primary', onclick: viewNew }, '+ New RFQ')),
        body)
    ));
  }

  function openDetail(id) {
    mount(el('div', null, topbar(), el('div', { className: 'p-wrap' }, el('p', { className: 'p-muted' }, 'Loading…'))));
    api('GET', '/rfqs/' + encodeURIComponent(id))
      .then(function (r) { S.current = r; viewDetail(); })
      .catch(function (err) { viewList(); flashList(err.message, 'err'); });
  }

  var _listFlash = null;
  function flashList(msg, kind) { _listFlash = { msg: msg, kind: kind }; }

  // ── Detail ──────────────────────────────────────────────────────────────
  function viewDetail() {
    var r = S.current;
    var msgSlot = el('div');

    // Facts panel
    var facts = el('div', { className: 'p-panel' },
      el('h3', null, 'Request'),
      el('dl', { className: 'p-dl' },
        el('dt', null, 'Reference'), el('dd', null, r.reference || '–'),
        el('dt', null, 'Status'), el('dd', null, statusBadge(r.status)),
        el('dt', null, 'Part number'), el('dd', null, r.partNumber || '–'),
        el('dt', null, 'Part name'), el('dd', null, r.partName || '–'),
        el('dt', null, 'Revision'), el('dd', null, r.revision || '–'),
        el('dt', null, 'CO number'), el('dd', null, r.coNumber || '–'),
        el('dt', null, 'Quote type'), el('dd', null, quoteTypeLabel(r.quoteType)),
        el('dt', null, 'Priority'), el('dd', null, r.priority ? ('Priority ' + r.priority) : '–'),
        el('dt', null, 'Required by'), el('dd', null, dmy(r.dateRequiredBy)),
        el('dt', null, 'Free issue'), el('dd', null, r.freeIssue == null ? '–' : (r.freeIssue ? 'Yes' : 'No')),
        el('dt', null, 'Potential units / yr'), el('dd', null, r.potentialUnitsAnnual != null ? String(r.potentialUnitsAnnual) : '–'),
        el('dt', null, 'Potential revenue / yr'), el('dd', null, r.potentialRevenueAnnual != null ? money(r.potentialRevenueAnnual) : '–'),
        el('dt', null, 'Submitted'), el('dd', null, dmy(r.submittedAt)),
        el('dt', null, 'Notes'), el('dd', null, r.requestComments || '–')));

    // Quote panel (only when issued)
    var quotePanel = null;
    if (r.quote) {
      var dSlot = el('div');
      quotePanel = el('div', { className: 'p-panel p-quote' },
        el('h3', null, 'Your quote'),
        el('dl', { className: 'p-dl' },
          el('dt', null, 'Quoted value'), el('dd', null, el('span', { className: 'p-quote-val', text: money(r.quote.value) })),
          el('dt', null, 'Quote reference'), el('dd', null, r.quote.reference || '–'),
          el('dt', null, 'Quote date'), el('dd', null, dmy(r.quote.date))),
        dSlot,
        el('div', { className: 'p-quote-actions' },
          el('button', { className: 'p-btn p-btn-green', onclick: function () { decide('accept', dSlot); } }, 'Accept quote'),
          el('button', { className: 'p-btn p-btn-danger', onclick: function () { decide('decline', dSlot); } }, 'Decline quote')),
        el('p', { className: 'p-muted', style: 'font-size:12px;margin:10px 0 0' }, 'Accepting or declining records your decision with our team. Pricing and ordering are confirmed separately.'));
    }

    // Message thread
    var events = (r.events || []).filter(function (e) { return e.body; });
    var thread = events.length
      ? el('div', { className: 'p-thread' }, events.map(function (e) {
          var isPhil = (e.authorName || '').toLowerCase().indexOf('philtronics') === 0 || (e.authorName === 'Philtronics');
          return el('div', { className: 'p-msg' + (isPhil ? ' p-msg-phil' : '') },
            el('div', { className: 'p-msg-head' },
              el('span', { className: 'p-msg-author', text: e.authorName || 'Philtronics' }),
              el('span', null, dmyTime(e.createdAt))),
            el('div', { className: 'p-msg-body', text: e.body }));
        }))
      : el('p', { className: 'p-muted' }, 'No messages yet.');

    var msgInput = el('textarea', { placeholder: 'Write a message to the Philtronics team…', maxlength: '4000' });
    var sendBtn = el('button', { className: 'p-btn p-btn-primary' }, 'Send message');
    var sendForm = el('form', { onsubmit: function (e) {
      e.preventDefault();
      var body = msgInput.value.trim();
      if (!body) return;
      clear(msgSlot);
      sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
      api('POST', '/rfqs/' + encodeURIComponent(r.id) + '/messages', { body: body })
        .then(function () { openDetail(r.id); })
        .catch(function (err) { sendBtn.disabled = false; sendBtn.textContent = 'Send message'; msgSlot.appendChild(alertBox('err', err.message)); });
    } },
      el('div', { className: 'p-field' }, msgInput),
      sendBtn);

    var msgPanel = el('div', { className: 'p-panel' },
      el('h3', null, 'Messages'),
      thread,
      el('hr', { className: 'p-hr' }),
      msgSlot,
      sendForm);

    mount(el('div', null,
      topbar(),
      el('div', { className: 'p-wrap' },
        el('div', { className: 'p-head' },
          el('button', { className: 'p-btn p-btn-sm', onclick: function () { S.current = null; refreshList(); } }, '← Back'),
          el('h2', null, r.reference || 'RFQ'),
          el('span', { className: 'p-spacer' }),
          statusBadge(r.status)),
        facts,
        quotePanel,
        msgPanel))
    );
  }

  function decide(word, slot) {
    clear(slot);
    api('POST', '/rfqs/' + encodeURIComponent(S.current.id) + '/' + word)
      .then(function () { openDetail(S.current.id); })
      .catch(function (err) { slot.appendChild(alertBox('err', err.message)); });
  }

  // ── New RFQ ─────────────────────────────────────────────────────────────
  function viewNew() {
    var errSlot = el('div');
    var f = {
      partNumber: el('input', { type: 'text', maxlength: '100', required: true }),
      partName: el('input', { type: 'text', maxlength: '200' }),
      revision: el('input', { type: 'text', maxlength: '40' }),
      coNumber: el('input', { type: 'text', maxlength: '40' }),
      quoteType: el('select', null, el('option', { value: '' }, '–'), el('option', { value: 'new' }, 'New quotation'), el('option', { value: 'up_rev' }, 'Up-rev')),
      priority: el('select', null, el('option', { value: '' }, '–'), el('option', { value: 'A' }, 'Priority A'), el('option', { value: 'B' }, 'Priority B'), el('option', { value: 'C' }, 'Priority C')),
      dateRequiredBy: el('input', { type: 'date' }),
      freeIssue: el('select', null, el('option', { value: '' }, '–'), el('option', { value: 'yes' }, 'Yes'), el('option', { value: 'no' }, 'No')),
      potentialUnitsAnnual: el('input', { type: 'number', min: '0', step: '1' }),
      potentialRevenueAnnual: el('input', { type: 'number', min: '0', step: '0.01' }),
      requestComments: el('textarea', { maxlength: '4000', placeholder: 'Anything that will help us quote accurately…' }),
    };
    var btn = el('button', { className: 'p-btn p-btn-primary', type: 'submit' }, 'Submit RFQ');

    function num(input) { var v = input.value.trim(); return v === '' ? null : Number(v); }

    var form = el('form', { onsubmit: function (e) {
      e.preventDefault();
      clear(errSlot);
      if (!f.partNumber.value.trim()) { errSlot.appendChild(alertBox('err', 'Part number is required.')); return; }
      var payload = {
        partNumber: f.partNumber.value.trim(),
        partName: f.partName.value.trim() || null,
        revision: f.revision.value.trim() || null,
        coNumber: f.coNumber.value.trim() || null,
        quoteType: f.quoteType.value || null,
        priority: f.priority.value || null,
        dateRequiredBy: f.dateRequiredBy.value || null,
        freeIssue: f.freeIssue.value === '' ? null : (f.freeIssue.value === 'yes'),
        potentialUnitsAnnual: num(f.potentialUnitsAnnual),
        potentialRevenueAnnual: num(f.potentialRevenueAnnual),
        requestComments: f.requestComments.value.trim() || null,
      };
      btn.disabled = true; btn.textContent = 'Submitting…';
      api('POST', '/rfqs', payload)
        .then(function (r) { S.current = null; S.rfqs = null; openDetail(r.id); })
        .catch(function (err) { btn.disabled = false; btn.textContent = 'Submit RFQ'; errSlot.appendChild(alertBox('err', err.message)); });
    } },
      errSlot,
      el('div', { className: 'p-row2' },
        el('div', { className: 'p-field' }, el('label', null, el('span', null, 'Part number '), el('span', { className: 'p-req' }, '*')), f.partNumber),
        el('div', { className: 'p-field' }, el('label', null, 'Part name'), f.partName)),
      el('div', { className: 'p-row2' },
        el('div', { className: 'p-field' }, el('label', null, 'Revision'), f.revision),
        el('div', { className: 'p-field' }, el('label', null, 'CO number'), f.coNumber)),
      el('div', { className: 'p-row2' },
        el('div', { className: 'p-field' }, el('label', null, 'Quote type'), f.quoteType),
        el('div', { className: 'p-field' }, el('label', null, 'Priority'), f.priority)),
      el('div', { className: 'p-row2' },
        el('div', { className: 'p-field' }, el('label', null, 'Required by'), f.dateRequiredBy),
        el('div', { className: 'p-field' }, el('label', null, 'Free issue material'), f.freeIssue)),
      el('div', { className: 'p-row2' },
        el('div', { className: 'p-field' }, el('label', null, 'Potential units per year'), f.potentialUnitsAnnual),
        el('div', { className: 'p-field' }, el('label', null, 'Potential revenue per year (GBP)'), f.potentialRevenueAnnual)),
      el('div', { className: 'p-field' }, el('label', null, 'Notes'), f.requestComments),
      el('div', { className: 'p-quote-actions' },
        btn,
        el('button', { className: 'p-btn', type: 'button', onclick: function () { S.current = null; refreshList(); } }, 'Cancel'))
    );

    mount(el('div', null,
      topbar(),
      el('div', { className: 'p-wrap' },
        el('div', { className: 'p-head' },
          el('button', { className: 'p-btn p-btn-sm', onclick: function () { refreshList(); } }, '← Back'),
          el('h2', null, 'New RFQ')),
        el('div', { className: 'p-panel' }, form)))
    );
  }

  // ── Flow ──────────────────────────────────────────────────────────────────
  function refreshList() {
    mount(el('div', null, topbar(), el('div', { className: 'p-wrap' }, el('p', { className: 'p-muted' }, 'Loading…'))));
    api('GET', '/rfqs')
      .then(function (rows) { S.rfqs = rows; viewList(); if (_listFlash) { /* surfaced via alert */ _listFlash = null; } })
      .catch(function (err) {
        if (err.status === 401) { S.me = null; viewLogin(); }
        else { mount(el('div', null, topbar(), el('div', { className: 'p-wrap' }, alertBox('err', err.message)))); }
      });
  }

  function doLogout() {
    api('POST', '/auth/logout').catch(function () {}).then(function () { S.me = null; S.rfqs = null; S.current = null; viewLogin('You have been logged out.'); });
  }

  // boot: resolve session, then route.
  function boot() {
    return api('GET', '/auth/me')
      .then(function (me) { S.me = me; refreshList(); })
      .catch(function () { S.me = null; viewLogin(); });
  }

  function start() {
    var path = window.location.pathname.replace(/\/+$/, '');
    var params = new URLSearchParams(window.location.search);
    if (path === '/portal/accept' && params.get('token')) { viewAccept(params.get('token')); return; }
    boot();
  }

  start();
})();
