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
  activeHandRaised:         false,
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
  reports:    { id: 'pageReports',    label: 'Reports',            minRole: 'manager'       },
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
  if (page !== 'wallboardc') {
    if (wallboardCInterval) { clearInterval(wallboardCInterval); wallboardCInterval = null; }
    if (wallboardCTick)     { clearInterval(wallboardCTick);     wallboardCTick = null;     }
  }

  for (const p of Object.values(PAGES)) {
    const el = document.getElementById(p.id);
    if (el) el.hidden = true;
  }
  const target = PAGES[page];
  if (target) {
    const node = document.getElementById(target.id);
    if (node) node.hidden = false;
  }
  buildNav();
  // Lazy-load page data
  if (page === 'home')       loadHomePage();
  if (page === 'timer')      loadTimerPage();
  if (page === 'history')    loadHistoryPage();
  if (page === 'wallboard')  loadWallboard();
  if (page === 'dashboard')  loadDashboard();
  if (page === 'targets')    loadTargetsPage();
  if (page === 'wallboardc') loadWallboardCompact();
  if (page === 'reports')    loadReportsPage();
}

// Nav drawer toggle
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
  // Pre-populate active timer state from the /me response so the banner
  // shows immediately — loadTimerPage will then verify and correct this
  // against the server before starting the stopwatch.
  if (state.user.activeTimer) {
    state.activeTimerId   = state.user.activeTimer.id;
    state.activeStartedAt = state.user.activeTimer.startedAt || null;
  } else {
    state.activeTimerId   = null;
    state.activeStartedAt = null;
  }
  refreshActiveTimerBanner();
  // Supervisors, managers and admins land on the home dashboard
  // Operators go straight to the timer
  if (hasRole('supervisor')) {
    navigateTo('home');
  } else {
    navigateTo('timer');
  }
  checkTotpSetupRequired();
  // Open SSE connection to receive real-time messages from supervisors/managers
  connectMessageStream();
}

async function doLogout() {
  stopStopwatch();
  disconnectMessageStream();
  try { await POST('/auth/logout'); } catch (_) {}
  state.user = null;
  closeNav();
  showLoginPage();
  toast('Signed out.');
}

// Store TOTP challenge token between login steps
let _totpChallengeToken = null;

