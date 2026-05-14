/**
 * app.js – Philtronics Time-to-Complete frontend
 * Vanilla JS SPA. No frameworks. XSS-safe DOM manipulation throughout.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════════════════ */
const state = {
  user:          null,
  currentPage:   null,
  stopwatchTimer: null,
  activeTimerId:  null,
  activeStartedAt: null,
};

// Wallboard interval handles — declared here so navigateTo can always access them
let wallboardInterval = null;
let wallboardTick     = null;

const ROLE_LEVEL = { operator: 1, supervisor: 2, manager: 3, administrator: 4 };
function hasRole(min) {
  return state.user && (ROLE_LEVEL[state.user.role] || 0) >= (ROLE_LEVEL[min] || 99);
}

/* ═══════════════════════════════════════════════════════════════════════════
   API HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  const data = await res.json().catch(() => ({ error: 'Unexpected server response.' }));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed.'), { status: res.status, data });
  return data;
}

const GET   = (path)       => api('GET',    path);
const POST  = (path, body) => api('POST',   path, body);
const PATCH = (path, body) => api('PATCH',  path, body);

/* ═══════════════════════════════════════════════════════════════════════════
   SAFE DOM HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') e.className = v;
    else if (k === 'textContent') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}
function setText(id, text) { const n = document.getElementById(id); if (n) n.textContent = text || ''; }
function setError(id, msg) { setText(id, msg); }
function clearError(id)    { setText(id, ''); }
function show(id) { const n = document.getElementById(id); if (n) n.hidden = false; }
function hide(id) { const n = document.getElementById(id); if (n) n.hidden = true; }

/* ═══════════════════════════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════════════════════════ */
function toast(msg, type = '') {
  const t = el('div', { className: `toast ${type}`, role: 'status' }, msg);
  document.getElementById('toastContainer').appendChild(t);
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 350); }, 3000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MODAL
   ═══════════════════════════════════════════════════════════════════════════ */
function openModal(title, bodyEl, footerEls = []) {
  document.getElementById('modalTitle').textContent = title;
  const body = document.getElementById('modalBody');
  body.innerHTML = '';
  body.appendChild(bodyEl);
  const footer = document.getElementById('modalFooter');
  footer.innerHTML = '';
  footerEls.forEach(b => footer.appendChild(b));
  document.getElementById('modal').hidden = false;
}
function closeModal() { document.getElementById('modal').hidden = true; }
document.getElementById('btnModalClose').addEventListener('click', closeModal);
document.getElementById('modal').addEventListener('click', e => {
  if (e.target === document.getElementById('modal')) closeModal();
});

/* ═══════════════════════════════════════════════════════════════════════════
   NAVIGATION
   ═══════════════════════════════════════════════════════════════════════════ */
const PAGES = {
  timer:     { id: 'pageTimer',     label: 'Timer',      minRole: 'operator'      },
  history:   { id: 'pageHistory',   label: 'History',    minRole: 'operator'      },
  wallboard: { id: 'pageWallboard', label: 'Wall Board', minRole: 'supervisor'    },
  dashboard: { id: 'pageDashboard', label: 'Dashboard',  minRole: 'manager'       },
  admin:     { id: 'pageAdmin',     label: 'Admin',      minRole: 'administrator' },
};

function buildNav() {
  const list = document.getElementById('navList');
  list.innerHTML = '';
  for (const [key, p] of Object.entries(PAGES)) {
    if (!hasRole(p.minRole)) continue;
    const btn = el('button', {
      textContent: p.label,
      onclick: () => { navigateTo(key); closeNav(); },
    });
    if (state.currentPage === key) btn.classList.add('active');
    list.appendChild(el('li', {}, btn));
  }
}

function navigateTo(page) {
  state.currentPage = page;

  // Stop wallboard intervals when leaving the wallboard page
  if (page !== 'wallboard') {
    if (wallboardInterval) { clearInterval(wallboardInterval); wallboardInterval = null; }
    if (wallboardTick)     { clearInterval(wallboardTick);     wallboardTick = null;     }
  }

  for (const p of Object.values(PAGES)) {
    const e = document.getElementById(p.id);
    if (e) e.hidden = true;
  }
  const target = PAGES[page];
  if (target) {
    const node = document.getElementById(target.id);
    if (node) node.hidden = false;
  }
  buildNav();
  if (page === 'timer')     loadTimerPage();
  if (page === 'history')   loadHistoryPage();
  if (page === 'wallboard') loadWallboard();
  if (page === 'dashboard') loadDashboard();
  if (page === 'admin')     loadAdminPage();
}

const navDrawer  = document.getElementById('navDrawer');
const navOverlay = document.getElementById('navOverlay');
const btnNav     = document.getElementById('btnNav');

