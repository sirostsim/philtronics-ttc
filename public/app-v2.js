/**
 * app.js – Philtronics Time-to-Complete frontend
 * Vanilla JS SPA. No frameworks. XSS-safe DOM manipulation throughout.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════════════════ */
const state = {
  user:                     null,
  currentPage:              null,
  stopwatchTimer:           null,
  activeTimerId:            null,
  activeStartedAt:          null,
  activeTargetSeconds:      null,
  activeIsPaused:           false,
  activePausedAt:           null,
  activeTotalPausedSeconds: 0,
};

// Wallboard interval handles — declared here so navigateTo can always access them
let wallboardInterval  = null;
let wallboardTick      = null;
let wallboardCInterval = null;
let wallboardCTick     = null;

// Declared here to avoid temporal dead zone — hideSuggestions() is called
// from btnStart handler before the autocomplete section further down.
const itemInput = document.getElementById('itemNumberInput');
const sugList   = document.getElementById('itemSuggestions');

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

const GET    = (path)        => api('GET',   path);
const POST   = (path, body)  => api('POST',  path, body);
const PATCH  = (path, body)  => api('PATCH', path, body);
const DELETE = (path, body)  => api('DELETE', path, body);

/* ═══════════════════════════════════════════════════════════════════════════
   SAFE DOM HELPERS  (XSS prevention)
   ═══════════════════════════════════════════════════════════════════════════ */
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
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
function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text || '';
}
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
  setTimeout(() => {
    t.classList.add('fade-out');
    setTimeout(() => t.remove(), 350);
  }, 3000);
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
  home:       { id: 'pageHome',       label: 'Home',               minRole: 'supervisor'    },
  timer:      { id: 'pageTimer',      label: 'Timer',              minRole: 'operator'      },
  history:    { id: 'pageHistory',    label: 'History',            minRole: 'operator'      },
  wallboard:  { id: 'pageWallboard',  label: 'Wall Board',         minRole: 'supervisor'    },
  wallboardc: { id: 'pageWallboardC', label: 'Wall Board Compact', minRole: 'supervisor'    },
  dashboard:  { id: 'pageDashboard',  label: 'Dashboard',          minRole: 'manager'       },
  targets:    { id: 'pageTargets',    label: 'Target Times',       minRole: 'manager'       },
  admin:      { id: 'pageAdmin',      label: 'Admin',              minRole: 'administrator' },
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

  if (page !== 'wallboard') {
    if (wallboardInterval) { clearInterval(wallboardInterval); wallboardInterval = null; }
    if (wallboardTick)     { clearInterval(wallboardTick);     wallboardTick = null;     }
  }
  if (page !== 'wallboardc') {
    if (wallboardCInterval) { clearInterval(wallboardCInterval); wallboardCInterval = null; }
    if (wallboardCTick)     { clearInterval(wallboardCTick);     wallboardCTick = null;     }
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
  if (page === 'home')       loadHomePage();
  if (page === 'timer')      loadTimerPage();
  if (page === 'history')    loadHistoryPage();
  if (page === 'wallboard')  loadWallboard();
  if (page === 'dashboard')  loadDashboard();
  if (page === 'targets')    loadTargetsPage();
  if (page === 'wallboardc') loadWallboardCompact();
  if (page === 'admin')      loadAdminPage();
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
  try {
    state.user = await GET('/me');
    onLoggedIn();
  } catch {
    showLoginPage();
  }
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
    state.activeStartedAt = state.user.activeTimer.startedAt || null;
  } else {
    state.activeTimerId   = null;
    state.activeStartedAt = null;
  }
  refreshActiveTimerBanner();
  if (hasRole('supervisor')) {
    navigateTo('home');
  } else {
    navigateTo('timer');
  }
  checkTotpSetupRequired();
  connectMessageStream();
}

async function doLogout() {
  stopStopwatch();
  disconnectMessageStream();
  stopPausePoll();
  try { await POST('/auth/logout'); } catch (_) {}
  state.user = null;
  closeNav();
  showLoginPage();
  toast('Signed out.');
}

let _totpChallengeToken = null;

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  clearError('loginError');
  const btn = document.getElementById('btnLogin');
  btn.disabled = true;
  btn.textContent = 'Signing in\u2026';
  try {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const result   = await POST('/auth/login', { username, password });

    if (result.totpRequired) {
      _totpChallengeToken = result.challengeToken;
      document.getElementById('loginForm').hidden = true;
      document.getElementById('totpStep').hidden  = false;
      document.getElementById('totpCode').value   = '';
      clearError('totpError');
      setTimeout(() => document.getElementById('totpCode').focus(), 50);
    } else {
      document.getElementById('loginPassword').value = '';
      state.user = result;
      onLoggedIn();
    }
  } catch (err) {
    setError('loginError', err.message || 'Login failed.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

document.getElementById('btnTotpVerify').addEventListener('click', async () => {
  clearError('totpError');
  const code = document.getElementById('totpCode').value.trim();
  if (!/^\d{6}$/.test(code)) {
    setError('totpError', 'Please enter the 6-digit code from your authenticator app.');
    return;
  }
  const btn = document.getElementById('btnTotpVerify');
  btn.disabled = true; btn.textContent = 'Verifying\u2026';
  try {
    state.user = await POST('/totp/verify', { challengeToken: _totpChallengeToken, code });
    _totpChallengeToken = null;
    document.getElementById('totpCode').value  = '';
    document.getElementById('totpStep').hidden = true;
    document.getElementById('loginForm').hidden = false;
    onLoggedIn();
  } catch (err) {
    setError('totpError', err.message || 'Verification failed.');
  } finally {
    btn.disabled = false; btn.textContent = 'Verify';
  }
});

document.getElementById('totpCode').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnTotpVerify').click();
});