// Login form — Step 1
document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  clearError('loginError');
  const btn = document.getElementById('btnLogin');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const result   = await POST('/auth/login', { username, password });

    if (result.totpRequired) {
      // Manager/admin with TOTP enabled — show 6-digit code step
      _totpChallengeToken = result.challengeToken;
      document.getElementById('loginForm').hidden = true;
      document.getElementById('totpStep').hidden  = false;
      document.getElementById('totpCode').value   = '';
      clearError('totpError');
      setTimeout(() => document.getElementById('totpCode').focus(), 50);
    } else {
      // Standard login complete — no TOTP required
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

// TOTP step — verify the 6-digit code
document.getElementById('btnTotpVerify').addEventListener('click', async () => {
  clearError('totpError');
  const code = document.getElementById('totpCode').value.trim();
  if (!/^\d{6}$/.test(code)) {
    setError('totpError', 'Please enter the 6-digit code from your authenticator app.');
    return;
  }
  const btn = document.getElementById('btnTotpVerify');
  btn.disabled = true; btn.textContent = 'Verifying…';
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

// Enter key in code input submits
document.getElementById('totpCode').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnTotpVerify').click();
});

// Back button resets to password form
document.getElementById('btnTotpBack').addEventListener('click', () => {
  _totpChallengeToken = null;
  document.getElementById('totpStep').hidden  = true;
  document.getElementById('loginForm').hidden = false;
  clearError('totpError');
});

/* ═══════════════════════════════════════════════════════════════════════════
   ACTIVE TIMER BANNER (topbar)
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

  // Always ask the server for the current active timer — this means
  // refreshes, different devices, and session restores all work correctly.
  // The browser is never the source of truth for timer state.
  try {
    const me = await GET('/me');
    if (me.activeTimer) {
      // /me now returns camelCase with status — set state directly
      state.activeTimerId   = me.activeTimer.id;
      state.activeStartedAt = me.activeTimer.startedAt;

      // Show timer immediately so operator sees it without waiting
      hide('panelStart');
      show('panelActive');
      document.getElementById('activeItemDisplay').textContent = me.activeTimer.itemNumber || '';
      const metaParts = ['Started at ' + formatLocalTime(me.activeTimer.startedAt)];
      if (me.activeTimer.workstation) metaParts.push('WS: ' + me.activeTimer.workstation);
      if (me.activeTimer.woNumber)    metaParts.push('W/O: ' + me.activeTimer.woNumber);
      document.getElementById('activeMeta').textContent = metaParts.join('  ·  ');

      refreshActiveTimerBanner();
      startStopwatch();
      // Refresh full details in background — does NOT clear state on failure
      showActivePanel();
    } else {
      // No active timer on server — clear any stale local state
      state.activeTimerId   = null;
      state.activeStartedAt = null;
      refreshActiveTimerBanner();
      showStartPanel();
      stopStopwatch();
    }
  } catch (_) {
    // Fallback: use whatever state we already have if the request fails
    if (state.activeTimerId) {
      await showActivePanel();
      startStopwatch();
    } else {
      showStartPanel();
    }
  }

  loadTodayEntries();
  // Poll for auto-pause changes from the schedule
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
  state.activeHandRaised       = false;
  hide('activeTargetWrap');
  stopPausePoll();
  const rb = document.getElementById('btnResumeTimer');
  if (rb) rb.remove();
  clearError('startError');
}

async function showActivePanel() {
  hide('panelStart');
  show('panelActive');

  // Always fetch the timer directly by ID from the server.
  // This is the most reliable restore path — works after browser close,
  // session crash, device switch, or page refresh.
  // We do NOT rely on the active-list query alone because it can miss
  // the timer if state is partially set during initialisation.
  try {
    let t = null;

    // Primary: fetch directly by ID — most reliable path for session restore
    if (state.activeTimerId) {
      try {
        const direct = await GET('/timers/' + state.activeTimerId);
        if (direct && direct.status === 'active') {
          // Timer confirmed active — use it
          t = direct;
        } else if (direct && direct.status && direct.status !== 'active') {
          // Timer exists but completed/cancelled — clear state
          state.activeTimerId   = null;
          state.activeStartedAt = null;
          refreshActiveTimerBanner();
          showStartPanel();
          stopStopwatch();
          toast('Your previous timer was already stopped.', '');
          return;
        }
        // If status is missing, fall through to list fallback
      } catch (_) {
        // Fetch failed — fall through to list fallback
      }
    }

    // Fallback: search the active list (handles edge cases where direct
    // fetch fails but the timer is still running)
    if (!t) {
      const timers = await GET('/timers?status=active');
      t = timers.find(timer => timer.id === state.activeTimerId);
    }

    if (t) {
      // Got the timer — restore full state from server values
      state.activeTimerId              = t.id;
      state.activeStartedAt            = t.startedAt;
      state.activeIsPaused             = t.isPaused || false;
      state.activePausedAt             = t.pausedAt || null;
      state.activeTotalPausedSeconds   = t.totalPausedSeconds || 0;
      state.activeHandRaised           = t.handRaised || false;
      document.getElementById('activeItemDisplay').textContent = t.itemNumber;
      const metaParts = [`Started at ${formatLocalTime(t.startedAt)}`];
      if (t.workstation) metaParts.push('WS: ' + t.workstation);
      if (t.woNumber)    metaParts.push('W/O: ' + t.woNumber);
      document.getElementById('activeMeta').textContent = metaParts.join('  ·  ');
      state.activeTargetSeconds = t.targetSeconds || null;
      updateActiveTargetDisplay();
      updatePauseUI();
      updateHandUI();
    } else if (state.activeTimerId) {
      // Both fetches found nothing — timer genuinely gone
      state.activeTimerId   = null;
      state.activeStartedAt = null;
      refreshActiveTimerBanner();
      showStartPanel();
      stopStopwatch();
      toast('Your previous timer was already stopped.', '');
    }
  } catch (_) {
    // Network failure — keep whatever state we have so the stopwatch
    // continues running with the last known startedAt.
    // The operator can still press STOP; the server will record the correct time.
  }
}

// ─── Start job ───────────────────────────────────────────────────────────
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
      // If the operator already has an active timer, offer to resume it
      if (startErr.status === 409) {
        setError('startError', startErr.message);
        // Show a Resume button so they can get back to their running timer
        const existingResumeBtn = document.getElementById('btnResumeTimer');
        if (!existingResumeBtn) {
          const resumeBtn = document.createElement('button');
          resumeBtn.id = 'btnResumeTimer';
          resumeBtn.className = 'btn btn-primary btn-full';
          resumeBtn.style.marginTop = '8px';
          resumeBtn.textContent = '↩ Resume My Active Timer';
          resumeBtn.addEventListener('click', async () => {
            resumeBtn.remove();
            clearError('startError');
            // Re-fetch to get the active timer details
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
    toast('Timer started for ' + timer.itemNumber, 'success');
  } catch (err) {
    setError('startError', err.message);
  } finally {
    btn.disabled = false;
  }
});

// ─── Stop job ────────────────────────────────────────────────────────────
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
    state.activeHandRaised       = false;
    showStartPanel();
    refreshActiveTimerBanner();
    loadTodayEntries();
    toast(`✓ Job complete: ${formatDuration(timer.durationSeconds)}`, 'success');
    // Re-sync user state so the banner and any other UI stays consistent
    GET('/me').then(me => { state.user = me; refreshActiveTimerBanner(); }).catch(() => {});
  } catch (err) {
    setError('stopError', err.message);
  } finally {
    btn.disabled = false;
  }
});

// ─── Cancel timer ────────────────────────────────────────────────────────
document.getElementById('btnCancelTimer').addEventListener('click', () => {
  if (!state.activeTimerId) return;
  const ageMs  = state.activeStartedAt
    ? Date.now() - new Date(state.activeStartedAt).getTime()
    : Infinity;
  const needsReason = ageMs > 60000;

  const bodyDiv = el('div', {});

  if (needsReason) {
    bodyDiv.appendChild(el('p', { textContent: 'This timer is over 60 seconds old. A reason is required.', className: 'mt-8' }));
  } else {
    bodyDiv.appendChild(el('p', { textContent: 'Are you sure you want to cancel this timer?', className: 'mt-8' }));
  }
  const reasonInput = el('input', { type: 'text', placeholder: 'Reason for cancellation', maxlength: '500' });
  if (needsReason) {
    bodyDiv.appendChild(el('div', { className: 'form-group mt-16' },
      el('label', { textContent: 'Reason *' }),
      reasonInput
    ));
  }
  const errDiv = el('div', { className: 'error-msg', role: 'alert' });
  bodyDiv.appendChild(errDiv);

  const btnConfirm = el('button', { className: 'btn btn-danger', textContent: 'Cancel Timer' });
  const btnClose   = el('button', { className: 'btn btn-ghost', textContent: 'Keep Running' });

  btnClose.addEventListener('click', closeModal);
  btnConfirm.addEventListener('click', async () => {
    const reason = reasonInput.value.trim() || 'Operator cancelled';
    if (needsReason && !reasonInput.value.trim()) {
      errDiv.textContent = 'Please enter a reason.';
      return;
    }
    btnConfirm.disabled = true;
    try {
      await POST(`/timers/${state.activeTimerId}/cancel`, { reason });
      state.activeTimerId   = null;
      state.activeStartedAt = null;
      stopStopwatch();
      showStartPanel();
      refreshActiveTimerBanner();
      loadTodayEntries();
      closeModal();
      toast('Timer cancelled.', 'error');
    } catch (err) {
      errDiv.textContent = err.message;
      btnConfirm.disabled = false;
    }
  });

  openModal('Cancel Timer', bodyDiv, [btnClose, btnConfirm]);
});

// ─── Stopwatch ───────────────────────────────────────────────────────────
function startStopwatch() {
  stopStopwatch();
  state.stopwatchTimer = setInterval(tickStopwatch, 500);
  tickStopwatch();
}
function stopStopwatch() {
  clearInterval(state.stopwatchTimer);
  state.stopwatchTimer = null;
  // Only reset display when there genuinely is no active timer
  if (!state.activeTimerId) {
    document.getElementById('stopwatch').textContent = '00:00:00';
  }
}
function tickStopwatch() {
  if (!state.activeStartedAt) return;
  // If paused, clock is frozen at pause moment
  const referenceMs = state.activeIsPaused && state.activePausedAt
    ? new Date(state.activePausedAt).getTime()
    : Date.now();
  const rawElapsed  = Math.max(0, Math.floor((referenceMs - new Date(state.activeStartedAt).getTime()) / 1000));
  const netElapsed  = Math.max(0, rawElapsed - state.activeTotalPausedSeconds);
  document.getElementById('stopwatch').textContent = formatDuration(netElapsed);
  if (state.activeTargetSeconds) updateActiveTargetDisplay(netElapsed);
}

function updateActiveTargetDisplay(elapsed) {
  if (elapsed === undefined) {
    elapsed = state.activeStartedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(state.activeStartedAt).getTime()) / 1000))
      : 0;
  }
  const tgt  = state.activeTargetSeconds;
  const wrap = document.getElementById('activeTargetWrap');
  if (!tgt || !wrap) return;

  wrap.hidden = false;
  const pct       = elapsed / tgt;
  const remaining = tgt - elapsed;
  const over      = remaining <= 0;

  // Progress bar fill
  const fill = document.getElementById('activeTargetFill');
  if (fill) {
    fill.style.width = Math.round(Math.min(1, pct) * 100) + '%';
    fill.className   = 'active-target-fill' + (over ? ' over' : pct >= 0.8 ? ' warn' : '');
  }

  // Percentage label
  const pctEl = document.getElementById('activeTargetPct');
  if (pctEl) pctEl.textContent = Math.round(pct * 100) + '%';

  // Text label
  const lbl = document.getElementById('activeTargetLabel');
  if (lbl) {
    if (over) {
      lbl.textContent = '⚠ ' + formatHM(Math.abs(remaining)) + ' overdue (target: ' + formatHM(tgt) + ')';
      lbl.className   = 'active-target-label overdue';
    } else {
      lbl.textContent = '🎯 ' + formatHM(remaining) + ' remaining (target: ' + formatHM(tgt) + ')';
      lbl.className   = 'active-target-label' + (pct >= 0.8 ? ' warn' : '');
    }
  }
}

// ─── Today's entries ─────────────────────────────────────────────────────
async function loadTodayEntries() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  try {
    const timers = await GET(`/timers?from=${today.toISOString()}`);
    renderEntryList('todayList', timers);
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════════════════════
   HISTORY PAGE
   ═══════════════════════════════════════════════════════════════════════════ */
function loadHistoryPage() {
  // Default: last 7 days — wide enough to catch any stuck timers
  const today = new Date().toISOString().slice(0, 10);
  const week  = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  document.getElementById('histFrom').value = week;
  document.getElementById('histTo').value   = today;

  // Supervisor+ get extra filters; admins also see status filter
  if (hasRole('supervisor')) {
    show('histSuperFilters');
  }

  searchHistory();
}

document.getElementById('btnHistSearch').addEventListener('click', searchHistory);

async function searchHistory() {
  const from     = document.getElementById('histFrom').value;
  const to       = document.getElementById('histTo').value;
  const operator = document.getElementById('histOperator')?.value.trim() || '';
  const item     = document.getElementById('histItem')?.value.trim() || '';
  const status   = document.getElementById('histStatus')?.value || '';

  const params = new URLSearchParams();
  if (from)     params.set('from',       new Date(from).toISOString());
  if (to)       { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  if (operator) params.set('operatorId', operator);
  if (item)     params.set('itemNumber', item);
  if (status)   params.set('status',     status);

  // When searching for active timers, don't restrict by date — they may be old
  if (status === 'active') {
    params.delete('from');
    params.delete('to');
  }

  try {
    const timers = await GET(`/timers?${params}`);
    renderEntryList('historyList', timers, true);
  } catch (err) {
    document.getElementById('historyList').textContent = err.message;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadDashboard() {
  try {
    const stats = await GET('/export/stats');
    renderStatCards(stats);
    renderDashTable(stats.byItem);
  } catch (err) {
    document.getElementById('dashTable').textContent = err.message;
  }
  loadTargetTimes();
}

document.getElementById('btnDashSearch').addEventListener('click', async () => {
  const from     = document.getElementById('dashFrom').value;
  const to       = document.getElementById('dashTo').value;
  const item     = document.getElementById('dashItem').value.trim();
  const operator = document.getElementById('dashOperator').value.trim();

  const params = new URLSearchParams();
  if (from)     params.set('from',       new Date(from).toISOString());
  if (to)       { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  if (item)     params.set('itemNumber', item);
  if (operator) params.set('operatorId', operator);

  try {
    const stats = await GET(`/export/stats?${params}`);
    renderDashTable(stats.byItem);
  } catch (err) {
    document.getElementById('dashTable').textContent = err.message;
  }
});

document.getElementById('btnExportCSV').addEventListener('click', () => {
  const from     = document.getElementById('dashFrom').value;
  const to       = document.getElementById('dashTo').value;
  const item     = document.getElementById('dashItem').value.trim();
  const operator = document.getElementById('dashOperator').value.trim();

  const params = new URLSearchParams();
  if (from)     params.set('from',       new Date(from).toISOString());
  if (to)       { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  if (item)     params.set('itemNumber', item);
  if (operator) params.set('operatorId', operator);

  window.location.href = `/api/export/csv?${params}`;
});

function renderStatCards(stats) {
  const container = document.getElementById('statCards');
  container.innerHTML = '';
  const cards = [
    { label: 'Active Now',    value: stats.activeCount },
    { label: 'Last 24 Hours', value: stats.total24h    },
    { label: 'Last 7 Days',   value: stats.total7d     },
    { label: 'Item Types',    value: stats.byItem.length },
  ];
  cards.forEach(c => {
    container.appendChild(el('div', { className: 'stat-card' },
      el('div', { className: 'stat-label', textContent: c.label }),
      el('div', { className: 'stat-value', textContent: c.value })
    ));
  });
}

function renderDashTable(rows) {
  const wrap = document.getElementById('dashTable');
  wrap.innerHTML = '';
  if (!rows || rows.length === 0) {
    wrap.appendChild(el('div', { className: 'empty-state', textContent: 'No data for selected filters.' }));
    return;
  }
  const table = el('table');
  const thead = el('thead', {},
    el('tr', {},
      el('th', { textContent: 'Item Number' }),
      el('th', { textContent: 'Count' }),
      el('th', { textContent: 'Avg Actual' }),
      el('th', { textContent: 'Min' }),
      el('th', { textContent: 'Max' }),
      el('th', { textContent: 'Target' }),
      el('th', { textContent: 'Avg Delta' }),
    )
  );
  const tbody = el('tbody', {});
  rows.forEach(r => {
    const hasTarget   = r.target_seconds != null;
    const avgDelta    = hasTarget ? Math.round(r.avg_seconds) - r.target_seconds : null;
    const deltaText   = avgDelta !== null ? (avgDelta >= 0 ? '+' : '') + formatDuration(Math.abs(avgDelta)) : '—';
    const deltaClass  = avgDelta === null ? '' : avgDelta > 0 ? 'dash-over' : 'dash-under';

    const row = el('tr', {},
      el('td', { textContent: r.item_number }),
      el('td', { textContent: r.count }),
      el('td', { textContent: formatDuration(Math.round(r.avg_seconds)) }),
      el('td', { textContent: formatDuration(r.min_seconds) }),
      el('td', { textContent: formatDuration(r.max_seconds) }),
      el('td', { textContent: hasTarget ? formatHM(r.target_seconds) : '—',
        className: hasTarget ? '' : 'dash-no-target' }),
    );
    const deltaCell = el('td', { textContent: deltaText, className: deltaClass });
    if (avgDelta !== null && avgDelta > 0) {
      deltaCell.title = 'Average is ' + formatDuration(avgDelta) + ' over target';
    } else if (avgDelta !== null && avgDelta < 0) {
      deltaCell.title = 'Average is ' + formatDuration(Math.abs(avgDelta)) + ' under target';
    }
    row.appendChild(deltaCell);
    tbody.appendChild(row);
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN PAGE
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadAdminPage() {
  // Always render the tools panel first — it doesn't depend on the user list
  renderAdminTools();
  try {
    const users = await GET('/users');
    renderUserList(users);
  } catch (err) {
    document.getElementById('userList').textContent = err.message;
  }
}

function renderAdminTools() {
  // The panel HTML is static in index.html — just wire up the button.
  // This avoids any timing issues with dynamic DOM insertion.
  const btn        = document.getElementById('btnCancelStuck');
  const resultDiv  = document.getElementById('cancelStuckResult');
  if (!btn) return;

  // Remove any previous listener by cloning the button
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);

  fresh.addEventListener('click', async () => {
    if (!confirm('This will cancel ALL currently active timers for all operators. Are you sure?')) return;
    fresh.disabled = true;
    fresh.textContent = 'Cancelling…';
    resultDiv.textContent = '';
    try {
      const result = await POST('/users/admin/cancel-stuck-timers', {
        reason: 'Cancelled by administrator via emergency tool'
      });
      resultDiv.style.color = 'var(--green)';
      resultDiv.textContent = '✓ ' + result.message;
      state.activeTimerId   = null;
      state.activeStartedAt = null;
      refreshActiveTimerBanner();
    } catch (err) {
      resultDiv.style.color = 'var(--red)';
      resultDiv.textContent = '✗ ' + err.message;
    } finally {
      fresh.disabled = false;
      fresh.textContent = '⚠ Cancel All Stuck Timers';
    }
  });
}

document.getElementById('btnNewUser').addEventListener('click', () => {
  openUserModal(null);
});

function renderUserList(users) {
  const container = document.getElementById('userList');
  container.innerHTML = '';
  if (!users.length) {
    container.appendChild(el('div', { className: 'empty-state', textContent: 'No users found.' }));
    return;
  }
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
    info.appendChild(meta);
    card.appendChild(info);

    const actions = el('div', { className: 'user-actions' });
    const editBtn = el('button', { className: 'btn btn-ghost', textContent: 'Edit',
      onclick: () => openUserModal(u) });
    const pwBtn   = el('button', { className: 'btn btn-ghost', textContent: 'Reset PW',
      onclick: () => openResetPasswordModal(u) });
    actions.appendChild(editBtn);
    actions.appendChild(pwBtn);
    // Show 2FA status for roles that require it
    if (ROLES_REQUIRING_TOTP.includes(u.role)) {
      const fa2Btn = el('button', {
        className: 'btn btn-ghost',
        textContent: u.totpEnabled ? 'Reset 2FA' : '2FA: Off',
        title: u.totpEnabled
          ? 'Reset this user\'s two-factor authentication (e.g. lost phone)'
          : '2FA not yet configured by this user',
        style: u.totpEnabled ? '' : 'color:var(--red);opacity:.7;',
      });
      if (u.totpEnabled) {
        fa2Btn.addEventListener('click', () => confirmReset2FA(u));
      } else {
        fa2Btn.setAttribute('disabled', '');
      }
      actions.appendChild(fa2Btn);
    }
    card.appendChild(actions);

    container.appendChild(card);
  });
}

function openUserModal(user) {
  const isNew  = !user;
  const title  = isNew ? 'New User' : 'Edit User';

  const body = el('div', {});

  const fields = [
    { id: 'mUsername', label: 'Username *', type: 'text',     value: user?.username || '',  disabled: !isNew },
    { id: 'mFullName', label: 'Full Name *', type: 'text',    value: user?.fullName || ''  },
  ];
  fields.forEach(f => {
    const input = el('input', { id: f.id, type: f.type, value: f.value, maxlength: '100' });
    if (f.disabled) input.setAttribute('disabled', '');
    body.appendChild(el('div', { className: 'form-group' },
      el('label', { for: f.id, textContent: f.label }),
      input
    ));
  });

  // Password field (new user only)
  if (isNew) {
    body.appendChild(el('div', { className: 'form-group' },
      el('label', { for: 'mPassword', textContent: 'Password *' }),
      el('input', { id: 'mPassword', type: 'password', maxlength: '64' })
    ));
  }

  // Role select
  const roleSelect = el('select', { id: 'mRole', style: 'background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:16px;padding:12px 14px;width:100%;' });
  ['operator','supervisor','manager','administrator'].forEach(r => {
    const o = el('option', { value: r, textContent: r.charAt(0).toUpperCase() + r.slice(1) });
    if (user?.role === r) o.selected = true;
    roleSelect.appendChild(o);
  });
  body.appendChild(el('div', { className: 'form-group' },
    el('label', { for: 'mRole', textContent: 'Role *' }),
    roleSelect
  ));

  // Active toggle (edit only)
  if (!isNew) {
    const activeCheck = el('input', { type: 'checkbox', id: 'mActive' });
    if (user.isActive) activeCheck.checked = true;
    body.appendChild(el('div', { className: 'form-group', style: 'flex-direction:row;align-items:center;gap:10px;' },
      activeCheck,
      el('label', { for: 'mActive', textContent: 'Account Active' })
    ));
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
      closeModal();
      loadAdminPage();
    } catch (err) {
      errDiv.textContent = err.message;
    } finally {
      btnSave.disabled = false;
    }
  });

  openModal(title, body, [btnCancel, btnSave]);
}

function openResetPasswordModal(user) {
  const body = el('div', {});
  body.appendChild(el('p', { textContent: `Reset password for ${user.fullName} (@${user.username}).`, className: 'mt-8' }));
  const pwInput = el('input', { type: 'password', placeholder: 'New password (min 8 chars)', maxlength: '64', id: 'mNewPw' });
  body.appendChild(el('div', { className: 'form-group mt-16' },
    el('label', { for: 'mNewPw', textContent: 'New Password *' }),
    pwInput
  ));
  const errDiv = el('div', { className: 'error-msg', role: 'alert' });
  body.appendChild(errDiv);

  const btnSave   = el('button', { className: 'btn btn-primary', textContent: 'Reset Password' });
  const btnCancel = el('button', { className: 'btn btn-ghost',   textContent: 'Cancel' });
  btnCancel.addEventListener('click', closeModal);

  btnSave.addEventListener('click', async () => {
    const pw = pwInput.value;
    if (pw.length < 8) { errDiv.textContent = 'Password must be at least 8 characters.'; return; }
    btnSave.disabled = true;
    try {
      await POST(`/users/${user.id}/reset-password`, { password: pw });
      toast('Password reset.', 'success');
      closeModal();
    } catch (err) {
      errDiv.textContent = err.message;
      btnSave.disabled = false;
    }
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

  if (!timers || timers.length === 0) {
    container.appendChild(el('div', { className: 'empty-state', textContent: 'No records found.' }));
    return;
  }

  const isAdmin = hasRole('administrator');

  timers.forEach(t => {
    const card = el('div', { className: 'entry-card', role: 'listitem' });

    const left = el('div', {});
    left.appendChild(el('div', { className: 'entry-item', textContent: t.itemNumber }));
    if (showOperator) {
      left.appendChild(el('div', { className: 'entry-operator', textContent: t.operatorName }));
    }
    left.appendChild(el('div', { className: 'entry-time',
      textContent: formatLocalTime(t.startedAt) + (t.completedAt ? ' → ' + formatLocalTime(t.completedAt) : '')
    }));
    if (t.workstation) left.appendChild(el('div', { className: 'entry-meta-tag', textContent: '🖥 ' + t.workstation }));
    if (t.woNumber)    left.appendChild(el('div', { className: 'entry-meta-tag', textContent: '📋 W/O: ' + t.woNumber }));
    if (t.timeCheck)   left.appendChild(el('span', { className: 'badge badge-timecheck', textContent: '✓ Time Check' }));
    if (t.targetSeconds) left.appendChild(el('div', { className: 'entry-target',
      textContent: '🎯 Target: ' + formatHM(t.targetSeconds) }));

    const right = el('div', {});
    right.appendChild(el('div', { className: 'entry-duration',
      textContent: t.durationSeconds != null ? formatDuration(t.durationSeconds) : '—'
    }));
    right.appendChild(el('div', { className: 'entry-status' },
      el('span', { className: `badge badge-${t.status}`, textContent: t.status })
    ));

    // Delete button — administrators only
    if (isAdmin) {
      const delBtn = el('button', {
        className: 'btn-delete-timer',
        textContent: '🗑',
        title: 'Delete this timer record',
        'aria-label': 'Delete timer record for ' + t.itemNumber,
      });
      delBtn.addEventListener('click', () => confirmDeleteTimer(t, card, containerId, timers));
      right.appendChild(delBtn);
    }

    card.appendChild(left);
    card.appendChild(right);
    container.appendChild(card);
  });
}

// ─── Delete timer confirmation ────────────────────────────────────────────────
function confirmDeleteTimer(t, card, containerId, timers) {
  const body = el('div', {});
  body.appendChild(el('p', {
    textContent: `Are you sure you want to permanently delete this timer record?`,
    style: 'margin-bottom:12px;'
  }));

  // Show summary of what will be deleted
  const summary = el('div', {
    style: 'background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:13px;color:var(--text2);margin-bottom:12px;'
  });
  summary.appendChild(el('div', { textContent: 'Item: ' + t.itemNumber, style: 'font-family:var(--font-mono);color:var(--accent);margin-bottom:4px;' }));
  summary.appendChild(el('div', { textContent: 'Operator: ' + t.operatorName }));
  summary.appendChild(el('div', { textContent: 'Started: ' + formatLocalTime(t.startedAt) }));
  summary.appendChild(el('div', { textContent: 'Status: ' + t.status }));
  body.appendChild(summary);

  body.appendChild(el('p', {
    textContent: '⚠ This cannot be undone. The audit log for this timer will also be deleted.',
    style: 'color:var(--red);font-size:13px;font-weight:600;'
  }));

  const errDiv = el('div', { className: 'error-msg', role: 'alert' });
  body.appendChild(errDiv);

  const btnConfirm = el('button', { className: 'btn btn-danger', textContent: 'Delete Record' });
  const btnCancel  = el('button', { className: 'btn btn-ghost',  textContent: 'Keep Record' });

  btnCancel.addEventListener('click', closeModal);

  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled = true;
    btnConfirm.textContent = 'Deleting…';
    try {
      await api('DELETE', '/timers/' + t.id);

      // If this was the user's own active timer, clear state
      if (t.id === state.activeTimerId) {
        state.activeTimerId   = null;
        state.activeStartedAt = null;
        stopStopwatch();
        refreshActiveTimerBanner();
      }

      // Remove the card from the DOM immediately
      card.remove();

      // If the list is now empty, show empty state
      const container = document.getElementById(containerId);
      if (container && container.children.length === 0) {
        container.appendChild(el('div', { className: 'empty-state', textContent: 'No records found.' }));
      }

      closeModal();
      toast('Timer record deleted.', '');
    } catch (err) {
      errDiv.textContent = err.message;
      btnConfirm.disabled = false;
      btnConfirm.textContent = 'Delete Record';
    }
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
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = cur ? (cur.nextSibling || items[0]) : items[0];
    if (cur) cur.removeAttribute('aria-selected');
    next.setAttribute('aria-selected', 'true');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = cur ? (cur.previousSibling || items[items.length-1]) : items[items.length-1];
    if (cur) cur.removeAttribute('aria-selected');
    prev.setAttribute('aria-selected', 'true');
  } else if (e.key === 'Enter') {
    const sel = sugList.querySelector('[aria-selected="true"]');
    if (sel) { e.preventDefault(); itemInput.value = sel.dataset.value; hideSuggestions(); }
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

document.addEventListener('click', e => {
  if (!itemInput.contains(e.target) && !sugList.contains(e.target)) hideSuggestions();
});

async function fetchSuggestions(q) {
  try {
    const items = await GET(`/items?q=${encodeURIComponent(q)}`);
    showSuggestions(items);
  } catch (_) {}
}

function showSuggestions(items) {
  sugList.innerHTML = '';
  if (!items.length) { hideSuggestions(); return; }
  items.forEach(item => {
    const li = el('li', { role: 'option', tabindex: '-1' });
    li.dataset.value = item.item_number;
    li.appendChild(el('span', { textContent: item.item_number }));
    if (item.description) li.appendChild(el('span', { className: 'sug-desc', textContent: item.description }));
    li.addEventListener('mousedown', e => {
      e.preventDefault();
      itemInput.value = item.item_number;
      hideSuggestions();
      itemInput.focus();
    });
    sugList.appendChild(li);
  });
  sugList.hidden = false;
}

function hideSuggestions() {
  sugList.hidden = true;
  sugList.innerHTML = '';
}

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
    timeZone:  'Europe/London',
    day:       '2-digit',
    month:     '2-digit',
    year:      'numeric',
    hour:      '2-digit',
    minute:    '2-digit',
    second:    '2-digit',
    hour12:    false,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   QR / BARCODE SCANNER
   Uses the browser-native BarcodeDetector API — built into Android Chrome
   83+ and Chrome desktop. No external libraries required.
   Falls back gracefully with a clear message on unsupported browsers.
   ═══════════════════════════════════════════════════════════════════════════ */
const scanner = (() => {
  let stream       = null;   // MediaStream
  let active       = false;
  let scanInterval = null;   // polling interval for BarcodeDetector
  let detector     = null;   // BarcodeDetector instance
  let torchEnabled = false;
  let targetInput  = null;   // the input element to fill on success
  let targetMode   = 'item'; // 'item' | 'notes' — controls validation + toast wording

  const overlay  = document.getElementById('scannerOverlay');
  const video    = document.getElementById('scannerVideo');
  const statusEl = document.getElementById('scannerStatus');
  const torchBtn = document.getElementById('btnScanTorch');
  const closeBtn = document.getElementById('btnScanClose');

  function setStatus(msg, type = '') {
    statusEl.textContent = msg;
    statusEl.className   = 'scanner-status' + (type ? ' ' + type : '');
  }

  // open(inputEl, mode) — mode is 'item' or 'notes'
  async function open(inputEl, mode) {
    targetInput = inputEl;
    targetMode  = mode || 'item';

    // ── Check camera API support ──────────────────────────────────────────
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Camera API not available. Use Chrome on Android.', 'error');
      return;
    }

    // ── Check BarcodeDetector support ─────────────────────────────────────
    if (!('BarcodeDetector' in window)) {
      overlay.hidden = false;
      setStatus(
        'Barcode scanning requires Chrome on Android or Chrome 83+ on desktop. ' +
        'Your current browser does not support it.',
        'error'
      );
      return;
    }

    overlay.hidden = false;
    active = true;
    setStatus('Scanning — point at a barcode or QR code');

    try {
      detector = new BarcodeDetector({
        formats: [
          'qr_code', 'code_128', 'code_39', 'code_93',
          'ean_13', 'ean_8', 'upc_a', 'upc_e',
          'data_matrix', 'pdf417',
        ],
      });

      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:      { ideal: 1280 },
          height:     { ideal: 720 },
        },
        audio: false,
      });

      video.srcObject = stream;
      await video.play();

      setStatus('Scanning — point at a barcode or QR code');
      tryEnableTorch();
      startScanLoop();

    } catch (err) {
      if (err.name === 'NotAllowedError') {
        setStatus(
          'Camera permission denied. Tap the camera icon in your browser address bar to allow access.',
          'error'
        );
      } else if (err.name === 'NotFoundError') {
        setStatus('No camera found on this device.', 'error');
      } else {
        setStatus('Camera error: ' + err.message, 'error');
      }
    }
  }

  // Poll BarcodeDetector against the live video frame every 300 ms
  function startScanLoop() {
    scanInterval = setInterval(async () => {
      if (!active || !detector || video.readyState < 2) return;
      try {
        const barcodes = await detector.detect(video);
        if (barcodes && barcodes.length > 0) {
          const text = barcodes[0].rawValue.trim();

          if (targetMode === 'item') {
            // Item number: strict alphanumeric + hyphen/underscore, max 40
            if (/^[A-Za-z0-9\-_]{1,40}$/.test(text)) {
              onScanSuccess(text);
            } else {
              setStatus(`Read "${text}" — not a valid item number. Try again.`, 'error');
              setTimeout(() => {
                if (active) setStatus('Scanning — point at a barcode or QR code');
              }, 2000);
            }
          } else {
            // Notes: accept any non-empty scan result (max 500 chars)
            if (text.length > 0) {
              onScanSuccess(text.slice(0, 500));
            }
          }
        }
      } catch (_) {
        // Detection errors on individual frames are normal — ignore
      }
    }, 300);
  }

  function onScanSuccess(text) {
    clearInterval(scanInterval);
    scanInterval = null;

    setStatus('✓ Scanned: ' + text, 'success');

    if (targetInput) {
      // For notes: append to existing value if there is one, otherwise set
      if (targetMode === 'notes' && targetInput.value.trim()) {
        targetInput.value = targetInput.value.trimEnd() + ' ' + text;
      } else {
        targetInput.value = text;
      }
      if (targetMode === 'item') hideSuggestions();
    }

    const label = targetMode === 'notes' ? 'Note scanned' : 'Item number scanned';
    setTimeout(() => {
      close();
      if (targetInput) targetInput.focus();
      toast(`${label}: ${text}`, 'success');
    }, 700);
  }

  function close() {
    active = false;
    overlay.hidden = true;

    clearInterval(scanInterval);
    scanInterval = null;

    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }

    video.srcObject = null;
    detector        = null;
    torchEnabled    = false;
    torchBtn.hidden = true;
    torchBtn.textContent = '🔦 Torch';
    setStatus('Initialising camera…');
  }

  // Torch / flashlight — supported on most Android devices in Chrome
  function tryEnableTorch() {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) {
      torchBtn.hidden = false;
      torchBtn.onclick = async () => {
        torchEnabled = !torchEnabled;
        try {
          await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
          torchBtn.textContent = torchEnabled ? '🔦 Torch On' : '🔦 Torch';
        } catch (_) {}
      };
    }
  }

  // ── Wire up buttons ───────────────────────────────────────────────────────
  // Item number scan button
  document.getElementById('btnScan').addEventListener('click', () => {
    open(document.getElementById('itemNumberInput'), 'item');
  });

  // Notes scan button
  document.getElementById('btnScanWorkstation').addEventListener('click', () => {
    open(document.getElementById('startWorkstation'), 'notes');
  });
  document.getElementById('btnScanWoNumber').addEventListener('click', () => {
    open(document.getElementById('startWoNumber'), 'notes');
  });

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return { open, close };
})();


/* ═══════════════════════════════════════════════════════════════════════════
   WALL BOARD
   Auto-refreshes every 30 seconds. Shows live tiles for all active timers.
   Available to Supervisor, Manager, Administrator.
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadWallboard() {
  if (wallboardInterval) clearInterval(wallboardInterval);
  await refreshWallboard();
  // Poll every 60s, but skip if tab is hidden — saves server resources
  wallboardInterval = setInterval(() => {
    if (document.visibilityState === 'visible') refreshWallboard();
  }, 300000);
}

// Resume immediately when a hidden tab becomes visible again
document.addEventListener('visibilitychange', () => {
  if (state.currentPage === 'wallboard' && document.visibilityState === 'visible') {
    refreshWallboard();
  }
});

async function refreshWallboard() {
  const container  = document.getElementById('wallboardTiles');
  const countEl    = document.getElementById('wallboardCount');
  const updatedEl  = document.getElementById('wallboardUpdated');
  if (!container) return;

  try {
    const [timers, onlineData] = await Promise.all([
      GET('/timers?status=active&limit=200'),
      GET('/messages/online').catch(() => ({ online: [] })),
    ]);
    const onlineSet = new Set(onlineData.online || []);

    // Update count and last-updated time
    if (countEl)   countEl.textContent  = timers.length + ' active job' + (timers.length !== 1 ? 's' : '');
    if (updatedEl) updatedEl.textContent = 'Updated ' + new Date().toLocaleTimeString('en-GB');

    container.innerHTML = '';

    if (timers.length === 0) {
      container.appendChild(el('div', { className: 'wallboard-empty' },
        el('div', { className: 'wallboard-empty-icon', textContent: '✓' }),
        el('div', { className: 'wallboard-empty-text', textContent: 'No active jobs right now' })
      ));
      return;
    }

    timers.forEach(t => {
      // Net elapsed from server (excludes paused time); fallback to local calc
      const serverNet = t.netElapsedSeconds != null ? t.netElapsedSeconds : null;
      const localEl   = Math.max(0, Math.floor((Date.now() - new Date(t.startedAt).getTime()) / 1000)) - (t.totalPausedSeconds || 0);
      const elapsed   = serverNet !== null ? serverNet : localEl;
      const tile      = el('div', { className: 'wallboard-tile' + (t.isPaused ? ' tile-paused' : '') });

      // Smart colouring: paused tiles are neutral; otherwise target-relative or fixed
      if (!t.isPaused) {
        if (t.targetSeconds) {
          const pctNow = elapsed / t.targetSeconds;
          if (pctNow >= 1.0)      tile.classList.add('tile-overdue');
          else if (pctNow >= 0.8) tile.classList.add('tile-warning');
        } else {
          if (elapsed > 4 * 3600)      tile.classList.add('tile-overdue');
          else if (elapsed > 2 * 3600) tile.classList.add('tile-warning');
        }
      }

      // Pause indicator on tile
      if (t.isPaused) {
        const pauseTag = el('div', { className: 'wb-paused-tag', textContent: '⏸ PAUSED' });
        if (t.pauseType === 'schedule') pauseTag.title = 'Auto-paused outside working hours';
        tile.appendChild(pauseTag);
      }

      // Raised hand indicator
      if (t.handRaised) {
        tile.classList.add('tile-hand-raised');
        tile.appendChild(el('div', { className: 'wb-hand-tag', textContent: '✋ Needs Attention' }));
      }

      tile.appendChild(el('div', { className: 'wb-item',     textContent: t.itemNumber }));
      const opRow = el('div', { className: 'wb-operator-row' });
      opRow.appendChild(el('span', {
        className: 'presence-dot ' + (onlineSet.has(t.operatorId) ? 'online' : 'offline'),
        title: onlineSet.has(t.operatorId) ? 'Session active' : 'Not connected',
      }));
      opRow.appendChild(el('span', { textContent: t.operatorName }));
      tile.appendChild(opRow);
      tile.appendChild(el('div', { className: 'wb-elapsed',  textContent: formatDuration(elapsed),
        'data-timerid':       t.id,
        'data-startedat':     t.startedAt,
        'data-pausedseconds': String(t.totalPausedSeconds || 0),
        'data-ispaused':      t.isPaused ? '1' : '0',
      }));
      tile.appendChild(el('div', { className: 'wb-started',
        textContent: 'Started ' + formatLocalTime(t.startedAt) }));

      if (t.workstation) tile.appendChild(el('div', { className: 'wb-notes', textContent: '🖥 ' + t.workstation }));
      if (t.woNumber)    tile.appendChild(el('div', { className: 'wb-notes', textContent: '📋 W/O: ' + t.woNumber }));
      if (t.timeCheck)   tile.appendChild(el('span', { className: 'badge badge-timecheck', style: 'margin-top:6px;display:inline-block;', textContent: '✓ Time Check' }));
      if (t.targetSeconds) {
        const pct       = elapsed / t.targetSeconds;
        const pctCapped = Math.min(1, pct);
        const remaining = t.targetSeconds - elapsed;
        const targetWrap = el('div', { className: 'wb-target-wrap' });
        const labelText  = remaining > 0
          ? formatHM(remaining) + ' remaining'
          : formatHM(Math.abs(remaining)) + ' overdue';
        const labelEl = el('div', {
          className: 'wb-target-label' + (remaining <= 0 ? ' overdue' : ''),
          textContent: '🎯 Target: ' + formatHM(t.targetSeconds) + '  —  ' + labelText,
          'data-startedat':    t.startedAt,
          'data-targetseconds': String(t.targetSeconds),
        });
        targetWrap.appendChild(labelEl);
        const bar  = el('div', { className: 'wb-target-bar' });
        const fill = el('div', {
          className: 'wb-target-fill' + (pct >= 1 ? ' over' : ''),
          style: 'width:' + Math.round(pctCapped * 100) + '%',
          'data-startedat':     t.startedAt,
          'data-targetseconds': String(t.targetSeconds),
        });
        bar.appendChild(fill);
        targetWrap.appendChild(bar);
        tile.appendChild(targetWrap);
      }

      // Action button row — supervisors and above only
      if (hasRole('supervisor')) {
        const btnRow = el('div', { className: 'wb-btn-row' });

        // Pause / Resume toggle button
        const pauseBtn = el('button', {
          className: 'wb-pause-btn' + (t.isPaused ? ' is-paused' : ''),
          textContent: t.isPaused ? '▶ Resume' : '⏸ Pause',
          'aria-label': (t.isPaused ? 'Resume' : 'Pause') + ' timer for ' + t.operatorName,
        });
        pauseBtn.addEventListener('click', async () => {
          pauseBtn.disabled = true;
          try {
            if (t.isPaused) {
              await POST('/pause/' + t.id + '/resume', {});
              toast('Timer resumed for ' + t.operatorName, 'success');
            } else {
              await POST('/pause/' + t.id + '/pause', { reason: 'Paused by ' + state.user.fullName });
              toast('Timer paused for ' + t.operatorName, '');
            }
            await refreshWallboard();
          } catch (err) { toast(err.message, 'error'); pauseBtn.disabled = false; }
        });
        btnRow.appendChild(pauseBtn);

        // Message button
        btnRow.appendChild(el('button', {
          className: 'wb-msg-btn',
          textContent: '✉ Message',
          'aria-label': 'Send message to ' + t.operatorName,
          onclick: () => openSendMessageModal(t.operatorId, t.operatorName),
        }));

        // Lower hand button — only shown when hand is raised
        if (t.handRaised) {
          const lowerBtn = el('button', {
            className: 'wb-lower-hand-btn',
            textContent: '✋ Lower Hand',
            'aria-label': 'Lower hand for ' + t.operatorName,
          });
          lowerBtn.addEventListener('click', async () => {
            lowerBtn.disabled = true;
            try {
              await POST('/timers/' + t.id + '/lower-hand', {});
              toast('Hand lowered for ' + t.operatorName, 'success');
              await refreshWallboard();
            } catch (err) { toast(err.message, 'error'); lowerBtn.disabled = false; }
          });
          btnRow.appendChild(lowerBtn);
        }

        tile.appendChild(btnRow);
      }

      container.appendChild(tile);
    });

    // Tick elapsed times every second so tiles update live
    startWallboardTick();

  } catch (err) {
    container.innerHTML = '';
    container.appendChild(el('div', { className: 'wallboard-empty',
      textContent: 'Could not load active timers: ' + err.message }));
  }
}

// Live tick — updates elapsed time on each tile every second
function startWallboardTick() {
  if (wallboardTick) clearInterval(wallboardTick);
  wallboardTick = setInterval(() => {
    if (state.currentPage !== 'wallboard') {
      clearInterval(wallboardTick); wallboardTick = null; return;
    }
    document.querySelectorAll('.wb-elapsed[data-startedat]').forEach(el => {
      const startedAt   = el.getAttribute('data-startedat');
      const pausedSecs  = parseInt(el.getAttribute('data-pausedseconds') || '0', 10);
      const isPaused    = el.getAttribute('data-ispaused') === '1';
      if (!startedAt) return;

      // Paused tiles show frozen net elapsed, don't increment
      const rawElapsed = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
      const elapsed    = Math.max(0, rawElapsed - pausedSecs);
      if (!isPaused) el.textContent = formatDuration(elapsed);

      const tile = el.closest('.wallboard-tile');
      if (!tile) return;

      // Skip colour logic for paused tiles
      if (isPaused) return;

      tile.classList.remove('tile-warning', 'tile-overdue');
      const fill = tile.querySelector('.wb-target-fill');
      const tgt  = fill ? parseInt(fill.getAttribute('data-targetseconds'), 10) : 0;
      if (tgt) {
        const pct = elapsed / tgt;
        if (pct >= 1.0)      tile.classList.add('tile-overdue');
        else if (pct >= 0.8) tile.classList.add('tile-warning');
        fill.style.width = Math.round(Math.min(1, pct) * 100) + '%';
        fill.classList.toggle('over', pct >= 1);
        const lbl = tile.querySelector('.wb-target-label');
        if (lbl) {
          const remaining = tgt - elapsed;
          const labelText = remaining > 0
            ? formatHM(remaining) + ' remaining'
            : formatHM(Math.abs(remaining)) + ' overdue';
          lbl.textContent = '🎯 Target: ' + formatHM(tgt) + '  --  ' + labelText;
          lbl.className   = 'wb-target-label' + (remaining <= 0 ? ' overdue' : '');
        }
      } else {
        if (elapsed > 4 * 3600)      tile.classList.add('tile-overdue');
        else if (elapsed > 2 * 3600) tile.classList.add('tile-warning');
      }
    });
  }, 1000);
}




/* ═══════════════════════════════════════════════════════════════════════════
   TARGET TIMES  (Manager / Administrator)
   ═══════════════════════════════════════════════════════════════════════════ */

// Format seconds as "Xh Ym"
function formatHM(totalSeconds) {
  if (!totalSeconds) return '—';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h === 0) return m + 'm';
  if (m === 0) return h + 'h';
  return h + 'h ' + m + 'm';
}