function openNav()  { navDrawer.setAttribute('data-open',''); navOverlay.classList.remove('hidden'); btnNav.setAttribute('aria-expanded','true'); }
function closeNav() { navDrawer.removeAttribute('data-open'); navOverlay.classList.add('hidden');    btnNav.setAttribute('aria-expanded','false'); }

btnNav.addEventListener('click', () => navDrawer.hasAttribute('data-open') ? closeNav() : openNav());
navOverlay.addEventListener('click', closeNav);
document.getElementById('btnLogout').addEventListener('click', doLogout);

/* ═══════════════════════════════════════════════════════════════════════════
   AUTH
   ═══════════════════════════════════════════════════════════════════════════ */
async function init() {
  try { state.user = await GET('/me'); onLoggedIn(); }
  catch { showLoginPage(); }
}

function showLoginPage() {
  document.getElementById('topbar').classList.add('hidden');
  document.getElementById('pageLogin').hidden = false;
  for (const p of Object.values(PAGES)) {
    const e = document.getElementById(p.id);
    if (e) e.hidden = true;
  }
}

function onLoggedIn() {
  document.getElementById('topbar').classList.remove('hidden');
  document.getElementById('pageLogin').hidden = true;
  document.getElementById('userLabel').textContent = state.user.fullName;
  if (state.user.activeTimer) {
    state.activeTimerId   = state.user.activeTimer.id;
    state.activeStartedAt = state.user.activeTimer.started_at;
  } else {
    state.activeTimerId   = null;
    state.activeStartedAt = null;
  }
  refreshActiveTimerBanner();
  navigateTo('timer');
}

