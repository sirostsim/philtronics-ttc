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
let wallboardInterval  = null; // kept for legacy — managed via _wbIntervals now
let wallboardTick      = null;
let wallboardCInterval = null;
let wallboardCTick     = null;

// Chat drawer state — declared here so onLoggedIn() can reset it on every login
const chat = {
  conversationId: null,
  isSupervisor:   false,
  otherName:      null,
  otherRole:      null,
};
const chatDrawer     = document.getElementById('chatDrawer');
const chatOverlay    = document.getElementById('chatOverlay');
// Force hidden immediately — belt and braces on top of the HTML hidden attribute
if (chatDrawer)  { chatDrawer.hidden  = true; chatDrawer.style.display  = 'none'; }
if (chatOverlay) { chatOverlay.hidden = true; }
const chatMessages   = document.getElementById('chatMessages');
const chatInput      = document.getElementById('chatInput');
const chatSendBtn    = document.getElementById('chatSendBtn');
const chatClose      = document.getElementById('chatCloseBtn');
const chatCharCount  = document.getElementById('chatCharCount');
const chatHeaderName = document.getElementById('chatHeaderName');
const chatHeaderSub  = document.getElementById('chatHeaderSub');

// Declared here to avoid temporal dead zone — hideSuggestions() is called
// from btnStart handler before the autocomplete section further down.
const itemInput = document.getElementById('itemNumberInput');
const sugList   = document.getElementById('itemSuggestions');

const ROLE_LEVEL = { operator: 1, supervisor: 2, manager: 3, administrator: 4, superuser: 5 };
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
const DEPARTMENTS = ['Production', 'Stores', 'Test and Inspection', 'PCB'];
const DEPT_SLUGS  = { 'Production': 'prod', 'Stores': 'stores', 'Test and Inspection': 'testinsp', 'PCB': 'pcb' };

const PAGES = {
  home:           { id: 'pageHome',             label: 'Home',                          minRole: 'supervisor'  },
  timer:          { id: 'pageTimer',             label: 'Timer',                         minRole: 'operator'    },
  history:        { id: 'pageHistory',           label: 'History',                       minRole: 'operator'    },
  // Department wallboards — shown/hidden based on role + department
  'wb-prod':   { id: 'page-production-wb',   label: '📋 Wall Board — Production',    minRole: 'supervisor', dept: 'Production'          },
  'wb-stores': { id: 'page-stores-wb',        label: '📋 Wall Board — Stores',        minRole: 'supervisor', dept: 'Stores'              },
  'wb-testinsp':{ id: 'page-testinsp-wb',     label: '📋 Wall Board — Test & Insp',   minRole: 'supervisor', dept: 'Test and Inspection' },
  'wbc-prod':  { id: 'page-production-wbc',   label: '📺 Compact — Production',       minRole: 'supervisor', dept: 'Production'          },
  'wbc-stores':{ id: 'page-stores-wbc',       label: '📺 Compact — Stores',           minRole: 'supervisor', dept: 'Stores'              },
  'wbc-testinsp':{ id: 'page-testinsp-wbc',   label: '📺 Compact — Test & Insp',      minRole: 'supervisor', dept: 'Test and Inspection' },
  'wb-pcb':      { id: 'page-pcb-wb',          label: '📋 Wall Board — PCB',           minRole: 'supervisor', dept: 'PCB'                },
  'wbc-pcb':     { id: 'page-pcb-wbc',         label: '📺 Compact — PCB',              minRole: 'supervisor', dept: 'PCB'                },
  dashboard:      { id: 'pageDashboard',         label: 'Dashboard',                     minRole: 'manager'     },
  targets:        { id: 'pageTargets',           label: 'Target Times',                  minRole: 'manager'     },
  reports:        { id: 'pageReports',           label: 'Reports',                       minRole: 'manager'     },
  charts:         { id: 'pageCharts',            label: 'Charts',                        minRole: 'manager'     },
  admin:          { id: 'pageAdmin',             label: 'Admin',                         minRole: 'administrator' },
};

function canSeePage(p) {
  if (!hasRole(p.minRole)) return false;
  // Supervisors can only see wallboards for their own department
  if (p.dept && !hasRole('manager')) {
    return state.user && state.user.department === p.dept;
  }
  return true;
}

function buildNav() {
  const list = document.getElementById('navList');
  list.innerHTML = '';

  // Non-wallboard pages — render as normal nav items
  const topPages    = ['home','timer','history','dashboard','targets','reports','charts','admin'];
  const wbPageKeys  = Object.keys(PAGES).filter(k => k.startsWith('wb-') || k.startsWith('wbc-'));
  const visibleWbs  = wbPageKeys.filter(k => canSeePage(PAGES[k]));

  for (const key of topPages) {
    const p = PAGES[key];
    if (!p || !canSeePage(p)) continue;
    const btn = el('button', {
      textContent: p.label,
      onclick: () => { navigateTo(key); closeNav(); },
    });
    if (state.currentPage === key) btn.classList.add('active');
    list.appendChild(el('li', {}, btn));
  }

  // Collapsible wallboard group — only if user can see any wallboards
  if (visibleWbs.length) {
    const isWbActive = visibleWbs.includes(state.currentPage);
    const groupLi = el('li', {});

    const header = el('button', { className: 'nav-group-header' + (isWbActive ? ' open' : '') });
    header.appendChild(el('span', { textContent: '📋 Wall Boards' }));
    header.appendChild(el('span', { className: 'nav-group-arrow', textContent: '▼' }));

    const children = el('div', { className: 'nav-group-children' + (isWbActive ? ' open' : '') });

    // Group by department
    const deptGroups = {};
    for (const key of visibleWbs) {
      const dept = PAGES[key].dept;
      if (!deptGroups[dept]) deptGroups[dept] = [];
      deptGroups[dept].push(key);
    }

    for (const [dept, keys] of Object.entries(deptGroups)) {
      const deptLabel = el('div', { style: 'padding:8px 20px 4px;font-size:11px;font-weight:700;letter-spacing:.1em;color:var(--text2);text-transform:uppercase' });
      deptLabel.textContent = dept;
      children.appendChild(deptLabel);
      for (const key of keys) {
        const p = PAGES[key];
        const isCompact = key.startsWith('wbc-');
        const btn = el('button', {
          textContent: (isCompact ? '📺 Compact' : '📋 Full Board'),
          onclick: () => { navigateTo(key); closeNav(); },
        });
        if (state.currentPage === key) btn.classList.add('active');
        children.appendChild(btn);
      }
    }

    header.addEventListener('click', () => {
      const open = children.classList.toggle('open');
      header.classList.toggle('open', open);
    });

    groupLi.appendChild(header);
    groupLi.appendChild(children);
    list.appendChild(groupLi);
  }
}

// Active dept wallboard intervals keyed by page key
const _wbIntervals = {};
const _wbTicks     = {};