async function loadTargetTimes(containerId = 'targetTimesList') {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const targets = await GET('/targets');
    renderTargetList(targets, containerId);
  } catch (_) {
    container.innerHTML = '<div class="empty-state">Could not load target times.</div>';
  }
}

function renderTargetList(targets, containerId = 'targetTimesList') {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (!targets || targets.length === 0) {
    container.appendChild(el('div', { className: 'empty-state',
      textContent: 'No target times set yet. Click + Add Target Time to get started.' }));
    return;
  }
  targets.forEach(t => {
    const row  = el('div', { className: 'target-row' });
    const info = el('div', { className: 'target-row-info' });
    info.appendChild(el('span', { className: 'target-item-number', textContent: t.itemNumber }));
    info.appendChild(el('span', { className: 'target-time-display',
      textContent: formatHM(t.totalSeconds) }));
    const actions = el('div', { className: 'target-row-actions' });
    actions.appendChild(el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Edit',
      onclick: () => openTargetModal(t, containerId) }));
    actions.appendChild(el('button', { className: 'btn btn-ghost btn-sm', textContent: '🗑',
      onclick: () => confirmDeleteTarget(t, containerId) }));
    row.appendChild(info);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

// Dedicated Target Times page loader
function loadTargetsPage() {
  loadTargetTimes('targetTimesPageList');
}

// Wire up Add button on the dedicated page
document.getElementById('btnAddTargetPage') &&
  document.getElementById('btnAddTargetPage').addEventListener('click', () =>
    openTargetModal(null, 'targetTimesPageList'));

function openTargetModal(existing, containerId = 'targetTimesList') {
  const isNew = !existing;
  const body  = el('div', {});
  const itemInput = el('input', {
    id: 'ttItemNumber', type: 'text',
    maxlength: '40',
    placeholder: 'e.g. PHL-1001',
    value: existing ? existing.itemNumber : '',
    autocapitalize: 'characters',
  });
  if (!isNew) itemInput.setAttribute('disabled', '');

  // Scan button for item number — only shown when adding new (not editing)
  const itemInputRow = el('div', { className: 'input-with-action' }, itemInput);
  if (isNew) {
    const scanBtn = el('button', {
      className: 'btn-scan', type: 'button',
      'aria-label': 'Scan barcode into item number',
    });
    // Reuse the scanner SVG icon
    scanBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
      <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
      <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
      <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
      <rect x="7" y="7" width="3" height="3"/>
      <rect x="14" y="7" width="3" height="3"/>
      <rect x="7" y="14" width="3" height="3"/>
      <rect x="14" y="14" width="3" height="3"/>
    </svg> Scan`;
    scanBtn.addEventListener('click', () => scanner.open(itemInput, 'item'));
    itemInputRow.appendChild(scanBtn);
  }

  body.appendChild(el('div', { className: 'form-group' },
    el('label', { for: 'ttItemNumber', textContent: 'Item Number *' }),
    itemInputRow));

  const timeRow = el('div', { className: 'form-group' });
  timeRow.appendChild(el('label', { textContent: 'Target Time *' }));
  const timeInputs = el('div', { className: 'time-input-row' });
  const hoursInput = el('input', {
    id: 'ttHours', type: 'number', min: '0', max: '99',
    placeholder: '0', style: 'width:70px;text-align:center;',
    value: existing ? String(existing.hours) : '0',
  });
  const minsInput = el('input', {
    id: 'ttMinutes', type: 'number', min: '0', max: '59',
    placeholder: '0', style: 'width:70px;text-align:center;',
    value: existing ? String(existing.minutes) : '0',
  });
  timeInputs.appendChild(hoursInput);
  timeInputs.appendChild(el('span', { textContent: 'h', style: 'margin:0 6px;color:var(--text2);font-weight:600;' }));
  timeInputs.appendChild(minsInput);
  timeInputs.appendChild(el('span', { textContent: 'm', style: 'margin:0 6px;color:var(--text2);font-weight:600;' }));
  timeRow.appendChild(timeInputs);
  body.appendChild(timeRow);

  const errDiv  = el('div', { className: 'error-msg', role: 'alert' });
  body.appendChild(errDiv);
  const btnSave   = el('button', { className: 'btn btn-primary', textContent: isNew ? 'Add Target Time' : 'Save Changes' });
  const btnCancel = el('button', { className: 'btn btn-ghost',   textContent: 'Cancel' });
  btnCancel.addEventListener('click', closeModal);
  btnSave.addEventListener('click', async () => {
    errDiv.textContent = '';
    const itemNumber = (document.getElementById('ttItemNumber').value || '').trim().toUpperCase();
    const hours      = parseInt(document.getElementById('ttHours').value, 10) || 0;
    const minutes    = parseInt(document.getElementById('ttMinutes').value, 10) || 0;
    if (!itemNumber) { errDiv.textContent = 'Item Number is required.'; return; }
    if (hours === 0 && minutes === 0) { errDiv.textContent = 'Target time must be greater than zero.'; return; }
    btnSave.disabled = true;
    try {
      await POST('/targets', { itemNumber, hours, minutes });
      toast((isNew ? 'Target time added' : 'Target time updated') + ' for ' + itemNumber, 'success');
      closeModal();
      // Reload both the dedicated page list and the dashboard section if present
      loadTargetTimes(containerId);
      if (containerId !== 'targetTimesList') loadTargetTimes('targetTimesList');
    } catch (err) {
      errDiv.textContent = err.message;
    } finally {
      btnSave.disabled = false;
    }
  });
  openModal(isNew ? 'Add Target Time' : 'Edit Target Time', body, [btnCancel, btnSave]);
}

function confirmDeleteTarget(t, containerId = 'targetTimesList') {
  const body = el('div', {});
  body.appendChild(el('p', { textContent: 'Remove the target time for ' + t.itemNumber + '?',
    style: 'margin-bottom:12px;' }));
  const errDiv    = el('div', { className: 'error-msg', role: 'alert' });
  body.appendChild(errDiv);
  const btnConfirm = el('button', { className: 'btn btn-danger', textContent: 'Remove' });
  const btnCancel  = el('button', { className: 'btn btn-ghost',  textContent: 'Keep' });
  btnCancel.addEventListener('click', closeModal);
  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled = true;
    try {
      await api('DELETE', '/targets/' + encodeURIComponent(t.itemNumber));
      toast('Target time removed for ' + t.itemNumber, '');
      closeModal();
      loadTargetTimes(containerId);
      if (containerId !== 'targetTimesList') loadTargetTimes('targetTimesList');
    } catch (err) {
      errDiv.textContent = err.message;
      btnConfirm.disabled = false;
    }
  });
  openModal('Remove Target Time', body, [btnCancel, btnConfirm]);
}

// Wire up the Add Target Time button on the dashboard
document.getElementById('btnAddTarget') &&
  document.getElementById('btnAddTarget').addEventListener('click', () =>
    openTargetModal(null, 'targetTimesList'));



function confirmReset2FA(user) {
  const body = el('div', {});
  body.appendChild(el('p', {
    textContent: 'This will disable two-factor authentication for ' + user.fullName + ' (@' + user.username + '). ' +
      'They will be prompted to set it up again on their next login.',
    style: 'margin-bottom:12px;',
  }));
  body.appendChild(el('p', {
    textContent: 'Only do this if they have lost access to their authenticator app.',
    style: 'color:var(--red);font-size:13px;font-weight:600;',
  }));
  const errDiv    = el('div', { className: 'error-msg', role: 'alert' });
  body.appendChild(errDiv);
  const btnConfirm = el('button', { className: 'btn btn-danger', textContent: 'Reset 2FA' });
  const btnCancel  = el('button', { className: 'btn btn-ghost',  textContent: 'Cancel' });
  btnCancel.addEventListener('click', closeModal);
  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled = true;
    try {
      await api('DELETE', '/totp/reset/' + user.id);
      toast('2FA reset for ' + user.fullName + '. They will be prompted to set it up again.', 'success');
      closeModal();
      loadAdminPage();
    } catch (err) {
      errDiv.textContent = err.message;
      btnConfirm.disabled = false;
    }
  });
  openModal('Reset Two-Factor Authentication', body, [btnCancel, btnConfirm]);
}

/* ═══════════════════════════════════════════════════════════════════════════
   TOTP SETUP  (Manager / Administrator)
   Shown automatically when a manager/admin logs in without TOTP configured.
   Also accessible via a button in their profile area.
   ═══════════════════════════════════════════════════════════════════════════ */
const ROLES_REQUIRING_TOTP = ['manager', 'administrator'];

// Called from onLoggedIn — prompts setup if TOTP required but not configured
function checkTotpSetupRequired() {
  if (!ROLES_REQUIRING_TOTP.includes(state.user.role)) return;
  // Only prompt if totpEnabled is EXPLICITLY false — not undefined/missing.
  // undefined means the field wasn't returned (e.g. older login path) — don't prompt.
  // false means the server confirmed 2FA is not yet set up — prompt.
  if (state.user.totpEnabled !== false) return;
  // Show setup prompt after a short delay so the main UI renders first
  setTimeout(() => openTotpSetupModal(), 800);
}

async function openTotpSetupModal() {
  const body = el('div', {});

  body.appendChild(el('p', {
    textContent: 'Your role requires two-factor authentication (2FA). ' +
      'Please scan the QR code below with an authenticator app such as ' +
      'Google Authenticator or Microsoft Authenticator, then enter the ' +
      '6-digit code to complete setup.',
    style: 'margin-bottom:16px;font-size:14px;',
  }));

  // Loading state while we fetch the QR code
  const qrWrap = el('div', { style: 'text-align:center;padding:20px 0;' });
  qrWrap.appendChild(el('div', { textContent: 'Generating QR code…', style: 'color:var(--text3);' }));
  body.appendChild(qrWrap);

  const codeGroup = el('div', { className: 'form-group', style: 'margin-top:8px;' });
  codeGroup.appendChild(el('label', { for: 'setupTotpCode', textContent: 'Enter code from app *' }));
  const codeInput = el('input', {
    id: 'setupTotpCode', type: 'text', inputmode: 'numeric',
    pattern: '\d{6}', maxlength: '6',
    placeholder: '000000',
    className: 'totp-code-input',
  });
  codeGroup.appendChild(codeInput);
  body.appendChild(codeGroup);

  const errDiv  = el('div', { className: 'error-msg', role: 'alert' });
  body.appendChild(errDiv);

  const btnEnable = el('button', { className: 'btn btn-primary', textContent: 'Enable 2FA' });
  const btnSkip   = el('button', { className: 'btn btn-ghost',   textContent: 'Remind Me Later' });
  btnSkip.addEventListener('click', () => {
    // Set to null (not false) so we don't re-prompt during this session
    state.user.totpEnabled = null;
    closeModal();
  });

  openModal('Set Up Two-Factor Authentication', body, [btnSkip, btnEnable]);

  // Fetch QR code from server
  try {
    const setup = await POST('/totp/setup', {});
    qrWrap.innerHTML = '';
    qrWrap.appendChild(el('img', {
      src: setup.qrDataUrl,
      alt: 'QR code for authenticator app',
      style: 'width:200px;height:200px;border-radius:8px;',
    }));
    qrWrap.appendChild(el('p', {
      textContent: "Can't scan? Enter this code manually: " + setup.secret,
      style: 'font-size:11px;color:var(--text3);margin-top:8px;word-break:break-all;',
    }));
    codeInput.focus();
  } catch (err) {
    qrWrap.innerHTML = '';
    qrWrap.appendChild(el('p', { textContent: 'Could not load QR code: ' + err.message, style: 'color:var(--red);' }));
  }

  btnEnable.addEventListener('click', async () => {
    errDiv.textContent = '';
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) {
      errDiv.textContent = 'Please enter the 6-digit code from your authenticator app.';
      return;
    }
    btnEnable.disabled = true;
    try {
      await POST('/totp/confirm', { code });
      state.user.totpEnabled = true;
      closeModal();
      toast('Two-factor authentication enabled successfully.', 'success');
    } catch (err) {
      errDiv.textContent = err.message;
      btnEnable.disabled = false;
    }
  });
}





/* ═══════════════════════════════════════════════════════════════════════════
   PAUSE / RESUME
   ═══════════════════════════════════════════════════════════════════════════ */

// Update the active panel UI to reflect current pause state
function updatePauseUI() {
  const isPaused  = state.activeIsPaused;
  const banner    = document.getElementById('pauseBanner');
  const bannerTxt = document.getElementById('pauseBannerText');
  const pauseBtn  = document.getElementById('btnPauseTimer');
  const label     = document.getElementById('activeJobLabel');
  const stopwatch = document.getElementById('stopwatch');
  const panel     = document.getElementById('panelActive');

  if (banner) banner.hidden = !isPaused;
  if (label)  label.textContent = isPaused ? 'PAUSED' : 'ACTIVE JOB';
  if (stopwatch) stopwatch.classList.toggle('stopwatch-paused', isPaused);
  if (panel)  panel.classList.toggle('panel-paused', isPaused);

  if (pauseBtn) {
    if (isPaused) {
      pauseBtn.textContent = '▶ Resume';
      pauseBtn.className   = 'btn btn-resume-sm';
      pauseBtn.setAttribute('aria-label', 'Resume timer');
    } else {
      pauseBtn.textContent = '⏸ Pause';
      pauseBtn.className   = 'btn btn-pause-sm';
      pauseBtn.setAttribute('aria-label', 'Pause timer');
    }
  }

  // Freeze or restart the stopwatch
  if (isPaused) {
    stopStopwatch();
    // Show the frozen net elapsed
    if (state.activeStartedAt && state.activePausedAt) {
      const raw = Math.floor((new Date(state.activePausedAt).getTime() - new Date(state.activeStartedAt).getTime()) / 1000);
      const net = Math.max(0, raw - state.activeTotalPausedSeconds);
      document.getElementById('stopwatch').textContent = formatDuration(net);
    }
  } else {
    startStopwatch();
  }
}

// Pause button handler
document.getElementById('btnPauseTimer').addEventListener('click', async () => {
  if (!state.activeTimerId) return;
  const btn = document.getElementById('btnPauseTimer');
  btn.disabled = true;
  try {
    if (state.activeIsPaused) {
      const t = await POST('/pause/' + state.activeTimerId + '/resume', {});
      state.activeIsPaused           = false;
      state.activePausedAt           = null;
      state.activeTotalPausedSeconds = t.totalPausedSeconds || 0;
      updatePauseUI();
      toast('Timer resumed.', 'success');
    } else {
      const t = await POST('/pause/' + state.activeTimerId + '/pause', { reason: 'Manual pause' });
      state.activeIsPaused         = true;
      state.activePausedAt         = t.pausedAt;
      updatePauseUI();
      toast('Timer paused.', '');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// Poll for pause state changes (e.g. auto-pause from schedule)
// Runs every 30s when on the timer page — lightweight single DB call
let pausePollInterval = null;

function startPausePoll() {
  if (pausePollInterval) clearInterval(pausePollInterval);
  pausePollInterval = setInterval(async () => {
    if (state.currentPage !== 'timer' || !state.activeTimerId) return;
    try {
      const t = await GET('/timers/' + state.activeTimerId);
      if (!t) return;
      const waspaused = state.activeIsPaused;
      state.activeIsPaused           = t.isPaused || false;
      state.activePausedAt           = t.pausedAt || null;
      state.activeTotalPausedSeconds = t.totalPausedSeconds || 0;
      if (waspaused !== state.activeIsPaused) {
        updatePauseUI();
        if (state.activeIsPaused) {
          toast('Your timer has been automatically paused outside working hours.', '');
        } else {
          toast('Your timer has automatically resumed for the new working day.', 'success');
        }
      }
    } catch (_) {}
  }, 30000);
}

function stopPausePoll() {
  if (pausePollInterval) { clearInterval(pausePollInterval); pausePollInterval = null; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   RAISE / LOWER HAND
   ═══════════════════════════════════════════════════════════════════════════ */
function updateHandUI() {
  const btn = document.getElementById('btnRaiseHand');
  if (!btn) return;
  if (state.activeHandRaised) {
    btn.textContent = '✋ Lower Hand';
    btn.className   = 'btn btn-hand-raised-sm';
    btn.setAttribute('aria-label', 'Lower hand');
  } else {
    btn.textContent = '✋ Raise Hand';
    btn.className   = 'btn btn-hand-sm';
    btn.setAttribute('aria-label', 'Raise hand');
  }
}

document.getElementById('btnRaiseHand').addEventListener('click', async () => {
  if (!state.activeTimerId) return;
  const btn = document.getElementById('btnRaiseHand');
  btn.disabled = true;
  try {
    if (state.activeHandRaised) {
      await POST(`/timers/${state.activeTimerId}/lower-hand`, {});
      state.activeHandRaised = false;
      toast('Hand lowered.', '');
    } else {
      await POST(`/timers/${state.activeTimerId}/raise-hand`, {});
      state.activeHandRaised = true;
      toast('Hand raised \u2014 a supervisor will be with you shortly.', 'success');
    }
    updateHandUI();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

/* ═══════════════════════════════════════════════════════════════════════════
   WALLBOARD TILE PAUSE / RESUME
   Inline button on each wallboard tile — works reliably on touch screens.
   Compact wallboard is display-only and has no pause button.
   ═══════════════════════════════════════════════════════════════════════════ */
// (pause/resume is handled inline per tile — no shared context menu needed)

/* ═══════════════════════════════════════════════════════════════════════════
   HOME PAGE  (Supervisor / Manager / Administrator)
   A command-centre dashboard landing page.
   Operators land on the Timer page instead.
   ═══════════════════════════════════════════════════════════════════════════ */

async function loadHomePage() {
  // Render the skeleton immediately so the page feels instant
  renderHomeSkeleton();

  // Fetch all data in parallel
  const [activeTimers, stats, users] = await Promise.all([
    GET('/timers?status=active&limit=200').catch(() => []),
    GET('/export/stats').catch(() => null),
    hasRole('administrator') ? GET('/users').catch(() => []) : Promise.resolve([]),
  ]);

  renderHomeActiveJobs(activeTimers);
  renderHomeTodayStats(stats);
  if (hasRole('manager')) renderHomePerformance(stats);
  if (hasRole('administrator')) renderHomeUsers(users);
  renderHomeQuickActions();
}

function renderHomeSkeleton() {
  const page = document.getElementById('pageHome');
  if (!page) return;
  page.innerHTML = `
    <div class="home-page">
      <div class="home-greeting" id="homeGreeting"></div>
      <div class="home-grid" id="homeGrid">
        <div class="home-card home-card-full" id="homeActiveJobs">
          <div class="home-card-title">Active Jobs</div>
          <div class="home-card-body"><div class="empty-state">Loading…</div></div>
        </div>
        <div class="home-card" id="homeTodayStats">
          <div class="home-card-title">Today at a Glance</div>
          <div class="home-card-body"><div class="empty-state">Loading…</div></div>
        </div>
        <div class="home-card" id="homeQuickActions">
          <div class="home-card-title">Quick Actions</div>
          <div class="home-card-body"></div>
        </div>
        ${hasRole('manager') ? '<div class="home-card home-card-full" id="homePerformance"><div class="home-card-title">Performance</div><div class="home-card-body"><div class="empty-state">Loading...</div></div></div>' : ''}
        ${hasRole('administrator') ? '<div class="home-card home-card-full" id="homeUsers"><div class="home-card-title">User Status</div><div class="home-card-body"><div class="empty-state">Loading...</div></div></div>' : ''}
      </div>
    </div>`;

  // Greeting
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const greetEl = document.getElementById('homeGreeting');
  if (greetEl) {
    greetEl.innerHTML = `<span class="home-greeting-text">${greeting}, ${state.user.fullName.split(' ')[0]}</span>
      <span class="home-greeting-date">${new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' })}</span>`;
  }
}

function renderHomeActiveJobs(timers) {
  const card = document.getElementById('homeActiveJobs');
  if (!card) return;
  const body = card.querySelector('.home-card-body');
  body.innerHTML = '';

  const titleEl = card.querySelector('.home-card-title');
  if (titleEl) titleEl.textContent = `Active Jobs  (${timers.length})`;

  if (!timers.length) {
    body.appendChild(el('div', { className: 'empty-state', textContent: 'No jobs currently running.' }));
    return;
  }

  // Sort overdue first, then by elapsed desc
  const now = Date.now();
  timers.sort((a, b) => {
    const elA = now - new Date(a.startedAt).getTime();
    const elB = now - new Date(b.startedAt).getTime();
    const overdueA = a.targetSeconds ? elA / 1000 > a.targetSeconds : elA > 4 * 3600000;
    const overdueB = b.targetSeconds ? elB / 1000 > b.targetSeconds : elB > 4 * 3600000;
    if (overdueA !== overdueB) return overdueA ? -1 : 1;
    return elB - elA;
  });

  const grid = el('div', { className: 'home-active-grid' });

  timers.forEach(t => {
    // Use server-calculated net elapsed (excludes all paused time) — same
    // source as the wallboard and timer screen so all three stay in sync.
    // Fall back to local calc if the field is missing.
    const referenceMs = t.isPaused && t.pausedAt
      ? new Date(t.pausedAt).getTime()
      : now;
    const localEl = Math.max(0, Math.floor((referenceMs - new Date(t.startedAt).getTime()) / 1000)) - (t.totalPausedSeconds || 0);
    const elapsed  = t.netElapsedSeconds != null ? t.netElapsedSeconds : localEl;

    const isOver    = t.targetSeconds ? elapsed >= t.targetSeconds : elapsed > 4 * 3600;
    const isWarning = !isOver && (t.targetSeconds ? elapsed / t.targetSeconds >= 0.8 : elapsed > 2 * 3600);

    const row = el('div', { className: 'home-active-row' + (isOver ? ' over' : isWarning ? ' warn' : '') + (t.handRaised ? ' hand-raised' : '') });

    // Status dot
    row.appendChild(el('span', { className: 'home-active-dot' + (isOver ? ' dot-red' : isWarning ? ' dot-amber' : ' dot-green') }));

    // Operator + item
    const info = el('div', { className: 'home-active-info' });
    const nameText = t.operatorName + (t.handRaised ? ' ✋' : '');
    info.appendChild(el('span', { className: 'home-active-name', textContent: nameText }));
    info.appendChild(el('span', { className: 'home-active-item', textContent: t.itemNumber }));
    if (t.workstation) info.appendChild(el('span', { className: 'home-active-ws', textContent: '🖥 ' + t.workstation }));
    row.appendChild(info);

    // Elapsed + target
    const timeInfo = el('div', { className: 'home-active-time' });
    timeInfo.appendChild(el('span', {
      className: 'home-active-elapsed' + (isOver ? ' text-red' : isWarning ? ' text-amber' : ''),
      textContent: formatDuration(elapsed),
    }));
    if (t.targetSeconds) {
      const remaining = t.targetSeconds - elapsed;
      timeInfo.appendChild(el('span', {
        className: 'home-active-target' + (isOver ? ' text-red' : ''),
        textContent: isOver
          ? '⚠ ' + formatHM(Math.abs(remaining)) + ' overdue'
          : '🎯 ' + formatHM(remaining) + ' left',
      }));
    }
    row.appendChild(timeInfo);

    // Message button (supervisor+)
    if (hasRole('supervisor')) {
      const msgBtn = el('button', {
        className: 'btn btn-ghost btn-sm home-msg-btn',
        textContent: '✉',
        title: 'Message ' + t.operatorName,
        onclick: () => openSendMessageModal(t.operatorId, t.operatorName),
      });
      row.appendChild(msgBtn);
    }

    grid.appendChild(row);
  });

  body.appendChild(grid);
}

function renderHomeTodayStats(stats) {
  const card = document.getElementById('homeTodayStats');
  if (!card) return;
  const body = card.querySelector('.home-card-body');
  body.innerHTML = '';
  if (!stats) {
    body.appendChild(el('div', { className: 'empty-state', textContent: 'Could not load stats.' }));
    return;
  }
  const items = [
    { icon: '▶', label: 'Active Now',    value: stats.activeCount, cls: 'stat-active' },
    { icon: '✓', label: 'Completed Today', value: stats.total24h,  cls: 'stat-done'   },
    { icon: '📅', label: 'This Week',     value: stats.total7d,    cls: ''             },
    { icon: '📦', label: 'Item Types',    value: stats.byItem?.length || 0, cls: '' },
  ];
  const grid = el('div', { className: 'home-stats-grid' });
  items.forEach(s => {
    const item = el('div', { className: 'home-stat-item' });
    item.appendChild(el('div', { className: 'home-stat-icon ' + s.cls, textContent: s.icon }));
    item.appendChild(el('div', { className: 'home-stat-value', textContent: s.value }));
    item.appendChild(el('div', { className: 'home-stat-label', textContent: s.label }));
    grid.appendChild(item);
  });
  body.appendChild(grid);
}

function renderHomePerformance(stats) {
  const card = document.getElementById('homePerformance');
  if (!card || !stats || !stats.byItem || !stats.byItem.length) {
    if (card) card.querySelector('.home-card-body').innerHTML =
      '<div class="empty-state">No completed jobs today.</div>';
    return;
  }
  const body = card.querySelector('.home-card-body');
  body.innerHTML = '';

  // Show top 10 by count, with target delta
  const rows = stats.byItem.slice(0, 10);
  const table = el('table', { className: 'home-perf-table' });
  const thead = el('thead', {}, el('tr', {},
    el('th', { textContent: 'Item' }),
    el('th', { textContent: 'Jobs' }),
    el('th', { textContent: 'Avg Time' }),
    el('th', { textContent: 'Target' }),
    el('th', { textContent: 'Delta' }),
  ));
  const tbody = el('tbody', {});
  rows.forEach(r => {
    const hasTarget = r.target_seconds != null;
    const delta     = hasTarget ? Math.round(r.avg_seconds) - r.target_seconds : null;
    const tr = el('tr', {},
      el('td', { className: 'perf-item', textContent: r.item_number }),
      el('td', { textContent: r.count }),
      el('td', { textContent: formatDuration(Math.round(r.avg_seconds)) }),
      el('td', { textContent: hasTarget ? formatHM(r.target_seconds) : '—', className: hasTarget ? '' : 'dash-no-target' }),
    );
    const deltaCell = el('td', {
      textContent: delta === null ? '—' : (delta >= 0 ? '+' : '') + formatDuration(Math.abs(delta)),
      className:   delta === null ? 'dash-no-target' : delta > 0 ? 'dash-over' : 'dash-under',
    });
    tr.appendChild(deltaCell);
    tbody.appendChild(tr);
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  body.appendChild(table);

  // Export shortcut
  const exportBtn = el('button', {
    className: 'btn btn-ghost btn-sm',
    textContent: '\u2b07 Export Today CSV',
    style: 'margin-top:12px;',
    onclick: () => {
      const today = new Date(); today.setHours(0,0,0,0);
      window.location.href = `/api/export/csv?from=${today.toISOString()}`;
    },
  });
  body.appendChild(exportBtn);
}

function renderHomeUsers(users) {
  const card = document.getElementById('homeUsers');
  if (!card || !users.length) return;
  const body = card.querySelector('.home-card-body');
  body.innerHTML = '';

  const active   = users.filter(u => u.isActive);
  const disabled = users.filter(u => !u.isActive);
  const need2fa  = active.filter(u => ['manager','administrator'].includes(u.role) && !u.totpEnabled);

  const summary = el('div', { className: 'home-user-summary' });
  [
    { label: 'Active Accounts',  value: active.length,   cls: '' },
    { label: 'Disabled',         value: disabled.length, cls: disabled.length ? 'text-amber' : '' },
    { label: '2FA Not Configured', value: need2fa.length, cls: need2fa.length ? 'text-red' : 'text-green' },
  ].forEach(s => {
    const item = el('div', { className: 'home-user-stat' });
    item.appendChild(el('span', { className: 'home-user-stat-val ' + s.cls, textContent: s.value }));
    item.appendChild(el('span', { className: 'home-user-stat-lbl', textContent: s.label }));
    summary.appendChild(item);
  });
  body.appendChild(summary);

  if (need2fa.length) {
    const warn = el('div', { className: 'home-2fa-warn' });
    warn.appendChild(el('span', { textContent: '⚠ Users without 2FA: ' }));
    warn.appendChild(el('span', { textContent: need2fa.map(u => u.fullName).join(', '), style: 'font-weight:600;' }));
    body.appendChild(warn);
  }
}

function renderHomeQuickActions() {
  const card = document.getElementById('homeQuickActions');
  if (!card) return;
  const body = card.querySelector('.home-card-body');
  body.innerHTML = '';

  const actions = [
    { label: '📋 Wall Board',       page: 'wallboard',  role: 'supervisor'    },
    { label: '📺 Compact Board',    page: 'wallboardc', role: 'supervisor'    },
    { label: '📊 Dashboard',        page: 'dashboard',  role: 'manager'       },
    { label: '📈 Reports',          page: 'reports',    role: 'manager'       },
    { label: '🎯 Target Times',     page: 'targets',    role: 'manager'       },
    { label: '🕐 History',          page: 'history',    role: 'operator'      },
    { label: '👥 User Management',  page: 'admin',      role: 'administrator' },
  ];

  actions
    .filter(a => hasRole(a.role))
    .forEach(a => {
      const btn = el('button', {
        className: 'home-action-btn',
        textContent: a.label,
        onclick: () => { navigateTo(a.page); closeNav(); },
      });
      body.appendChild(btn);
    });
}

/* ═══════════════════════════════════════════════════════════════════════════
   WALL BOARD — COMPACT MODE
   Designed for a large shopfloor TV. Maximum tiles, minimum clutter.
   Shows: operator name, item number, elapsed time counter.
   Colour: smart target-relative (green / amber / red) same as main wallboard.
   No message button, no detail — just the essential status at a glance.
   ═══════════════════════════════════════════════════════════════════════════ */

async function loadWallboardCompact() {
  if (wallboardCInterval) clearInterval(wallboardCInterval);
  await refreshWallboardCompact();
  wallboardCInterval = setInterval(() => {
    if (document.visibilityState === 'visible') refreshWallboardCompact();
  }, 300000);
}

async function refreshWallboardCompact() {
  const container = document.getElementById('wallboardCTiles');
  const countEl   = document.getElementById('wallboardCCount');
  const updatedEl = document.getElementById('wallboardCUpdated');
  if (!container) return;
  try {
    const [timers, onlineData] = await Promise.all([
      GET('/timers?status=active&limit=200'),
      GET('/messages/online').catch(() => ({ online: [] })),
    ]);
    const onlineSet = new Set(onlineData.online || []);
    if (countEl)   countEl.textContent   = timers.length + ' active job' + (timers.length !== 1 ? 's' : '');
    if (updatedEl) updatedEl.textContent = 'Updated ' + new Date().toLocaleTimeString('en-GB');
    container.innerHTML = '';

    if (timers.length === 0) {
      container.appendChild(el('div', { className: 'wallboard-empty' },
        el('div', { className: 'wallboard-empty-icon', textContent: '✓' }),
        el('div', { className: 'wallboard-empty-text', textContent: 'No active jobs right now' })
      ));
      return;
    }

    timers.forEach(t => {
      const sNet    = t.netElapsedSeconds != null ? t.netElapsedSeconds : null;
      const localEl = Math.max(0, Math.floor((Date.now() - new Date(t.startedAt).getTime()) / 1000)) - (t.totalPausedSeconds || 0);
      const elapsed = sNet !== null ? sNet : localEl;
      const tile    = el('div', { className: 'wbc-tile' + (t.isPaused ? ' tile-paused' : '') + (t.handRaised ? ' tile-hand-raised' : '') });

      // Smart colour — paused = neutral; otherwise target-relative or fixed
      if (!t.isPaused) {
        if (t.targetSeconds) {
          const pct = elapsed / t.targetSeconds;
          if (pct >= 1.0)      tile.classList.add('tile-overdue');
          else if (pct >= 0.8) tile.classList.add('tile-warning');
        } else {
          if (elapsed > 4 * 3600)      tile.classList.add('tile-overdue');
          else if (elapsed > 2 * 3600) tile.classList.add('tile-warning');
        }
      }

      const opRow = el('div', { className: 'wb-operator-row' });
      opRow.appendChild(el('span', {
        className: 'presence-dot ' + (onlineSet.has(t.operatorId) ? 'online' : 'offline'),
        title: onlineSet.has(t.operatorId) ? 'Session active' : 'Not connected',
      }));
      opRow.appendChild(el('span', { textContent: t.operatorName }));
      tile.appendChild(opRow);
      tile.appendChild(el('div', { className: 'wbc-item',     textContent: t.itemNumber }));
      if (t.isPaused) {
        tile.appendChild(el('div', { className: 'wbc-paused-tag', textContent: '⏸' }));
      }
      if (t.handRaised) {
        tile.appendChild(el('div', { className: 'wbc-hand-tag', textContent: '✋' }));
      }
      tile.appendChild(el('div', {
        className: 'wbc-elapsed',
        textContent: formatDuration(elapsed),
        'data-startedat':       t.startedAt,
        'data-targetseconds':   t.targetSeconds ? String(t.targetSeconds) : '',
        'data-pausedseconds':   String(t.totalPausedSeconds || 0),
        'data-ispaused':        t.isPaused ? '1' : '0',
      }));

      container.appendChild(tile);
    });

    startWallboardCompactTick();
  } catch (err) {
    container.innerHTML = '';
    container.appendChild(el('div', { className: 'wallboard-empty',
      textContent: 'Could not load timers: ' + err.message }));
  }
}

function startWallboardCompactTick() {
  if (wallboardCTick) clearInterval(wallboardCTick);
  wallboardCTick = setInterval(() => {
    if (state.currentPage !== 'wallboardc') {
      clearInterval(wallboardCTick); wallboardCTick = null; return;
    }
    document.querySelectorAll('.wbc-elapsed[data-startedat]').forEach(node => {
      const startedAt  = node.getAttribute('data-startedat');
      const pausedSecs = parseInt(node.getAttribute('data-pausedseconds') || '0', 10);
      const isPaused   = node.getAttribute('data-ispaused') === '1';
      if (!startedAt) return;

      // Paused tiles: clock is frozen, don't increment
      if (isPaused) return;

      const rawElapsed = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
      const elapsed    = Math.max(0, rawElapsed - pausedSecs);
      node.textContent = formatDuration(elapsed);

      const tile = node.closest('.wbc-tile');
      if (!tile) return;
      tile.classList.remove('tile-warning', 'tile-overdue');
      const tgt = parseInt(node.getAttribute('data-targetseconds'), 10) || 0;
      if (tgt) {
        const pct = elapsed / tgt;
        if (pct >= 1.0)      tile.classList.add('tile-overdue');
        else if (pct >= 0.8) tile.classList.add('tile-warning');
      } else {
        if (elapsed > 4 * 3600)      tile.classList.add('tile-overdue');
        else if (elapsed > 2 * 3600) tile.classList.add('tile-warning');
      }
    });
  }, 1000);
}

// Resume immediately when hidden tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (state.currentPage === 'wallboardc' && document.visibilityState === 'visible') {
    refreshWallboardCompact();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   REAL-TIME MESSAGING  (SSE + Chat Drawer)
   All users connect via SSE. Supervisors start conversations, operators
   reply. Either side can continue the thread until the supervisor closes it.
   ═══════════════════════════════════════════════════════════════════════════ */

let _messageStream = null;

function connectMessageStream() {
  if (_messageStream) return;
  try {
    _messageStream = new EventSource('/api/messages/listen', { withCredentials: true });
    _messageStream.addEventListener('message', e => {
      try { handleIncomingSSE(JSON.parse(e.data)); } catch (_) {}
    });
    _messageStream.addEventListener('error', () => {
      disconnectMessageStream();
      setTimeout(() => { if (state.user) connectMessageStream(); }, 10000);
    });
  } catch (_) {}
}
function disconnectMessageStream() {
  if (_messageStream) { _messageStream.close(); _messageStream = null; }
}

// Route incoming SSE payloads to the right handler
function handleIncomingSSE(data) {
  if (!data || !data.type) return;
  switch (data.type) {
    case 'message':
      // New conversation — always opens the drawer
      openChatDrawer(data);
      break;
    case 'reply':
      // If the drawer is closed but conversation matches, reopen it
      if (chatDrawer.hidden && data.conversationId === chat.conversationId) {
        chatDrawer.hidden        = false;
        chatDrawer.style.display = '';
        chatOverlay.hidden       = false;
      }
      appendChatMessage(data);
      break;
    case 'close':
      handleConversationClosed(data);
      break;
  }
  playPing(data.type);
}

/* ─── Chat Drawer ─────────────────────────────────────────────────────────── */

// Conversation state — one active conversation at a time per session
const chat = {
  conversationId: null,
  isSupervisor:   false,  // true = supervisor side (they initiated)
  otherName:      null,
  otherRole:      null,
};

const chatDrawer  = document.getElementById('chatDrawer');
const chatOverlay = document.getElementById('chatOverlay');
const chatMessages= document.getElementById('chatMessages');
const chatInput   = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const chatClose   = document.getElementById('chatCloseBtn');
const chatCharCount = document.getElementById('chatCharCount');
const chatHeaderName= document.getElementById('chatHeaderName');
const chatHeaderSub = document.getElementById('chatHeaderSub');

function openChatDrawer(data) {
  console.log('[chat] openChatDrawer called, type=', data.type, 'convId=', data.conversationId, 'isSupervisor=', hasRole('supervisor'));
  // Called on the operator side when a supervisor sends them a message,
  // or on the supervisor side when they tap Message on the wallboard.
  chat.conversationId = data.conversationId;
  chat.isSupervisor   = hasRole('supervisor');
  chat.otherName      = chat.isSupervisor ? data.to : data.from;
  chat.otherRole      = chat.isSupervisor ? 'operator' : data.fromRole;

  chatHeaderName.textContent = chat.otherName;
  chatHeaderSub.textContent  = chat.isSupervisor
    ? 'Tap \u2715 to close the conversation'
    : 'Reply below \u2014 your supervisor can see this';

  chatMessages.innerHTML = '';

  // Add the opening message
  appendChatMessage(data, true);

  chatDrawer.hidden  = false;
  chatDrawer.style.display = '';  // clear any force-hide from closeChatDrawer
  chatOverlay.hidden = false;
  chatInput.value    = '';
  chatCharCount.textContent = '0 / 500';
  setTimeout(() => chatInput.focus(), 80);
}

function appendChatMessage(data, isOpening = false) {
  // Never reopen the drawer from here — only openChatDrawer() does that.
  // If the drawer is closed and this isn't the opening message, discard.
  if (chatDrawer.hidden && !isOpening) return;

  if (data.conversationId && data.conversationId !== chat.conversationId) return;

  const isMine = data.fromId === state.user.id;
  const bubble = el('div', { className: 'chat-bubble-wrap' + (isMine ? ' mine' : ' theirs') });
  const bbl    = el('div', { className: 'chat-bubble' + (isMine ? ' mine' : ' theirs') });
  bbl.appendChild(el('div', { className: 'chat-bubble-text', textContent: data.message }));
  bbl.appendChild(el('div', { className: 'chat-bubble-time',
    textContent: new Date(data.sentAt).toLocaleTimeString('en-GB',
      { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) }));
  bubble.appendChild(bbl);
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Pulse the drawer header if it was already open and not the opening message
  if (!isOpening && !isMine) {
    chatDrawer.classList.add('chat-pulse');
    setTimeout(() => chatDrawer.classList.remove('chat-pulse'), 600);
  }
}

function handleConversationClosed(data) {
  if (data.conversationId !== chat.conversationId) return;
  const sys = el('div', { className: 'chat-system-msg',
    textContent: data.closedBy + ' closed the conversation.' });
  chatMessages.appendChild(sys);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  chatInput.disabled    = true;
  chatSendBtn.disabled  = true;
  // Give the operator a moment to read the closure message, then dismiss
  setTimeout(() => {
    chat.conversationId = null; // clear before close so no signal is sent back
    closeChatDrawer(false);
  }, 2500);
}

function closeChatDrawer(sendCloseSignal = true) {
  console.log('[chat] closeChatDrawer called, isSupervisor=', chat.isSupervisor, 'convId=', chat.conversationId);
  // Close the UI immediately — never let the server call block this
  chatDrawer.hidden    = true;
  chatOverlay.hidden   = true;
  chatDrawer.removeAttribute('hidden');   // belt-and-braces: set AND remove attr
  chatDrawer.setAttribute('hidden', '');  // some browsers treat hidden attr differently
  chatDrawer.style.display = 'none';      // nuclear option — force hide via style
  chatInput.disabled   = false;
  chatSendBtn.disabled = false;
  chatMessages.innerHTML = '';
  console.log('[chat] after close: chatDrawer.hidden=', chatDrawer.hidden, 'display=', chatDrawer.style.display);

  // Fire-and-forget the close signal so the operator side gets notified
  if (sendCloseSignal && chat.isSupervisor && chat.conversationId) {
    POST('/messages/close', { conversationId: chat.conversationId }).catch(() => {});
  }

  chat.conversationId = null;
  chat.isSupervisor   = false;
  chat.otherName      = null;
}

async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || !chat.conversationId) return;
  chatSendBtn.disabled = true;

  try {
    let result;
    if (chat.isSupervisor && !chatMessages.children.length) {
      // Should not happen — supervisor always opens via openSendMessageModal
      throw new Error('No active conversation.');
    } else {
      // Ongoing reply from either side
      result = await POST('/messages/reply', {
        conversationId: chat.conversationId,
        message: text,
      });
    }

    if (!result.delivered) {
      toast(chat.otherName + ' is no longer connected \u2014 message not delivered.', '');
    }

    // Append own message immediately (optimistic)
    appendChatMessage({
      conversationId: chat.conversationId,
      from:     state.user.fullName,
      fromId:   state.user.id,
      fromRole: state.user.role,
      message:  text,
      sentAt:   new Date().toISOString(),
    });

    chatInput.value = '';
    chatCharCount.textContent = '0 / 500';
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    chatSendBtn.disabled = false;
    chatInput.focus();
  }
}

// Wire up drawer controls
chatSendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChatMessage(); }
});
chatInput.addEventListener('input', () => {
  chatCharCount.textContent = chatInput.value.length + ' / 500';
});
chatClose.addEventListener('click', () => closeChatDrawer(true));
chatOverlay.addEventListener('click', () => {
  // Operators: clicking overlay dismisses without sending a close signal
  // Supervisors: clicking overlay does NOT close — they must use the X button
  // to ensure they deliberately end the conversation
  if (!chat.isSupervisor) closeChatDrawer(false);
});