document.getElementById('btnTotpBack').addEventListener('click', () => {
  _totpChallengeToken = null;
  document.getElementById('totpStep').hidden  = true;
  document.getElementById('loginForm').hidden = false;
  clearError('totpError');
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
      state.activeStartedAt = me.activeTimer.startedAt;

      hide('panelStart');
      show('panelActive');
      document.getElementById('activeItemDisplay').textContent = me.activeTimer.itemNumber || '';
      const metaParts = ['Started at ' + formatLocalTime(me.activeTimer.startedAt)];
      if (me.activeTimer.workstation) metaParts.push('WS: ' + me.activeTimer.workstation);
      if (me.activeTimer.woNumber)    metaParts.push('W/O: ' + me.activeTimer.woNumber);
      document.getElementById('activeMeta').textContent = metaParts.join('  ·  ');

      refreshActiveTimerBanner();
      startStopwatch();
      showActivePanel();
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
  if (state.activeTimerId) startPausePoll();
  else stopPausePoll();
}

function showStartPanel() {
  show('panelStart');
  hide('panelActive');
  state.activeTargetSeconds    = null;
  state.activeIsPaused         = false;
  state.activePausedAt         = null;
  state.activeTotalPausedSeconds = 0;
  hide('activeTargetWrap');
  stopPausePoll();
  const rb = document.getElementById('btnResumeTimer');
  if (rb) rb.remove();
  clearError('startError');
}

async function showActivePanel() {
  hide('panelStart');
  show('panelActive');

  try {
    let t = null;

    if (state.activeTimerId) {
      try {
        const direct = await GET('/timers/' + state.activeTimerId);
        if (direct && direct.status === 'active') {
          t = direct;
        } else if (direct && direct.status && direct.status !== 'active') {
          state.activeTimerId   = null;
          state.activeStartedAt = null;
          refreshActiveTimerBanner();
          showStartPanel();
          stopStopwatch();
          toast('Your previous timer was already stopped.', '');
          return;
        }
      } catch (_) {}
    }

    if (!t) {
      const timers = await GET('/timers?status=active');
      t = timers.find(timer => timer.id === state.activeTimerId);
    }

    if (t) {
      state.activeTimerId              = t.id;
      state.activeStartedAt            = t.startedAt;
      state.activeIsPaused             = t.isPaused || false;
      state.activePausedAt             = t.pausedAt || null;
      state.activeTotalPausedSeconds   = t.totalPausedSeconds || 0;
      document.getElementById('activeItemDisplay').textContent = t.itemNumber;
      const metaParts = [`Started at ${formatLocalTime(t.startedAt)}`];
      if (t.workstation) metaParts.push('WS: ' + t.workstation);
      if (t.woNumber)    metaParts.push('W/O: ' + t.woNumber);
      document.getElementById('activeMeta').textContent = metaParts.join('  ·  ');
      state.activeTargetSeconds = t.targetSeconds || null;
      updateActiveTargetDisplay();
      updatePauseUI();
    } else if (state.activeTimerId) {
      state.activeTimerId   = null;
      state.activeStartedAt = null;
      refreshActiveTimerBanner();
      showStartPanel();
      stopStopwatch();
      toast('Your previous timer was already stopped.', '');
    }
  } catch (_) {}
}

document.getElementById('btnStart').addEventListener('click', async () => {
  clearError('startError');
  const itemNumber  = document.getElementById('itemNumberInput').value.trim();
  const workstation = document.getElementById('startWorkstation').value.trim();
  const woNumber    = document.getElementById('startWoNumber').value.trim();
  const timeCheck   = document.getElementById('startTimeCheck').checked;

  if (!itemNumber) {
    setError('startError', 'Item Number is required.');
    document.getElementById('itemNumberInput').focus();
    return;
  }
  if (!/^[A-Za-z0-9\-_]{1,40}$/.test(itemNumber)) {
    setError('startError', 'Item Number may only contain letters, numbers, hyphens and underscores (max 40).');
    return;
  }

  const btn = document.getElementById('btnStart');
  btn.disabled = true;
  try {
    let timer;
    try {
      timer = await POST('/timers/start', {
        itemNumber,
        timeCheck,
        workstation: workstation || undefined,
        woNumber:    woNumber    || undefined,
      });
    } catch (startErr) {
      if (startErr.status === 409) {
        setError('startError', startErr.message);
        const existingResumeBtn = document.getElementById('btnResumeTimer');
        if (!existingResumeBtn) {
          const resumeBtn = document.createElement('button');
          resumeBtn.id = 'btnResumeTimer';
          resumeBtn.className = 'btn btn-primary btn-full';
          resumeBtn.style.marginTop = '8px';
          resumeBtn.textContent = '\u21a9 Resume My Active Timer';
          resumeBtn.addEventListener('click', async () => {
            resumeBtn.remove();
            clearError('startError');
            const me = await GET('/me').catch(() => null);
            if (me && me.activeTimer) {
              state.activeTimerId   = me.activeTimer.id;
              state.activeStartedAt = me.activeTimer.started_at || me.activeTimer.startedAt;
              refreshActiveTimerBanner();
              await showActivePanel();
              startStopwatch();
            }
          });
          document.getElementById('startError').insertAdjacentElement('afterend', resumeBtn);
        }
        btn.disabled = false;
        return;
      }
      throw startErr;
    }
    state.activeTimerId   = timer.id;
    state.activeStartedAt = timer.startedAt;
    document.getElementById('itemNumberInput').value  = '';
    document.getElementById('startWorkstation').value = '';
    document.getElementById('startWoNumber').value    = '';
    document.getElementById('startTimeCheck').checked = false;
    hideSuggestions();
    showActivePanel();
    startStopwatch();
    refreshActiveTimerBanner();
    loadTodayEntries();
    startPausePoll();
    toast('Timer started for ' + timer.itemNumber, 'success');
  } catch (err) {
    setError('startError', err.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btnStop').addEventListener('click', async () => {
  if (!state.activeTimerId) return;
  clearError('stopError');
  const btn = document.getElementById('btnStop');
  btn.disabled = true;
  try {
    const timer = await POST(`/timers/${state.activeTimerId}/stop`, {});
    state.activeTimerId          = null;
    state.activeStartedAt        = null;
    state.activeTargetSeconds    = null;
    state.activeIsPaused         = false;
    state.activePausedAt         = null;
    state.activeTotalPausedSeconds = 0;
    stopStopwatch();
    showStartPanel();
    refreshActiveTimerBanner();
    loadTodayEntries();
    toast(`\u2713 Job complete: ${formatDuration(timer.durationSeconds)}`, 'success');
    GET('/me').then(me => { state.user = me; refreshActiveTimerBanner(); }).catch(() => {});
  } catch (err) {
    setError('stopError', err.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btnCancelTimer').addEventListener('click', () => {
  if (!state.activeTimerId) return;
  const ageMs = state.activeStartedAt
    ? Date.now() - new Date(state.activeStartedAt).getTime()
    : Infinity;
  const needsReason = ageMs > 60000;
  const bodyDiv = el('div', {});
  if (needsReason) bodyDiv.appendChild(el('p', { textContent: 'This timer is over 60 seconds old. A reason is required.', className: 'mt-8' }));
  else             bodyDiv.appendChild(el('p', { textContent: 'Are you sure you want to cancel this timer?', className: 'mt-8' }));
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
      state.activeTimerId   = null; state.activeStartedAt = null;
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
  const referenceMs = state.activeIsPaused && state.activePausedAt
    ? new Date(state.activePausedAt).getTime()
    : Date.now();
  const rawElapsed = Math.max(0, Math.floor((referenceMs - new Date(state.activeStartedAt).getTime()) / 1000));
  const netElapsed = Math.max(0, rawElapsed - state.activeTotalPausedSeconds);
  document.getElementById('stopwatch').textContent = formatDuration(netElapsed);
  if (state.activeTargetSeconds) updateActiveTargetDisplay(netElapsed);
}

function updateActiveTargetDisplay(elapsed) {
  if (elapsed === undefined) {
    const refMs = state.activeIsPaused && state.activePausedAt
      ? new Date(state.activePausedAt).getTime() : Date.now();
    const raw = state.activeStartedAt
      ? Math.max(0, Math.floor((refMs - new Date(state.activeStartedAt).getTime()) / 1000)) : 0;
    elapsed = Math.max(0, raw - state.activeTotalPausedSeconds);
  }
  const tgt  = state.activeTargetSeconds;
  const wrap = document.getElementById('activeTargetWrap');
  if (!tgt || !wrap) return;
  wrap.hidden = false;
  const pct       = elapsed / tgt;
  const remaining = tgt - elapsed;
  const over      = remaining <= 0;
  const fill = document.getElementById('activeTargetFill');
  if (fill) { fill.style.width = Math.round(Math.min(1, pct) * 100) + '%'; fill.className = 'active-target-fill' + (over ? ' over' : pct >= 0.8 ? ' warn' : ''); }
  const pctEl = document.getElementById('activeTargetPct');
  if (pctEl) pctEl.textContent = Math.round(pct * 100) + '%';
  const lbl = document.getElementById('activeTargetLabel');
  if (lbl) {
    if (over) { lbl.textContent = '\u26a0 ' + formatHM(Math.abs(remaining)) + ' overdue (target: ' + formatHM(tgt) + ')'; lbl.className = 'active-target-label overdue'; }
    else      { lbl.textContent = '\uD83C\uDFAF ' + formatHM(remaining) + ' remaining (target: ' + formatHM(tgt) + ')'; lbl.className = 'active-target-label' + (pct >= 0.8 ? ' warn' : ''); }
  }
}

async function loadTodayEntries() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  try { renderEntryList('todayList', await GET(`/timers?from=${today.toISOString()}`)); } catch (_) {}
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
  if (from)     params.set('from',       new Date(from).toISOString());
  if (to)       { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  if (operator) params.set('operatorId', operator);
  if (item)     params.set('itemNumber', item);
  if (status)   params.set('status',     status);
  if (status === 'active') { params.delete('from'); params.delete('to'); }
  try { renderEntryList('historyList', await GET(`/timers?${params}`), true); }
  catch (err) { document.getElementById('historyList').textContent = err.message; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadDashboard() {
  try {
    const stats = await GET('/export/stats');
    renderStatCards(stats);
    renderDashTable(stats.byItem);
  } catch (err) { document.getElementById('dashTable').textContent = err.message; }
  loadTargetTimes();
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
  try { renderDashTable((await GET(`/export/stats?${params}`)).byItem); }
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
  [{ label:'Active Now', value:stats.activeCount }, { label:'Last 24 Hours', value:stats.total24h },
   { label:'Last 7 Days', value:stats.total7d }, { label:'Item Types', value:stats.byItem.length }]
  .forEach(c => container.appendChild(el('div', { className:'stat-card' },
    el('div', { className:'stat-label', textContent:c.label }),
    el('div', { className:'stat-value', textContent:c.value }))));
}

function renderDashTable(rows) {
  const wrap = document.getElementById('dashTable');
  wrap.innerHTML = '';
  if (!rows || !rows.length) { wrap.appendChild(el('div', { className:'empty-state', textContent:'No data for selected filters.' })); return; }
  const table = el('table');
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', { textContent:'Item Number' }), el('th', { textContent:'Count' }),
    el('th', { textContent:'Avg Actual' }), el('th', { textContent:'Min' }), el('th', { textContent:'Max' }),
    el('th', { textContent:'Target' }), el('th', { textContent:'Avg Delta' }))));
  const tbody = el('tbody', {});
  rows.forEach(r => {
    const hasTarget = r.target_seconds != null;
    const delta     = hasTarget ? Math.round(r.avg_seconds) - r.target_seconds : null;
    const row = el('tr', {},
      el('td', { textContent:r.item_number }), el('td', { textContent:r.count }),
      el('td', { textContent:formatDuration(Math.round(r.avg_seconds)) }),
      el('td', { textContent:formatDuration(r.min_seconds) }), el('td', { textContent:formatDuration(r.max_seconds) }),
      el('td', { textContent:hasTarget ? formatHM(r.target_seconds) : '\u2014', className:hasTarget?'':'dash-no-target' }));
    const dc = el('td', { textContent:delta===null?'\u2014':(delta>=0?'+':'')+formatDuration(Math.abs(delta)),
      className:delta===null?'dash-no-target':delta>0?'dash-over':'dash-under' });
    if (delta!==null) dc.title = (delta>0?'Over':'Under')+' target by '+formatDuration(Math.abs(delta));
    row.appendChild(dc); tbody.appendChild(row);
  });
  table.appendChild(tbody); wrap.appendChild(table);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN PAGE
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadAdminPage() {
  renderAdminTools();
  try { renderUserList(await GET('/users')); }
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
    fresh.disabled = true; fresh.textContent = 'Cancelling\u2026'; resultDiv.textContent = '';
    try {
      const result = await POST('/users/admin/cancel-stuck-timers', { reason: 'Cancelled by administrator via emergency tool' });
      resultDiv.style.color = 'var(--green)'; resultDiv.textContent = '\u2713 ' + result.message;
      state.activeTimerId = null; state.activeStartedAt = null; refreshActiveTimerBanner();
    } catch (err) { resultDiv.style.color = 'var(--red)'; resultDiv.textContent = '\u2717 ' + err.message; }
    finally { fresh.disabled = false; fresh.textContent = '\u26a0 Cancel All Stuck Timers'; }
  });
}

document.getElementById('btnNewUser').addEventListener('click', () => openUserModal(null));

const ROLES_REQUIRING_TOTP = ['manager', 'administrator'];

function renderUserList(users) {
  const container = document.getElementById('userList');
  container.innerHTML = '';
  if (!users.length) { container.appendChild(el('div', { className:'empty-state', textContent:'No users found.' })); return; }
  users.forEach(u => {
    const card = el('div', { className:`user-card ${u.isActive?'':'disabled'}`, role:'listitem' });
    const initials = (u.fullName||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
    card.appendChild(el('div', { className:'user-avatar', textContent:initials }));
    const info = el('div', { className:'user-info' });
    info.appendChild(el('div', { className:'user-name', textContent:u.fullName }));
    const meta = el('div', { className:'user-meta' });
    meta.appendChild(el('span', { textContent:'@'+u.username }));
    meta.appendChild(el('span', { className:`badge role-${u.role}`, textContent:u.role }));
    if (!u.isActive) meta.appendChild(el('span', { className:'badge badge-cancelled', textContent:'disabled' }));
    info.appendChild(meta); card.appendChild(info);
    const actions = el('div', { className:'user-actions' });
    actions.appendChild(el('button', { className:'btn btn-ghost', textContent:'Edit', onclick:()=>openUserModal(u) }));
    actions.appendChild(el('button', { className:'btn btn-ghost', textContent:'Reset PW', onclick:()=>openResetPasswordModal(u) }));
    if (ROLES_REQUIRING_TOTP.includes(u.role)) {
      const fa2Btn = el('button', {
        className:'btn btn-ghost',
        textContent: u.totpEnabled ? 'Reset 2FA' : '2FA: Off',
        title: u.totpEnabled ? 'Reset this user\'s 2FA' : '2FA not yet configured',
        style: u.totpEnabled ? '' : 'color:var(--red);opacity:.7;',
      });
      if (u.totpEnabled) fa2Btn.addEventListener('click', () => confirmReset2FA(u));
      else fa2Btn.setAttribute('disabled', '');
      actions.appendChild(fa2Btn);
    }
    card.appendChild(actions);
    container.appendChild(card);
  });
}

function openUserModal(user) {
  const isNew = !user;
  const body  = el('div', {});
  [{ id:'mUsername', label:'Username *', value:user?.username||'', disabled:!isNew },
   { id:'mFullName', label:'Full Name *', value:user?.fullName||'' }].forEach(f => {
    const input = el('input', { id:f.id, type:'text', value:f.value, maxlength:'100' });
    if (f.disabled) input.setAttribute('disabled', '');
    body.appendChild(el('div', { className:'form-group' }, el('label', { for:f.id, textContent:f.label }), input));
  });
  if (isNew) body.appendChild(el('div', { className:'form-group' },
    el('label', { for:'mPassword', textContent:'Password *' }),
    el('input', { id:'mPassword', type:'password', maxlength:'64' })));
  const roleSelect = el('select', { id:'mRole', style:'background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:16px;padding:12px 14px;width:100%;' });
  ['operator','supervisor','manager','administrator'].forEach(r => {
    const o = el('option', { value:r, textContent:r.charAt(0).toUpperCase()+r.slice(1) });
    if (user?.role===r) o.selected=true;
    roleSelect.appendChild(o);
  });
  body.appendChild(el('div', { className:'form-group' }, el('label', { for:'mRole', textContent:'Role *' }), roleSelect));
  if (!isNew) {
    const chk = el('input', { type:'checkbox', id:'mActive' });
    if (user.isActive) chk.checked=true;
    body.appendChild(el('div', { className:'form-group', style:'flex-direction:row;align-items:center;gap:10px;' },
      chk, el('label', { for:'mActive', textContent:'Account Active' })));
  }
  const errDiv  = el('div', { className:'error-msg', role:'alert' }); body.appendChild(errDiv);
  const btnSave   = el('button', { className:'btn btn-primary', textContent:isNew?'Create User':'Save Changes' });
  const btnCancel = el('button', { className:'btn btn-ghost',   textContent:'Cancel' });
  btnCancel.addEventListener('click', closeModal);
  btnSave.addEventListener('click', async () => {
    errDiv.textContent = '';
    const fullName = document.getElementById('mFullName').value.trim();
    const role     = document.getElementById('mRole').value;
    if (!fullName) { errDiv.textContent='Full name is required.'; return; }
    btnSave.disabled = true;
    try {
      if (isNew) {
        const username = document.getElementById('mUsername').value.trim();
        const password = document.getElementById('mPassword').value;
        if (!username) { errDiv.textContent='Username is required.'; btnSave.disabled=false; return; }
        if (password.length<8) { errDiv.textContent='Password must be at least 8 characters.'; btnSave.disabled=false; return; }
        await POST('/users', { username, password, full_name:fullName, role });
        toast('User created.', 'success');
      } else {
        await PATCH(`/users/${user.id}`, { full_name:fullName, role, is_active:document.getElementById('mActive').checked });
        toast('User updated.', 'success');
      }
      closeModal(); loadAdminPage();
    } catch (err) { errDiv.textContent=err.message; }
    finally { btnSave.disabled=false; }
  });
  openModal(isNew?'New User':'Edit User', body, [btnCancel, btnSave]);
}

function openResetPasswordModal(user) {
  const body = el('div', {});
  body.appendChild(el('p', { textContent:`Reset password for ${user.fullName} (@${user.username}).`, className:'mt-8' }));
  const pwInput = el('input', { type:'password', placeholder:'New password (min 8 chars)', maxlength:'64', id:'mNewPw' });
  body.appendChild(el('div', { className:'form-group mt-16' }, el('label', { for:'mNewPw', textContent:'New Password *' }), pwInput));
  const errDiv = el('div', { className:'error-msg', role:'alert' }); body.appendChild(errDiv);
  const btnSave   = el('button', { className:'btn btn-primary', textContent:'Reset Password' });
  const btnCancel = el('button', { className:'btn btn-ghost',   textContent:'Cancel' });
  btnCancel.addEventListener('click', closeModal);
  btnSave.addEventListener('click', async () => {
    const pw = pwInput.value;
    if (pw.length<8) { errDiv.textContent='Password must be at least 8 characters.'; return; }
    btnSave.disabled=true;
    try { await POST(`/users/${user.id}/reset-password`, { password:pw }); toast('Password reset.','success'); closeModal(); }
    catch (err) { errDiv.textContent=err.message; btnSave.disabled=false; }
  });
  openModal('Reset Password', body, [btnCancel, btnSave]);
}

function confirmReset2FA(user) {
  const body = el('div', {});
  body.appendChild(el('p', { textContent:'This will disable 2FA for '+user.fullName+'. They will be prompted to set it up again on next login.', style:'margin-bottom:12px;' }));
  body.appendChild(el('p', { textContent:'Only do this if they have lost access to their authenticator app.', style:'color:var(--red);font-size:13px;font-weight:600;' }));
  const errDiv = el('div', { className:'error-msg', role:'alert' }); body.appendChild(errDiv);
  const btnConfirm = el('button', { className:'btn btn-danger', textContent:'Reset 2FA' });
  const btnCancel  = el('button', { className:'btn btn-ghost',  textContent:'Cancel' });
  btnCancel.addEventListener('click', closeModal);
  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled=true;
    try { await api('DELETE', '/totp/reset/'+user.id); toast('2FA reset for '+user.fullName,'success'); closeModal(); loadAdminPage(); }
    catch (err) { errDiv.textContent=err.message; btnConfirm.disabled=false; }
  });
  openModal('Reset Two-Factor Authentication', body, [btnCancel, btnConfirm]);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SHARED RENDER HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */
function renderEntryList(containerId, timers, showOperator = false) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (!timers || !timers.length) { container.appendChild(el('div', { className:'empty-state', textContent:'No records found.' })); return; }
  const isAdmin = hasRole('administrator');
  timers.forEach(t => {
    const card = el('div', { className:'entry-card', role:'listitem' });
    const left = el('div', {});
    left.appendChild(el('div', { className:'entry-item', textContent:t.itemNumber }));
    if (showOperator) left.appendChild(el('div', { className:'entry-operator', textContent:t.operatorName }));
    left.appendChild(el('div', { className:'entry-time', textContent:formatLocalTime(t.startedAt)+(t.completedAt?' \u2192 '+formatLocalTime(t.completedAt):'') }));
    if (t.workstation) left.appendChild(el('div', { className:'entry-meta-tag', textContent:'\uD83D\uDDA5 '+t.workstation }));
    if (t.woNumber)    left.appendChild(el('div', { className:'entry-meta-tag', textContent:'\uD83D\uDCCB W/O: '+t.woNumber }));
    if (t.timeCheck)   left.appendChild(el('span', { className:'badge badge-timecheck', textContent:'\u2713 Time Check' }));
    if (t.targetSeconds) left.appendChild(el('div', { className:'entry-target', textContent:'\uD83C\uDFAF Target: '+formatHM(t.targetSeconds) }));
    const right = el('div', {});
    right.appendChild(el('div', { className:'entry-duration', textContent:t.durationSeconds!=null?formatDuration(t.durationSeconds):'\u2014' }));
    right.appendChild(el('div', { className:'entry-status' }, el('span', { className:`badge badge-${t.status}`, textContent:t.status })));
    if (isAdmin) {
      const delBtn = el('button', { className:'btn-delete-timer', textContent:'\uD83D\uDDD1', title:'Delete this timer record', 'aria-label':'Delete timer record for '+t.itemNumber });
      delBtn.addEventListener('click', () => confirmDeleteTimer(t, card, containerId, timers));
      right.appendChild(delBtn);
    }
    card.appendChild(left); card.appendChild(right);
    container.appendChild(card);
  });
}

function confirmDeleteTimer(t, card, containerId) {
  const body = el('div', {});
  body.appendChild(el('p', { textContent:'Are you sure you want to permanently delete this timer record?', style:'margin-bottom:12px;' }));
  const summary = el('div', { style:'background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:13px;color:var(--text2);margin-bottom:12px;' });
  [['Item: '+t.itemNumber,'font-family:var(--font-mono);color:var(--accent);margin-bottom:4px;'],
   ['Operator: '+t.operatorName,''],['Started: '+formatLocalTime(t.startedAt),''],['Status: '+t.status,'']].forEach(([txt,sty])=>summary.appendChild(el('div',{textContent:txt,style:sty})));
  body.appendChild(summary);
  body.appendChild(el('p', { textContent:'\u26a0 This cannot be undone. The audit log will also be deleted.', style:'color:var(--red);font-size:13px;font-weight:600;' }));
  const errDiv = el('div', { className:'error-msg', role:'alert' }); body.appendChild(errDiv);
  const btnConfirm = el('button', { className:'btn btn-danger', textContent:'Delete Record' });
  const btnCancel  = el('button', { className:'btn btn-ghost',  textContent:'Keep Record' });
  btnCancel.addEventListener('click', closeModal);
  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled=true; btnConfirm.textContent='Deleting\u2026';
    try {
      await api('DELETE', '/timers/'+t.id);
      if (t.id===state.activeTimerId) { state.activeTimerId=null; state.activeStartedAt=null; stopStopwatch(); refreshActiveTimerBanner(); }
      card.remove();
      const c = document.getElementById(containerId);
      if (c&&!c.children.length) c.appendChild(el('div',{className:'empty-state',textContent:'No records found.'}));
      closeModal(); toast('Timer record deleted.','');
    } catch (err) { errDiv.textContent=err.message; btnConfirm.disabled=false; btnConfirm.textContent='Delete Record'; }
  });
  openModal('Delete Timer Record', body, [btnCancel, btnConfirm]);
}

/* ═══════════════════════════════════════════════════════════════════════════
   AUTOCOMPLETE
   ═══════════════════════════════════════════════════════════════════════════ */
let acDebounce = null;
// itemInput and sugList declared at top of file

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
  if (e.key === 'ArrowDown') { e.preventDefault(); const next=cur?(cur.nextSibling||items[0]):items[0]; if(cur)cur.removeAttribute('aria-selected'); next.setAttribute('aria-selected','true'); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); const prev=cur?(cur.previousSibling||items[items.length-1]):items[items.length-1]; if(cur)cur.removeAttribute('aria-selected'); prev.setAttribute('aria-selected','true'); }
  else if (e.key === 'Enter') { const sel=sugList.querySelector('[aria-selected="true"]'); if(sel){e.preventDefault();itemInput.value=sel.dataset.value;hideSuggestions();} }
  else if (e.key === 'Escape') hideSuggestions();
});