function navigateTo(page) {
  state.currentPage = page;

  // Stop all wallboard intervals except the one we're navigating to
  for (const [key, intv] of Object.entries(_wbIntervals)) {
    if (key !== page) { clearInterval(intv); delete _wbIntervals[key]; }
  }
  for (const [key, tick] of Object.entries(_wbTicks)) {
    if (key !== page) { clearInterval(tick); delete _wbTicks[key]; }
  }

  // Hide all pages
  for (const p of Object.values(PAGES)) {
    const node = document.getElementById(p.id);
    if (node) node.hidden = true;
  }
  const target = PAGES[page];
  if (target) {
    const node = document.getElementById(target.id);
    if (node) node.hidden = false;
  }
  buildNav();

  if (page === 'home')           loadHomePage();
  else if (page === 'timer')     loadTimerPage();
  else if (page === 'history')   loadHistoryPage();
  else if (page === 'dashboard') loadDashboard();
  else if (page === 'targets')   loadTargetsPage();
  else if (page === 'reports')   loadReportsPage();
  else if (page === 'charts')    loadChartsPage();
  else if (page === 'admin')     loadAdminPage();
  else if (page.startsWith('wb-'))  loadDeptWallboard(PAGES[page].dept);
  else if (page.startsWith('wbc-')) loadDeptWallboardCompact(PAGES[page].dept);
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
  // Ensure chat drawer is fully closed and state is clean on every login
  chat.conversationId = null;
  chat.isSupervisor   = false;
  chat.otherName      = null;
  chatDrawer.hidden        = true;
  chatDrawer.style.display = 'none';
  chatOverlay.hidden       = true;
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
    if (u.role !== 'superuser') {
      meta.appendChild(el('span', { className: `badge dept-badge dept-${DEPT_SLUGS[u.department] || 'prod'}`, textContent: u.department || 'Production' }));
    }
    if (!u.isActive) meta.appendChild(el('span', { className: 'badge badge-cancelled', textContent: 'disabled' }));
    info.appendChild(meta);
    card.appendChild(info);

    const actions = el('div', { className: 'user-actions' });
    const isSuTarget = u.role === 'superuser';
    const canEdit    = !isSuTarget || state.user.role === 'superuser';
    const editBtn = el('button', { className: 'btn btn-ghost', textContent: 'Edit',
      onclick: () => canEdit ? openUserModal(u) : toast('Only a superuser can edit superuser accounts.', 'error'),
      title: canEdit ? '' : 'Only a superuser can edit this account',
    });
    if (!canEdit) editBtn.disabled = true;
    const pwBtn = el('button', { className: 'btn btn-ghost', textContent: 'Reset PW',
      onclick: () => canEdit ? openResetPasswordModal(u) : toast('Only a superuser can reset superuser passwords.', 'error'),
      title: canEdit ? '' : 'Only a superuser can reset this password',
    });
    if (!canEdit) pwBtn.disabled = true;
    actions.appendChild(editBtn);
    actions.appendChild(pwBtn);
    // Show 2FA button for non-operators (2FA is optional)
    if (u.role !== 'operator') {
      const fa2Btn = el('button', {
        className: 'btn btn-ghost',
        textContent: u.totpEnabled ? 'Reset 2FA' : '2FA: Off',
        title: u.totpEnabled
          ? 'Reset this user\'s two-factor authentication (e.g. lost phone)'
          : '2FA not configured — user can enable this themselves',
        style: u.totpEnabled ? '' : 'color:var(--text3);',
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

  // Role select — options depend on the current user's own role
  const roleSelect = el('select', { id: 'mRole', style: 'background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:16px;padding:12px 14px;width:100%;' });
  const assignableRoles = state.user.role === 'superuser'
    ? ['operator','supervisor','manager','administrator','superuser']
    : ['operator','supervisor','manager'];
  assignableRoles.forEach(r => {
    const o = el('option', { value: r, textContent: r.charAt(0).toUpperCase() + r.slice(1) });
    if (user?.role === r) o.selected = true;
    roleSelect.appendChild(o);
  });
  body.appendChild(el('div', { className: 'form-group' },
    el('label', { for: 'mRole', textContent: 'Role *' }),
    roleSelect
  ));

  // Department select
  const deptSelect = el('select', { id: 'mDepartment', style: 'background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:16px;padding:12px 14px;width:100%;' });
  DEPARTMENTS.forEach(d => {
    const o = el('option', { value: d, textContent: d });
    if ((user?.department || 'Production') === d) o.selected = true;
    deptSelect.appendChild(o);
  });
  body.appendChild(el('div', { className: 'form-group' },
    el('label', { for: 'mDepartment', textContent: 'Department *' }),
    deptSelect
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
    const fullName   = document.getElementById('mFullName').value.trim();
    const role       = document.getElementById('mRole').value;
    const department = document.getElementById('mDepartment').value;

    if (!fullName) { errDiv.textContent = 'Full name is required.'; return; }

    btnSave.disabled = true;
    try {
      if (isNew) {
        const username = document.getElementById('mUsername').value.trim();
        const password = document.getElementById('mPassword').value;
        if (!username) { errDiv.textContent = 'Username is required.'; btnSave.disabled = false; return; }
        if (password.length < 8) { errDiv.textContent = 'Password must be at least 8 characters.'; btnSave.disabled = false; return; }
        await POST('/users', { username, password, full_name: fullName, role, department });
        toast('User created.', 'success');
      } else {
        const isActive = document.getElementById('mActive').checked;
        await PATCH(`/users/${user.id}`, { full_name: fullName, role, is_active: isActive, department });
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
   FORMAT HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */
function formatHM(totalSeconds) {
  if (!totalSeconds) return '—';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h === 0) return m + 'm';
  if (m === 0) return h + 'h';
  return h + 'h ' + m + 'm';
}

/* ═══════════════════════════════════════════════════════════════════════════
   TARGET TIMES
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadTargetTimes(containerId = 'targetTimesList') {
  const container = document.getElementById(containerId); if (!container) return;
  container.innerHTML = '<div class="empty-state">Loading...</div>';
  try { renderTargetList(await GET('/targets'), containerId); }
  catch (_) { container.innerHTML = '<div class="empty-state">Could not load target times.</div>'; }
}
function renderTargetList(targets, containerId = 'targetTimesList') {
  const container = document.getElementById(containerId); if (!container) return;
  container.innerHTML = '';
  if (!targets || !targets.length) { container.appendChild(el('div', { className: 'empty-state', textContent: 'No target times set yet. Click + Add Target Time to get started.' })); return; }
  targets.forEach(t => {
    const row = el('div', { className: 'target-row' });
    const info = el('div', { className: 'target-row-info' });
    info.appendChild(el('span', { className: 'target-item-number', textContent: t.itemNumber }));
    info.appendChild(el('span', { className: 'target-time-display', textContent: formatHM(t.totalSeconds) }));
    const actions = el('div', { className: 'target-row-actions' });
    actions.appendChild(el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Edit', onclick: () => openTargetModal(t, containerId) }));
    actions.appendChild(el('button', { className: 'btn btn-ghost btn-sm', textContent: '\uD83D\uDDD1', onclick: () => confirmDeleteTarget(t, containerId) }));
    row.appendChild(info); row.appendChild(actions); container.appendChild(row);
  });
}
function loadTargetsPage() { loadTargetTimes('targetTimesPageList'); }
document.getElementById('btnAddTargetPage') && document.getElementById('btnAddTargetPage').addEventListener('click', () => openTargetModal(null, 'targetTimesPageList'));
document.getElementById('btnAddTarget') && document.getElementById('btnAddTarget').addEventListener('click', () => openTargetModal(null, 'targetTimesList'));
function openTargetModal(existing, containerId = 'targetTimesList') {
  const isNew = !existing, body = el('div', {});
  const ttInput = el('input', { id: 'ttItemNumber', type: 'text', maxlength: '40', placeholder: 'e.g. PHL-1001', value: existing ? existing.itemNumber : '', autocapitalize: 'characters' });
  if (!isNew) ttInput.setAttribute('disabled', '');
  const inputRow = el('div', { className: 'input-with-action' }, ttInput);
  if (isNew) {
    const scanBtn = el('button', { className: 'btn-scan', type: 'button', 'aria-label': 'Scan barcode' });
    scanBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="3" height="3"/><rect x="14" y="7" width="3" height="3"/><rect x="7" y="14" width="3" height="3"/><rect x="14" y="14" width="3" height="3"/></svg> Scan`;
    scanBtn.addEventListener('click', () => scanner.open(ttInput, 'item'));
    inputRow.appendChild(scanBtn);
  }
  body.appendChild(el('div', { className: 'form-group' }, el('label', { for: 'ttItemNumber', textContent: 'Item Number *' }), inputRow));
  const timeRow = el('div', { className: 'form-group' }); timeRow.appendChild(el('label', { textContent: 'Target Time *' }));
  const timeInputs = el('div', { className: 'time-input-row' });
  const hInp = el('input', { id: 'ttHours',   type: 'number', min: '0', max: '99', placeholder: '0', style: 'width:70px;text-align:center;', value: existing ? String(existing.hours)   : '0' });
  const mInp = el('input', { id: 'ttMinutes', type: 'number', min: '0', max: '59', placeholder: '0', style: 'width:70px;text-align:center;', value: existing ? String(existing.minutes) : '0' });
  timeInputs.appendChild(hInp); timeInputs.appendChild(el('span', { textContent: 'h', style: 'margin:0 6px;color:var(--text2);font-weight:600;' }));
  timeInputs.appendChild(mInp); timeInputs.appendChild(el('span', { textContent: 'm', style: 'margin:0 6px;color:var(--text2);font-weight:600;' }));
  timeRow.appendChild(timeInputs); body.appendChild(timeRow);
  const errDiv = el('div', { className: 'error-msg', role: 'alert' }); body.appendChild(errDiv);
  const btnSave = el('button', { className: 'btn btn-primary', textContent: isNew ? 'Add Target Time' : 'Save Changes' });
  const btnCancel = el('button', { className: 'btn btn-ghost', textContent: 'Cancel' });
  btnCancel.addEventListener('click', closeModal);
  btnSave.addEventListener('click', async () => {
    errDiv.textContent = '';
    const itemNumber = (document.getElementById('ttItemNumber').value || '').trim().toUpperCase();
    const hours = parseInt(document.getElementById('ttHours').value, 10) || 0;
    const minutes = parseInt(document.getElementById('ttMinutes').value, 10) || 0;
    if (!itemNumber) { errDiv.textContent = 'Item Number is required.'; return; }
    if (hours === 0 && minutes === 0) { errDiv.textContent = 'Target time must be greater than zero.'; return; }
    btnSave.disabled = true;
    try {
      await POST('/targets', { itemNumber, hours, minutes });
      toast((isNew ? 'Target time added' : 'Target time updated') + ' for ' + itemNumber, 'success');
      closeModal(); loadTargetTimes(containerId);
      if (containerId !== 'targetTimesList') loadTargetTimes('targetTimesList');
    } catch (err) { errDiv.textContent = err.message; } finally { btnSave.disabled = false; }
  });
  openModal(isNew ? 'Add Target Time' : 'Edit Target Time', body, [btnCancel, btnSave]);
}
function confirmDeleteTarget(t, containerId = 'targetTimesList') {
  const body = el('div', {}); body.appendChild(el('p', { textContent: 'Remove the target time for ' + t.itemNumber + '?', style: 'margin-bottom:12px;' }));
  const errDiv = el('div', { className: 'error-msg', role: 'alert' }); body.appendChild(errDiv);
  const btnConfirm = el('button', { className: 'btn btn-danger', textContent: 'Remove' });
  const btnCancel  = el('button', { className: 'btn btn-ghost',  textContent: 'Keep' });
  btnCancel.addEventListener('click', closeModal);
  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled = true;
    try {
      await api('DELETE', '/targets/' + encodeURIComponent(t.itemNumber));
      toast('Target time removed for ' + t.itemNumber, ''); closeModal();
      loadTargetTimes(containerId);
      if (containerId !== 'targetTimesList') loadTargetTimes('targetTimesList');
    } catch (err) { errDiv.textContent = err.message; btnConfirm.disabled = false; }
  });
  openModal('Remove Target Time', body, [btnCancel, btnConfirm]);
}

/* ═══════════════════════════════════════════════════════════════════════════
   TOTP SETUP
   ═══════════════════════════════════════════════════════════════════════════ */
const ROLES_REQUIRING_TOTP = ['manager', 'administrator', 'superuser'];
function checkTotpSetupRequired() {
  // 2FA is optional — never force the setup prompt on login
}
async function openTotpSetupModal() {
  const body = el('div', {});
  body.appendChild(el('p', { textContent: 'Your role requires two-factor authentication (2FA). Please scan the QR code below with an authenticator app such as Google Authenticator or Microsoft Authenticator, then enter the 6-digit code to complete setup.', style: 'margin-bottom:16px;font-size:14px;' }));
  const qrWrap = el('div', { style: 'text-align:center;padding:20px 0;' });
  qrWrap.appendChild(el('div', { textContent: 'Generating QR code\u2026', style: 'color:var(--text3);' }));
  body.appendChild(qrWrap);
  const codeGroup = el('div', { className: 'form-group', style: 'margin-top:8px;' });
  codeGroup.appendChild(el('label', { for: 'setupTotpCode', textContent: 'Enter code from app *' }));
  const codeInput = el('input', { id: 'setupTotpCode', type: 'text', inputmode: 'numeric', pattern: '\\d{6}', maxlength: '6', placeholder: '000000', className: 'totp-code-input' });
  codeGroup.appendChild(codeInput); body.appendChild(codeGroup);
  const errDiv = el('div', { className: 'error-msg', role: 'alert' }); body.appendChild(errDiv);
  const btnEnable = el('button', { className: 'btn btn-primary', textContent: 'Enable 2FA' });
  const btnSkip   = el('button', { className: 'btn btn-ghost',   textContent: 'Remind Me Later' });
  btnSkip.addEventListener('click', () => { state.user.totpEnabled = null; closeModal(); });
  openModal('Set Up Two-Factor Authentication', body, [btnSkip, btnEnable]);
  try {
    const setup = await POST('/totp/setup', {});
    qrWrap.innerHTML = '';
    qrWrap.appendChild(el('img', { src: setup.qrDataUrl, alt: 'QR code', style: 'width:200px;height:200px;border-radius:8px;' }));
    qrWrap.appendChild(el('p', { textContent: "Can't scan? Enter this code manually: " + setup.secret, style: 'font-size:11px;color:var(--text3);margin-top:8px;word-break:break-all;' }));
    codeInput.focus();
  } catch (err) { qrWrap.innerHTML = ''; qrWrap.appendChild(el('p', { textContent: 'Could not load QR code: ' + err.message, style: 'color:var(--red);' })); }
  btnEnable.addEventListener('click', async () => {
    errDiv.textContent = '';
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) { errDiv.textContent = 'Please enter the 6-digit code from your authenticator app.'; return; }
    btnEnable.disabled = true;
    try { await POST('/totp/confirm', { code }); state.user.totpEnabled = true; closeModal(); toast('Two-factor authentication enabled successfully.', 'success'); }
    catch (err) { errDiv.textContent = err.message; btnEnable.disabled = false; }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   PAUSE / RESUME
   ═══════════════════════════════════════════════════════════════════════════ */
function updatePauseUI() {
  const isPaused  = state.activeIsPaused;
  const banner    = document.getElementById('pauseBanner');
  const pauseBtn  = document.getElementById('btnPauseTimer');
  const label     = document.getElementById('activeJobLabel');
  const stopwatch = document.getElementById('stopwatch');
  const panel     = document.getElementById('panelActive');
  if (banner)    banner.hidden = !isPaused;
  if (label)     label.textContent = isPaused ? 'PAUSED' : 'ACTIVE JOB';
  if (stopwatch) stopwatch.classList.toggle('stopwatch-paused', isPaused);
  if (panel)     panel.classList.toggle('panel-paused', isPaused);
  if (pauseBtn) {
    if (isPaused) { pauseBtn.textContent = '\u25b6 Resume'; pauseBtn.className = 'btn btn-resume-sm'; pauseBtn.setAttribute('aria-label', 'Resume timer'); }
    else          { pauseBtn.textContent = '\u23f8 Pause';  pauseBtn.className = 'btn btn-pause-sm';  pauseBtn.setAttribute('aria-label', 'Pause timer'); }
  }
  if (isPaused) {
    stopStopwatch();
    if (state.activeStartedAt && state.activePausedAt) {
      const raw = Math.floor((new Date(state.activePausedAt).getTime() - new Date(state.activeStartedAt).getTime()) / 1000);
      document.getElementById('stopwatch').textContent = formatDuration(Math.max(0, raw - state.activeTotalPausedSeconds));
    }
  } else { startStopwatch(); }
}

document.getElementById('btnPauseTimer').addEventListener('click', async () => {
  if (!state.activeTimerId) return;
  const btn = document.getElementById('btnPauseTimer'); btn.disabled = true;
  try {
    if (state.activeIsPaused) {
      const t = await POST('/pause/' + state.activeTimerId + '/resume', {});
      state.activeIsPaused = false; state.activePausedAt = null; state.activeTotalPausedSeconds = t.totalPausedSeconds || 0;
      updatePauseUI(); toast('Timer resumed.', 'success');
    } else {
      const t = await POST('/pause/' + state.activeTimerId + '/pause', { reason: 'Manual pause' });
      state.activeIsPaused = true; state.activePausedAt = t.pausedAt;
      updatePauseUI(); toast('Timer paused.', '');
    }
  } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
});

let pausePollInterval = null;
function startPausePoll() {
  if (pausePollInterval) clearInterval(pausePollInterval);
  pausePollInterval = setInterval(async () => {
    if (state.currentPage !== 'timer' || !state.activeTimerId) return;
    try {
      const t = await GET('/timers/' + state.activeTimerId); if (!t) return;
      const waspaused = state.activeIsPaused, wasHandRaised = state.activeHandRaised;
      state.activeIsPaused = t.isPaused || false; state.activePausedAt = t.pausedAt || null;
      state.activeTotalPausedSeconds = t.totalPausedSeconds || 0; state.activeHandRaised = t.handRaised || false;
      if (waspaused !== state.activeIsPaused) {
        updatePauseUI();
        toast(state.activeIsPaused ? 'Your timer has been automatically paused outside working hours.' : 'Your timer has automatically resumed for the new working day.', state.activeIsPaused ? '' : 'success');
      }
      if (wasHandRaised !== state.activeHandRaised) { updateHandUI(); if (!state.activeHandRaised) toast('Your hand has been lowered by a supervisor.', ''); }
    } catch (_) {}
  }, 30000);
}
function stopPausePoll() { if (pausePollInterval) { clearInterval(pausePollInterval); pausePollInterval = null; } }

/* ═══════════════════════════════════════════════════════════════════════════
   RAISE / LOWER HAND
   ═══════════════════════════════════════════════════════════════════════════ */
function updateHandUI() {
  const btn = document.getElementById('btnRaiseHand'); if (!btn) return;
  if (state.activeHandRaised) { btn.textContent = '\u270b Lower Hand'; btn.className = 'btn btn-hand-raised-sm'; btn.setAttribute('aria-label', 'Lower hand'); }
  else                        { btn.textContent = '\u270b Raise Hand';  btn.className = 'btn btn-hand-sm';        btn.setAttribute('aria-label', 'Raise hand'); }
}

function showHandRaisedPopup(data) {
  document.querySelectorAll('.hand-raised-popup').forEach(p => p.remove());
  const popup = el('div', { className: 'hand-raised-popup', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'Operator needs attention' });
  const icon  = el('div', { className: 'hrp-icon', textContent: '\u270b' });
  const body  = el('div', { className: 'hrp-body' });
  body.appendChild(el('div', { className: 'hrp-title', textContent: 'Operator Needs Attention' }));
  body.appendChild(el('div', { className: 'hrp-name',  textContent: data.operatorName }));
  const meta = el('div', { className: 'hrp-meta' });
  if (data.itemNumber)  meta.appendChild(el('span', { textContent: '\uD83D\uDCE6 ' + data.itemNumber }));
  if (data.workstation) meta.appendChild(el('span', { textContent: '\uD83D\uDDA5 ' + data.workstation }));
  if (meta.children.length) body.appendChild(meta);
  body.appendChild(el('div', { className: 'hrp-time', textContent: 'Raised at ' + new Date(data.raisedAt).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit' }) }));
  const closeBtn = el('button', { className: 'hrp-close', textContent: '\u2715', 'aria-label': 'Dismiss' });
  closeBtn.addEventListener('click', () => popup.remove());
  popup.appendChild(icon); popup.appendChild(body); popup.appendChild(closeBtn);
  document.body.appendChild(popup);
  playPing('message'); setTimeout(() => playPing('message'), 400);
  setTimeout(() => { if (popup.isConnected) popup.remove(); }, 30000);
}

document.getElementById('btnRaiseHand').addEventListener('click', async () => {
  if (!state.activeTimerId) return;
  const btn = document.getElementById('btnRaiseHand'); btn.disabled = true;
  try {
    if (state.activeHandRaised) { await POST(`/timers/${state.activeTimerId}/lower-hand`, {}); state.activeHandRaised = false; toast('Hand lowered.', ''); }
    else                        { await POST(`/timers/${state.activeTimerId}/raise-hand`,  {}); state.activeHandRaised = true;  toast('Hand raised \u2014 a supervisor will be with you shortly.', 'success'); }
    updateHandUI();
  } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
});

/* ═══════════════════════════════════════════════════════════════════════════
   HOME PAGE
   ═══════════════════════════════════════════════════════════════════════════ */
async function loadHomePage() {
  renderHomeSkeleton();
  const today = new Date().toISOString().slice(0,10);
  const [activeTimers, stats, users, productivity] = await Promise.all([
    GET('/timers?status=active&limit=200').catch(() => []),
    GET('/export/stats').catch(() => null),
    hasRole('administrator') ? GET('/users').catch(() => []) : Promise.resolve([]),
    hasRole('manager') ? GET(`/export/productivity?from=${today}&to=${today}`).catch(() => ({ targetPct:80, operators:[] })) : Promise.resolve({ targetPct:80, operators:[] }),
  ]);
  renderHomeActiveJobs(activeTimers);
  renderHomeTodayStats(stats, activeTimers);
  if (hasRole('manager'))       renderHomePerformance(stats);
  if (hasRole('manager'))       renderHomeProductivity(productivity?.operators || [], productivity?.targetPct || 80);
  if (hasRole('administrator')) renderHomeUsers(users);
  renderHomeQuickActions();
}

function renderHomeSkeleton() {
  const page = document.getElementById('pageHome'); if (!page) return;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  page.innerHTML = `<div class="home-page">
    <div class="home-greeting">
      <span class="home-greeting-text">${greeting}, ${state.user.fullName.split(' ')[0]}</span>
      <span class="home-greeting-date">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
    </div>
    <div class="home-grid" id="homeGrid">
      <div class="home-card home-card-full" id="homeActiveJobs"><div class="home-card-title">Active Jobs</div><div class="home-card-body"><div class="empty-state">Loading...</div></div></div>
      <div class="home-card" id="homeTodayStats"><div class="home-card-title">Today at a Glance</div><div class="home-card-body"><div class="empty-state">Loading...</div></div></div>
      <div class="home-card" id="homeQuickActions"><div class="home-card-title">Quick Actions</div><div class="home-card-body"></div></div>
      ${hasRole('manager') ? '<div class="home-card home-card-full" id="homePerformance"><div class="home-card-title">Performance</div><div class="home-card-body"><div class="empty-state">Loading...</div></div></div>' : ''}
      ${hasRole('manager') ? '<div class="home-card home-card-full" id="homeProductivity"><div class="home-card-title">Operator Productivity — Today</div><div class="home-card-body"><div class="empty-state">Loading...</div></div></div>' : ''}
      ${hasRole('administrator') ? '<div class="home-card home-card-full" id="homeUsers"><div class="home-card-title">User Status</div><div class="home-card-body"><div class="empty-state">Loading...</div></div></div>' : ''}
    </div>
  </div>`;
}

function renderHomeActiveJobs(timers) {
  const card = document.getElementById('homeActiveJobs'); if (!card) return;
  const body = card.querySelector('.home-card-body'); body.innerHTML = '';
  const titleEl = card.querySelector('.home-card-title'); if (titleEl) titleEl.textContent = `Active Jobs  (${timers.length})`;
  if (!timers.length) { body.appendChild(el('div', { className: 'empty-state', textContent: 'No jobs currently running.' })); return; }
  const now = Date.now();
  timers.sort((a, b) => {
    const elA = now - new Date(a.startedAt).getTime(), elB = now - new Date(b.startedAt).getTime();
    const ovA = a.targetSeconds ? elA / 1000 > a.targetSeconds : elA > 4 * 3600000;
    const ovB = b.targetSeconds ? elB / 1000 > b.targetSeconds : elB > 4 * 3600000;
    if (ovA !== ovB) return ovA ? -1 : 1; return elB - elA;
  });
  const grid = el('div', { className: 'home-active-grid' });
  timers.forEach(t => {
    const refMs   = t.isPaused && t.pausedAt ? new Date(t.pausedAt).getTime() : now;
    const localEl = Math.max(0, Math.floor((refMs - new Date(t.startedAt).getTime()) / 1000)) - (t.totalPausedSeconds || 0);
    const elapsed = t.netElapsedSeconds != null ? t.netElapsedSeconds : localEl;
    const isOver  = t.targetSeconds ? elapsed >= t.targetSeconds : elapsed > 4 * 3600;
    const isWarn  = !isOver && (t.targetSeconds ? elapsed / t.targetSeconds >= 0.8 : elapsed > 2 * 3600);
    const row = el('div', { className: 'home-active-row' + (isOver ? ' over' : isWarn ? ' warn' : '') + (t.handRaised ? ' hand-raised' : '') });
    row.appendChild(el('span', { className: 'home-active-dot' + (isOver ? ' dot-red' : isWarn ? ' dot-amber' : ' dot-green') }));
    const info = el('div', { className: 'home-active-info' });
    info.appendChild(el('span', { className: 'home-active-name', textContent: t.operatorName + (t.handRaised ? ' \u270b' : '') }));
    info.appendChild(el('span', { className: 'home-active-item', textContent: t.itemNumber }));
    if (t.workstation) info.appendChild(el('span', { className: 'home-active-ws', textContent: '\uD83D\uDDA5 ' + t.workstation }));
    row.appendChild(info);
    const timeInfo = el('div', { className: 'home-active-time' });
    timeInfo.appendChild(el('span', { className: 'home-active-elapsed' + (isOver ? ' text-red' : isWarn ? ' text-amber' : ''), textContent: formatDuration(elapsed) }));
    if (t.targetSeconds) {
      const rem = t.targetSeconds - elapsed;
      timeInfo.appendChild(el('span', { className: 'home-active-target' + (isOver ? ' text-red' : ''),
        textContent: isOver ? '\u26a0 ' + formatHM(Math.abs(rem)) + ' overdue' : '\uD83C\uDFAF ' + formatHM(rem) + ' left' }));
    }
    row.appendChild(timeInfo);
    if (hasRole('supervisor')) row.appendChild(el('button', { className: 'btn btn-ghost btn-sm home-msg-btn', textContent: '\u2709', title: 'Message ' + t.operatorName, onclick: () => openSendMessageModal(t.operatorId, t.operatorName) }));
    grid.appendChild(row);
  });
  body.appendChild(grid);
}

function renderHomeTodayStats(stats, activeTimers = []) {
  const card = document.getElementById('homeTodayStats'); if (!card) return;
  const body = card.querySelector('.home-card-body'); body.innerHTML = '';
  if (!stats) { body.appendChild(el('div', { className: 'empty-state', textContent: 'Could not load stats.' })); return; }
  const raisedCount = activeTimers.filter(t => t.handRaised).length;
  const grid = el('div', { className: 'home-stats-grid' });
  [{ icon: '\u25b6', label: 'Active Now', value: stats.activeCount, cls: 'stat-active' },
   { icon: '\u2713', label: 'Completed Today', value: stats.total24h, cls: 'stat-done' },
   { icon: '\uD83D\uDCC5', label: 'This Week', value: stats.total7d, cls: '' },
   { icon: '\uD83D\uDCE6', label: 'Item Types', value: stats.byItem?.length || 0, cls: '' }].forEach(s => {
    const item = el('div', { className: 'home-stat-item' });
    item.appendChild(el('div', { className: 'home-stat-icon ' + s.cls, textContent: s.icon }));
    item.appendChild(el('div', { className: 'home-stat-value', textContent: s.value }));
    item.appendChild(el('div', { className: 'home-stat-label', textContent: s.label }));
    grid.appendChild(item);
  });
  body.appendChild(grid);
  if (hasRole('supervisor')) {
    const handTile = el('div', { className: 'home-hand-tile' + (raisedCount > 0 ? ' active' : '') });
    const handLeft = el('div', { className: 'home-hand-left' });
    handLeft.appendChild(el('div', { className: 'home-hand-icon', textContent: '\u270b' }));
    const handInfo = el('div', {});
    handInfo.appendChild(el('div', { className: 'home-hand-value', textContent: raisedCount }));
    handInfo.appendChild(el('div', { className: 'home-hand-label', textContent: raisedCount === 1 ? 'Raised Hand' : 'Raised Hands' }));
    handLeft.appendChild(handInfo); handTile.appendChild(handLeft);
    if (raisedCount > 0) {
      const lowerBtn = el('button', { className: 'btn btn-ghost btn-sm home-lower-all-btn', textContent: '\u270b Lower All' });
      lowerBtn.addEventListener('click', async () => {
        lowerBtn.disabled = true; lowerBtn.textContent = 'Lowering\u2026';
        try { const r = await POST('/timers/lower-all-hands', {}); toast(r.message, 'success'); loadHomePage(); }
        catch (err) { toast(err.message, 'error'); lowerBtn.disabled = false; lowerBtn.textContent = '\u270b Lower All'; }
      });
      handTile.appendChild(lowerBtn);
    }
    body.appendChild(handTile);
  }
}

function renderHomePerformance(stats) {
  const card = document.getElementById('homePerformance'); if (!card) return;
  const body = card.querySelector('.home-card-body'); body.innerHTML = '';
  if (!stats || !stats.byItem || !stats.byItem.length) { body.appendChild(el('div', { className: 'empty-state', textContent: 'No completed jobs today.' })); return; }
  const table = el('table', { className: 'home-perf-table' });
  table.appendChild(el('thead', {}, el('tr', {}, el('th', { textContent: 'Item' }), el('th', { textContent: 'Jobs' }), el('th', { textContent: 'Avg Time' }), el('th', { textContent: 'Target' }), el('th', { textContent: 'Delta' }))));
  const tbody = el('tbody', {});
  stats.byItem.slice(0, 10).forEach(r => {
    const hasTarget = r.target_seconds != null, delta = hasTarget ? Math.round(r.avg_seconds) - r.target_seconds : null;
    const tr = el('tr', {}, el('td', { className: 'perf-item', textContent: r.item_number }), el('td', { textContent: r.count }), el('td', { textContent: formatDuration(Math.round(r.avg_seconds)) }), el('td', { textContent: hasTarget ? formatHM(r.target_seconds) : '\u2014', className: hasTarget ? '' : 'dash-no-target' }));
    tr.appendChild(el('td', { textContent: delta === null ? '\u2014' : (delta >= 0 ? '+' : '') + formatDuration(Math.abs(delta)), className: delta === null ? 'dash-no-target' : delta > 0 ? 'dash-over' : 'dash-under' }));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); body.appendChild(table);
  body.appendChild(el('button', { className: 'btn btn-ghost btn-sm', textContent: '\u2b07 Export Today CSV', style: 'margin-top:12px;',
    onclick: () => { const t = new Date(); t.setHours(0,0,0,0); window.location.href = `/api/export/csv?from=${t.toISOString()}`; } }));
}

function renderHomeUsers(users) {
  const card = document.getElementById('homeUsers'); if (!card || !users.length) return;
  const body = card.querySelector('.home-card-body'); body.innerHTML = '';
  const active  = users.filter(u => u.isActive), disabled = users.filter(u => !u.isActive);
  const need2fa = active.filter(u => ['manager','administrator'].includes(u.role) && !u.totpEnabled);
  const summary = el('div', { className: 'home-user-summary' });
  [{ label: 'Active Accounts', value: active.length, cls: '' },
   { label: 'Disabled', value: disabled.length, cls: disabled.length ? 'text-amber' : '' },
   { label: '2FA Enabled', value: active.filter(u => u.totpEnabled).length, cls: '' }].forEach(s => {
    const item = el('div', { className: 'home-user-stat' });
    item.appendChild(el('span', { className: 'home-user-stat-val ' + s.cls, textContent: s.value }));
    item.appendChild(el('span', { className: 'home-user-stat-lbl', textContent: s.label }));
    summary.appendChild(item);
  });
  body.appendChild(summary);
}

function renderHomeProductivity(rows, targetPct = 80) {
  const card = document.getElementById('homeProductivity');
  if (!card) return;
  const body = card.querySelector('.home-card-body');
  body.innerHTML = '';
  if (!rows || !rows.length) {
    body.appendChild(el('div', { className: 'empty-state', textContent: 'No operator timer activity today.' }));
    return;
  }
  // Target indicator
  const targetBadge = el('div', { style: 'font-size:11px;color:var(--text2);margin-bottom:8px' });
  targetBadge.textContent = `Target: ${targetPct}% productive`;
  body.appendChild(targetBadge);
  const grid = el('div', { style: 'display:grid;gap:6px' });
  rows.forEach(r => {
    const pct = r.productivityPct;
    const barColor = pct >= targetPct ? 'var(--green)' : pct >= targetPct * 0.7 ? 'var(--amber)' : 'var(--red)';
    const row = el('div', { style: 'display:flex;align-items:center;gap:10px;background:var(--bg2);border-radius:6px;padding:8px 12px' });
    const nameCol = el('div', { style: 'min-width:130px;font-weight:600;font-size:13px;color:var(--text)' });
    nameCol.textContent = r.operatorName;
    const barWrap = el('div', { style: 'flex:1;background:var(--bg3);border-radius:4px;height:8px' });
    barWrap.appendChild(el('div', { style: `width:${pct}%;background:${barColor};height:8px;border-radius:4px` }));
    const pctLabel = el('div', { style: `min-width:44px;text-align:right;font-weight:700;font-size:13px;color:${barColor}` });
    pctLabel.textContent = pct + '%';
    const timeLabel = el('div', { style: 'min-width:60px;text-align:right;font-size:12px;color:var(--text2)' });
    timeLabel.textContent = r.activeHoursDisplay;
    row.appendChild(nameCol);
    row.appendChild(barWrap);
    row.appendChild(pctLabel);
    row.appendChild(timeLabel);
    grid.appendChild(row);
  });
  body.appendChild(grid);
}

function renderHomeQuickActions() {
  const card = document.getElementById('homeQuickActions'); if (!card) return;
  const body = card.querySelector('.home-card-body'); body.innerHTML = '';

  // Single wallboard picker button instead of one per department
  if (hasRole('supervisor')) {
    const wbBtn = el('button', { className: 'home-action-btn', textContent: '📋 Wall Boards' });
    wbBtn.addEventListener('click', () => openWallboardPicker());
    body.appendChild(wbBtn);
  }

  const actions = [
    { label: '📊 Dashboard',      page: 'dashboard', role: 'manager'       },
    { label: '📈 Reports',         page: 'reports',   role: 'manager'       },
    { label: '📉 Charts',          page: 'charts',    role: 'manager'       },
    { label: '🎯 Target Times',    page: 'targets',   role: 'manager'       },
    { label: '🕐 History',         page: 'history',   role: 'operator'      },
    { label: '👥 User Management', page: 'admin',     role: 'administrator' },
  ];
  actions.filter(a => hasRole(a.role)).forEach(a => {
    body.appendChild(el('button', { className: 'home-action-btn', textContent: a.label, onclick: () => { navigateTo(a.page); closeNav(); } }));
  });
}

function openWallboardPicker() {
  const dept       = state.user?.department || 'Production';
  const slug       = DEPT_SLUGS[dept] || 'prod';
  const isManager  = hasRole('manager');

  // Build list of departments visible to this user
  const depts = isManager ? DEPARTMENTS : [dept];

  const body = el('div', {});
  body.appendChild(el('p', { textContent: 'Choose a department and view:', style: 'margin-bottom:16px;color:var(--text2);font-size:14px' }));

  depts.forEach(d => {
    const s = DEPT_SLUGS[d];
    const deptLabel = el('div', { style: 'font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text2);margin-bottom:6px;margin-top:12px' });
    deptLabel.textContent = d;
    body.appendChild(deptLabel);
    const row = el('div', { className: 'wb-picker-grid' });

    const fullBtn = el('button', { className: 'wb-picker-btn' });
    fullBtn.innerHTML = `📋 Full Board<span class="wb-picker-sub">All tiles with details</span>`;
    fullBtn.addEventListener('click', () => { closeModal(); navigateTo('wb-' + s); });

    const compactBtn = el('button', { className: 'wb-picker-btn' });
    compactBtn.innerHTML = `📺 Compact<span class="wb-picker-sub">Overview grid</span>`;
    compactBtn.addEventListener('click', () => { closeModal(); navigateTo('wbc-' + s); });

    row.appendChild(fullBtn);
    row.appendChild(compactBtn);
    body.appendChild(row);
  });

  openModal('Wall Boards', body, [el('button', { className: 'btn btn-ghost', textContent: 'Close', onclick: closeModal })]);
}



/* ═══════════════════════════════════════════════════════════════════════════
   DEPARTMENT WALLBOARDS
   Each wallboard is parameterised by department name.
   Supervisors see only their own department; managers/admins see all.
   ═══════════════════════════════════════════════════════════════════════════ */

function deptIds(dept) {
  const slug = DEPT_SLUGS[dept] || 'prod';
  return {
    tilesId:   `wallboard-${slug}-tiles`,
    countId:   `wallboard-${slug}-count`,
    updatedId: `wallboard-${slug}-updated`,
    pageKey:   `wb-${slug}`,
  };
}
function deptCIds(dept) {
  const slug = DEPT_SLUGS[dept] || 'prod';
  return {
    tilesId:   `wallboardC-${slug}-tiles`,
    countId:   `wallboardC-${slug}-count`,
    updatedId: `wallboardC-${slug}-updated`,
    pageKey:   `wbc-${slug}`,
  };
}

document.addEventListener('visibilitychange', () => {
  const p = state.currentPage;
  if (!p || !document.visibilityState === 'visible') return;
  if (p.startsWith('wb-'))  { const dept = PAGES[p]?.dept; if (dept) refreshDeptWallboard(dept); }
  if (p.startsWith('wbc-')) { const dept = PAGES[p]?.dept; if (dept) refreshDeptWallboardCompact(dept); }
});

async function loadDeptWallboard(dept) {
  const { pageKey } = deptIds(dept);
  if (_wbIntervals[pageKey]) clearInterval(_wbIntervals[pageKey]);
  await refreshDeptWallboard(dept);
  _wbIntervals[pageKey] = setInterval(() => {
    if (document.visibilityState === 'visible') refreshDeptWallboard(dept);
  }, 300000);
}

async function refreshDeptWallboard(dept) {
  const { tilesId, countId, updatedId, pageKey } = deptIds(dept);
  const container = document.getElementById(tilesId);
  const countEl   = document.getElementById(countId);
  const updatedEl = document.getElementById(updatedId);
  if (!container) return;

  try {
    const deptParam = hasRole('manager') ? `&department=${encodeURIComponent(dept)}` : '';
    const [timers, onlineData] = await Promise.all([
      GET(`/timers?status=active&limit=200${deptParam}`),
      GET('/messages/online').catch(() => ({ online: [] })),
    ]);
    const onlineSet = new Set(onlineData.online || []);
    if (countEl)   countEl.textContent  = timers.length + ' active job' + (timers.length !== 1 ? 's' : '');
    if (updatedEl) updatedEl.textContent = 'Updated ' + new Date().toLocaleTimeString('en-GB');
    container.innerHTML = '';

    if (!timers.length) {
      container.appendChild(el('div', { className: 'wallboard-empty' },
        el('div', { className: 'wallboard-empty-icon', textContent: '\u2713' }),
        el('div', { className: 'wallboard-empty-text', textContent: 'No active jobs right now' })));
      return;
    }

    timers.forEach(t => {
      const sNet    = t.netElapsedSeconds != null ? t.netElapsedSeconds : null;
      const localEl = Math.max(0, Math.floor((Date.now() - new Date(t.startedAt).getTime()) / 1000)) - (t.totalPausedSeconds || 0);
      const elapsed = sNet !== null ? sNet : localEl;
      const tile    = el('div', { className: 'wallboard-tile' + (t.isPaused ? ' tile-paused' : '') });

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

      if (t.isPaused) {
        const pauseTag = el('div', { className: 'wb-paused-tag', textContent: '\u23f8 PAUSED' });
        if (t.pauseType === 'schedule') pauseTag.title = 'Auto-paused outside working hours';
        tile.appendChild(pauseTag);
      }

      if (t.handRaised) {
        tile.classList.add('tile-hand-raised');
        const handBanner = el('div', { className: 'wb-hand-banner' });
        handBanner.appendChild(el('span', { className: 'wb-hand-banner-text', textContent: '\u270b Needs Attention' }));
        if (hasRole('supervisor')) {
          const lowerBtn = el('button', { className: 'wb-hand-lower-btn', textContent: 'Lower \u2715', 'aria-label': 'Lower hand for ' + t.operatorName });
          lowerBtn.addEventListener('click', async e => {
            e.stopPropagation(); lowerBtn.disabled = true;
            try { await POST('/timers/' + t.id + '/lower-hand', {}); toast('Hand lowered for ' + t.operatorName, 'success'); await refreshDeptWallboard(dept); }
            catch (err) { toast(err.message, 'error'); lowerBtn.disabled = false; }
          });
          handBanner.appendChild(lowerBtn);
        }
        tile.appendChild(handBanner);
      }

      tile.appendChild(el('div', { className: 'wb-item', textContent: t.itemNumber }));
      const opRow = el('div', { className: 'wb-operator-row' });
      opRow.appendChild(el('span', {
        className: 'presence-dot ' + (onlineSet.has(t.operatorId) ? 'online' : 'offline'),
        title: onlineSet.has(t.operatorId) ? 'Session active' : 'Not connected',
      }));
      opRow.appendChild(el('span', { textContent: t.operatorName }));
      tile.appendChild(opRow);
      tile.appendChild(el('div', {
        className: 'wb-elapsed', textContent: formatDuration(elapsed),
        'data-timerid': t.id, 'data-startedat': t.startedAt,
        'data-pausedseconds': String(t.totalPausedSeconds || 0), 'data-ispaused': t.isPaused ? '1' : '0',
      }));
      tile.appendChild(el('div', { className: 'wb-started', textContent: 'Started ' + formatLocalTime(t.startedAt) }));
      if (t.workstation) tile.appendChild(el('div', { className: 'wb-notes', textContent: '\uD83D\uDDA5 ' + t.workstation }));
      if (t.woNumber)    tile.appendChild(el('div', { className: 'wb-notes', textContent: '\uD83D\uDCCB W/O: ' + t.woNumber }));
      if (t.timeCheck)   tile.appendChild(el('span', { className: 'badge badge-timecheck', style: 'margin-top:6px;display:inline-block;', textContent: '\u2713 Time Check' }));

      if (t.targetSeconds) {
        const pct = elapsed / t.targetSeconds, pctCapped = Math.min(1, pct), remaining = t.targetSeconds - elapsed;
        const targetWrap = el('div', { className: 'wb-target-wrap' });
        const labelText  = remaining > 0 ? formatHM(remaining) + ' remaining' : formatHM(Math.abs(remaining)) + ' overdue';
        targetWrap.appendChild(el('div', {
          className: 'wb-target-label' + (remaining <= 0 ? ' overdue' : ''),
          textContent: '\uD83C\uDFAF Target: ' + formatHM(t.targetSeconds) + '  \u2014  ' + labelText,
          'data-startedat': t.startedAt, 'data-targetseconds': String(t.targetSeconds),
        }));
        const bar = el('div', { className: 'wb-target-bar' });
        bar.appendChild(el('div', {
          className: 'wb-target-fill' + (pct >= 1 ? ' over' : ''),
          style: 'width:' + Math.round(pctCapped * 100) + '%',
          'data-startedat': t.startedAt, 'data-targetseconds': String(t.targetSeconds),
        }));
        targetWrap.appendChild(bar); tile.appendChild(targetWrap);
      }

      if (hasRole('supervisor')) {
        const btnRow = el('div', { className: 'wb-btn-row' });
        const pauseBtn = el('button', {
          className: 'wb-pause-btn' + (t.isPaused ? ' is-paused' : ''),
          textContent: t.isPaused ? '\u25b6 Resume' : '\u23f8 Pause',
          'aria-label': (t.isPaused ? 'Resume' : 'Pause') + ' timer for ' + t.operatorName,
        });
        pauseBtn.addEventListener('click', async () => {
          pauseBtn.disabled = true;
          try {
            if (t.isPaused) { await POST('/pause/' + t.id + '/resume', {}); toast('Timer resumed for ' + t.operatorName, 'success'); }
            else            { await POST('/pause/' + t.id + '/pause', { reason: 'Paused by ' + state.user.fullName }); toast('Timer paused for ' + t.operatorName, ''); }
            await refreshDeptWallboard(dept);
          } catch (err) { toast(err.message, 'error'); pauseBtn.disabled = false; }
        });
        btnRow.appendChild(pauseBtn);
        btnRow.appendChild(el('button', {
          className: 'wb-msg-btn', textContent: '\u2709 Message',
          'aria-label': 'Send message to ' + t.operatorName,
          onclick: () => openSendMessageModal(t.operatorId, t.operatorName),
        }));
        tile.appendChild(btnRow);
      }
      container.appendChild(tile);
    });

    startDeptWallboardTick(dept, pageKey);
  } catch (err) {
    container.innerHTML = '';
    container.appendChild(el('div', { className: 'wallboard-empty', textContent: 'Could not load active timers: ' + err.message }));
  }
}

function startDeptWallboardTick(dept, pageKey) {
  if (_wbTicks[pageKey]) clearInterval(_wbTicks[pageKey]);
  const tilesId = deptIds(dept).tilesId;
  _wbTicks[pageKey] = setInterval(() => {
    if (state.currentPage !== pageKey) { clearInterval(_wbTicks[pageKey]); delete _wbTicks[pageKey]; return; }
    document.getElementById(tilesId)?.querySelectorAll('.wb-elapsed[data-startedat]').forEach(node => {
      const startedAt  = node.getAttribute('data-startedat');
      const pausedSecs = parseInt(node.getAttribute('data-pausedseconds') || '0', 10);
      const isPaused   = node.getAttribute('data-ispaused') === '1';
      if (!startedAt) return;
      const rawElapsed = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
      const elapsed    = Math.max(0, rawElapsed - pausedSecs);
      if (!isPaused) node.textContent = formatDuration(elapsed);
      const tile = node.closest('.wallboard-tile');
      if (!tile || isPaused) return;
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
          const rem = tgt - elapsed;
          lbl.textContent = '\uD83C\uDFAF Target: ' + formatHM(tgt) + '  \u2014  ' + (rem > 0 ? formatHM(rem) + ' remaining' : formatHM(Math.abs(rem)) + ' overdue');
          lbl.className   = 'wb-target-label' + (rem <= 0 ? ' overdue' : '');
        }
      } else {
        if (elapsed > 4 * 3600)      tile.classList.add('tile-overdue');
        else if (elapsed > 2 * 3600) tile.classList.add('tile-warning');
      }
    });
  }, 1000);
}

async function loadDeptWallboardCompact(dept) {
  const { pageKey } = deptCIds(dept);
  if (_wbIntervals[pageKey]) clearInterval(_wbIntervals[pageKey]);
  await refreshDeptWallboardCompact(dept);
  _wbIntervals[pageKey] = setInterval(() => {
    if (document.visibilityState === 'visible') refreshDeptWallboardCompact(dept);
  }, 300000);
}

async function refreshDeptWallboardCompact(dept) {
  const { tilesId, countId, updatedId, pageKey } = deptCIds(dept);
  const container = document.getElementById(tilesId);
  const countEl   = document.getElementById(countId);
  const updatedEl = document.getElementById(updatedId);
  if (!container) return;
  try {
    const deptParam = hasRole('manager') ? `&department=${encodeURIComponent(dept)}` : '';
    const [timers, onlineData] = await Promise.all([
      GET(`/timers?status=active&limit=200${deptParam}`),
      GET('/messages/online').catch(() => ({ online: [] })),
    ]);
    const onlineSet = new Set(onlineData.online || []);
    if (countEl)   countEl.textContent  = timers.length + ' active job' + (timers.length !== 1 ? 's' : '');
    if (updatedEl) updatedEl.textContent = 'Updated ' + new Date().toLocaleTimeString('en-GB');
    container.innerHTML = '';
    if (!timers.length) {
      container.appendChild(el('div', { className: 'wallboard-empty' },
        el('div', { className: 'wallboard-empty-icon', textContent: '\u2713' }),
        el('div', { className: 'wallboard-empty-text', textContent: 'No active jobs right now' })));
      return;
    }
    timers.forEach(t => {
      const sNet    = t.netElapsedSeconds != null ? t.netElapsedSeconds : null;
      const localEl = Math.max(0, Math.floor((Date.now() - new Date(t.startedAt).getTime()) / 1000)) - (t.totalPausedSeconds || 0);
      const elapsed = sNet !== null ? sNet : localEl;
      const tile    = el('div', { className: 'wbc-tile' + (t.isPaused ? ' tile-paused' : '') + (t.handRaised ? ' tile-hand-raised' : '') });
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
      tile.appendChild(el('div', { className: 'wbc-item', textContent: t.itemNumber }));
      if (t.isPaused)   tile.appendChild(el('div', { className: 'wbc-paused-tag', textContent: '\u23f8' }));
      if (t.handRaised) tile.appendChild(el('div', { className: 'wbc-hand-tag',   textContent: '\u270b' }));
      tile.appendChild(el('div', {
        className: 'wbc-elapsed', textContent: formatDuration(elapsed),
        'data-startedat':     t.startedAt,
        'data-targetseconds': t.targetSeconds ? String(t.targetSeconds) : '',
        'data-pausedseconds': String(t.totalPausedSeconds || 0),
        'data-ispaused':      t.isPaused ? '1' : '0',
      }));
      container.appendChild(tile);
    });
    startDeptWallboardCompactTick(dept, pageKey, tilesId);
  } catch (err) {
    container.innerHTML = '';
    container.appendChild(el('div', { className: 'wallboard-empty', textContent: 'Could not load timers: ' + err.message }));
  }
}

function startDeptWallboardCompactTick(dept, pageKey, tilesId) {
  if (_wbTicks[pageKey]) clearInterval(_wbTicks[pageKey]);
  _wbTicks[pageKey] = setInterval(() => {
    if (state.currentPage !== pageKey) { clearInterval(_wbTicks[pageKey]); delete _wbTicks[pageKey]; return; }
    document.getElementById(tilesId)?.querySelectorAll('.wbc-elapsed[data-startedat]').forEach(node => {
      const startedAt  = node.getAttribute('data-startedat');
      const pausedSecs = parseInt(node.getAttribute('data-pausedseconds') || '0', 10);
      const isPaused   = node.getAttribute('data-ispaused') === '1';
      if (!startedAt || isPaused) return;
      const rawElapsed = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
      const elapsed    = Math.max(0, rawElapsed - pausedSecs);
      node.textContent = formatDuration(elapsed);
      const tile = node.closest('.wbc-tile'); if (!tile) return;
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
      openChatDrawer(data);
      break;
    case 'reply':
      if (chat.conversationId && data.conversationId && chatDrawer.hidden && data.conversationId === chat.conversationId) {
        chatDrawer.hidden        = false;
        chatDrawer.style.display = '';
        chatOverlay.hidden       = false;
      }
      appendChatMessage(data);
      break;
    case 'close':
      handleConversationClosed(data);
      break;
    case 'hand_raised':
      if (hasRole('supervisor')) showHandRaisedPopup(data);
      return; // no ping for hand_raised — the popup is notification enough
  }
  playPing(data.type);
}

/* ─── Chat Drawer ─────────────────────────────────────────────────────────── */

// Conversation state — one active conversation at a time per session
function openChatDrawer(data) {
  // Validate — must have a conversationId and a message to be worth opening
  if (!data || !data.conversationId || !data.message) {
    console.warn('[chat] openChatDrawer called with invalid data, ignoring', data);
    return;
  }
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
  if (_charts[key]) { try { _charts[key].destroy(); } catch(_) {} delete _charts[key]; }
}
function forceDestroyCanvas(canvas) {
  if (!canvas || typeof Chart === 'undefined') return;
  try { const ex = Chart.getChart(canvas); if (ex) ex.destroy(); } catch(_) {}
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
  // Sync productivity date pickers to match report range
  const pFrom = document.getElementById('productivityFrom');
  const pTo   = document.getElementById('productivityTo');
  if (pFrom && !pFrom.value) { pFrom.value = ago30; }
  if (pTo   && !pTo.value)   { pTo.value   = today; }
  runReport();
  runProductivitySection();
}

// Use delegation — some buttons are inside hidden sections at load time
document.addEventListener('click', e => {
  if (e.target.id === 'btnReportSearch')       runReport();
  if (e.target.id === 'btnChartSearch')        runCharts();
  if (e.target.id === 'btnProductivityRefresh') runProductivitySection();
  if (e.target.id === 'btnProductivityCSV')    exportProductivityCSV();
});

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
    .forEach(id => { const n = document.getElementById(id); if (n) n.innerHTML = '<div class="empty-state">Loading…</div>'; });

  let stats, operators, trends, overdue, productivity;
  try {
    [stats, operators, trends, overdue, productivity] = await Promise.all([
      GET(`/export/stats?${qs}`),
      GET(`/export/report/operators?${qs}`),
      GET(`/export/report/trends?${qs}`),
      GET(`/export/report/overdue?${qs}`),
      GET(`/export/productivity?${qs}&groupByDay=true`),
    ]);
  } catch (err) {
    console.error('Report fetch error:', err);
    const sc = document.getElementById('reportStatCards');
    if (sc) sc.innerHTML = `<div class="error-msg" style="padding:16px">Could not load report data: ${err.message}</div>`;
    return;
  }
  trends       = trends       || [];
  operators    = operators    || [];
  overdue      = overdue      || { byItem: [], byOperator: [] };
  productivity = productivity || [];

  renderReportStatCards(stats);
  renderReportTrendTable(trends);
  renderReportItemTable(stats?.byItem || []);
  renderReportOperatorTable(operators);
  renderReportOverdue(overdue);
  renderProductivityTable(productivity?.operators || [], productivity?.targetPct || 80, productivity?.operators?.[0]?.daily?.length > 0);
}

async function runProductivitySection() {
  const from = document.getElementById('productivityFrom')?.value;
  const to   = document.getElementById('productivityTo')?.value;
  const params = new URLSearchParams();
  if (from) params.set('from', new Date(from).toISOString());
  if (to)   { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  params.set('groupByDay', 'true');
  const container = document.getElementById('reportProductivityTable');
  if (container) container.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const data = await GET(`/export/productivity?${params}`);
    renderProductivityTable(data?.operators || [], data?.targetPct || 80, true);
  } catch (err) {
    if (container) container.innerHTML = `<div class="error-msg" style="padding:16px">Could not load productivity data: ${err.message}</div>`;
  }
}

function exportProductivityCSV() {
  const from = document.getElementById('productivityFrom')?.value;
  const to   = document.getElementById('productivityTo')?.value;
  const params = new URLSearchParams();
  if (from) params.set('from', new Date(from).toISOString());
  if (to)   { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  window.location.href = `/api/export/productivity/csv?${params}`;
}

// ── CHARTS PAGE ───────────────────────────────────────────────────────────────

function loadChartsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const ago30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const rFrom = document.getElementById('reportFrom')?.value;
  const rTo   = document.getElementById('reportTo')?.value;
  if (!document.getElementById('chartFrom').value) {
    document.getElementById('chartFrom').value = rFrom || ago30;
    document.getElementById('chartTo').value   = rTo   || today;
  }
  runCharts();
}

async function runCharts() {
  const from = document.getElementById('chartFrom').value;
  const to   = document.getElementById('chartTo').value;
  const params = new URLSearchParams();
  if (from) params.set('from', new Date(from).toISOString());
  if (to)   { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  const qs = params.toString();

  // Show loading state in all three wraps
  document.querySelectorAll('#pageCharts .report-chart-wrap').forEach(wrap => {
    wrap.innerHTML = '<div style="padding:40px 0;text-align:center;color:var(--text2)">Loading…</div>';
  });

  let stats, operators, trends;
  try {
    [stats, operators, trends] = await Promise.all([
      GET(`/export/stats?${qs}`),
      GET(`/export/report/operators?${qs}`),
      GET(`/export/report/trends?${qs}`),
    ]);
  } catch (err) {
    document.querySelectorAll('#pageCharts .report-chart-wrap').forEach(wrap => {
      wrap.innerHTML = `<div style="padding:40px 0;text-align:center;color:var(--red)">Error: ${err.message}</div>`;
    });
    return;
  }

  trends    = trends    || [];
  operators = operators || [];
  const byItem = stats?.byItem || [];

  // Use named div containers for SVG charts — no canvas, no timing issues
  const chartDefs = [
    { id: 'chartDailyTrendSVG',  label: 'Daily Trend' },
    { id: 'chartItemOnTimeSVG',  label: 'On-Time vs Over Target' },
    { id: 'chartOperatorSVG',    label: 'Operator Performance' },
  ];
  const wraps = document.querySelectorAll('#pageCharts .report-chart-wrap');
  wraps.forEach((wrap, i) => {
    wrap.innerHTML = '';
    const div = document.createElement('div');
    div.id = chartDefs[i].id;
    div.style.cssText = 'width:100%;height:100%';
    wrap.appendChild(div);
  });

  // Render SVG charts directly — no library, no timing issues
  renderChartDailyTrend(trends);
  renderChartItemOnTime(byItem);
  renderChartOperator(operators);
}

// ── CHART RENDERERS — pure SVG, no Chart.js dependency ──────────────────────

const CHART_COLORS = {
  blue:  '#4299e1',
  red:   '#ef4444',
  green: '#22c55e',
  amber: '#f0b429',
  grid:  'rgba(255,255,255,0.07)',
  text:  '#9aa0b8',
  bg2:   '#171b26',
};

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function makeSVGChart(wrap, W, H) {
  wrap.innerHTML = '';
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%',
    style: 'display:block;overflow:visible' });
  wrap.appendChild(svg);
  return svg;
}

function drawBarChart(containerId, { labels, datasets, title, yLabel }) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;

  const W = 700, H = 320;
  const PAD = { top: 30, right: 20, bottom: 60, left: 55 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;

  const svg = makeSVGChart(wrap, W, H);

  // Find max value across all datasets
  const allVals = datasets.flatMap(d => d.data);
  const maxVal  = Math.max(...allVals, 1);
  const yTicks  = 5;
  const yStep   = Math.ceil(maxVal / yTicks);
  const yMax    = yStep * yTicks;

  // Grid lines + Y axis labels
  for (let i = 0; i <= yTicks; i++) {
    const val = yStep * i;
    const y   = PAD.top + chartH - (val / yMax) * chartH;
    svg.appendChild(svgEl('line', { x1: PAD.left, y1: y, x2: PAD.left + chartW, y2: y,
      stroke: CHART_COLORS.grid, 'stroke-width': 1 }));
    const lbl = svgEl('text', { x: PAD.left - 8, y: y + 4, 'text-anchor': 'end',
      fill: CHART_COLORS.text, 'font-size': '11', 'font-family': 'sans-serif' });
    lbl.textContent = val;
    svg.appendChild(lbl);
  }

  // Bars
  const nGroups  = labels.length;
  const nDatasets = datasets.length;
  const groupW   = chartW / nGroups;
  const barPad   = groupW * 0.15;
  const barW     = (groupW - barPad * 2) / nDatasets;

  datasets.forEach((ds, di) => {
    ds.data.forEach((val, gi) => {
      if (!val) return;
      const barH = (val / yMax) * chartH;
      const x    = PAD.left + gi * groupW + barPad + di * barW;
      const y    = PAD.top + chartH - barH;
      const rect = svgEl('rect', { x, y, width: barW - 2, height: barH,
        fill: ds.color, rx: 3 });
      // Tooltip on hover
      const t = svgEl('title'); t.textContent = `${ds.label}: ${val}`;
      rect.appendChild(t);
      svg.appendChild(rect);
    });
  });

  // X axis labels
  labels.forEach((lbl, gi) => {
    const x = PAD.left + gi * groupW + groupW / 2;
    const t = svgEl('text', { x, y: PAD.top + chartH + 18, 'text-anchor': 'middle',
      fill: CHART_COLORS.text, 'font-size': '11', 'font-family': 'sans-serif' });
    t.textContent = lbl;
    svg.appendChild(t);
  });

  // Y axis label
  const yAxisLbl = svgEl('text', {
    x: 12, y: PAD.top + chartH / 2,
    'text-anchor': 'middle', fill: CHART_COLORS.text,
    'font-size': '11', 'font-family': 'sans-serif',
    transform: `rotate(-90, 12, ${PAD.top + chartH / 2})`,
  });
  yAxisLbl.textContent = yLabel || '';
  svg.appendChild(yAxisLbl);

  // Legend
  let lx = PAD.left;
  datasets.forEach(ds => {
    const rect = svgEl('rect', { x: lx, y: H - 18, width: 12, height: 12,
      fill: ds.color, rx: 2 });
    svg.appendChild(rect);
    const t = svgEl('text', { x: lx + 16, y: H - 8, fill: CHART_COLORS.text,
      'font-size': '11', 'font-family': 'sans-serif' });
    t.textContent = ds.label;
    svg.appendChild(t);
    lx += ds.label.length * 7 + 30;
  });
}

function drawLineOverlay(containerId, { labels, data, color, yMax, label }) {
  // Overlay a line on an existing chart SVG
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const svg  = wrap.querySelector('svg');
  if (!svg)  return;

  const W = 700, H = 320;
  const PAD = { top: 30, right: 20, bottom: 60, left: 55 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;
  const localMax = Math.max(...data, 1);
  const scale = localMax > 0 ? yMax / localMax : 1;

  const nGroups = labels.length;
  const groupW  = chartW / nGroups;

  const points = data.map((val, gi) => {
    const x = PAD.left + gi * groupW + groupW / 2;
    const y = PAD.top + chartH - (val / localMax) * chartH;
    return `${x},${y}`;
  });

  if (points.length > 1) {
    const poly = svgEl('polyline', {
      points: points.join(' '),
      fill: 'none', stroke: color, 'stroke-width': 2.5,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    });
    svg.appendChild(poly);
  }

  // Dots
  data.forEach((val, gi) => {
    const x = PAD.left + gi * groupW + groupW / 2;
    const y = PAD.top + chartH - (val / localMax) * chartH;
    const circle = svgEl('circle', { cx: x, cy: y, r: 4, fill: color });
    const t = svgEl('title'); t.textContent = `${label}: ${Math.round(val / 60)}m avg`;
    circle.appendChild(t);
    svg.appendChild(circle);
  });

  // Add to legend
  let lx = PAD.left;
  svg.querySelectorAll('text').forEach(t => {
    if (parseFloat(t.getAttribute('y')) > H - 25) {
      lx = Math.max(lx, parseFloat(t.getAttribute('x')) + t.textContent.length * 7 + 20);
    }
  });
  const r = svgEl('circle', { cx: lx + 6, cy: H - 12, r: 6, fill: color });
  svg.appendChild(r);
  const lt = svgEl('text', { x: lx + 16, y: H - 8, fill: CHART_COLORS.text,
    'font-size': '11', 'font-family': 'sans-serif' });
  lt.textContent = label;
  svg.appendChild(lt);
}

function renderChartDailyTrend(rows) {
  const wrap = document.querySelector('#pageCharts .report-chart-wrap:nth-child(1)') ||
               document.getElementById('chartDailyTrend')?.closest('.report-chart-wrap');
  if (!wrap) return;

  if (!rows || !rows.length) {
    wrap.innerHTML = '<div style="padding:40px 0;text-align:center;color:var(--text2);font-size:14px">No completed jobs found for this date range.</div>';
    return;
  }

  const labels  = rows.map(r => new Date(r.day).toLocaleDateString('en-GB', { day:'2-digit', month:'short' }));
  const jobs    = rows.map(r => r.jobs_completed || 0);
  const overdue = rows.map(r => r.overdue_count  || 0);
  const avgMins = rows.map(r => r.avg_seconds     || 0);

  drawBarChart('chartDailyTrendSVG', {
    labels,
    datasets: [
      { label: 'Jobs Completed', data: jobs,    color: CHART_COLORS.blue  },
      { label: 'Over Target',    data: overdue, color: CHART_COLORS.red   },
    ],
    yLabel: 'Jobs',
  });
  drawLineOverlay('chartDailyTrendSVG', {
    labels, data: avgMins, color: CHART_COLORS.amber, label: 'Avg Secs',
  });
}

function renderChartItemOnTime(rows) {
  const wrap = document.querySelector('#pageCharts .report-chart-wrap:nth-child(2)') ||
               document.getElementById('chartItemOnTimeSVG')?.closest('.report-chart-wrap');
  if (!wrap) return;

  const withTarget = (rows || []).filter(r => r.target_seconds).slice(0, 12);
  if (!withTarget.length) {
    wrap.innerHTML = '<div style="padding:40px 0;text-align:center;color:var(--text2);font-size:14px">No items with target times set.</div>';
    return;
  }

  const labels = withTarget.map(r => r.item_number);
  const over   = withTarget.map(r => Math.round(r.avg_seconds || 0) > r.target_seconds ? r.count : 0);
  const onTime = withTarget.map((r, i) => (r.count || 0) - over[i]);

  drawBarChart('chartItemOnTimeSVG', {
    labels,
    datasets: [
      { label: 'On Time',     data: onTime, color: CHART_COLORS.green },
      { label: 'Over Target', data: over,   color: CHART_COLORS.red   },
    ],
    yLabel: 'Jobs',
  });
}

function renderChartOperator(rows) {
  const wrap = document.querySelector('#pageCharts .report-chart-wrap:nth-child(3)') ||
               document.getElementById('chartOperatorSVG')?.closest('.report-chart-wrap');
  if (!wrap) return;

  if (!rows || !rows.length) {
    wrap.innerHTML = '<div style="padding:40px 0;text-align:center;color:var(--text2);font-size:14px">No operator data for this date range.</div>';
    return;
  }

  const labels  = rows.map(r => r.operator_name.split(' ')[0]);
  const jobs    = rows.map(r => r.jobs_completed || 0);
  const overdue = rows.map(r => r.overdue_count  || 0);
  const avgMins = rows.map(r => r.avg_seconds     || 0);

  drawBarChart('chartOperatorSVG', {
    labels,
    datasets: [
      { label: 'Jobs Completed', data: jobs,    color: CHART_COLORS.blue },
      { label: 'Over Target',    data: overdue, color: CHART_COLORS.red  },
    ],
    yLabel: 'Jobs',
  });
  drawLineOverlay('chartOperatorSVG', {
    labels, data: avgMins, color: CHART_COLORS.amber, label: 'Avg Secs',
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