// ── openSendMessageModal → now opens the chat drawer ─────────────────────────
async function openSendMessageModal(operatorId, operatorName) {
  const body    = el('div', {});
  const msgArea = el('textarea', {
    id:          'initMsgText',
    placeholder: 'Type your opening message\u2026',
    maxlength:   '500',
    rows:        '4',
    style:       'width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:15px;padding:12px;resize:vertical;font-family:var(--font-body);',
  });
  body.appendChild(el('p', { textContent: 'Start a conversation with ' + operatorName + '. You can continue chatting until you close the conversation.',
    style: 'margin-bottom:14px;font-size:14px;color:var(--text2);' }));
  body.appendChild(msgArea);
  const charCount = el('div', { style: 'font-size:11px;color:var(--text3);text-align:right;margin-top:4px;', textContent: '0 / 500' });
  msgArea.addEventListener('input', () => { charCount.textContent = msgArea.value.length + ' / 500'; });
  body.appendChild(charCount);
  const errDiv = el('div', { className: 'error-msg', role: 'alert' }); body.appendChild(errDiv);

  const btnSend   = el('button', { className: 'btn btn-primary', textContent: '\uD83D\uDCAC Start Conversation' });
  const btnCancel = el('button', { className: 'btn btn-ghost',   textContent: 'Cancel' });
  btnCancel.addEventListener('click', closeModal);
  btnSend.addEventListener('click', async () => {
    const message = msgArea.value.trim();
    if (!message) { errDiv.textContent = 'Please type a message.'; return; }
    btnSend.disabled = true; btnSend.textContent = 'Starting\u2026';
    try {
      const result = await POST('/messages/send', { operatorId, message });
      closeModal();
      if (result.delivered) {
        // Open the chat drawer on the supervisor side
        chat.conversationId = result.conversationId;
        chat.isSupervisor   = true;
        chat.otherName      = operatorName;
        chatHeaderName.textContent = operatorName;
        chatHeaderSub.textContent  = 'Tap \u2715 to close the conversation';
        chatMessages.innerHTML = '';
        // Append the opening message as mine
        appendChatMessage({
          conversationId: result.conversationId,
          from:    state.user.fullName,
          fromId:  state.user.id,
          fromRole:state.user.role,
          message,
          sentAt:  new Date().toISOString(),
        }, true);
        chatDrawer.hidden  = false;
        chatDrawer.style.display = '';
        chatOverlay.hidden = false;
        setTimeout(() => chatInput.focus(), 80);
      } else {
        toast(operatorName + ' is not currently logged in \u2014 message not delivered.', '');
      }
    } catch (err) {
      errDiv.textContent = err.message;
      btnSend.disabled = false; btnSend.textContent = '\uD83D\uDCAC Start Conversation';
    }
  });
  msgArea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) btnSend.click();
  });
  openModal('Message ' + operatorName, body, [btnCancel, btnSend]);
  setTimeout(() => msgArea.focus(), 50);
}