document.addEventListener('click', e => {
  if (!itemInput.contains(e.target) && !sugList.contains(e.target)) hideSuggestions();
});

async function fetchSuggestions(q) {
  try { showSuggestions(await GET(`/items?q=${encodeURIComponent(q)}`)); } catch (_) {}
}

function showSuggestions(items) {
  sugList.innerHTML = '';
  if (!items.length) { hideSuggestions(); return; }
  items.forEach(item => {
    const li = el('li', { role:'option', tabindex:'-1' });
    li.dataset.value = item.item_number;
    li.appendChild(el('span', { textContent:item.item_number }));
    if (item.description) li.appendChild(el('span', { className:'sug-desc', textContent:item.description }));
    li.addEventListener('mousedown', e => { e.preventDefault(); itemInput.value=item.item_number; hideSuggestions(); itemInput.focus(); });
    sugList.appendChild(li);
  });
  sugList.hidden = false;
}

function hideSuggestions() { sugList.hidden = true; sugList.innerHTML = ''; }

/* ═══════════════════════════════════════════════════════════════════════════
   FORMATTING
   ═══════════════════════════════════════════════════════════════════════════ */
function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '\u2014';
  const h=Math.floor(seconds/3600), m=Math.floor((seconds%3600)/60), s=seconds%60;
  return [h,m,s].map(n=>String(n).padStart(2,'0')).join(':');
}
function formatHM(totalSeconds) {
  if (!totalSeconds) return '\u2014';
  const h=Math.floor(totalSeconds/3600), m=Math.floor((totalSeconds%3600)/60);
  if (h===0) return m+'m';
  if (m===0) return h+'h';
  return h+'h '+m+'m';
}
function formatLocalTime(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleString('en-GB', {
    timeZone:'Europe/London', day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCANNER
   ═══════════════════════════════════════════════════════════════════════════ */
const scanner = (() => {
  let stream=null, active=false, scanInterval=null, detector=null, torchEnabled=false, targetInput=null, targetMode='item';
  const overlay=document.getElementById('scannerOverlay'), video=document.getElementById('scannerVideo'),
        statusEl=document.getElementById('scannerStatus'), torchBtn=document.getElementById('btnScanTorch'),
        closeBtn=document.getElementById('btnScanClose');

  function setStatus(msg, type='') { statusEl.textContent=msg; statusEl.className='scanner-status'+(type?' '+type:''); }

  async function open(inputEl, mode) {
    targetInput=inputEl; targetMode=mode||'item';
    if (!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia) { toast('Camera API not available. Use Chrome on Android.','error'); return; }
    if (!('BarcodeDetector' in window)) { overlay.hidden=false; setStatus('Barcode scanning requires Chrome on Android or Chrome 83+ on desktop.','error'); return; }
    overlay.hidden=false; active=true; setStatus('Scanning \u2014 point at a barcode or QR code');
    try {
      detector=new BarcodeDetector({formats:['qr_code','code_128','code_39','code_93','ean_13','ean_8','upc_a','upc_e','data_matrix','pdf417']});
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
      video.srcObject=stream; await video.play();
      setStatus('Scanning \u2014 point at a barcode or QR code');
      tryEnableTorch(); startScanLoop();
    } catch(err) {
      if (err.name==='NotAllowedError') setStatus('Camera permission denied.','error');
      else if (err.name==='NotFoundError') setStatus('No camera found on this device.','error');
      else setStatus('Camera error: '+err.message,'error');
    }
  }

  function startScanLoop() {
    scanInterval=setInterval(async()=>{
      if (!active||!detector||video.readyState<2) return;
      try {
        const barcodes=await detector.detect(video);
        if (barcodes&&barcodes.length>0) {
          const text=barcodes[0].rawValue.trim();
          if (targetMode==='item') {
            if (/^[A-Za-z0-9\-_]{1,40}$/.test(text)) onScanSuccess(text);
            else { setStatus(`Read "${text}" \u2014 not a valid item number. Try again.`,'error'); setTimeout(()=>{if(active)setStatus('Scanning \u2014 point at a barcode or QR code');},2000); }
          } else { if (text.length>0) onScanSuccess(text.slice(0,500)); }
        }
      } catch(_){}
    },300);
  }

  function onScanSuccess(text) {
    clearInterval(scanInterval); scanInterval=null; setStatus('\u2713 Scanned: '+text,'success');
    if (targetInput) {
      if (targetMode==='notes'&&targetInput.value.trim()) targetInput.value=targetInput.value.trimEnd()+' '+text;
      else targetInput.value=text;
      if (targetMode==='item') hideSuggestions();
    }
    setTimeout(()=>{close(); if(targetInput)targetInput.focus(); toast((targetMode==='notes'?'Note':'Item number')+' scanned: '+text,'success');},700);
  }

  function close() {
    active=false; overlay.hidden=true; clearInterval(scanInterval); scanInterval=null;
    if (stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
    video.srcObject=null; detector=null; torchEnabled=false;
    torchBtn.hidden=true; torchBtn.textContent='\uD83D\uDD26 Torch'; setStatus('Initialising camera\u2026');
  }

  function tryEnableTorch() {
    if (!stream) return;
    const track=stream.getVideoTracks()[0]; if (!track) return;
    const caps=track.getCapabilities?track.getCapabilities():{};
    if (caps.torch) {
      torchBtn.hidden=false;
      torchBtn.onclick=async()=>{torchEnabled=!torchEnabled;try{await track.applyConstraints({advanced:[{torch:torchEnabled}]});torchBtn.textContent=torchEnabled?'\uD83D\uDD26 Torch On':'\uD83D\uDD26 Torch';}catch(_){}};
    }
  }

  document.getElementById('btnScan').addEventListener('click',()=>open(document.getElementById('itemNumberInput'),'item'));
  document.getElementById('btnScanWorkstation').addEventListener('click',()=>open(document.getElementById('startWorkstation'),'notes'));
  document.getElementById('btnScanWoNumber').addEventListener('click',()=>open(document.getElementById('startWoNumber'),'notes'));
  closeBtn.addEventListener('click',close);
  overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!overlay.hidden)close();});
  return { open, close };
})();

/* ═══════════════════════════════════════════════════════════════════════════
   WALL BOARD
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadWallboard() {
  if (wallboardInterval) clearInterval(wallboardInterval);
  await refreshWallboard();
  wallboardInterval = setInterval(() => { if (document.visibilityState==='visible') refreshWallboard(); }, 300000);
}

document.addEventListener('visibilitychange', () => {
  if (state.currentPage==='wallboard' && document.visibilityState==='visible') refreshWallboard();
  if (state.currentPage==='wallboardc' && document.visibilityState==='visible') refreshWallboardCompact();
});

async function refreshWallboard() {
  const container=document.getElementById('wallboardTiles');
  const countEl=document.getElementById('wallboardCount');
  const updatedEl=document.getElementById('wallboardUpdated');
  if (!container) return;
  try {
    const timers=await GET('/timers?status=active&limit=200');
    if (countEl)   countEl.textContent=timers.length+' active job'+(timers.length!==1?'s':'');
    if (updatedEl) updatedEl.textContent='Updated '+new Date().toLocaleTimeString('en-GB');
    container.innerHTML='';
    if (!timers.length) {
      container.appendChild(el('div',{className:'wallboard-empty'},el('div',{className:'wallboard-empty-icon',textContent:'\u2713'}),el('div',{className:'wallboard-empty-text',textContent:'No active jobs right now'})));
      return;
    }
    timers.forEach(t => {
      const sNet    = t.netElapsedSeconds!=null ? t.netElapsedSeconds : null;
      const localEl = Math.max(0,Math.floor((Date.now()-new Date(t.startedAt).getTime())/1000))-(t.totalPausedSeconds||0);
      const elapsed = sNet!==null ? sNet : localEl;
      const tile    = el('div',{className:'wallboard-tile'+(t.isPaused?' tile-paused':'')});

      if (hasRole('supervisor')) {
        tile.addEventListener('contextmenu',e=>openContextMenu(e,t));
        let lpt=null;
        tile.addEventListener('touchstart',e=>{lpt=setTimeout(()=>openContextMenu(e,t),600);},{passive:true});
        tile.addEventListener('touchend',()=>{if(lpt){clearTimeout(lpt);lpt=null;}});
        tile.addEventListener('touchmove',()=>{if(lpt){clearTimeout(lpt);lpt=null;}});
      }

      if (!t.isPaused) {
        if (t.targetSeconds) {
          const pct=elapsed/t.targetSeconds;
          if (pct>=1.0)      tile.classList.add('tile-overdue');
          else if (pct>=0.8) tile.classList.add('tile-warning');
        } else {
          if (elapsed>4*3600)      tile.classList.add('tile-overdue');
          else if (elapsed>2*3600) tile.classList.add('tile-warning');
        }
      }

      if (t.isPaused) {
        const pauseTag=el('div',{className:'wb-paused-tag',textContent:'\u23f8 PAUSED'});
        if (t.pauseType==='schedule') pauseTag.title='Auto-paused outside working hours';
        tile.appendChild(pauseTag);
      }

      tile.appendChild(el('div',{className:'wb-item',textContent:t.itemNumber}));
      tile.appendChild(el('div',{className:'wb-operator',textContent:t.operatorName}));
      tile.appendChild(el('div',{className:'wb-elapsed',textContent:formatDuration(elapsed),
        'data-timerid':t.id,'data-startedat':t.startedAt,
        'data-pausedseconds':String(t.totalPausedSeconds||0),'data-ispaused':t.isPaused?'1':'0'}));
      tile.appendChild(el('div',{className:'wb-started',textContent:'Started '+formatLocalTime(t.startedAt)}));
      if (t.workstation) tile.appendChild(el('div',{className:'wb-notes',textContent:'\uD83D\uDDA5 '+t.workstation}));
      if (t.woNumber)    tile.appendChild(el('div',{className:'wb-notes',textContent:'\uD83D\uDCCB W/O: '+t.woNumber}));
      if (t.timeCheck)   tile.appendChild(el('span',{className:'badge badge-timecheck',style:'margin-top:6px;display:inline-block;',textContent:'\u2713 Time Check'}));
      if (t.targetSeconds) {
        const pct=elapsed/t.targetSeconds, pctCapped=Math.min(1,pct), remaining=t.targetSeconds-elapsed;
        const targetWrap=el('div',{className:'wb-target-wrap'});
        const labelText=remaining>0?formatHM(remaining)+' remaining':formatHM(Math.abs(remaining))+' overdue';
        targetWrap.appendChild(el('div',{className:'wb-target-label'+(remaining<=0?' overdue':''),
          textContent:'\uD83C\uDFAF Target: '+formatHM(t.targetSeconds)+'  \u2014  '+labelText,
          'data-startedat':t.startedAt,'data-targetseconds':String(t.targetSeconds)}));
        const bar=el('div',{className:'wb-target-bar'});
        bar.appendChild(el('div',{className:'wb-target-fill'+(pct>=1?' over':''),
          style:'width:'+Math.round(pctCapped*100)+'%',
          'data-startedat':t.startedAt,'data-targetseconds':String(t.targetSeconds)}));
        targetWrap.appendChild(bar); tile.appendChild(targetWrap);
      }
      if (hasRole('supervisor')) {
        tile.appendChild(el('button',{className:'wb-msg-btn',textContent:'\u2709 Message',
          'aria-label':'Send message to '+t.operatorName,onclick:()=>openSendMessageModal(t.operatorId,t.operatorName)}));
      }
      container.appendChild(tile);
    });
    startWallboardTick();
  } catch(err) {
    container.innerHTML='';
    container.appendChild(el('div',{className:'wallboard-empty',textContent:'Could not load active timers: '+err.message}));
  }
}

function startWallboardTick() {
  if (wallboardTick) clearInterval(wallboardTick);
  wallboardTick=setInterval(()=>{
    if (state.currentPage!=='wallboard') { clearInterval(wallboardTick); wallboardTick=null; return; }
    document.querySelectorAll('.wb-elapsed[data-startedat]').forEach(el=>{
      const startedAt=el.getAttribute('data-startedat');
      const pausedSecs=parseInt(el.getAttribute('data-pausedseconds')||'0',10);
      const isPaused=el.getAttribute('data-ispaused')==='1';
      if (!startedAt) return;
      const rawElapsed=Math.max(0,Math.floor((Date.now()-new Date(startedAt).getTime())/1000));
      const elapsed=Math.max(0,rawElapsed-pausedSecs);
      if (!isPaused) el.textContent=formatDuration(elapsed);
      const tile=el.closest('.wallboard-tile');
      if (!tile||isPaused) return;
      tile.classList.remove('tile-warning','tile-overdue');
      const fill=tile.querySelector('.wb-target-fill');
      const tgt=fill?parseInt(fill.getAttribute('data-targetseconds'),10):0;
      if (tgt) {
        const pct=elapsed/tgt;
        if (pct>=1.0)      tile.classList.add('tile-overdue');
        else if (pct>=0.8) tile.classList.add('tile-warning');
        fill.style.width=Math.round(Math.min(1,pct)*100)+'%';
        fill.classList.toggle('over',pct>=1);
        const lbl=tile.querySelector('.wb-target-label');
        if (lbl) { const rem=tgt-elapsed; lbl.textContent='\uD83C\uDFAF Target: '+formatHM(tgt)+'  \u2014  '+(rem>0?formatHM(rem)+' remaining':formatHM(Math.abs(rem))+' overdue'); lbl.className='wb-target-label'+(rem<=0?' overdue':''); }
      } else {
        if (elapsed>4*3600)      tile.classList.add('tile-overdue');
        else if (elapsed>2*3600) tile.classList.add('tile-warning');
      }
    });
  },1000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   TARGET TIMES
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadTargetTimes(containerId='targetTimesList') {
  const container=document.getElementById(containerId);
  if (!container) return;
  container.innerHTML='<div class="empty-state">Loading...</div>';
  try { renderTargetList(await GET('/targets'),containerId); }
  catch(_) { container.innerHTML='<div class="empty-state">Could not load target times.</div>'; }
}

function renderTargetList(targets, containerId='targetTimesList') {
  const container=document.getElementById(containerId);
  if (!container) return;
  container.innerHTML='';
  if (!targets||!targets.length) { container.appendChild(el('div',{className:'empty-state',textContent:'No target times set yet. Click + Add Target Time to get started.'})); return; }
  targets.forEach(t=>{
    const row=el('div',{className:'target-row'});
    const info=el('div',{className:'target-row-info'});
    info.appendChild(el('span',{className:'target-item-number',textContent:t.itemNumber}));
    info.appendChild(el('span',{className:'target-time-display',textContent:formatHM(t.totalSeconds)}));
    const actions=el('div',{className:'target-row-actions'});
    actions.appendChild(el('button',{className:'btn btn-ghost btn-sm',textContent:'Edit',onclick:()=>openTargetModal(t,containerId)}));
    actions.appendChild(el('button',{className:'btn btn-ghost btn-sm',textContent:'\uD83D\uDDD1',onclick:()=>confirmDeleteTarget(t,containerId)}));
    row.appendChild(info); row.appendChild(actions);
    container.appendChild(row);
  });
}

function loadTargetsPage() { loadTargetTimes('targetTimesPageList'); }
document.getElementById('btnAddTargetPage')&&document.getElementById('btnAddTargetPage').addEventListener('click',()=>openTargetModal(null,'targetTimesPageList'));
document.getElementById('btnAddTarget')&&document.getElementById('btnAddTarget').addEventListener('click',()=>openTargetModal(null,'targetTimesList'));

function openTargetModal(existing, containerId='targetTimesList') {
  const isNew=!existing;
  const body=el('div',{});
  const ttItemInput=el('input',{id:'ttItemNumber',type:'text',maxlength:'40',placeholder:'e.g. PHL-1001',value:existing?existing.itemNumber:'',autocapitalize:'characters'});
  if (!isNew) ttItemInput.setAttribute('disabled','');
  const itemInputRow=el('div',{className:'input-with-action'},ttItemInput);
  if (isNew) {
    const scanBtn=el('button',{className:'btn-scan',type:'button','aria-label':'Scan barcode into item number'});
    scanBtn.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="3" height="3"/><rect x="14" y="7" width="3" height="3"/><rect x="7" y="14" width="3" height="3"/><rect x="14" y="14" width="3" height="3"/></svg> Scan`;
    scanBtn.addEventListener('click',()=>scanner.open(ttItemInput,'item'));
    itemInputRow.appendChild(scanBtn);
  }
  body.appendChild(el('div',{className:'form-group'},el('label',{for:'ttItemNumber',textContent:'Item Number *'}),itemInputRow));
  const timeRow=el('div',{className:'form-group'});
  timeRow.appendChild(el('label',{textContent:'Target Time *'}));
  const timeInputs=el('div',{className:'time-input-row'});
  const hoursInput=el('input',{id:'ttHours',type:'number',min:'0',max:'99',placeholder:'0',style:'width:70px;text-align:center;',value:existing?String(existing.hours):'0'});
  const minsInput=el('input',{id:'ttMinutes',type:'number',min:'0',max:'59',placeholder:'0',style:'width:70px;text-align:center;',value:existing?String(existing.minutes):'0'});
  timeInputs.appendChild(hoursInput);
  timeInputs.appendChild(el('span',{textContent:'h',style:'margin:0 6px;color:var(--text2);font-weight:600;'}));
  timeInputs.appendChild(minsInput);
  timeInputs.appendChild(el('span',{textContent:'m',style:'margin:0 6px;color:var(--text2);font-weight:600;'}));
  timeRow.appendChild(timeInputs); body.appendChild(timeRow);
  const errDiv=el('div',{className:'error-msg',role:'alert'}); body.appendChild(errDiv);
  const btnSave=el('button',{className:'btn btn-primary',textContent:isNew?'Add Target Time':'Save Changes'});
  const btnCancel=el('button',{className:'btn btn-ghost',textContent:'Cancel'});
  btnCancel.addEventListener('click',closeModal);
  btnSave.addEventListener('click',async()=>{
    errDiv.textContent='';
    const itemNumber=(document.getElementById('ttItemNumber').value||'').trim().toUpperCase();
    const hours=parseInt(document.getElementById('ttHours').value,10)||0;
    const minutes=parseInt(document.getElementById('ttMinutes').value,10)||0;
    if (!itemNumber){errDiv.textContent='Item Number is required.';return;}
    if (hours===0&&minutes===0){errDiv.textContent='Target time must be greater than zero.';return;}
    btnSave.disabled=true;
    try {
      await POST('/targets',{itemNumber,hours,minutes});
      toast((isNew?'Target time added':'Target time updated')+' for '+itemNumber,'success');
      closeModal(); loadTargetTimes(containerId);
      if (containerId!=='targetTimesList') loadTargetTimes('targetTimesList');
    } catch(err){errDiv.textContent=err.message;}
    finally{btnSave.disabled=false;}
  });
  openModal(isNew?'Add Target Time':'Edit Target Time',body,[btnCancel,btnSave]);
}

function confirmDeleteTarget(t, containerId='targetTimesList') {
  const body=el('div',{});
  body.appendChild(el('p',{textContent:'Remove the target time for '+t.itemNumber+'?',style:'margin-bottom:12px;'}));
  const errDiv=el('div',{className:'error-msg',role:'alert'}); body.appendChild(errDiv);
  const btnConfirm=el('button',{className:'btn btn-danger',textContent:'Remove'});
  const btnCancel=el('button',{className:'btn btn-ghost',textContent:'Keep'});
  btnCancel.addEventListener('click',closeModal);
  btnConfirm.addEventListener('click',async()=>{
    btnConfirm.disabled=true;
    try {
      await api('DELETE','/targets/'+encodeURIComponent(t.itemNumber));
      toast('Target time removed for '+t.itemNumber,'');
      closeModal(); loadTargetTimes(containerId);
      if (containerId!=='targetTimesList') loadTargetTimes('targetTimesList');
    } catch(err){errDiv.textContent=err.message;btnConfirm.disabled=false;}
  });
  openModal('Remove Target Time',body,[btnCancel,btnConfirm]);
}

/* ═══════════════════════════════════════════════════════════════════════════
   TOTP SETUP
   ═══════════════════════════════════════════════════════════════════════════ */
function checkTotpSetupRequired() {
  if (!ROLES_REQUIRING_TOTP.includes(state.user.role)) return;
  if (state.user.totpEnabled !== false) return;
  setTimeout(()=>openTotpSetupModal(), 800);
}

async function openTotpSetupModal() {
  const body=el('div',{});
  body.appendChild(el('p',{textContent:'Your role requires two-factor authentication (2FA). Please scan the QR code below with an authenticator app such as Google Authenticator or Microsoft Authenticator, then enter the 6-digit code to complete setup.',style:'margin-bottom:16px;font-size:14px;'}));
  const qrWrap=el('div',{style:'text-align:center;padding:20px 0;'});
  qrWrap.appendChild(el('div',{textContent:'Generating QR code\u2026',style:'color:var(--text3);'}));
  body.appendChild(qrWrap);
  const codeGroup=el('div',{className:'form-group',style:'margin-top:8px;'});
  codeGroup.appendChild(el('label',{for:'setupTotpCode',textContent:'Enter code from app *'}));
  const codeInput=el('input',{id:'setupTotpCode',type:'text',inputmode:'numeric',pattern:'\\d{6}',maxlength:'6',placeholder:'000000',className:'totp-code-input'});
  codeGroup.appendChild(codeInput); body.appendChild(codeGroup);
  const errDiv=el('div',{className:'error-msg',role:'alert'}); body.appendChild(errDiv);
  const btnEnable=el('button',{className:'btn btn-primary',textContent:'Enable 2FA'});
  const btnSkip=el('button',{className:'btn btn-ghost',textContent:'Remind Me Later'});
  btnSkip.addEventListener('click',()=>{state.user.totpEnabled=null;closeModal();});
  openModal('Set Up Two-Factor Authentication',body,[btnSkip,btnEnable]);
  try {
    const setup=await POST('/totp/setup',{});
    qrWrap.innerHTML='';
    qrWrap.appendChild(el('img',{src:setup.qrDataUrl,alt:'QR code for authenticator app',style:'width:200px;height:200px;border-radius:8px;'}));
    qrWrap.appendChild(el('p',{textContent:"Can't scan? Enter this code manually: "+setup.secret,style:'font-size:11px;color:var(--text3);margin-top:8px;word-break:break-all;'}));
    codeInput.focus();
  } catch(err) { qrWrap.innerHTML=''; qrWrap.appendChild(el('p',{textContent:'Could not load QR code: '+err.message,style:'color:var(--red);'})); }
  btnEnable.addEventListener('click',async()=>{
    errDiv.textContent='';
    const code=codeInput.value.trim();
    if (!/^\d{6}$/.test(code)){errDiv.textContent='Please enter the 6-digit code from your authenticator app.';return;}
    btnEnable.disabled=true;
    try{await POST('/totp/confirm',{code});state.user.totpEnabled=true;closeModal();toast('Two-factor authentication enabled successfully.','success');}
    catch(err){errDiv.textContent=err.message;btnEnable.disabled=false;}
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   PAUSE / RESUME
   ═══════════════════════════════════════════════════════════════════════════ */
function updatePauseUI() {
  const isPaused=state.activeIsPaused;
  const banner=document.getElementById('pauseBanner');
  const pauseBtn=document.getElementById('btnPauseTimer');
  const label=document.getElementById('activeJobLabel');
  const stopwatch=document.getElementById('stopwatch');
  const panel=document.getElementById('panelActive');
  if (banner)    banner.hidden=!isPaused;
  if (label)     label.textContent=isPaused?'PAUSED':'ACTIVE JOB';
  if (stopwatch) stopwatch.classList.toggle('stopwatch-paused',isPaused);
  if (panel)     panel.classList.toggle('panel-paused',isPaused);
  if (pauseBtn) {
    if (isPaused) { pauseBtn.textContent='\u25b6 Resume'; pauseBtn.className='btn btn-resume-sm'; pauseBtn.setAttribute('aria-label','Resume timer'); }
    else          { pauseBtn.textContent='\u23f8 Pause';  pauseBtn.className='btn btn-pause-sm';  pauseBtn.setAttribute('aria-label','Pause timer');  }
  }
  if (isPaused) {
    stopStopwatch();
    if (state.activeStartedAt&&state.activePausedAt) {
      const raw=Math.floor((new Date(state.activePausedAt).getTime()-new Date(state.activeStartedAt).getTime())/1000);
      document.getElementById('stopwatch').textContent=formatDuration(Math.max(0,raw-state.activeTotalPausedSeconds));
    }
  } else {
    startStopwatch();
  }
}

document.getElementById('btnPauseTimer').addEventListener('click', async () => {
  if (!state.activeTimerId) return;
  const btn=document.getElementById('btnPauseTimer');
  btn.disabled=true;
  try {
    if (state.activeIsPaused) {
      const t=await POST('/pause/'+state.activeTimerId+'/resume',{});
      state.activeIsPaused=false; state.activePausedAt=null;
      state.activeTotalPausedSeconds=t.totalPausedSeconds||0;
      updatePauseUI(); toast('Timer resumed.','success');
    } else {
      const t=await POST('/pause/'+state.activeTimerId+'/pause',{reason:'Manual pause'});
      state.activeIsPaused=true; state.activePausedAt=t.pausedAt;
      updatePauseUI(); toast('Timer paused.','');
    }
  } catch(err){toast(err.message,'error');}
  finally{btn.disabled=false;}
});

let pausePollInterval=null;
function startPausePoll() {
  if (pausePollInterval) clearInterval(pausePollInterval);
  pausePollInterval=setInterval(async()=>{
    if (state.currentPage!=='timer'||!state.activeTimerId) return;
    try {
      const t=await GET('/timers/'+state.activeTimerId);
      if (!t) return;
      const wasPaused=state.activeIsPaused;
      state.activeIsPaused=t.isPaused||false;
      state.activePausedAt=t.pausedAt||null;
      state.activeTotalPausedSeconds=t.totalPausedSeconds||0;
      if (wasPaused!==state.activeIsPaused) {
        updatePauseUI();
        toast(state.activeIsPaused?'Your timer has been automatically paused outside working hours.':'Your timer has automatically resumed for the new working day.',state.activeIsPaused?'':'success');
      }
    } catch(_){}
  },30000);
}
function stopPausePoll(){if(pausePollInterval){clearInterval(pausePollInterval);pausePollInterval=null;}}

/* ═══════════════════════════════════════════════════════════════════════════
   WALLBOARD CONTEXT MENU
   ═══════════════════════════════════════════════════════════════════════════ */
let _ctxTimer=null;
const ctxMenu=document.getElementById('wbContextMenu');
const ctxPause=document.getElementById('wbContextPause');
const ctxResume=document.getElementById('wbContextResume');
const ctxMsgBtn=document.getElementById('wbContextMsg');

function openContextMenu(e, timerData) {
  if (!hasRole('supervisor')) return;
  e.preventDefault(); _ctxTimer=timerData;
  ctxPause.hidden=timerData.isPaused; ctxResume.hidden=!timerData.isPaused;
  const infoEl=document.getElementById('wbContextInfo');
  if (infoEl) infoEl.textContent=timerData.operatorName+' \u2014 '+timerData.itemNumber;
  ctxMenu.hidden=false;
  const x=Math.min(e.clientX||(e.touches&&e.touches[0]?e.touches[0].clientX:0),window.innerWidth-200);
  const y=Math.min(e.clientY||(e.touches&&e.touches[0]?e.touches[0].clientY:0),window.innerHeight-150);
  ctxMenu.style.left=x+'px'; ctxMenu.style.top=y+'px';
}
function closeContextMenu(){ctxMenu.hidden=true;_ctxTimer=null;}
document.addEventListener('click',e=>{if(!ctxMenu.contains(e.target))closeContextMenu();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeContextMenu();});

ctxPause.addEventListener('click',async()=>{
  if (!_ctxTimer) return; closeContextMenu();
  try { await POST('/pause/'+_ctxTimer.id+'/pause',{reason:'Paused by '+state.user.fullName}); toast('Timer paused for '+_ctxTimer.operatorName,''); refreshWallboard(); if(state.currentPage==='wallboardc')refreshWallboardCompact(); }
  catch(err){toast(err.message,'error');}
});
ctxResume.addEventListener('click',async()=>{
  if (!_ctxTimer) return; closeContextMenu();
  try { await POST('/pause/'+_ctxTimer.id+'/resume',{}); toast('Timer resumed for '+_ctxTimer.operatorName,'success'); refreshWallboard(); if(state.currentPage==='wallboardc')refreshWallboardCompact(); }
  catch(err){toast(err.message,'error');}
});
ctxMsgBtn.addEventListener('click',()=>{if(!_ctxTimer)return;closeContextMenu();openSendMessageModal(_ctxTimer.operatorId,_ctxTimer.operatorName);});

/* ═══════════════════════════════════════════════════════════════════════════
   HOME PAGE
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadHomePage() {
  renderHomeSkeleton();
  const [activeTimers,stats,users]=await Promise.all([
    GET('/timers?status=active&limit=200').catch(()=>[]),
    GET('/export/stats').catch(()=>null),
    hasRole('administrator')?GET('/users').catch(()=>[]):Promise.resolve([]),
  ]);
  renderHomeActiveJobs(activeTimers);
  renderHomeTodayStats(stats);
  if (hasRole('manager')) renderHomePerformance(stats);
  if (hasRole('administrator')) renderHomeUsers(users);
  renderHomeQuickActions();
}

function renderHomeSkeleton() {
  const page=document.getElementById('pageHome');
  if (!page) return;
  const hour=new Date().getHours();
  const greeting=hour<12?'Good morning':hour<17?'Good afternoon':'Good evening';
  page.innerHTML=`<div class="home-page">
    <div class="home-greeting">
      <span class="home-greeting-text">${greeting}, ${state.user.fullName.split(' ')[0]}</span>
      <span class="home-greeting-date">${new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})}</span>
    </div>
    <div class="home-grid" id="homeGrid">
      <div class="home-card home-card-full" id="homeActiveJobs"><div class="home-card-title">Active Jobs</div><div class="home-card-body"><div class="empty-state">Loading...</div></div></div>
      <div class="home-card" id="homeTodayStats"><div class="home-card-title">Today at a Glance</div><div class="home-card-body"><div class="empty-state">Loading...</div></div></div>
      <div class="home-card" id="homeQuickActions"><div class="home-card-title">Quick Actions</div><div class="home-card-body"></div></div>
      ${hasRole('manager')?'<div class="home-card home-card-full" id="homePerformance"><div class="home-card-title">Performance</div><div class="home-card-body"><div class="empty-state">Loading...</div></div></div>':''}
      ${hasRole('administrator')?'<div class="home-card home-card-full" id="homeUsers"><div class="home-card-title">User Status</div><div class="home-card-body"><div class="empty-state">Loading...</div></div></div>':''}
    </div>
  </div>`;
}

function renderHomeActiveJobs(timers) {
  const card=document.getElementById('homeActiveJobs'); if (!card) return;
  const body=card.querySelector('.home-card-body'); body.innerHTML='';
  const titleEl=card.querySelector('.home-card-title'); if (titleEl) titleEl.textContent=`Active Jobs  (${timers.length})`;
  if (!timers.length) { body.appendChild(el('div',{className:'empty-state',textContent:'No jobs currently running.'})); return; }
  const now=Date.now();
  timers.sort((a,b)=>{
    const elA=now-new Date(a.startedAt).getTime(), elB=now-new Date(b.startedAt).getTime();
    const ovA=a.targetSeconds?elA/1000>a.targetSeconds:elA>4*3600000;
    const ovB=b.targetSeconds?elB/1000>b.targetSeconds:elB>4*3600000;
    if (ovA!==ovB) return ovA?-1:1; return elB-elA;
  });
  const grid=el('div',{className:'home-active-grid'});
  timers.forEach(t=>{
    const elapsed=Math.max(0,Math.floor((now-new Date(t.startedAt).getTime())/1000))-(t.totalPausedSeconds||0);
    const isOver=t.targetSeconds?elapsed>=t.targetSeconds:elapsed>4*3600;
    const isWarn=!isOver&&(t.targetSeconds?elapsed/t.targetSeconds>=0.8:elapsed>2*3600);
    const row=el('div',{className:'home-active-row'+(isOver?' over':isWarn?' warn':'')+(t.isPaused?' paused':'')});
    row.appendChild(el('span',{className:'home-active-dot'+(isOver?' dot-red':isWarn?' dot-amber':' dot-green')}));
    const info=el('div',{className:'home-active-info'});
    info.appendChild(el('span',{className:'home-active-name',textContent:t.operatorName+(t.isPaused?' \u23f8':'')}));
    info.appendChild(el('span',{className:'home-active-item',textContent:t.itemNumber}));
    if (t.workstation) info.appendChild(el('span',{className:'home-active-ws',textContent:'\uD83D\uDDA5 '+t.workstation}));
    row.appendChild(info);
    const timeInfo=el('div',{className:'home-active-time'});
    timeInfo.appendChild(el('span',{className:'home-active-elapsed'+(isOver?' text-red':isWarn?' text-amber':''),textContent:formatDuration(elapsed)}));
    if (t.targetSeconds) {
      const rem=t.targetSeconds-elapsed;
      timeInfo.appendChild(el('span',{className:'home-active-target'+(isOver?' text-red':''),textContent:isOver?'\u26a0 '+formatHM(Math.abs(rem))+' overdue':'\uD83C\uDFAF '+formatHM(rem)+' left'}));
    }
    row.appendChild(timeInfo);
    if (hasRole('supervisor')) row.appendChild(el('button',{className:'btn btn-ghost btn-sm home-msg-btn',textContent:'\u2709',title:'Message '+t.operatorName,onclick:()=>openSendMessageModal(t.operatorId,t.operatorName)}));
    grid.appendChild(row);
  });
  body.appendChild(grid);
}

function renderHomeTodayStats(stats) {
  const card=document.getElementById('homeTodayStats'); if (!card) return;
  const body=card.querySelector('.home-card-body'); body.innerHTML='';
  if (!stats) { body.appendChild(el('div',{className:'empty-state',textContent:'Could not load stats.'})); return; }
  const grid=el('div',{className:'home-stats-grid'});
  [{icon:'\u25b6',label:'Active Now',value:stats.activeCount,cls:'stat-active'},{icon:'\u2713',label:'Completed Today',value:stats.total24h,cls:'stat-done'},
   {icon:'\uD83D\uDCC5',label:'This Week',value:stats.total7d,cls:''},{icon:'\uD83D\uDCE6',label:'Item Types',value:stats.byItem?.length||0,cls:''}].forEach(s=>{
    const item=el('div',{className:'home-stat-item'});
    item.appendChild(el('div',{className:'home-stat-icon '+s.cls,textContent:s.icon}));
    item.appendChild(el('div',{className:'home-stat-value',textContent:s.value}));
    item.appendChild(el('div',{className:'home-stat-label',textContent:s.label}));
    grid.appendChild(item);
  });
  body.appendChild(grid);
}

function renderHomePerformance(stats) {
  const card=document.getElementById('homePerformance'); if (!card) return;
  const body=card.querySelector('.home-card-body'); body.innerHTML='';
  if (!stats||!stats.byItem||!stats.byItem.length) { body.appendChild(el('div',{className:'empty-state',textContent:'No completed jobs today.'})); return; }
  const table=el('table',{className:'home-perf-table'});
  table.appendChild(el('thead',{},el('tr',{},el('th',{textContent:'Item'}),el('th',{textContent:'Jobs'}),el('th',{textContent:'Avg Time'}),el('th',{textContent:'Target'}),el('th',{textContent:'Delta'}))));
  const tbody=el('tbody',{});
  stats.byItem.slice(0,10).forEach(r=>{
    const hasTarget=r.target_seconds!=null, delta=hasTarget?Math.round(r.avg_seconds)-r.target_seconds:null;
    const tr=el('tr',{},el('td',{className:'perf-item',textContent:r.item_number}),el('td',{textContent:r.count}),el('td',{textContent:formatDuration(Math.round(r.avg_seconds))}),el('td',{textContent:hasTarget?formatHM(r.target_seconds):'\u2014',className:hasTarget?'':'dash-no-target'}));
    tr.appendChild(el('td',{textContent:delta===null?'\u2014':(delta>=0?'+':'')+formatDuration(Math.abs(delta)),className:delta===null?'dash-no-target':delta>0?'dash-over':'dash-under'}));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); body.appendChild(table);
  body.appendChild(el('button',{className:'btn btn-ghost btn-sm',textContent:'\u2b07 Export Today CSV',style:'margin-top:12px;',onclick:()=>{const today=new Date();today.setHours(0,0,0,0);window.location.href=`/api/export/csv?from=${today.toISOString()}`;}}));
}

function renderHomeUsers(users) {
  const card=document.getElementById('homeUsers'); if (!card||!users.length) return;
  const body=card.querySelector('.home-card-body'); body.innerHTML='';
  const active=users.filter(u=>u.isActive), disabled=users.filter(u=>!u.isActive);
  const need2fa=active.filter(u=>['manager','administrator'].includes(u.role)&&!u.totpEnabled);
  const summary=el('div',{className:'home-user-summary'});
  [{label:'Active Accounts',value:active.length,cls:''},{label:'Disabled',value:disabled.length,cls:disabled.length?'text-amber':''},{label:'2FA Not Configured',value:need2fa.length,cls:need2fa.length?'text-red':'text-green'}].forEach(s=>{
    const item=el('div',{className:'home-user-stat'});
    item.appendChild(el('span',{className:'home-user-stat-val '+s.cls,textContent:s.value}));
    item.appendChild(el('span',{className:'home-user-stat-lbl',textContent:s.label}));
    summary.appendChild(item);
  });
  body.appendChild(summary);
  if (need2fa.length) {
    const warn=el('div',{className:'home-2fa-warn'});
    warn.appendChild(el('span',{textContent:'\u26a0 Users without 2FA: '}));
    warn.appendChild(el('span',{textContent:need2fa.map(u=>u.fullName).join(', '),style:'font-weight:600;'}));
    body.appendChild(warn);
  }
}

function renderHomeQuickActions() {
  const card=document.getElementById('homeQuickActions'); if (!card) return;
  const body=card.querySelector('.home-card-body'); body.innerHTML='';
  [{label:'\uD83D\uDCCB Wall Board',page:'wallboard',role:'supervisor'},{label:'\uD83D\uDCFA Compact Board',page:'wallboardc',role:'supervisor'},
   {label:'\uD83D\uDCCA Dashboard',page:'dashboard',role:'manager'},{label:'\uD83C\uDFAF Target Times',page:'targets',role:'manager'},
   {label:'\uD83D\uDD50 History',page:'history',role:'operator'},{label:'\uD83D\uDC65 User Management',page:'admin',role:'administrator'}]
  .filter(a=>hasRole(a.role)).forEach(a=>{
    body.appendChild(el('button',{className:'home-action-btn',textContent:a.label,onclick:()=>{navigateTo(a.page);closeNav();}}));
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   WALL BOARD COMPACT
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadWallboardCompact() {
  if (wallboardCInterval) clearInterval(wallboardCInterval);
  await refreshWallboardCompact();
  wallboardCInterval=setInterval(()=>{if(document.visibilityState==='visible')refreshWallboardCompact();},300000);
}

async function refreshWallboardCompact() {
  const container=document.getElementById('wallboardCTiles');
  const countEl=document.getElementById('wallboardCCount');
  const updatedEl=document.getElementById('wallboardCUpdated');
  if (!container) return;
  try {
    const timers=await GET('/timers?status=active&limit=200');
    if (countEl)   countEl.textContent=timers.length+' active job'+(timers.length!==1?'s':'');
    if (updatedEl) updatedEl.textContent='Updated '+new Date().toLocaleTimeString('en-GB');
    container.innerHTML='';
    if (!timers.length) { container.appendChild(el('div',{className:'wallboard-empty'},el('div',{className:'wallboard-empty-icon',textContent:'\u2713'}),el('div',{className:'wallboard-empty-text',textContent:'No active jobs right now'}))); return; }
    const now=Date.now();
    timers.forEach(t=>{
      const sNet=t.netElapsedSeconds!=null?t.netElapsedSeconds:null;
      const localEl=Math.max(0,Math.floor((now-new Date(t.startedAt).getTime())/1000))-(t.totalPausedSeconds||0);
      const elapsed=sNet!==null?sNet:localEl;
      const tile=el('div',{className:'wbc-tile'+(t.isPaused?' tile-paused':'')});
      if (hasRole('supervisor')) {
        tile.addEventListener('contextmenu',e=>openContextMenu(e,t));
        let lpt=null;
        tile.addEventListener('touchstart',e=>{lpt=setTimeout(()=>openContextMenu(e,t),600);},{passive:true});
        tile.addEventListener('touchend',()=>{if(lpt){clearTimeout(lpt);lpt=null;}});
        tile.addEventListener('touchmove',()=>{if(lpt){clearTimeout(lpt);lpt=null;}});
      }
      if (!t.isPaused) {
        if (t.targetSeconds) { const pct=elapsed/t.targetSeconds; if(pct>=1.0)tile.classList.add('tile-overdue'); else if(pct>=0.8)tile.classList.add('tile-warning'); }
        else { if(elapsed>4*3600)tile.classList.add('tile-overdue'); else if(elapsed>2*3600)tile.classList.add('tile-warning'); }
      }
      tile.appendChild(el('div',{className:'wbc-operator',textContent:t.operatorName}));
      tile.appendChild(el('div',{className:'wbc-item',textContent:t.itemNumber}));
      if (t.isPaused) tile.appendChild(el('div',{className:'wbc-paused-tag',textContent:'\u23f8'}));
      tile.appendChild(el('div',{className:'wbc-elapsed',textContent:formatDuration(elapsed),
        'data-startedat':t.startedAt,'data-targetseconds':t.targetSeconds?String(t.targetSeconds):'',
        'data-pausedseconds':String(t.totalPausedSeconds||0),'data-ispaused':t.isPaused?'1':'0'}));
      container.appendChild(tile);
    });
    startWallboardCompactTick();
  } catch(err) { container.innerHTML=''; container.appendChild(el('div',{className:'wallboard-empty',textContent:'Could not load timers: '+err.message})); }
}

function startWallboardCompactTick() {
  if (wallboardCTick) clearInterval(wallboardCTick);
  wallboardCTick=setInterval(()=>{
    if (state.currentPage!=='wallboardc'){clearInterval(wallboardCTick);wallboardCTick=null;return;}
    document.querySelectorAll('.wbc-elapsed[data-startedat]').forEach(node=>{
      const startedAt=node.getAttribute('data-startedat');
      const pausedSecs=parseInt(node.getAttribute('data-pausedseconds')||'0',10);
      const isPaused=node.getAttribute('data-ispaused')==='1';
      if (!startedAt||isPaused) return;
      const rawElapsed=Math.max(0,Math.floor((Date.now()-new Date(startedAt).getTime())/1000));
      const elapsed=Math.max(0,rawElapsed-pausedSecs);
      node.textContent=formatDuration(elapsed);
      const tile=node.closest('.wbc-tile'); if (!tile) return;
      tile.classList.remove('tile-warning','tile-overdue');
      const tgt=parseInt(node.getAttribute('data-targetseconds'),10)||0;
      if (tgt){const pct=elapsed/tgt;if(pct>=1.0)tile.classList.add('tile-overdue');else if(pct>=0.8)tile.classList.add('tile-warning');}
      else{if(elapsed>4*3600)tile.classList.add('tile-overdue');else if(elapsed>2*3600)tile.classList.add('tile-warning');}
    });
  },1000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   REAL-TIME MESSAGING (SSE)
   ═══════════════════════════════════════════════════════════════════════════ */
let _messageStream=null;
function connectMessageStream() {
  if (_messageStream) return;
  try {
    _messageStream=new EventSource('/api/messages/listen',{withCredentials:true});
    _messageStream.addEventListener('message',e=>{try{showMessageNotification(JSON.parse(e.data));}catch(_){}});
    _messageStream.addEventListener('error',()=>{disconnectMessageStream();setTimeout(()=>{if(state.user)connectMessageStream();},10000);});
  } catch(_){}
}
function disconnectMessageStream(){if(_messageStream){_messageStream.close();_messageStream=null;}}

function showMessageNotification(data) {
  const existing=document.getElementById('msgNotification'); if (existing) existing.remove();
  const notif=el('div',{id:'msgNotification',className:'msg-notification',role:'alert'});
  const header=el('div',{className:'msg-notif-header'});
  header.appendChild(el('span',{className:'msg-notif-from',textContent:'\u2709 Message from '+data.from}));
  const closeBtn=el('button',{className:'msg-notif-close','aria-label':'Dismiss message',textContent:'\u2715'});
  closeBtn.addEventListener('click',()=>notif.remove()); header.appendChild(closeBtn);
  notif.appendChild(header);
  notif.appendChild(el('p',{className:'msg-notif-body',textContent:data.message}));
  notif.appendChild(el('div',{className:'msg-notif-time',textContent:'Sent at '+new Date(data.sentAt).toLocaleTimeString('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit'})}));
  document.body.appendChild(notif);
  try {
    const ctx=new(window.AudioContext||window.webkitAudioContext)(), osc=ctx.createOscillator(), gain=ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination); osc.frequency.value=880;
    gain.gain.setValueAtTime(0.15,ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.4);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime+0.4);
  } catch(_){}
  setTimeout(()=>{if(notif.isConnected)notif.remove();},60000);
}

function openSendMessageModal(operatorId, operatorName) {
  const body=el('div',{});
  body.appendChild(el('p',{textContent:'Send a message to '+operatorName+'. It will appear as a popup on their screen immediately.',style:'margin-bottom:14px;font-size:14px;color:var(--text2);'}));
  const textarea=el('textarea',{id:'msgText',placeholder:'Type your message here\u2026',maxlength:'500',rows:'4',style:'width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:15px;padding:12px;resize:vertical;font-family:var(--font-body);'});
  body.appendChild(textarea);
  const charCount=el('div',{style:'font-size:11px;color:var(--text3);text-align:right;margin-top:4px;',textContent:'0 / 500'});
  textarea.addEventListener('input',()=>{charCount.textContent=textarea.value.length+' / 500';});
  body.appendChild(charCount);
  const errDiv=el('div',{className:'error-msg',role:'alert'}); body.appendChild(errDiv);
  const btnSend=el('button',{className:'btn btn-primary',textContent:'\u2709 Send Message'});
  const btnCancel=el('button',{className:'btn btn-ghost',textContent:'Cancel'});
  btnCancel.addEventListener('click',closeModal);
  btnSend.addEventListener('click',async()=>{
    const message=textarea.value.trim();
    if (!message){errDiv.textContent='Please type a message.';return;}
    btnSend.disabled=true; btnSend.textContent='Sending\u2026';
    try {
      const result=await POST('/messages/send',{operatorId,message});
      closeModal();
      toast(result.delivered?'Message delivered to '+result.operatorName:result.operatorName+' is not currently logged in \u2014 message not delivered.',result.delivered?'success':'');
    } catch(err){errDiv.textContent=err.message;btnSend.disabled=false;btnSend.textContent='\u2709 Send Message';}
  });
  textarea.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))btnSend.click();});
  openModal('Send Message to '+operatorName,body,[btnCancel,btnSend]);
  setTimeout(()=>textarea.focus(),50);
}

/* ═══════════════════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════════════════ */
init();