async function doLogout() {
  stopStopwatch();
  try { await POST('/auth/logout'); } catch (_) {}
  state.user = null;
  closeNav();
  showLoginPage();
  toast('Signed out.');
}

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  clearError('loginError');
  const btn = document.getElementById('btnLogin');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    state.user = await POST('/auth/login', { username, password });
    document.getElementById('loginPassword').value = '';
    onLoggedIn();
  } catch (err) {
    setError('loginError', err.message || 'Login failed.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ACTIVE TIMER BANNER
   ═══════════════════════════════════════════════════════════════════════════ */
function refreshActiveTimerBanner() {
  const banner = document.getElementById('activeTimerBanner');
  banner.innerHTML = '';
  if (state.activeTimerId) {
    const pill = el('div', { className: 'active-banner-pill' },
      el('span', { className: 'active-banner-dot' }),
      document.createTextNode('TIMER RUNNING')
    );
    banner.appendChild(pill);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   TIMER PAGE
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadTimerPage() {
  clearError('startError');
  clearError('stopError');
  try {
    const me = await GET('/me');
    if (me.activeTimer) {
      state.activeTimerId   = me.activeTimer.id;
      state.activeStartedAt = me.activeTimer.started_at;
      refreshActiveTimerBanner();
      await showActivePanel();
      startStopwatch();
    } else {
      state.activeTimerId   = null;
      state.activeStartedAt = null;
      refreshActiveTimerBanner();
      showStartPanel();
      stopStopwatch();
    }
  } catch (_) {
    if (state.activeTimerId) { await showActivePanel(); startStopwatch(); }
    else showStartPanel();
  }
  loadTodayEntries();
}

function showStartPanel() { show('panelStart'); hide('panelActive'); }

async function showActivePanel() {
  hide('panelStart');
  show('panelActive');
  try {
    const timers = await GET('/timers?status=active');
    const t = timers.find(t => t.id === state.activeTimerId);
    if (t) {
      state.activeStartedAt = t.startedAt;
      document.getElementById('activeItemDisplay').textContent = t.itemNumber;
      document.getElementById('activeMeta').textContent = `Started at ${formatLocalTime(t.startedAt)}`;
    } else if (state.activeTimerId) {
      state.activeTimerId = null; state.activeStartedAt = null;
      refreshActiveTimerBanner(); showStartPanel(); stopStopwatch();
      toast('Your previous timer was already stopped.', '');
    }
  } catch (_) {}
}

document.getElementById('btnStart').addEventListener('click', async () => {
  clearError('startError');
  const itemNumber = document.getElementById('itemNumberInput').value.trim();
  const notes      = document.getElementById('startNotes').value.trim();
  if (!itemNumber) { setError('startError', 'Item Number is required.'); document.getElementById('itemNumberInput').focus(); return; }
  if (!/^[A-Za-z0-9\-_]{1,40}$/.test(itemNumber)) { setError('startError', 'Item Number may only contain letters, numbers, hyphens and underscores (max 40).'); return; }
  const btn = document.getElementById('btnStart');
  btn.disabled = true;
  try {
    const timer = await POST('/timers/start', { itemNumber, notes: notes || undefined });
    state.activeTimerId = timer.id; state.activeStartedAt = timer.startedAt;
    document.getElementById('itemNumberInput').value = '';
    document.getElementById('startNotes').value = '';
    hideSuggestions();
    await showActivePanel(); startStopwatch(); refreshActiveTimerBanner(); loadTodayEntries();
    toast('Timer started for ' + timer.itemNumber, 'success');
  } catch (err) { setError('startError', err.message); }
  finally { btn.disabled = false; }
});

document.getElementById('btnStop').addEventListener('click', async () => {
  if (!state.activeTimerId) return;
  clearError('stopError');
  const btn = document.getElementById('btnStop');
  btn.disabled = true;
  try {
    const timer = await POST(`/timers/${state.activeTimerId}/stop`, {});
    state.activeTimerId = null; state.activeStartedAt = null;
    stopStopwatch(); showStartPanel(); refreshActiveTimerBanner(); loadTodayEntries();
    toast(`✓ Job complete: ${formatDuration(timer.durationSeconds)}`, 'success');
    GET('/me').then(me => { state.user = me; refreshActiveTimerBanner(); }).catch(() => {});
  } catch (err) { setError('stopError', err.message); }
  finally { btn.disabled = false; }
});

document.getElementById('btnCancelTimer').addEventListener('click', () => {
  if (!state.activeTimerId) return;
  const ageMs = state.activeStartedAt ? Date.now() - new Date(state.activeStartedAt).getTime() : Infinity;
  const needsReason = ageMs > 60000;
  const bodyDiv = el('div', {});
  if (needsReason) bodyDiv.appendChild(el('p', { textContent: 'This timer is over 60 seconds old. A reason is required.', className: 'mt-8' }));
  else bodyDiv.appendChild(el('p', { textContent: 'Are you sure you want to cancel this timer?', className: 'mt-8' }));
  const reasonInput = el('input', { type: 'text', placeholder: 'Reason for cancellation', maxlength: '500' });
  if (needsReason) bodyDiv.appendChild(el('div', { className: 'form-group mt-16' }, el('label', { textContent: 'Reason *' }), reasonInput));
  const errDiv = el('div', { className: 'error-msg', role: 'alert' });
  bodyDiv.appendChild(errDiv);
  const btnConfirm = el('button', { className: 'btn btn-danger', textContent: 'Cancel Timer' });
  const btnClose   = el('button', { className: 'btn btn-ghost',  textContent: 'Keep Running' });
  btnClose.addEventListener('click', closeModal);
  btnConfirm.addEventListener('click', async () => {
    const reason = reasonInput.value.trim() || 'Operator cancelled';
    if (needsReason && !reasonInput.value.trim()) { errDiv.textContent = 'Please enter a reason.'; return; }
    btnConfirm.disabled = true;
    try {
      await POST(`/timers/${state.activeTimerId}/cancel`, { reason });
      state.activeTimerId = null; state.activeStartedAt = null;
      stopStopwatch(); showStartPanel(); refreshActiveTimerBanner(); loadTodayEntries();
      closeModal(); toast('Timer cancelled.', 'error');
    } catch (err) { errDiv.textContent = err.message; btnConfirm.disabled = false; }
  });
  openModal('Cancel Timer', bodyDiv, [btnClose, btnConfirm]);
});

function startStopwatch() { stopStopwatch(); state.stopwatchTimer = setInterval(tickStopwatch, 500); tickStopwatch(); }
function stopStopwatch() {
  clearInterval(state.stopwatchTimer); state.stopwatchTimer = null;
  if (!state.activeTimerId) document.getElementById('stopwatch').textContent = '00:00:00';
}
function tickStopwatch() {
  if (!state.activeStartedAt) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(state.activeStartedAt).getTime()) / 1000));
  document.getElementById('stopwatch').textContent = formatDuration(elapsed);
}

async function loadTodayEntries() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  try { const timers = await GET(`/timers?from=${today.toISOString()}`); renderEntryList('todayList', timers); } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════════════════════
   HISTORY PAGE
   ═══════════════════════════════════════════════════════════════════════════ */
function loadHistoryPage() {
  const today = new Date().toISOString().slice(0, 10);
  const week  = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  document.getElementById('histFrom').value = week;
  document.getElementById('histTo').value   = today;
  if (hasRole('supervisor')) show('histSuperFilters');
  searchHistory();
}

document.getElementById('btnHistSearch').addEventListener('click', searchHistory);

async function searchHistory() {
  const from     = document.getElementById('histFrom').value;
  const to       = document.getElementById('histTo').value;
  const operator = document.getElementById('histOperator')?.value.trim() || '';
  const item     = document.getElementById('histItem')?.value.trim() || '';
  const status   = document.getElementById('histStatus')?.value || '';
  const params   = new URLSearchParams();
  if (from)     params.set('from', new Date(from).toISOString());
  if (to)       { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  if (operator) params.set('operatorId', operator);
  if (item)     params.set('itemNumber', item);
  if (status)   params.set('status', status);
  if (status === 'active') { params.delete('from'); params.delete('to'); }
  try {
    const timers = await GET(`/timers?${params}`);
    renderEntryList('historyList', timers, true);
  } catch (err) { document.getElementById('historyList').textContent = err.message; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadDashboard() {
  try { const stats = await GET('/export/stats'); renderStatCards(stats); renderDashTable(stats.byItem); }
  catch (err) { document.getElementById('dashTable').textContent = err.message; }
}

document.getElementById('btnDashSearch').addEventListener('click', async () => {
  const from = document.getElementById('dashFrom').value;
  const to   = document.getElementById('dashTo').value;
  const item = document.getElementById('dashItem').value.trim();
  const op   = document.getElementById('dashOperator').value.trim();
  const params = new URLSearchParams();
  if (from) params.set('from', new Date(from).toISOString());
  if (to)   { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  if (item) params.set('itemNumber', item);
  if (op)   params.set('operatorId', op);
  try { const stats = await GET(`/export/stats?${params}`); renderDashTable(stats.byItem); }
  catch (err) { document.getElementById('dashTable').textContent = err.message; }
});

document.getElementById('btnExportCSV').addEventListener('click', () => {
  const from = document.getElementById('dashFrom').value;
  const to   = document.getElementById('dashTo').value;
  const item = document.getElementById('dashItem').value.trim();
  const op   = document.getElementById('dashOperator').value.trim();
  const params = new URLSearchParams();
  if (from) params.set('from', new Date(from).toISOString());
  if (to)   { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  if (item) params.set('itemNumber', item);
  if (op)   params.set('operatorId', op);
  window.location.href = `/api/export/csv?${params}`;
});

function renderStatCards(stats) {
  const container = document.getElementById('statCards');
  container.innerHTML = '';
  [{ label: 'Active Now', value: stats.activeCount }, { label: 'Last 24 Hours', value: stats.total24h },
   { label: 'Last 7 Days', value: stats.total7d }, { label: 'Item Types', value: stats.byItem.length }]
  .forEach(c => container.appendChild(el('div', { className: 'stat-card' },
    el('div', { className: 'stat-label', textContent: c.label }),
    el('div', { className: 'stat-value', textContent: c.value }))));
}

function renderDashTable(rows) {
  const wrap = document.getElementById('dashTable');
  wrap.innerHTML = '';
  if (!rows || !rows.length) { wrap.appendChild(el('div', { className: 'empty-state', textContent: 'No data for selected filters.' })); return; }
  const table = el('table');
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', { textContent: 'Item Number' }), el('th', { textContent: 'Count' }),
    el('th', { textContent: 'Avg Duration' }), el('th', { textContent: 'Min' }), el('th', { textContent: 'Max' }))));
  const tbody = el('tbody', {});
  rows.forEach(r => tbody.appendChild(el('tr', {},
    el('td', { textContent: r.item_number }), el('td', { textContent: r.count }),
    el('td', { textContent: formatDuration(Math.round(r.avg_seconds)) }),
    el('td', { textContent: formatDuration(r.min_seconds) }),
    el('td', { textContent: formatDuration(r.max_seconds) }))));
  table.appendChild(tbody);
  wrap.appendChild(table);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN PAGE
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadAdminPage() {
  renderAdminTools();
  try { const users = await GET('/users'); renderUserList(users); }
  catch (err) { document.getElementById('userList').textContent = err.message; }
}

function renderAdminTools() {
  const btn = document.getElementById('btnCancelStuck');
  const resultDiv = document.getElementById('cancelStuckResult');
  if (!btn) return;
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);
  fresh.addEventListener('click', async () => {
    if (!confirm('This will cancel ALL currently active timers for all operators. Are you sure?')) return;
    fresh.disabled = true; fresh.textContent = 'Cancelling…'; resultDiv.textContent = '';
    try {
      const result = await POST('/users/admin/cancel-stuck-timers', { reason: 'Cancelled by administrator via emergency tool' });
      resultDiv.style.color = 'var(--green)'; resultDiv.textContent = '✓ ' + result.message;
      state.activeTimerId = null; state.activeStartedAt = null; refreshActiveTimerBanner();
    } catch (err) { resultDiv.style.color = 'var(--red)'; resultDiv.textContent = '✗ ' + err.message; }
    finally { fresh.disabled = false; fresh.textContent = '⚠ Cancel All Stuck Timers'; }
  });
}

document.getElementById('btnNewUser').addEventListener('click', () => openUserModal(null));

function renderUserList(users) {
  const container = document.getElementById('userList');
  container.innerHTML = '';
  if (!users.length) { container.appendChild(el('div', { className: 'empty-state', textContent: 'No users found.' })); return; }
  users.forEach(u => {
    const card = el('div', { className: `user-card ${u.isActive ? '' : 'disabled'}`, role: 'listitem' });
    const initials = (u.fullName || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
    card.appendChild(el('div', { className: 'user-avatar', textContent: initials }));
    const info = el('div', { className: 'user-info' });
    info.appendChild(el('div', { className: 'user-name', textContent: u.fullName }));
    const meta = el('div', { className: 'user-meta' });
    meta.appendChild(el('span', { textContent: '@' + u.username }));
    meta.appendChild(el('span', { className: `badge role-${u.role}`, textContent: u.role }));
    if (!u.isActive) meta.appendChild(el('span', { className: 'badge badge-cancelled', textContent: 'disabled' }));
    info.appendChild(meta); card.appendChild(info);
    const actions = el('div', { className: 'user-actions' });
    actions.appendChild(el('button', { className: 'btn btn-ghost', textContent: 'Edit', onclick: () => openUserModal(u) }));
    actions.appendChild(el('button', { className: 'btn btn-ghost', textContent: 'Reset PW', onclick: () => openResetPasswordModal(u) }));
    card.appendChild(actions);
    container.appendChild(card);
  });
}

function openUserModal(user) {
  const isNew = !user;
  const body = el('div', {});
  [{ id: 'mUsername', label: 'Username *', value: user?.username || '', disabled: !isNew },
   { id: 'mFullName', label: 'Full Name *', value: user?.fullName || '' }].forEach(f => {
    const input = el('input', { id: f.id, type: 'text', value: f.value, maxlength: '100' });
    if (f.disabled) input.setAttribute('disabled', '');
    body.appendChild(el('div', { className: 'form-group' }, el('label', { for: f.id, textContent: f.label }), input));
  });
  if (isNew) body.appendChild(el('div', { className: 'form-group' },
    el('label', { for: 'mPassword', textContent: 'Password *' }),
    el('input', { id: 'mPassword', type: 'password', maxlength: '64' })));
  const roleSelect = el('select', { id: 'mRole', style: 'background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:16px;padding:12px 14px;width:100%;' });
  ['operator','supervisor','manager','administrator'].forEach(r => {
    const o = el('option', { value: r, textContent: r.charAt(0).toUpperCase() + r.slice(1) });
    if (user?.role === r) o.selected = true;
    roleSelect.appendChild(o);
  });
  body.appendChild(el('div', { className: 'form-group' }, el('label', { for: 'mRole', textContent: 'Role *' }), roleSelect));
  if (!isNew) {
    const chk = el('input', { type: 'checkbox', id: 'mActive' });
    if (user.isActive) chk.checked = true;
    body.appendChild(el('div', { className: 'form-group', style: 'flex-direction:row;align-items:center;gap:10px;' }, chk, el('label', { for: 'mActive', textContent: 'Account Active' })));
  }
  const errDiv = el('div', { className: 'error-msg', role: 'alert' });
  body.appendChild(errDiv);
  const btnSave   = el('button', { className: 'btn btn-primary', textContent: isNew ? 'Create User' : 'Save Changes' });
  const btnCancel = el('button', { className: 'btn btn-ghost',   textContent: 'Cancel' });
  btnCancel.addEventListener('click', closeModal);
  btnSave.addEventListener('click', async () => {
    errDiv.textContent = '';
    const fullName = document.getElementById('mFullName').value.trim();
    const role     = document.getElementById('mRole').value;
    if (!fullName) { errDiv.textContent = 'Full name is required.'; return; }
    btnSave.disabled = true;
    try {
      if (isNew) {
        const username = document.getElementById('mUsername').value.trim();
        const password = document.getElementById('mPassword').value;
        if (!username) { errDiv.textContent = 'Username is required.'; btnSave.disabled = false; return; }
        if (password.length < 8) { errDiv.textContent = 'Password must be at least 8 characters.'; btnSave.disabled = false; return; }
        await POST('/users', { username, password, full_name: fullName, role });
        toast('User created.', 'success');
      } else {
        const isActive = document.getElementById('mActive').checked;
        await PATCH(`/users/${user.id}`, { full_name: fullName, role, is_active: isActive });
        toast('User updated.', 'success');
      }
      closeModal(); loadAdminPage();
    } catch (err) { errDiv.textContent = err.message; }
    finally { btnSave.disabled = false; }
  });
  openModal(isNew ? 'New User' : 'Edit User', body, [btnCancel, btnSave]);
}

function openResetPasswordModal(user) {
  const body = el('div', {});
  body.appendChild(el('p', { textContent: `Reset password for ${user.fullName} (@${user.username}).`, className: 'mt-8' }));
  const pwInput = el('input', { type: 'password', placeholder: 'New password (min 8 chars)', maxlength: '64', id: 'mNewPw' });
  body.appendChild(el('div', { className: 'form-group mt-16' }, el('label', { for: 'mNewPw', textContent: 'New Password *' }), pwInput));
  const errDiv = el('div', { className: 'error-msg', role: 'alert' });
  body.appendChild(errDiv);
  const btnSave   = el('button', { className: 'btn btn-primary', textContent: 'Reset Password' });
  const btnCancel = el('button', { className: 'btn btn-ghost',   textContent: 'Cancel' });
  btnCancel.addEventListener('click', closeModal);
  btnSave.addEventListener('click', async () => {
    const pw = pwInput.value;
    if (pw.length < 8) { errDiv.textContent = 'Password must be at least 8 characters.'; return; }
    btnSave.disabled = true;
    try { await POST(`/users/${user.id}/reset-password`, { password: pw }); toast('Password reset.', 'success'); closeModal(); }
    catch (err) { errDiv.textContent = err.message; btnSave.disabled = false; }
  });
  openModal('Reset Password', body, [btnCancel, btnSave]);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SHARED RENDER HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */
function renderEntryList(containerId, timers, showOperator = false) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (!timers || !timers.length) { container.appendChild(el('div', { className: 'empty-state', textContent: 'No records found.' })); return; }
  const isAdmin = hasRole('administrator');
  timers.forEach(t => {
    const card = el('div', { className: 'entry-card', role: 'listitem' });
    const left = el('div', {});
    left.appendChild(el('div', { className: 'entry-item', textContent: t.itemNumber }));
    if (showOperator) left.appendChild(el('div', { className: 'entry-operator', textContent: t.operatorName }));
    left.appendChild(el('div', { className: 'entry-time',
      textContent: formatLocalTime(t.startedAt) + (t.completedAt ? ' → ' + formatLocalTime(t.completedAt) : '') }));
    if (t.notes) left.appendChild(el('div', { className: 'entry-time', textContent: '📝 ' + t.notes }));
    const right = el('div', {});
    right.appendChild(el('div', { className: 'entry-duration', textContent: t.durationSeconds != null ? formatDuration(t.durationSeconds) : '—' }));
    right.appendChild(el('div', { className: 'entry-status' }, el('span', { className: `badge badge-${t.status}`, textContent: t.status })));
    if (isAdmin) {
      const delBtn = el('button', { className: 'btn-delete-timer', textContent: '🗑', title: 'Delete this timer record', 'aria-label': 'Delete timer record for ' + t.itemNumber });
      delBtn.addEventListener('click', () => confirmDeleteTimer(t, card, containerId));
      right.appendChild(delBtn);
    }
    card.appendChild(left); card.appendChild(right);
    container.appendChild(card);
  });
}

function confirmDeleteTimer(t, card, containerId) {
  const body = el('div', {});
  body.appendChild(el('p', { textContent: 'Are you sure you want to permanently delete this timer record?', style: 'margin-bottom:12px;' }));
  const summary = el('div', { style: 'background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:13px;color:var(--text2);margin-bottom:12px;' });
  summary.appendChild(el('div', { textContent: 'Item: ' + t.itemNumber, style: 'font-family:var(--font-mono);color:var(--accent);margin-bottom:4px;' }));
  summary.appendChild(el('div', { textContent: 'Operator: ' + t.operatorName }));
  summary.appendChild(el('div', { textContent: 'Started: ' + formatLocalTime(t.startedAt) }));
  summary.appendChild(el('div', { textContent: 'Status: ' + t.status }));
  body.appendChild(summary);
  body.appendChild(el('p', { textContent: '⚠ This cannot be undone. The audit log for this timer will also be deleted.', style: 'color:var(--red);font-size:13px;font-weight:600;' }));
  const errDiv = el('div', { className: 'error-msg', role: 'alert' });
  body.appendChild(errDiv);
  const btnConfirm = el('button', { className: 'btn btn-danger', textContent: 'Delete Record' });
  const btnCancel  = el('button', { className: 'btn btn-ghost',  textContent: 'Keep Record' });
  btnCancel.addEventListener('click', closeModal);
  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled = true; btnConfirm.textContent = 'Deleting…';
    try {
      await api('DELETE', '/timers/' + t.id);
      if (t.id === state.activeTimerId) { state.activeTimerId = null; state.activeStartedAt = null; stopStopwatch(); refreshActiveTimerBanner(); }
      card.remove();
      const container = document.getElementById(containerId);
      if (container && container.children.length === 0) container.appendChild(el('div', { className: 'empty-state', textContent: 'No records found.' }));
      closeModal(); toast('Timer record deleted.', '');
    } catch (err) { errDiv.textContent = err.message; btnConfirm.disabled = false; btnConfirm.textContent = 'Delete Record'; }
  });
  openModal('Delete Timer Record', body, [btnCancel, btnConfirm]);
}

/* ═══════════════════════════════════════════════════════════════════════════
   AUTOCOMPLETE
   ═══════════════════════════════════════════════════════════════════════════ */
let acDebounce = null;
const itemInput = document.getElementById('itemNumberInput');
const sugList   = document.getElementById('itemSuggestions');

itemInput.addEventListener('input', () => {
  clearTimeout(acDebounce);
  const q = itemInput.value.trim();
  if (q.length < 1) { hideSuggestions(); return; }
  acDebounce = setTimeout(() => fetchSuggestions(q), 200);
});
itemInput.addEventListener('keydown', e => {
  const items = sugList.querySelectorAll('li');
  if (!items.length) return;
  const cur = sugList.querySelector('[aria-selected="true"]');
  if (e.key === 'ArrowDown') { e.preventDefault(); const next = cur ? (cur.nextSibling || items[0]) : items[0]; if (cur) cur.removeAttribute('aria-selected'); next.setAttribute('aria-selected', 'true'); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); const prev = cur ? (cur.previousSibling || items[items.length-1]) : items[items.length-1]; if (cur) cur.removeAttribute('aria-selected'); prev.setAttribute('aria-selected', 'true'); }
  else if (e.key === 'Enter') { const sel = sugList.querySelector('[aria-selected="true"]'); if (sel) { e.preventDefault(); itemInput.value = sel.dataset.value; hideSuggestions(); } }
  else if (e.key === 'Escape') hideSuggestions();
});
document.addEventListener('click', e => { if (!itemInput.contains(e.target) && !sugList.contains(e.target)) hideSuggestions(); });

async function fetchSuggestions(q) {
  try { showSuggestions(await GET(`/items?q=${encodeURIComponent(q)}`)); } catch (_) {}
}
function showSuggestions(items) {
  sugList.innerHTML = '';
  if (!items.length) { hideSuggestions(); return; }
  items.forEach(item => {
    const li = el('li', { role: 'option', tabindex: '-1' });
    li.dataset.value = item.item_number;
    li.appendChild(el('span', { textContent: item.item_number }));
    if (item.description) li.appendChild(el('span', { className: 'sug-desc', textContent: item.description }));
    li.addEventListener('mousedown', e => { e.preventDefault(); itemInput.value = item.item_number; hideSuggestions(); itemInput.focus(); });
    sugList.appendChild(li);
  });
  sugList.hidden = false;
}
function hideSuggestions() { sugList.hidden = true; sugList.innerHTML = ''; }

/* ═══════════════════════════════════════════════════════════════════════════
   FORMATTING
   ═══════════════════════════════════════════════════════════════════════════ */
function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}
function formatLocalTime(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleString('en-GB', {
    timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCANNER
   ═══════════════════════════════════════════════════════════════════════════ */
const scanner = (() => {
  let stream = null, active = false, scanInterval = null, detector = null;
  let torchEnabled = false, targetInput = null, targetMode = 'item';
  const overlay  = document.getElementById('scannerOverlay');
  const video    = document.getElementById('scannerVideo');
  const statusEl = document.getElementById('scannerStatus');
  const torchBtn = document.getElementById('btnScanTorch');
  const closeBtn = document.getElementById('btnScanClose');

  function setStatus(msg, type = '') { statusEl.textContent = msg; statusEl.className = 'scanner-status' + (type ? ' ' + type : ''); }

  async function open(inputEl, mode) {
    targetInput = inputEl; targetMode = mode || 'item';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Camera API not available. Use Chrome on Android.', 'error'); return; }
    if (!('BarcodeDetector' in window)) { overlay.hidden = false; setStatus('Barcode scanning requires Chrome on Android or Chrome 83+ on desktop. Your current browser does not support it.', 'error'); return; }
    overlay.hidden = false; active = true; setStatus('Scanning — point at a barcode or QR code');
    try {
      detector = new BarcodeDetector({ formats: ['qr_code','code_128','code_39','code_93','ean_13','ean_8','upc_a','upc_e','data_matrix','pdf417'] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream; await video.play();
      setStatus('Scanning — point at a barcode or QR code');
      tryEnableTorch(); startScanLoop();
    } catch (err) {
      if (err.name === 'NotAllowedError') setStatus('Camera permission denied. Tap the camera icon in your browser address bar to allow access.', 'error');
      else if (err.name === 'NotFoundError') setStatus('No camera found on this device.', 'error');
      else setStatus('Camera error: ' + err.message, 'error');
    }
  }

  function startScanLoop() {
    scanInterval = setInterval(async () => {
      if (!active || !detector || video.readyState < 2) return;
      try {
        const barcodes = await detector.detect(video);
        if (barcodes && barcodes.length > 0) {
          const text = barcodes[0].rawValue.trim();
          if (targetMode === 'item') {
            if (/^[A-Za-z0-9\-_]{1,40}$/.test(text)) onScanSuccess(text);
            else { setStatus(`Read "${text}" — not a valid item number. Try again.`, 'error'); setTimeout(() => { if (active) setStatus('Scanning — point at a barcode or QR code'); }, 2000); }
          } else { if (text.length > 0) onScanSuccess(text.slice(0, 500)); }
        }
      } catch (_) {}
    }, 300);
  }

  function onScanSuccess(text) {
    clearInterval(scanInterval); scanInterval = null;
    setStatus('✓ Scanned: ' + text, 'success');
    if (targetInput) {
      if (targetMode === 'notes' && targetInput.value.trim()) targetInput.value = targetInput.value.trimEnd() + ' ' + text;
      else targetInput.value = text;
      if (targetMode === 'item') hideSuggestions();
    }
    const label = targetMode === 'notes' ? 'Note scanned' : 'Item number scanned';
    setTimeout(() => { close(); if (targetInput) targetInput.focus(); toast(`${label}: ${text}`, 'success'); }, 700);
  }

  function close() {
    active = false; overlay.hidden = true;
    clearInterval(scanInterval); scanInterval = null;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    video.srcObject = null; detector = null; torchEnabled = false;
    torchBtn.hidden = true; torchBtn.textContent = '🔦 Torch';
    setStatus('Initialising camera…');
  }

  function tryEnableTorch() {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) {
      torchBtn.hidden = false;
      torchBtn.onclick = async () => { torchEnabled = !torchEnabled; try { await track.applyConstraints({ advanced: [{ torch: torchEnabled }] }); torchBtn.textContent = torchEnabled ? '🔦 Torch On' : '🔦 Torch'; } catch (_) {} };
    }
  }

  document.getElementById('btnScan').addEventListener('click', () => open(document.getElementById('itemNumberInput'), 'item'));
  document.getElementById('btnScanNotes').addEventListener('click', () => open(document.getElementById('startNotes'), 'notes'));
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) close(); });
  return { open, close };
})();

/* ═══════════════════════════════════════════════════════════════════════════
   WALL BOARD
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadWallboard() {
  if (wallboardInterval) clearInterval(wallboardInterval);
  await refreshWallboard();
  wallboardInterval = setInterval(refreshWallboard, 30000);
}

async function refreshWallboard() {
  const container = document.getElementById('wallboardTiles');
  const countEl   = document.getElementById('wallboardCount');
  const updatedEl = document.getElementById('wallboardUpdated');
  if (!container) return;
  try {
    const timers = await GET('/timers?status=active&limit=200');
    if (countEl)   countEl.textContent   = timers.length + ' active job' + (timers.length !== 1 ? 's' : '');
    if (updatedEl) updatedEl.textContent = 'Updated ' + new Date().toLocaleTimeString('en-GB');
    container.innerHTML = '';
    if (timers.length === 0) {
      container.appendChild(el('div', { className: 'wallboard-empty' },
        el('div', { className: 'wallboard-empty-icon', textContent: '✓' }),
        el('div', { className: 'wallboard-empty-text', textContent: 'No active jobs right now' })));
      return;
    }
    timers.forEach(t => {
      const elapsed = Math.max(0, Math.floor((Date.now() - new Date(t.startedAt).getTime()) / 1000));
      const tile = el('div', { className: 'wallboard-tile' });
      if (elapsed > 4 * 3600) tile.classList.add('tile-overdue');
      else if (elapsed > 2 * 3600) tile.classList.add('tile-warning');
      tile.appendChild(el('div', { className: 'wb-item',     textContent: t.itemNumber }));
      tile.appendChild(el('div', { className: 'wb-operator', textContent: t.operatorName }));
      tile.appendChild(el('div', { className: 'wb-elapsed',  textContent: formatDuration(elapsed), 'data-startedat': t.startedAt }));
      tile.appendChild(el('div', { className: 'wb-started',  textContent: 'Started ' + formatLocalTime(t.startedAt) }));
      if (t.notes) tile.appendChild(el('div', { className: 'wb-notes', textContent: '📝 ' + t.notes }));
      container.appendChild(tile);
    });
    startWallboardTick();
  } catch (err) {
    container.innerHTML = '';
    container.appendChild(el('div', { className: 'wallboard-empty', textContent: 'Could not load active timers: ' + err.message }));
  }
}

function startWallboardTick() {
  if (wallboardTick) clearInterval(wallboardTick);
  wallboardTick = setInterval(() => {
    if (state.currentPage !== 'wallboard') { clearInterval(wallboardTick); wallboardTick = null; return; }
    document.querySelectorAll('.wb-elapsed[data-startedat]').forEach(node => {
      const startedAt = node.getAttribute('data-startedat');
      if (!startedAt) return;
      const elapsed = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
      node.textContent = formatDuration(elapsed);
      const tile = node.closest('.wallboard-tile');
      if (tile) {
        tile.classList.remove('tile-warning', 'tile-overdue');
        if (elapsed > 4 * 3600) tile.classList.add('tile-overdue');
        else if (elapsed > 2 * 3600) tile.classList.add('tile-warning');
      }
    });
  }, 1000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════════════════ */
init();