function playPing(type) {
  try {
    const actx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc   = actx.createOscillator();
    const gain  = actx.createGain();
    osc.connect(gain); gain.connect(actx.destination);
    osc.frequency.value = type === 'reply' ? 660 : 880;
    gain.gain.setValueAtTime(0.12, actx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.4);
    osc.start(actx.currentTime);
    osc.stop(actx.currentTime + 0.4);
  } catch (_) {}
}



/* ═══════════════════════════════════════════════════════════════════════════
   REPORTS PAGE  (Manager / Administrator)
   ═══════════════════════════════════════════════════════════════════════════ */

// Chart instances — destroyed and recreated on each report run
const _charts = {};
function destroyChart(key) {
  if (_charts[key]) { _charts[key].destroy(); delete _charts[key]; }
}
const C = {
  green: '#38a169', red: '#e53e3e', amber: '#d97706',
  blue: '#4299e1', grid: 'rgba(255,255,255,0.07)', text: '#a0aec0',
};
const CFONT = { family: "'Barlow', sans-serif", size: 12 };

function loadReportsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const ago30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (!document.getElementById('reportFrom').value) {
    document.getElementById('reportFrom').value = ago30;
    document.getElementById('reportTo').value   = today;
  }
  runReport();
}

document.getElementById('btnReportSearch').addEventListener('click', runReport);

document.getElementById('btnReportExportCSV').addEventListener('click', () => {
  const from = document.getElementById('reportFrom').value;
  const to   = document.getElementById('reportTo').value;
  const params = new URLSearchParams();
  if (from) params.set('from', new Date(from).toISOString());
  if (to)   { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  window.location.href = `/api/export/report/csv?${params}`;
});

async function runReport() {
  const from = document.getElementById('reportFrom').value;
  const to   = document.getElementById('reportTo').value;
  const params = new URLSearchParams();
  if (from) params.set('from', new Date(from).toISOString());
  if (to)   { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  const qs = params.toString();

  ['reportStatCards','reportItemTable','reportOperatorTable','reportTrendTable','reportOverdueGrid']
    .forEach(id => { const n = document.getElementById(id); if (n) n.innerHTML = '<div class="empty-state">Loading\u2026</div>'; });

  // Reset all tabs back to chart view
  [['trendChart','trendTable'],['itemChart','itemTable'],['operatorChart','operatorTable']].forEach(([show,hide]) => {
    const showEl = document.getElementById(show), hideEl = document.getElementById(hide);
    if (showEl) showEl.hidden = false;
    if (hideEl) hideEl.hidden = true;
  });
  document.querySelectorAll('.report-tab').forEach((t,i) => {
    t.classList.toggle('active', i % 2 === 0);
  });

  const [stats, operators, trends, overdue] = await Promise.all([
    GET(`/export/stats?${qs}`).catch(() => null),
    GET(`/export/report/operators?${qs}`).catch(() => []),
    GET(`/export/report/trends?${qs}`).catch(() => []),
    GET(`/export/report/overdue?${qs}`).catch(() => ({ byItem: [], byOperator: [] })),
  ]);

  renderReportStatCards(stats);
  _lastTrends    = trends;
  _lastByItem    = stats?.byItem || [];
  _lastOperators = operators;
  renderReportTrendTable(trends);
  renderReportItemTable(stats?.byItem || []);
  renderReportOperatorTable(operators);
  renderReportOverdue(overdue);

  // Defer chart rendering until after the DOM has painted —
  // canvas elements need to be visible with real dimensions first
  requestAnimationFrame(() => {
    setTimeout(() => {
      renderChartDailyTrend(trends);
      renderChartItemOnTime(stats?.byItem || []);
      renderChartOperator(operators);
    }, 50);
  });
}

function switchReportTab(btn, showId, hideId) {
  // Update button states
  const tabs = btn.closest('.report-tabs').querySelectorAll('.report-tab');
  tabs.forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  // Show/hide panels
  document.getElementById(showId).hidden = false;
  document.getElementById(hideId).hidden = true;
  // If switching to a chart panel, redraw — canvas may have been zero-sized when hidden
  const canvasMap = {
    trendChart:    () => renderChartDailyTrend(_lastTrends),
    itemChart:     () => renderChartItemOnTime(_lastByItem),
    operatorChart: () => renderChartOperator(_lastOperators),
  };
  if (canvasMap[showId]) {
    requestAnimationFrame(() => setTimeout(canvasMap[showId], 30));
  }
}

// Cache last data so tabs can redraw charts on demand
let _lastTrends = [], _lastByItem = [], _lastOperators = [];



function renderChartDailyTrend(rows) {
  destroyChart('dailyTrend');
  const canvas = document.getElementById('chartDailyTrend');
  if (!canvas || !rows.length) return;
  const labels  = rows.map(r => new Date(r.day).toLocaleDateString('en-GB', { day:'2-digit', month:'short' }));
  const jobs    = rows.map(r => r.jobs_completed);
  const overdue = rows.map(r => r.overdue_count);
  const avgMins = rows.map(r => r.avg_seconds ? +(r.avg_seconds / 60).toFixed(1) : 0);
  _charts.dailyTrend = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Jobs Completed', data: jobs, backgroundColor: C.blue, borderRadius: 4, yAxisID: 'yJobs' },
        { label: 'Over Target',    data: overdue, backgroundColor: C.red, borderRadius: 4, yAxisID: 'yJobs' },
        { label: 'Avg Time (mins)', data: avgMins, type: 'line', borderColor: C.amber,
          backgroundColor: 'transparent', pointBackgroundColor: C.amber, pointRadius: 3, tension: 0.3, yAxisID: 'yMins' },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: C.text, font: CFONT } } },
      scales: {
        x:     { ticks: { color: C.text, font: CFONT }, grid: { color: C.grid } },
        yJobs: { ticks: { color: C.text, font: CFONT }, grid: { color: C.grid }, beginAtZero: true,
                 title: { display: true, text: 'Jobs', color: C.text, font: CFONT } },
        yMins: { position: 'right', ticks: { color: C.amber, font: CFONT }, grid: { drawOnChartArea: false },
                 beginAtZero: true, title: { display: true, text: 'Avg Mins', color: C.amber, font: CFONT } },
      },
    },
  });
}

function renderChartItemOnTime(rows) {
  destroyChart('itemOnTime');
  const canvas = document.getElementById('chartItemOnTime');
  if (!canvas) return;
  const withTarget = rows.filter(r => r.target_seconds).slice(0, 12);
  if (!withTarget.length) { canvas.closest('.report-chart-wrap').style.display='none'; return; }
  canvas.closest('.report-chart-wrap').style.display='';
  const labels  = withTarget.map(r => r.item_number);
  const over    = withTarget.map(r => Math.round(r.avg_seconds) > r.target_seconds ? r.count : 0);
  const onTime  = withTarget.map((r, i) => r.count - over[i]);
  _charts.itemOnTime = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'On Time',     data: onTime, backgroundColor: C.green, borderRadius: 4 },
        { label: 'Over Target', data: over,   backgroundColor: C.red,   borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: C.text, font: CFONT } }, tooltip: { mode: 'index', intersect: false } },
      scales: {
        x: { stacked: true, ticks: { color: C.text, font: CFONT }, grid: { color: C.grid } },
        y: { stacked: true, ticks: { color: C.text, font: CFONT }, grid: { color: C.grid }, beginAtZero: true,
             title: { display: true, text: 'Jobs', color: C.text, font: CFONT } },
      },
    },
  });
}

function renderChartOperator(rows) {
  destroyChart('operator');
  const canvas = document.getElementById('chartOperator');
  if (!canvas || !rows.length) return;
  const labels  = rows.map(r => r.operator_name.split(' ')[0]);
  const jobs    = rows.map(r => r.jobs_completed);
  const overdue = rows.map(r => r.overdue_count);
  const avgMins = rows.map(r => r.avg_seconds ? +(r.avg_seconds / 60).toFixed(1) : 0);
  _charts.operator = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Jobs Completed', data: jobs,    backgroundColor: C.blue, borderRadius: 4, yAxisID: 'yJobs' },
        { label: 'Over Target',    data: overdue, backgroundColor: C.red,  borderRadius: 4, yAxisID: 'yJobs' },
        { label: 'Avg Time (mins)', data: avgMins, type: 'line', borderColor: C.amber,
          backgroundColor: 'transparent', pointBackgroundColor: C.amber, pointRadius: 4, yAxisID: 'yMins' },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: C.text, font: CFONT } } },
      scales: {
        x:     { ticks: { color: C.text, font: CFONT }, grid: { color: C.grid } },
        yJobs: { ticks: { color: C.text, font: CFONT }, grid: { color: C.grid }, beginAtZero: true,
                 title: { display: true, text: 'Jobs', color: C.text, font: CFONT } },
        yMins: { position: 'right', ticks: { color: C.amber, font: CFONT }, grid: { drawOnChartArea: false },
                 beginAtZero: true, title: { display: true, text: 'Avg Mins', color: C.amber, font: CFONT } },
      },
    },
  });
}

/* ── Tables ──────────────────────────────────────────────────────────────── */

function renderReportStatCards(stats) {
  const container = document.getElementById('reportStatCards');
  container.innerHTML = '';
  if (!stats) return;
  const byItem = stats.byItem || [];
  const totalJobs = byItem.reduce((s, r) => s + r.count, 0);
  const withTarget = byItem.filter(r => r.target_seconds);
  const overdueItems = withTarget.filter(r => Math.round(r.avg_seconds) > r.target_seconds);
  const onTimeRate = withTarget.length
    ? Math.round(((withTarget.length - overdueItems.length) / withTarget.length) * 100) : null;
  [
    { label: 'Jobs Completed',    value: totalJobs },
    { label: 'Item Types',        value: byItem.length },
    { label: 'On-Time Rate',      value: onTimeRate != null ? onTimeRate + '%' : '\u2014' },
    { label: 'Items Over Target', value: overdueItems.length },
  ].forEach(c => {
    container.appendChild(el('div', { className: 'stat-card' },
      el('div', { className: 'stat-label', textContent: c.label }),
      el('div', { className: 'stat-value', textContent: c.value })
    ));
  });
}

function renderReportItemTable(rows) {
  const wrap = document.getElementById('reportItemTable');
  wrap.innerHTML = '';
  if (!rows || !rows.length) {
    wrap.appendChild(el('div', { className: 'empty-state', textContent: 'No completed jobs in this period.' }));
    return;
  }
  const table = el('table');
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', { textContent: 'Item' }), el('th', { textContent: 'Jobs' }),
    el('th', { textContent: 'Avg Actual' }), el('th', { textContent: 'Min' }),
    el('th', { textContent: 'Max' }), el('th', { textContent: 'Target' }),
    el('th', { textContent: 'Avg Delta' }), el('th', { textContent: 'Status' }),
  )));
  const tbody = el('tbody', {});
  rows.forEach(r => {
    const hasTarget = r.target_seconds != null;
    const delta = hasTarget ? Math.round(r.avg_seconds) - r.target_seconds : null;
    tbody.appendChild(el('tr', {},
      el('td', { textContent: r.item_number, className: 'perf-item' }),
      el('td', { textContent: r.count }),
      el('td', { textContent: formatDuration(Math.round(r.avg_seconds)) }),
      el('td', { textContent: formatDuration(r.min_seconds) }),
      el('td', { textContent: formatDuration(r.max_seconds) }),
      el('td', { textContent: hasTarget ? formatHM(r.target_seconds) : '\u2014', className: hasTarget ? '' : 'dash-no-target' }),
      el('td', { textContent: delta == null ? '\u2014' : (delta >= 0 ? '+' : '') + formatDuration(Math.abs(delta)), className: delta == null ? 'dash-no-target' : delta > 0 ? 'dash-over' : 'dash-under' }),
      el('td', { textContent: delta == null ? '\u2014' : delta > 0 ? '\u26a0 Over' : '\u2713 On time', className: delta == null ? '' : delta > 0 ? 'dash-over' : 'dash-under' }),
    ));
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
}

function renderReportOperatorTable(rows) {
  const wrap = document.getElementById('reportOperatorTable');
  wrap.innerHTML = '';
  if (!rows || !rows.length) {
    wrap.appendChild(el('div', { className: 'empty-state', textContent: 'No data for this period.' }));
    return;
  }
  const table = el('table');
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', { textContent: 'Operator' }), el('th', { textContent: 'Jobs' }),
    el('th', { textContent: 'Avg Time' }), el('th', { textContent: 'Fastest' }),
    el('th', { textContent: 'Slowest' }), el('th', { textContent: 'Over Target' }),
    el('th', { textContent: 'Time Checks' }),
  )));
  const tbody = el('tbody', {});
  rows.forEach(r => {
    const overduePct = r.jobs_completed > 0 ? Math.round((r.overdue_count / r.jobs_completed) * 100) : 0;
    tbody.appendChild(el('tr', {},
      el('td', { textContent: r.operator_name, className: 'perf-item' }),
      el('td', { textContent: r.jobs_completed }),
      el('td', { textContent: formatDuration(r.avg_seconds) }),
      el('td', { textContent: formatDuration(r.min_seconds) }),
      el('td', { textContent: formatDuration(r.max_seconds) }),
      el('td', { textContent: r.overdue_count + (overduePct ? ` (${overduePct}%)` : ''), className: r.overdue_count > 0 ? 'dash-over' : '' }),
      el('td', { textContent: r.time_check_count }),
    ));
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
}

function renderReportTrendTable(rows) {
  const wrap = document.getElementById('reportTrendTable');
  wrap.innerHTML = '';
  if (!rows || !rows.length) {
    wrap.appendChild(el('div', { className: 'empty-state', textContent: 'No data for this period.' }));
    return;
  }
  const table = el('table');
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', { textContent: 'Date' }), el('th', { textContent: 'Jobs Completed' }),
    el('th', { textContent: 'Avg Time' }), el('th', { textContent: 'Over Target' }),
  )));
  const tbody = el('tbody', {});
  [...rows].reverse().forEach(r => {
    const date = new Date(r.day).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    tbody.appendChild(el('tr', {},
      el('td', { textContent: date }),
      el('td', { textContent: r.jobs_completed }),
      el('td', { textContent: r.avg_seconds ? formatDuration(r.avg_seconds) : '\u2014' }),
      el('td', { textContent: r.overdue_count, className: r.overdue_count > 0 ? 'dash-over' : '' }),
    ));
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
}

function renderReportOverdue(overdue) {
  const grid = document.getElementById('reportOverdueGrid');
  grid.innerHTML = '';

  const itemCard = el('div', { className: 'report-overdue-card' });
  itemCard.appendChild(el('div', { className: 'report-overdue-title', textContent: 'Most Overdue \u2014 by Item' }));
  if (!overdue.byItem || !overdue.byItem.length) {
    itemCard.appendChild(el('div', { className: 'empty-state', textContent: 'No overdue jobs in this period.' }));
  } else {
    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {},
      el('th', { textContent: 'Item' }), el('th', { textContent: 'Times Over' }),
      el('th', { textContent: 'Avg Overrun' }), el('th', { textContent: 'Worst Overrun' }),
    )));
    const tbody = el('tbody', {});
    overdue.byItem.forEach(r => {
      tbody.appendChild(el('tr', {},
        el('td', { textContent: r.item_number, className: 'perf-item' }),
        el('td', { textContent: r.overdue_count, className: 'dash-over' }),
        el('td', { textContent: '+' + formatDuration(r.avg_overrun_seconds) }),
        el('td', { textContent: '+' + formatDuration(r.max_overrun_seconds) }),
      ));
    });
    table.appendChild(tbody);
    itemCard.appendChild(table);
  }
  grid.appendChild(itemCard);

  const opCard = el('div', { className: 'report-overdue-card' });
  opCard.appendChild(el('div', { className: 'report-overdue-title', textContent: 'Most Overdue \u2014 by Operator' }));
  if (!overdue.byOperator || !overdue.byOperator.length) {
    opCard.appendChild(el('div', { className: 'empty-state', textContent: 'No overdue jobs in this period.' }));
  } else {
    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {},
      el('th', { textContent: 'Operator' }), el('th', { textContent: 'Times Over' }),
      el('th', { textContent: 'Avg Overrun' }),
    )));
    const tbody = el('tbody', {});
    overdue.byOperator.forEach(r => {
      tbody.appendChild(el('tr', {},
        el('td', { textContent: r.operator_name, className: 'perf-item' }),
        el('td', { textContent: r.overdue_count, className: 'dash-over' }),
        el('td', { textContent: '+' + formatDuration(r.avg_overrun_seconds) }),
      ));
    });
    table.appendChild(tbody);
    opCard.appendChild(table);
  }
  grid.appendChild(opCard);
}



init();