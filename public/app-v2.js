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
  features:                 {},
  thresholds:               {},
};

// Per-instance thresholds (WT-DESIGN-001) with current Philtronics defaults.
// Returned as fractions / seconds ready for comparison against progress.
function warnFrac()    { return (state.thresholds.warningPct != null ? state.thresholds.warningPct : 80) / 100; }
function overdueFrac() { return (state.thresholds.overduePct != null ? state.thresholds.overduePct : 100) / 100; }
function noTargetWarnSecs() { return (state.thresholds.noTargetWarningMinutes != null ? state.thresholds.noTargetWarningMinutes : 120) * 60; }
function noTargetOverdueSecs() { return noTargetWarnSecs() * 2; } // reference: 2x the warning point

// Terminology override (WT-DESIGN-001). Returns the customer's preferred label
// for a term, or the built-in default. e.g. term('routeCard', 'Route Card').
function term(key, fallback) {
  const t = state.terminology || {};
  return (t && t[key]) ? t[key] : fallback;
}

// True while the Adjust Times modal is open, used to pause wallboard refresh.
let _adjustModalOpen = false;

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

// 'planner' shares manager's level (3): same general access as a manager. The
// planner's EXTRA power (writing the planner / order book) is a capability, not a
// level, so it is checked with canPlanWrite() -- never hasRole('planner'), which
// a manager would also pass.
const ROLE_LEVEL = { operator: 1, supervisor: 2, manager: 3, planner: 3, administrator: 4, superuser: 5 };
function hasRole(min) {
  return state.user && (ROLE_LEVEL[state.user.role] || 0) >= (ROLE_LEVEL[min] || 99);
}
// Mirror of the server's canPlanWrite: only the planner role and the superuser may
// modify the plan / order book. Everyone else (supervisor..administrator) is read-only.
function canPlanWrite() {
  return !!state.user && (state.user.role === 'planner' || state.user.role === 'superuser');
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
function closeModal() {
  document.getElementById('modal').hidden = true;
  if (_adjustModalOpen) {
    _adjustModalOpen = false;
    // If a full wallboard is showing, refresh it so an adjusted start time appears.
    const p = state.currentPage;
    if (p && p.startsWith('wb-') && PAGES[p] && PAGES[p].dept) {
      refreshDeptWallboard(PAGES[p].dept);
    }
  }
}

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
  planner:        { id: 'pagePlanner',           label: '📅 Planner',                    minRole: 'supervisor'  },
  pushpull:       { id: 'pagePushPull',          label: '🔀 Push/Pull',                  minRole: 'manager'     },
  dashboard:      { id: 'pageDashboard',         label: 'Dashboard',                     minRole: 'manager'     },
  targets:        { id: 'pageTargets',           label: 'Target Times',                  minRole: 'manager'     },
  reports:        { id: 'pageReports',           label: 'Reports',                       minRole: 'manager'     },
  charts:         { id: 'pageCharts',            label: 'Charts',                        minRole: 'manager'     },
  devrequests:    { id: 'pageDevRequests',       label: '💡 Dev Requests',               minRole: 'supervisor'  },
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
  const topPages    = ['home','timer','history','planner','pushpull','dashboard','targets','reports','charts','devrequests','admin'];
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
  else if (page === 'planner')   loadPlannerPage();
  else if (page === 'pushpull')  loadPushPullPage();
  else if (page === 'targets')   loadTargetsPage();
  else if (page === 'reports')   loadReportsPage();
  else if (page === 'charts')    loadChartsPage();
  else if (page === 'devrequests') loadDevRequestsPage();
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
  await applyBranding();
  try {
    state.user = await GET('/me');
    onLoggedIn();
  } catch {
    showLoginPage();
  }
}

// Apply per-instance branding (WT-DESIGN-001). Defaults reproduce the current
// Philtronics look, so this is inert until an instance overrides a value.
let _branding = null;
async function applyBranding() {
  try { _branding = await GET('/settings/public'); }
  catch (_) { return; }
  if (!_branding) return;
  // Primary colour → CSS variable used across the theme.
  if (_branding.primaryColour) {
    document.documentElement.style.setProperty('--blue', _branding.primaryColour);
    document.documentElement.style.setProperty('--accent-blue', _branding.primaryColour);
  }
  // Customer name → the "Developed for" client-brand label on login.
  const clientLabel = document.querySelector('.login-client-brand-label');
  if (clientLabel && _branding.customerName) clientLabel.textContent = 'For ' + _branding.customerName;
  // Optional login welcome text.
  if (_branding.loginText) {
    let lt = document.getElementById('loginCustomText');
    if (!lt) {
      const sub = document.querySelector('.login-subtitle') || document.querySelector('.login-title');
      if (sub && sub.parentNode) {
        lt = el('p', { id: 'loginCustomText', className: 'login-custom-text' });
        sub.parentNode.insertBefore(lt, sub.nextSibling);
      }
    }
    if (lt) lt.textContent = _branding.loginText;
  }
  // Optional customer logo (replaces the client logo if provided).
  if (_branding.logoUrl) {
    document.querySelectorAll('.login-client-logo').forEach(img => { img.src = _branding.logoUrl; });
  }
  // Stash enabled features for feature-toggle checks elsewhere.
  state.features = _branding.features || {};
  state.thresholds = _branding.thresholds || {};
  applyFeatureToggles();
}

// Hide UI for features switched off for this instance. Defaults are all-on.
function applyFeatureToggles() {
  const f = state.features || {};
  const toggle = (on, selector) => {
    if (on === false) document.querySelectorAll(selector).forEach(el => { el.hidden = true; el.style.display = 'none'; });
  };
  // These are best-effort hides; the server still enforces availability.
  toggle(f.messaging,   '[data-feature="messaging"]');
  toggle(f.raisedHands, '[data-feature="raised-hands"]');
  toggle(f.timeCheck,   '[data-feature="time-check"]');
  toggle(f.availability,'[data-feature="availability"]');
  toggle(f.qualityRft,  '[data-feature="quality-rft"]');
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
      if (me.activeTimer.workstation)     metaParts.push('WS: ' + me.activeTimer.workstation);
      if (me.activeTimer.woNumber)        metaParts.push('W/O: ' + me.activeTimer.woNumber);
      if (me.activeTimer.routeCardNumber) metaParts.push('RC: ' + me.activeTimer.routeCardNumber);
      if (me.activeTimer.timerCategory === 'rework') metaParts.push('🔄 REWORK');
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
  refreshAvailabilityBar();
  refreshStandaloneHandBar();
  // Poll for auto-pause changes from the schedule
  if (state.activeTimerId) startPausePoll();
  else stopPausePoll();
}

/* ─── Raise hand without a running job (standalone hands) ─────────────────── */
// Only relevant on the start panel (no active timer). Lets an operator signal
// for help before starting a job; the hand carries onto the job when they start.
async function refreshStandaloneHandBar() {
  const bar = document.getElementById('standaloneHandBar');
  if (!bar) return;
  // Only operators, and only when no job is running (start panel showing).
  if ((state.user && state.user.role !== 'operator') || state.activeTimerId) { bar.hidden = true; return; }
  let status = { raised: false };
  try { status = await GET('/timers/my-hand'); } catch (_) {}
  bar.hidden = false;
  bar.innerHTML = '';
  if (status.raised) {
    bar.className = 'standalone-hand-bar raised';
    const info = el('div', { className: 'shb-info' });
    info.appendChild(el('span', { className: 'shb-text', textContent: '\u270b Your hand is raised — a supervisor has been notified.' }));
    bar.appendChild(info);
    const btn = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Lower Hand' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await POST('/timers/lower-hand-standalone', {}); toast('Hand lowered.', ''); refreshStandaloneHandBar(); }
      catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
    bar.appendChild(btn);
  } else {
    bar.className = 'standalone-hand-bar';
    const info = el('div', { className: 'shb-info' });
    info.appendChild(el('span', { className: 'shb-text-muted', textContent: 'Need help before starting a job?' }));
    bar.appendChild(info);
    const btn = el('button', { className: 'btn btn-overtime btn-sm', textContent: '\u270b Raise Hand' });
    btn.style.width = 'auto';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await POST('/timers/raise-hand-standalone', {}); toast('Hand raised — a supervisor has been notified.', 'success'); refreshStandaloneHandBar(); }
      catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
    bar.appendChild(btn);
  }
}

/* ─── Operator availability (stage 2) ─────────────────────────────────────── */
// Lets an operator declare themselves unavailable (training, meeting, half-day,
// late start) when no job is running — the gap a paused timer can't reach.
let _availReasons = null;

async function loadAvailReasons() {
  if (_availReasons) return _availReasons;
  try {
    const all = await GET('/pause/reasons');
    _availReasons = all.filter(r => r.id && r.isAvailable === false); // non-available only
  } catch (_) { _availReasons = []; }
  return _availReasons;
}

async function refreshAvailabilityBar() {
  const bar = document.getElementById('availabilityBar');
  if (!bar) return;
  // Only operators declare their own availability.
  if (state.user && state.user.role !== 'operator') { bar.hidden = true; return; }
  let status = { active: false };
  try { status = await GET('/availability/me'); } catch (_) {}
  bar.hidden = false;
  bar.innerHTML = '';
  if (status.active) {
    bar.className = 'availability-bar unavailable';
    const info = el('div', { className: 'avail-info' });
    info.appendChild(el('span', { className: 'avail-dot' }));
    info.appendChild(el('span', { className: 'avail-text', textContent: 'You are marked unavailable: ' + status.reasonLabel }));
    bar.appendChild(info);
    const btn = el('button', { className: 'btn btn-primary btn-sm', textContent: "I'm back — Available" });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await POST('/availability/end', {}); toast('Welcome back — marked available.', 'success'); refreshAvailabilityBar(); }
      catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
    bar.appendChild(btn);
  } else {
    bar.className = 'availability-bar available';
    const info = el('div', { className: 'avail-info' });
    info.appendChild(el('span', { className: 'avail-text-muted', textContent: 'Not working a job right now? Mark training, a meeting or time away so it does not count against your productivity.' }));
    bar.appendChild(info);
    const btn = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Mark Unavailable' });
    btn.addEventListener('click', () => openUnavailablePicker());
    bar.appendChild(btn);
  }
}

async function openUnavailablePicker() {
  const reasons = await loadAvailReasons();
  if (!reasons.length) { toast('No unavailable reasons are configured.', ''); return; }
  const wrap = el('div', { className: 'pause-reason-list' });
  wrap.appendChild(el('p', { className: 'pause-reason-intro', textContent: 'Why are you unavailable? This time will be excluded from your productivity.' }));
  reasons.forEach(r => {
    const row = el('button', { className: 'pause-reason-btn pause-reason-na' });
    row.appendChild(el('span', { className: 'pause-reason-label', textContent: r.label }));
    row.appendChild(el('span', { className: 'pause-reason-tag', textContent: 'excluded from productivity' }));
    row.addEventListener('click', async () => {
      closeModal();
      try { await POST('/availability/start', { reasonId: r.id }); toast('Marked unavailable: ' + r.label, ''); refreshAvailabilityBar(); }
      catch (err) { toast(err.message, 'error'); }
    });
    wrap.appendChild(row);
  });
  openModal('Mark Unavailable', wrap, []);
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
      state.activePauseType            = t.pauseType || null;
      state.activePausedAt             = t.pausedAt || null;
      state.activeTotalPausedSeconds   = t.totalPausedSeconds || 0;
      state.activeHandRaised           = t.handRaised || false;
      document.getElementById('activeItemDisplay').textContent = t.itemNumber;
      const metaParts = [`Started at ${formatLocalTime(t.startedAt)}`];
      if (t.workstation)     metaParts.push('WS: ' + t.workstation);
      if (t.woNumber)        metaParts.push('W/O: ' + t.woNumber);
      if (t.routeCardNumber) metaParts.push('RC: ' + t.routeCardNumber);
      if (t.timerCategory === 'rework') metaParts.push('🔄 REWORK');
      document.getElementById('activeMeta').textContent = metaParts.join('  ·  ');
      state.activeTargetSeconds = t.targetSeconds || null;
      state._activeTimerObj = t;
      updateActiveTargetDisplay();
      updatePauseUI();
      updateHandUI();
      // Adjust button — supervisors and above only (corrects a rogue timer).
      const adjBtnEl = document.getElementById('btnAdjustTimer');
      if (adjBtnEl) adjBtnEl.hidden = !hasRole('supervisor');
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
  const itemNumber   = document.getElementById('itemNumberInput').value.trim();
  const workstation  = document.getElementById('startWorkstation').value.trim();
  const woNumber     = document.getElementById('startWoNumber').value.trim();
  const routeCard    = document.getElementById('startRouteCard').value.trim();
  const quantityRaw  = document.getElementById('startQuantity') ? document.getElementById('startQuantity').value.trim() : '1';
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

  // Quantity: positive integer, default 1. Only meaningful with a route card,
  // since it expands into that many contiguous route cards on completion.
  const quantity = parseInt(quantityRaw || '1', 10);
  if (isNaN(quantity) || quantity < 1 || quantity > 999 || String(quantity) !== String(quantityRaw || '1')) {
    setError('startError', 'Quantity must be a whole number between 1 and 999.');
    if (document.getElementById('startQuantity')) document.getElementById('startQuantity').focus();
    return;
  }
  if (quantity > 1 && !routeCard) {
    setError('startError', 'A starting Route Card number is required when Quantity is more than 1.');
    document.getElementById('startRouteCard').focus();
    return;
  }
  if (quantity > 1 && !/^\d+$/.test(routeCard)) {
    setError('startError', 'For a multi-quantity run, the Route Card number must be numeric (the run covers contiguous cards from that number).');
    document.getElementById('startRouteCard').focus();
    return;
  }

  // ── Assembly resume check ────────────────────────────────────────────────
  // Declare btn early so it can be re-enabled if the user cancels the prompt
  const btn = document.getElementById('btnStart');
  btn.disabled = true;

  if (woNumber && routeCard) {
    try {
      const fmtSecs = s => {
        if (!s) return '0m';
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        return h > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`;
      };
      const asm = await GET(
        `/timers/assembly?item=${encodeURIComponent(itemNumber)}&wo=${encodeURIComponent(woNumber)}&rc=${encodeURIComponent(routeCard)}`
      );
      // Only ask "continuation or rework?" when the operator's OWN stage
      // (department) already has finished work on this assembly. Prior work in a
      // different stage — e.g. Stores picking before a Production build — is a
      // normal handover to the next stage, not a return to this one, so it must
      // not trigger the prompt. The per-stage breakdown is still shown for context.
      if (asm && asm.ownStage && asm.ownStage.priorWork) {
        const myStage   = (asm.stages || []).find(s => s.department === asm.ownStage.department) || { operators: [], totalSeconds: 0 };
        const operators = (myStage.operators || []).map(o => ({
          operatorId: o.operatorId, operatorName: o.operatorName,
          totalSeconds: o.totalSeconds, totalDisplay: fmtSecs(o.totalSeconds),
          stints: Array.from({ length: o.timerCount || 0 }),
        }));
        const assemblyObj = {
          itemNumber, woNumber, routeCardNumber: routeCard,
          operatorCount:   operators.length,
          operators,
          combinedSeconds: myStage.totalSeconds,
          combinedDisplay: fmtSecs(myStage.totalSeconds),
          elapsedDisplay:  null,
          multiOperator:   operators.length > 1,
          ownStageDepartment:    asm.ownStage.department,
          lifecycleTotalDisplay: fmtSecs(asm.totalSeconds),
          stages: (asm.stages || []).map(s => ({
            department: s.department, totalDisplay: fmtSecs(s.totalSeconds),
            hasActive: s.hasActive, isOwn: s.department === asm.ownStage.department,
          })),
        };
        const result = await showAssemblyResumePrompt(assemblyObj);
        if (result === null) { btn.disabled = false; return; }
        window._timerCategory = result.category || 'work';
      }
    } catch (checkErr) {
      console.warn('Assembly resume check failed:', checkErr.message);
    }
  }
  // ── End assembly resume check ────────────────────────────────────────────

  window._timerCategory = window._timerCategory || 'work';
  btn.disabled = true;
  try {
    let timer;
    try {
      timer = await POST('/timers/start', {
        itemNumber,
        timeCheck,
        workstation:     workstation     || undefined,
        woNumber:        woNumber        || undefined,
        routeCardNumber: routeCard       || undefined,
        quantity:        quantity,
        timerCategory:   window._timerCategory || 'work',
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
    document.getElementById('startRouteCard').value   = '';
    if (document.getElementById('startQuantity')) document.getElementById('startQuantity').value = '1';
    document.getElementById('startTimeCheck').checked = false;
    window._timerCategory = 'work';
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
document.getElementById('btnAdjustTimer') && document.getElementById('btnAdjustTimer').addEventListener('click', () => {
  if (!state.activeTimerId || !state._activeTimerObj) return;
  openAdjustTimerModal(state._activeTimerObj, null);
});

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
    fill.className   = 'active-target-fill' + (over ? ' over' : pct >= warnFrac() ? ' warn' : '');
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
      lbl.className   = 'active-target-label' + (pct >= warnFrac() ? ' warn' : '');
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
/* ═══════════════════════════════════════════════════════════════════════════
   DEV REQUESTS  (mini-forum: supervisor and above)
   ═══════════════════════════════════════════════════════════════════════════ */
const DEV_STATUS = {
  requested:    { label: 'Requested',    cls: 'st-requested'   },
  under_review: { label: 'Under Review', cls: 'st-review'      },
  planned:      { label: 'Planned',      cls: 'st-planned'     },
  in_progress:  { label: 'In Progress',  cls: 'st-progress'    },
  done:         { label: 'Done',         cls: 'st-done'        },
  declined:     { label: 'Declined',     cls: 'st-declined'    },
};
const DEV_STATUS_ORDER = ['requested','under_review','planned','in_progress','done','declined'];
const _devState = { sort: 'active', status: '', currentId: null };

function devTimeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s/60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h/24); if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-GB');
}

function devStatusBadge(status) {
  const s = DEV_STATUS[status] || DEV_STATUS.requested;
  return el('span', { className: `dev-status-badge ${s.cls}`, textContent: s.label });
}

async function loadDevRequestsPage() {
  document.getElementById('devReqDetailView').hidden = true;
  document.getElementById('devReqListView').hidden = false;
  _devState.currentId = null;

  // Wire toolbar once
  const sortTabs = document.getElementById('devSortTabs');
  if (sortTabs && !sortTabs._wired) {
    sortTabs._wired = true;
    sortTabs.addEventListener('click', e => {
      const b = e.target.closest('.dev-sort-tab'); if (!b) return;
      _devState.sort = b.getAttribute('data-sort');
      sortTabs.querySelectorAll('.dev-sort-tab').forEach(t => t.classList.toggle('active', t === b));
      renderDevReqList();
    });
  }
  const filter = document.getElementById('devStatusFilter');
  if (filter && !filter._wired) {
    filter._wired = true;
    filter.addEventListener('change', () => { _devState.status = filter.value; renderDevReqList(); });
  }
  const newBtn = document.getElementById('btnNewDevRequest');
  if (newBtn && !newBtn._wired) {
    newBtn._wired = true;
    newBtn.addEventListener('click', () => openDevRequestForm(null));
  }

  renderDevReqList();
}

async function renderDevReqList() {
  const list = document.getElementById('devReqList');
  list.innerHTML = '';
  list.appendChild(el('div', { className: 'empty-state', textContent: 'Loading…' }));
  try {
    const params = new URLSearchParams();
    params.set('sort', _devState.sort);
    if (_devState.status) params.set('status', _devState.status);
    const requests = await GET(`/dev-requests?${params}`);
    list.innerHTML = '';
    if (!requests.length) {
      list.appendChild(el('div', { className: 'empty-state', textContent: 'No requests yet. Be the first to suggest an improvement.' }));
      return;
    }
    for (const r of requests) list.appendChild(devReqCard(r));
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(el('div', { className: 'error-msg', textContent: err.message }));
  }
}

function devReqCard(r) {
  const voteBtn = el('button', {
    className: 'dev-vote' + (r.hasVoted ? ' voted' : ''),
    title: r.hasVoted ? 'Remove your vote' : 'Upvote this request',
    onclick: async (e) => { e.stopPropagation(); await toggleDevVote(r.id, voteBtn); },
  },
    el('span', { className: 'dev-vote-arrow', textContent: '▲' }),
    el('span', { className: 'dev-vote-count', textContent: String(r.voteCount) })
  );

  const meta = el('div', { className: 'dev-card-meta' },
    devStatusBadge(r.status),
    el('span', { className: 'dev-card-author', textContent: r.authorName }),
    el('span', { className: 'dev-card-dot', textContent: '·' }),
    el('span', { className: 'dev-card-time', textContent: devTimeAgo(r.lastActivityAt) }),
    el('span', { className: 'dev-card-comments', textContent: `💬 ${r.commentCount}` }),
  );

  const body = el('div', { className: 'dev-card-body' },
    el('h3', { className: 'dev-card-title', textContent: r.title }),
    meta,
  );

  const card = el('div', { className: 'dev-req-card', onclick: () => openDevRequest(r.id) }, voteBtn, body);
  return card;
}

async function toggleDevVote(id, btnEl) {
  try {
    const res = await POST(`/dev-requests/${id}/vote`);
    btnEl.classList.toggle('voted', res.hasVoted);
    const countEl = btnEl.querySelector('.dev-vote-count');
    if (countEl) countEl.textContent = String(res.voteCount);
  } catch (err) { toast(err.message, 'error'); }
}

async function openDevRequest(id) {
  _devState.currentId = id;
  const listView = document.getElementById('devReqListView');
  const detail   = document.getElementById('devReqDetailView');
  listView.hidden = true;
  detail.hidden = false;
  detail.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const r = await GET(`/dev-requests/${id}`);
    renderDevRequestDetail(r);
  } catch (err) {
    detail.innerHTML = '';
    detail.appendChild(el('div', { className: 'error-msg', textContent: err.message }));
  }
}

function renderDevRequestDetail(r) {
  const detail = document.getElementById('devReqDetailView');
  detail.innerHTML = '';

  // Back link
  detail.appendChild(el('button', {
    className: 'dev-back', textContent: '← Back to all requests',
    onclick: () => loadDevRequestsPage(),
  }));

  // Header: vote + title + status
  const voteBtn = el('button', {
    className: 'dev-vote dev-vote-lg' + (r.hasVoted ? ' voted' : ''),
    title: r.hasVoted ? 'Remove your vote' : 'Upvote this request',
    onclick: async () => { await toggleDevVote(r.id, voteBtn); },
  },
    el('span', { className: 'dev-vote-arrow', textContent: '▲' }),
    el('span', { className: 'dev-vote-count', textContent: String(r.voteCount) })
  );

  const titleWrap = el('div', { className: 'dev-detail-titlewrap' },
    el('h2', { className: 'dev-detail-title', textContent: r.title }),
    el('div', { className: 'dev-detail-meta' },
      devStatusBadge(r.status),
      el('span', { className: 'dev-card-author', textContent: `by ${r.authorName}` }),
      el('span', { className: 'dev-card-dot', textContent: '·' }),
      el('span', { className: 'dev-card-time', textContent: devTimeAgo(r.createdAt) }),
    ),
  );

  detail.appendChild(el('div', { className: 'dev-detail-header' }, voteBtn, titleWrap));

  // Body text
  if (r.body) {
    detail.appendChild(el('div', { className: 'dev-detail-body' }, devMultiline(r.body)));
  }

  // Action row: edit (author/SU), status control (SU), delete (SU)
  const actions = el('div', { className: 'dev-detail-actions' });
  if (r.canEdit) {
    actions.appendChild(el('button', { className: 'btn btn-ghost btn-sm', textContent: '✎ Edit',
      onclick: () => openDevRequestForm(r) }));
  }
  if (r.canChangeStatus) {
    const sel = el('select', { className: 'dev-status-select', 'aria-label': 'Change status',
      onchange: async () => { await changeDevStatus(r.id, sel.value); } });
    for (const key of DEV_STATUS_ORDER) {
      const opt = el('option', { value: key, textContent: DEV_STATUS[key].label });
      if (key === r.status) opt.selected = true;
      sel.appendChild(opt);
    }
    actions.appendChild(el('span', { className: 'dev-status-control' },
      el('span', { className: 'dev-status-label', textContent: 'Status:' }), sel));
  }
  if (r.canDelete) {
    actions.appendChild(el('button', { className: 'btn btn-ghost btn-sm dev-danger', textContent: '🗑 Delete',
      onclick: () => confirmDeleteDevRequest(r.id) }));
  }
  if (actions.children.length) detail.appendChild(actions);

  // Comment thread
  detail.appendChild(el('h3', { className: 'dev-thread-heading', textContent: `Discussion (${r.comments.length})` }));
  const thread = el('div', { className: 'dev-thread' });
  if (!r.comments.length) {
    thread.appendChild(el('div', { className: 'empty-state', textContent: 'No comments yet. Start the conversation.' }));
  } else {
    for (const c of r.comments) thread.appendChild(devCommentEl(c));
  }
  detail.appendChild(thread);

  // Add-comment box (open in every status)
  const ta = el('textarea', { className: 'dev-comment-input', rows: '3', placeholder: 'Add a comment…', maxlength: '4000' });
  const postBtn = el('button', { className: 'btn btn-primary btn-sm', textContent: 'Post comment',
    onclick: async () => {
      const body = ta.value.trim();
      if (!body) return;
      postBtn.disabled = true;
      try {
        await POST(`/dev-requests/${r.id}/comments`, { body });
        ta.value = '';
        openDevRequest(r.id); // reload thread
      } catch (err) { toast(err.message, 'error'); postBtn.disabled = false; }
    } });
  detail.appendChild(el('div', { className: 'dev-comment-form' }, ta, el('div', { className: 'dev-comment-form-actions' }, postBtn)));
}

function devMultiline(text) {
  // Render text preserving line breaks, safely (textContent per line).
  const frag = document.createDocumentFragment();
  String(text).split('\n').forEach((line, i) => {
    if (i) frag.appendChild(el('br'));
    frag.appendChild(document.createTextNode(line));
  });
  return frag;
}

function devCommentEl(c) {
  const wrap = el('div', { className: 'dev-comment' });
  const head = el('div', { className: 'dev-comment-head' },
    el('span', { className: 'dev-comment-author', textContent: c.authorName }),
    el('span', { className: 'dev-card-time', textContent: devTimeAgo(c.createdAt) + (c.edited ? ' · edited' : '') }),
  );
  const bodyEl = el('div', { className: 'dev-comment-body' }, devMultiline(c.body));
  wrap.appendChild(head);
  wrap.appendChild(bodyEl);

  if (c.canEdit) {
    const controls = el('div', { className: 'dev-comment-controls' },
      el('button', { className: 'dev-link', textContent: 'Edit', onclick: () => editDevComment(c, wrap, bodyEl) }),
      el('button', { className: 'dev-link dev-danger', textContent: 'Delete', onclick: () => deleteDevComment(c) }),
    );
    wrap.appendChild(controls);
  }
  return wrap;
}

function editDevComment(c, wrap, bodyEl) {
  const ta = el('textarea', { className: 'dev-comment-input', rows: '3', maxlength: '4000' });
  ta.value = c.body;
  const save = el('button', { className: 'btn btn-primary btn-sm', textContent: 'Save',
    onclick: async () => {
      const body = ta.value.trim(); if (!body) return;
      try { await PATCH(`/dev-requests/${c.requestId}/comments/${c.id}`, { body }); openDevRequest(c.requestId); }
      catch (err) { toast(err.message, 'error'); }
    } });
  const cancel = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Cancel',
    onclick: () => openDevRequest(c.requestId) });
  bodyEl.replaceWith(el('div', {}, ta, el('div', { className: 'dev-comment-form-actions' }, save, cancel)));
}

async function deleteDevComment(c) {
  if (!confirm('Delete this comment?')) return;
  try { await DELETE(`/dev-requests/${c.requestId}/comments/${c.id}`); openDevRequest(c.requestId); }
  catch (err) { toast(err.message, 'error'); }
}

async function changeDevStatus(id, status) {
  try { await PATCH(`/dev-requests/${id}/status`, { status }); toast('Status updated', 'success'); openDevRequest(id); }
  catch (err) { toast(err.message, 'error'); }
}

async function confirmDeleteDevRequest(id) {
  if (!confirm('Delete this request and its entire discussion? This cannot be undone.')) return;
  try { await DELETE(`/dev-requests/${id}`); toast('Request deleted', 'success'); loadDevRequestsPage(); }
  catch (err) { toast(err.message, 'error'); }
}

function openDevRequestForm(existing) {
  const isEdit = !!existing;
  const titleInput = el('input', { type: 'text', maxlength: '160', placeholder: 'Short, clear title', value: isEdit ? existing.title : '' });
  const bodyInput  = el('textarea', { rows: '6', maxlength: '8000', placeholder: 'Describe the improvement you would like, and why it would help.' });
  if (isEdit) bodyInput.value = existing.body || '';
  const errBox = el('div', { className: 'error-msg', style: 'margin-top:8px' });

  const save = el('button', { className: 'btn btn-primary', textContent: isEdit ? 'Save changes' : 'Submit request',
    onclick: async () => {
      const title = titleInput.value.trim();
      const body  = bodyInput.value.trim();
      if (!title) { errBox.textContent = 'A title is required.'; return; }
      save.disabled = true;
      try {
        if (isEdit) { await PATCH(`/dev-requests/${existing.id}`, { title, body }); closeModal(); openDevRequest(existing.id); }
        else { const created = await POST('/dev-requests', { title, body }); closeModal(); openDevRequest(created.id); }
      } catch (err) { errBox.textContent = err.message; save.disabled = false; }
    } });
  const cancel = el('button', { className: 'btn btn-ghost', textContent: 'Cancel', onclick: () => closeModal() });

  const body = el('div', {},
    el('label', { className: 'dev-form-label', textContent: 'Title' }), titleInput,
    el('label', { className: 'dev-form-label', textContent: 'Description' }), bodyInput,
    errBox,
  );
  openModal(isEdit ? 'Edit Request' : 'New Dev Request', body, [cancel, save]);
}


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

document.getElementById('btnBulkUpload').addEventListener('click', () => {
  openBulkUploadModal();
});

document.getElementById('btnNewUser').addEventListener('click', () => {
  openUserModal(null);
});

// Returns a Promise:
//   true  — operator confirmed they want to continue this assembly (proceed to start)
//   false — operator chose to start fresh (proceed to start)
//   null  — operator cancelled (do not start)
function showAssemblyResumePrompt(assembly) {
  return new Promise(resolve => {
    const body = el('div', {});
    // Identity card
    const identityCard = el('div', { style: 'background:var(--bg3);border-radius:10px;padding:14px 16px;margin-bottom:16px' });
    identityCard.appendChild(el('div', { textContent: assembly.itemNumber, style: 'font-size:20px;font-weight:700;color:var(--accent);margin-bottom:6px' }));
    const tags = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
    tags.appendChild(el('span', { textContent: 'W/O: ' + assembly.woNumber, style: 'font-size:13px;color:var(--text2);background:var(--bg2);padding:3px 10px;border-radius:4px' }));
    if (assembly.routeCardNumber) tags.appendChild(el('span', { textContent: 'RC: ' + assembly.routeCardNumber, style: 'font-size:13px;color:var(--text2);background:var(--bg2);padding:3px 10px;border-radius:4px' }));
    identityCard.appendChild(tags); body.appendChild(identityCard);
    body.appendChild(el('p', { textContent: 'Time has already been recorded on this assembly in your stage' + (assembly.ownStageDepartment ? ' (' + assembly.ownStageDepartment + ')' : '') + ':', style: 'font-size:14px;color:var(--text2);margin-bottom:12px' }));
    // Time grid — figures scoped to the operator's own stage, plus the item total.
    const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px' });
    [{ label: 'Your time so far', value: assembly.operators?.find(o => o.operatorId === state.user?.id)?.totalDisplay || assembly.combinedDisplay || '—', color: 'var(--text)' },
     { label: 'This stage (combined)', value: assembly.combinedDisplay || '—', color: 'var(--text)' },
     { label: 'Contributors (this stage)', value: assembly.operatorCount + ' operator' + (assembly.operatorCount !== 1 ? 's' : ''), color: 'var(--text2)' },
     { label: 'Item total (all stages)', value: assembly.lifecycleTotalDisplay || assembly.combinedDisplay || '—', color: 'var(--green)' },
    ].forEach(({ label, value, color }) => {
      const box = el('div', { style: 'background:var(--bg3);border-radius:8px;padding:10px 12px' });
      box.appendChild(el('div', { textContent: label, style: 'font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px' }));
      box.appendChild(el('div', { textContent: value, style: `font-size:16px;font-weight:700;color:${color}` }));
      grid.appendChild(box);
    });
    body.appendChild(grid);
    // Lifecycle across stages (Stores / PCB / Production / Test and Inspection).
    // The operator's own stage is outlined so the handover context is clear.
    if (assembly.stages && assembly.stages.length) {
      body.appendChild(el('div', { textContent: 'Time by stage', style: 'font-size:13px;font-weight:600;color:var(--text2);margin-bottom:6px' }));
      const sgrid = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px' });
      assembly.stages.forEach(s => {
        const box = el('div', { style: `background:var(--bg3);border-radius:8px;padding:8px 12px;border:1px solid ${s.isOwn ? 'var(--accent)' : 'var(--border)'}` });
        box.appendChild(el('div', { textContent: s.department + (s.hasActive ? ' • active' : ''), style: 'font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px' }));
        box.appendChild(el('div', { textContent: s.totalDisplay, style: 'font-size:15px;font-weight:700;color:var(--text)' }));
        sgrid.appendChild(box);
      });
      body.appendChild(sgrid);
    }
    // Multi-op breakdown
    if (assembly.operatorCount > 1) {
      body.appendChild(el('div', { textContent: 'Operators who have worked on this assembly:', style: 'font-size:13px;font-weight:600;color:var(--text2);margin-bottom:6px' }));
      const tbl = el('table', { className: 'dash-table', style: 'margin-bottom:16px' });
      tbl.appendChild(el('thead', {}, el('tr', {}, el('th', { textContent: 'Operator' }), el('th', { textContent: 'Time' }), el('th', { textContent: 'Stints' }))));
      const tbody = el('tbody', {});
      (assembly.operators || []).forEach(op => { tbody.appendChild(el('tr', {}, el('td', { textContent: op.operatorName, style: 'font-weight:600' }), el('td', { textContent: op.totalDisplay || '—' }), el('td', { textContent: op.stints.length, style: 'color:var(--text2)' }))); });
      tbl.appendChild(tbody); body.appendChild(tbl);
    }
    // The key question
    const qCard = el('div', { style: 'background:var(--bg3);border-radius:10px;padding:14px 16px;margin-bottom:8px;border:1px solid var(--border)' });
    qCard.appendChild(el('div', { textContent: 'Why are you returning to this assembly?', style: 'font-size:15px;font-weight:700;color:var(--text);margin-bottom:12px' }));
    let selectedCategory = null;
    const optCards = [];
    [{ value: 'work',   icon: '▶', title: 'Continuing the build', desc: 'The assembly is not yet finished — picking up where you left off.', color: 'var(--blue)' },
     { value: 'rework', icon: '🔄', title: 'Re-Work Request', desc: 'The assembly was completed but has been returned for correction.', color: 'var(--amber)' },
    ].forEach(opt => {
      const card = el('div', { style: 'cursor:pointer;border:2px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;transition:border-color .15s' });
      const row = el('div', { style: 'display:flex;align-items:flex-start;gap:12px' });
      row.appendChild(el('span', { textContent: opt.icon, style: 'font-size:20px;margin-top:2px' }));
      const txt = el('div', {});
      txt.appendChild(el('div', { textContent: opt.title, style: `font-weight:700;font-size:15px;color:${opt.color};margin-bottom:3px` }));
      txt.appendChild(el('div', { textContent: opt.desc,  style: 'font-size:13px;color:var(--text2)' }));
      row.appendChild(txt); card.appendChild(row);
      optCards.push({ card, value: opt.value, color: opt.color });
      card.addEventListener('click', () => {
        selectedCategory = opt.value;
        optCards.forEach(o => { o.card.style.borderColor = o.value === opt.value ? o.color : 'var(--border)'; });
        btnStart.disabled = false;
      });
      qCard.appendChild(card);
    });
    body.appendChild(qCard);
    const btnCancel = el('button', { className: 'btn btn-ghost',   textContent: 'Cancel' });
    const btnStart  = el('button', { className: 'btn btn-primary', textContent: '▶ Start Timer', disabled: true });
    btnCancel.addEventListener('click', () => { closeModal(); resolve(null); });
    btnStart.addEventListener('click',  () => { closeModal(); resolve({ category: selectedCategory || 'work' }); });
    openModal('Assembly Already in Progress', body, [btnCancel, btnStart]);
  });
}

function openBulkUploadModal() {
  const body = el('div', {});

  // Instructions
  const instructions = el('div', { style: 'background:var(--bg3);border-radius:8px;padding:14px;margin-bottom:16px;font-size:13px;color:var(--text2);line-height:1.6' });
  instructions.innerHTML = `
    <strong style="color:var(--text);display:block;margin-bottom:6px">CSV Format</strong>
    Upload a CSV file with the following columns (header row required):<br>
    <code style="color:var(--accent);font-size:12px">username, full_name, role, department, password</code><br><br>
    <strong style="color:var(--text)">Valid roles:</strong> operator, supervisor, manager, planner${state.user.role === 'superuser' ? ', administrator' : ''}<br>
    <strong style="color:var(--text)">Valid departments:</strong> Production, Stores, Test and Inspection, PCB<br>
    <strong style="color:var(--text)">Max rows:</strong> 200 per upload
  `;
  body.appendChild(instructions);

  // Download template link
  const tmplBtn = el('button', { className: 'btn btn-ghost btn-sm', textContent: '⬇ Download CSV Template', style: 'margin-bottom:16px' });
  tmplBtn.addEventListener('click', () => {
    const csv = [
      'username,full_name,role,department,password',
      'jsmith,John Smith,operator,Production,Temp1234!',
      'ataylor,Anne Taylor,supervisor,Stores,Temp1234!',
    ].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'worktime-users-template.csv'; a.click();
  });
  body.appendChild(tmplBtn);

  // File input
  const fileLabel = el('label', { style: 'display:block;margin-bottom:16px' });
  fileLabel.appendChild(el('div', { textContent: 'Select CSV file', style: 'font-size:13px;font-weight:600;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em' }));
  const fileInput = el('input', { type: 'file', accept: '.csv,text/csv',
    style: 'width:100%;padding:10px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px;cursor:pointer' });
  fileLabel.appendChild(fileInput);
  body.appendChild(fileLabel);

  // Preview area
  const previewArea = el('div', { id: 'bulkPreviewArea' });
  body.appendChild(previewArea);

  const errDiv = el('div', { className: 'error-msg', style: 'margin-top:8px' });
  body.appendChild(errDiv);

  const btnCancel  = el('button', { className: 'btn btn-ghost',   textContent: 'Cancel' });
  const btnPreview = el('button', { className: 'btn btn-ghost',   textContent: 'Validate CSV', disabled: true });
  const btnConfirm = el('button', { className: 'btn btn-primary', textContent: 'Create Users', disabled: true });
  btnCancel.addEventListener('click', closeModal);

  let parsedRows = [];

  // Parse CSV when file selected
  fileInput.addEventListener('change', () => {
    previewArea.innerHTML = '';
    btnPreview.disabled = true;
    btnConfirm.disabled = true;
    errDiv.textContent = '';
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result;
      const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) { errDiv.textContent = 'File must have a header row and at least one data row.'; return; }
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g,''));
      const required = ['username','full_name','role','department','password'];
      const missing = required.filter(r => !headers.includes(r));
      if (missing.length) { errDiv.textContent = `Missing columns: ${missing.join(', ')}`; return; }
      parsedRows = lines.slice(1).map(line => {
        // Handle quoted CSV fields
        const vals = []; let cur = ''; let inQ = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') { inQ = !inQ; }
          else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
          else { cur += ch; }
        }
        vals.push(cur.trim());
        const row = {};
        headers.forEach((h, i) => { row[h] = (vals[i] || '').replace(/^"|"$/g,''); });
        return row;
      }).filter(r => Object.values(r).some(v => v));
      if (!parsedRows.length) { errDiv.textContent = 'No data rows found.'; return; }
      previewArea.appendChild(el('div', { textContent: `${parsedRows.length} row${parsedRows.length!==1?'s':''} found. Click Validate to check for errors.`,
        style: 'font-size:13px;color:var(--text2);padding:8px 0' }));
      btnPreview.disabled = false;
    };
    reader.readAsText(file);
  });

  // Validate (dry run)
  btnPreview.addEventListener('click', async () => {
    previewArea.innerHTML = '';
    btnConfirm.disabled = true;
    errDiv.textContent = '';
    btnPreview.disabled = true;
    btnPreview.textContent = 'Validating\u2026';
    try {
      const data = await api('POST', '/users/bulk-upload', { rows: parsedRows, dryRun: true });
      renderBulkPreview(previewArea, data.results);
      const validCount = data.validCount;
      if (validCount === 0) {
        errDiv.textContent = 'No valid rows to create. Please fix the errors above.';
      } else {
        btnConfirm.disabled = false;
        btnConfirm.textContent = `Create ${validCount} User${validCount!==1?'s':''}`;
      }
    } catch (err) {
      errDiv.textContent = err.message;
    } finally {
      btnPreview.disabled = false;
      btnPreview.textContent = 'Validate CSV';
    }
  });

  // Confirm upload
  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled = true;
    btnConfirm.textContent = 'Creating\u2026';
    errDiv.textContent = '';
    try {
      const data = await api('POST', '/users/bulk-upload', { rows: parsedRows, dryRun: false });
      closeModal();
      toast(`${data.created} user${data.created!==1?'s':''} created${data.skipped?' ('+data.skipped+' skipped)':''}`, 'success');
      loadAdminPage();
    } catch (err) {
      errDiv.textContent = err.message;
      btnConfirm.disabled = false;
      btnConfirm.textContent = 'Create Users';
    }
  });

  openModal('Bulk Upload Users', body, [btnCancel, btnPreview, btnConfirm]);
}

function renderBulkPreview(container, results) {
  container.innerHTML = '';
  const validCount   = results.filter(r => r.valid).length;
  const invalidCount = results.length - validCount;

  // Summary banner
  const summary = el('div', { style: `display:flex;gap:10px;margin-bottom:12px;padding:10px 14px;border-radius:8px;background:var(--bg3);font-size:13px` });
  summary.appendChild(el('span', { textContent: `✓ ${validCount} valid`, style: 'color:var(--green);font-weight:700' }));
  if (invalidCount) summary.appendChild(el('span', { textContent: `✗ ${invalidCount} invalid`, style: 'color:var(--red);font-weight:700' }));
  container.appendChild(summary);

  // Preview table
  const wrap = el('div', { style: 'max-height:320px;overflow-y:auto;border:1px solid var(--border);border-radius:8px' });
  const tbl = el('table', { className: 'dash-table', style: 'margin:0' });
  tbl.appendChild(el('thead', {}, el('tr', {},
    el('th', { textContent: '#' }),
    el('th', { textContent: 'Username' }),
    el('th', { textContent: 'Full Name' }),
    el('th', { textContent: 'Role' }),
    el('th', { textContent: 'Department' }),
    el('th', { textContent: 'Status' }),
  )));
  const tbody = el('tbody', {});
  results.forEach(r => {
    const tr = el('tr', { style: r.valid ? '' : 'background:rgba(239,68,68,.06)' });
    tr.appendChild(el('td', { textContent: r.rowNum, style: 'color:var(--text2)' }));
    tr.appendChild(el('td', { textContent: r.username || '\u2014', style: 'font-family:var(--font-mono,monospace)' }));
    tr.appendChild(el('td', { textContent: r.fullName  || '\u2014' }));
    tr.appendChild(el('td', { textContent: r.role      || '\u2014' }));
    tr.appendChild(el('td', { textContent: r.department|| '\u2014' }));
    const statusCell = el('td', {});
    if (r.valid) {
      statusCell.appendChild(el('span', { textContent: '✓ Ready', style: 'color:var(--green);font-weight:600;font-size:12px' }));
    } else {
      const errList = el('ul', { style: 'margin:0;padding-left:16px;list-style:disc' });
      r.errors.forEach(e => errList.appendChild(el('li', { textContent: e, style: 'color:var(--red);font-size:12px' })));
      statusCell.appendChild(errList);
    }
    tr.appendChild(statusCell);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  container.appendChild(wrap);
}

// ── Profile avatars ───────────────────────────────────────────────────────────
// Reusable circle: shows the user's photo when set, otherwise their initials.
// size is the diameter in px (default 40, matching the user list).
function avatarEl(u, size = 40) {
  const initials = (u.fullName || u.full_name || '?')
    .split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const url = u.avatarUrl || u.avatar_url || null;
  if (url) {
    const img = el('img', {
      className: 'user-avatar user-avatar-img',
      src: url, alt: u.fullName || 'Profile photo',
      style: `width:${size}px;height:${size}px;`,
    });
    // If the image fails to load, fall back to an initials circle in place.
    img.addEventListener('error', () => {
      const fallback = el('div', { className: 'user-avatar', textContent: initials,
        style: `width:${size}px;height:${size}px;` });
      img.replaceWith(fallback);
    });
    return img;
  }
  return el('div', { className: 'user-avatar', textContent: initials,
    style: `width:${size}px;height:${size}px;` });
}

function openAvatarModal(u) {
  let selectedDataUrl = null;

  const preview = avatarEl(u, 96);
  const previewWrap = el('div', { className: 'avatar-preview-wrap' }, preview);

  const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: 'display:none' });
  const errBox = el('div', { className: 'error-msg', style: 'margin-top:10px' });

  const chooseBtn = el('button', { className: 'btn btn-ghost', textContent: 'Choose image…',
    onclick: () => fileInput.click() });

  fileInput.addEventListener('change', () => {
    errBox.textContent = '';
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      errBox.textContent = 'Please choose a PNG, JPEG or WebP image.'; return;
    }
    if (file.size > 3 * 1024 * 1024) {
      errBox.textContent = 'Image is too large. Please use one under 3MB.'; return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      selectedDataUrl = reader.result;
      // live preview
      const newPreview = el('img', { className: 'user-avatar user-avatar-img',
        src: selectedDataUrl, alt: 'Preview', style: 'width:96px;height:96px;' });
      previewWrap.innerHTML = '';
      previewWrap.appendChild(newPreview);
    };
    reader.onerror = () => { errBox.textContent = 'Could not read that file.'; };
    reader.readAsDataURL(file);
  });

  const saveBtn = el('button', { className: 'btn btn-primary', textContent: 'Save photo',
    onclick: async () => {
      if (!selectedDataUrl) { errBox.textContent = 'Choose an image first.'; return; }
      saveBtn.disabled = true;
      try {
        const res = await POST(`/avatars/${u.id}`, { image: selectedDataUrl });
        u.avatarUrl = res.avatarUrl;
        closeModal();
        toast('Photo updated', 'success');
        loadAdminPage();
      } catch (err) { errBox.textContent = err.message; saveBtn.disabled = false; }
    } });

  const footer = [el('button', { className: 'btn btn-ghost', textContent: 'Cancel', onclick: () => closeModal() })];
  if (u.avatarUrl) {
    footer.push(el('button', { className: 'btn btn-ghost dev-danger', textContent: 'Remove photo',
      onclick: async () => {
        if (!confirm('Remove this user\'s photo and revert to initials?')) return;
        try { await DELETE(`/avatars/${u.id}`); u.avatarUrl = null; closeModal(); toast('Photo removed', 'success'); loadAdminPage(); }
        catch (err) { errBox.textContent = err.message; }
      } }));
  }
  footer.push(saveBtn);

  const body = el('div', { className: 'avatar-modal' },
    previewWrap,
    el('p', { className: 'avatar-hint', textContent: `Profile photo for ${u.fullName}. Images are cropped to a square and resized automatically.` }),
    chooseBtn, fileInput, errBox,
  );
  openModal('Profile Photo', body, footer);
}

function renderUserList(users) {
  const container = document.getElementById('userList');
  container.innerHTML = '';
  if (!users.length) {
    container.appendChild(el('div', { className: 'empty-state', textContent: 'No users found.' }));
    return;
  }
  users.forEach(u => {
    const card = el('div', { className: `user-card ${u.isActive ? '' : 'disabled'}`, role: 'listitem' });
    card.appendChild(avatarEl(u, 40));
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
    // Photo button — manager and above may manage a user's profile image.
    if (hasRole('manager') && canEdit) {
      const photoBtn = el('button', { className: 'btn btn-ghost', textContent: u.avatarUrl ? 'Photo ✓' : 'Photo',
        title: 'Upload or change this user\'s profile photo',
        onclick: () => openAvatarModal(u) });
      actions.appendChild(photoBtn);
    }
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
    ? ['operator','supervisor','manager','planner','administrator','superuser']
    : ['operator','supervisor','manager','planner'];
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
    if (t.workstation)     left.appendChild(el('div', { className: 'entry-meta-tag', textContent: '🖥 ' + t.workstation }));
    if (t.woNumber)        left.appendChild(el('div', { className: 'entry-meta-tag', textContent: '📋 W/O: ' + t.woNumber }));
    if (t.routeCardNumber) left.appendChild(el('div', { className: 'entry-meta-tag', textContent: '🔢 RC: ' + t.routeCardNumber }));
    if (t.timerCategory === 'rework') left.appendChild(el('div', { className: 'entry-meta-tag', style: 'color:var(--amber);border-color:var(--amber)', textContent: '🔄 Rework' }));
    // Lifecycle: this assembly's time across all four stages (needs a WO to key on).
    if (t.woNumber) {
      const lcBtn = el('button', { className: 'entry-lifecycle-btn', textContent: '⧉ Stages', title: 'Time across all stages for this assembly' });
      lcBtn.addEventListener('click', () => openAssemblyLifecycleModal(t));
      left.appendChild(lcBtn);
    }
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

    // Adjust times — supervisors and above (corrects a rogue/incorrect timer)
    if (hasRole('supervisor')) {
      const adjBtn = el('button', {
        className: 'btn-adjust-timer',
        textContent: '\u270e',
        title: 'Adjust start / finish time',
        'aria-label': 'Adjust times for ' + t.itemNumber,
      });
      adjBtn.addEventListener('click', () => openAdjustTimerModal(t, containerId));
      right.appendChild(adjBtn);
    }

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

// ─── Assembly lifecycle (per-stage breakdown) ─────────────────────────────────
// On-demand view of one assembly's time across the four stages (departments),
// plus the item total. Reuses GET /api/timers/assembly. Opened from a history
// entry's "Stages" chip. Stages are shown in lifecycle order; a stage with no
// timers yet is shown as "not started".
const STAGE_ORDER = ['Stores', 'PCB', 'Production', 'Test and Inspection'];

async function openAssemblyLifecycleModal(t) {
  const item = t.itemNumber, wo = t.woNumber || '', rc = t.routeCardNumber || '';
  const body = el('div', {});

  const idCard = el('div', { className: 'lc-idcard' });
  idCard.appendChild(el('div', { className: 'lc-item', textContent: item }));
  const tags = el('div', { className: 'lc-tags' });
  if (wo) tags.appendChild(el('span', { className: 'lc-tag', textContent: 'W/O: ' + wo }));
  if (rc) tags.appendChild(el('span', { className: 'lc-tag', textContent: 'RC: ' + rc }));
  idCard.appendChild(tags);
  body.appendChild(idCard);

  const totalLine = el('div', { className: 'lc-total', textContent: 'Loading…' });
  body.appendChild(totalLine);
  const stagesWrap = el('div', { className: 'lc-stages' });
  body.appendChild(stagesWrap);

  openModal('Assembly lifecycle', body, [ el('button', { className: 'btn btn-ghost', textContent: 'Close', onclick: () => closeModal() }) ]);

  try {
    const qs = `item=${encodeURIComponent(item)}&wo=${encodeURIComponent(wo)}` + (rc ? `&rc=${encodeURIComponent(rc)}` : '');
    const asm = await GET('/timers/assembly?' + qs);
    totalLine.textContent = 'Item total (all stages): ' + formatDuration(asm.totalSeconds || 0);

    const byDept = {};
    (asm.stages || []).forEach(s => { byDept[s.department] = s; });
    // Canonical lifecycle order first, then any other departments that appear.
    const order = STAGE_ORDER.concat((asm.stages || []).map(s => s.department).filter(d => !STAGE_ORDER.includes(d)));
    const seen = new Set();
    stagesWrap.innerHTML = '';
    order.forEach(dept => {
      if (seen.has(dept)) return;
      seen.add(dept);
      const s = byDept[dept];
      const row = el('div', { className: 'lc-stage' + (s ? '' : ' lc-stage-empty') });
      const head = el('div', { className: 'lc-stage-head' },
        el('span', { className: 'lc-stage-name', textContent: dept }),
        el('span', { className: 'lc-stage-time', textContent: s ? formatDuration(s.totalSeconds) : 'not started' }),
      );
      row.appendChild(head);
      if (s) {
        const meta = [s.timerCount + ' timer' + (s.timerCount !== 1 ? 's' : '')];
        if (s.hasActive) meta.push('active now');
        if (s.hasRework) meta.push('rework logged');
        row.appendChild(el('div', { className: 'lc-stage-meta', textContent: meta.join(' · ') }));
        (s.operators || []).forEach(op => {
          row.appendChild(el('div', { className: 'lc-op' },
            el('span', { className: 'lc-op-name', textContent: op.operatorName }),
            el('span', { className: 'lc-op-time', textContent: formatDuration(op.totalSeconds) }),
          ));
        });
      }
      stagesWrap.appendChild(row);
    });
  } catch (err) {
    totalLine.textContent = '';
    stagesWrap.innerHTML = '';
    stagesWrap.appendChild(el('div', { className: 'error-msg', textContent: err.message }));
  }
}

// ─── Adjust timer times (supervisor+) ─────────────────────────────────────────
// Corrects a rogue or mistaken timer's start / finish time. Reason is mandatory
// and the change is audit-logged on the server.
function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  // datetime-local needs YYYY-MM-DDTHH:MM in local time
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openAdjustTimerModal(t, containerId) {
  _adjustModalOpen = true; // pause wallboard auto-refresh while editing
  const isCompleted = !!t.completedAt;
  const wrap = el('div', { className: 'adjust-form' });
  wrap.appendChild(el('p', { className: 'adjust-intro',
    textContent: 'Correct the start or finish time for this job. A reason is required and the change is recorded.' }));

  const summary = el('div', { className: 'adjust-summary' });
  summary.appendChild(el('div', { className: 'adjust-summary-item', textContent: t.itemNumber }));
  summary.appendChild(el('div', { className: 'adjust-summary-op', textContent: t.operatorName }));
  wrap.appendChild(summary);

  wrap.appendChild(el('label', { className: 'adjust-label', textContent: 'Start time' }));
  const startInput = el('input', { type: 'datetime-local', className: 'adjust-input', value: toLocalInputValue(t.startedAt) });
  wrap.appendChild(startInput);

  let endInput = null;
  if (isCompleted) {
    wrap.appendChild(el('label', { className: 'adjust-label', textContent: 'Finish time' }));
    endInput = el('input', { type: 'datetime-local', className: 'adjust-input', value: toLocalInputValue(t.completedAt) });
    wrap.appendChild(endInput);
  } else {
    wrap.appendChild(el('p', { className: 'adjust-note', textContent: 'This job is still running, so only its start time can be adjusted. The finish time can be corrected once the job is stopped.' }));
  }

  wrap.appendChild(el('label', { className: 'adjust-label', textContent: 'Reason (required)' }));
  const reasonInput = el('input', { type: 'text', maxlength: '500', className: 'adjust-input', placeholder: 'e.g. Operator forgot to stop the timer overnight' });
  wrap.appendChild(reasonInput);

  const errLine = el('div', { className: 'adjust-error', style: 'display:none;' });
  wrap.appendChild(errLine);

  const saveBtn = el('button', { className: 'btn btn-primary', textContent: 'Save Adjustment' });
  saveBtn.addEventListener('click', async () => {
    errLine.style.display = 'none';
    const reason = reasonInput.value.trim();
    if (!reason) { errLine.textContent = 'Please give a reason for the adjustment.'; errLine.style.display = 'block'; return; }
    const body = { reason };
    if (startInput.value) body.startedAt = new Date(startInput.value).toISOString();
    if (endInput && endInput.value) body.completedAt = new Date(endInput.value).toISOString();
    // Client-side guard: finish must not precede start
    if (body.startedAt && body.completedAt && new Date(body.completedAt) < new Date(body.startedAt)) {
      errLine.textContent = 'The finish time cannot be before the start time.'; errLine.style.display = 'block'; return;
    }
    saveBtn.disabled = true;
    try {
      await PATCH('/timers/' + t.id, body);
      closeModal();
      toast('Timer adjusted.', 'success');
      // Refresh whatever view we came from
      if (containerId === 'historyList') searchHistory();
      else if (containerId === 'todayList') loadTodayEntries();
      if (state.activeTimerId === t.id) loadTimerPage();
    } catch (err) {
      errLine.textContent = err.message; errLine.style.display = 'block'; saveBtn.disabled = false;
    }
  });
  wrap.appendChild(saveBtn);
  openModal('Adjust Times', wrap, []);
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
  // Secondary-field scan buttons. Each button targets EXACTLY ONE field —
  // the input beside it — so a scan can never land in the wrong field.
  // Null-safe so a removed/missing button id won't throw (the Route Card scan
  // button has been removed, as operators only type that field).
  function bindScan(buttonId, inputId, mode) {
    const btn = document.getElementById(buttonId);
    const input = document.getElementById(inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', () => open(input, mode));
  }

  bindScan('btnScanWorkstation', 'startWorkstation', 'notes');
  bindScan('btnScanWoNumber',    'startWoNumber',    'notes');
  bindScan('btnScanRouteCard',   'startRouteCard',   'notes');

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
function loadTargetsPage() { loadTargetTimes('targetTimesPageList'); loadReasonsAdmin(); loadPauseNotesReview(); loadSystemSettings(); }

/* ─── Recent "Other" pause notes (manager+ review) ─────────────────────────── */
function loadPauseNotesReview() {
  const from = document.getElementById('pnFrom');
  const to   = document.getElementById('pnTo');
  // Default to the last 30 days on first open; keep any range the user has set.
  if (from && !from.value) from.value = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (to && !to.value)     to.value   = new Date().toISOString().slice(0, 10);
  const btn = document.getElementById('btnPauseNotesSearch');
  if (btn && !btn._wired) { btn._wired = true; btn.addEventListener('click', searchPauseNotes); }
  searchPauseNotes();
}

async function searchPauseNotes() {
  const list = document.getElementById('pauseNotesList');
  if (!list) return;
  list.innerHTML = '<div class="empty-state">Loading...</div>';
  const params = new URLSearchParams();
  const from = document.getElementById('pnFrom')?.value;
  const to   = document.getElementById('pnTo')?.value;
  if (from) params.set('from', new Date(from).toISOString());
  if (to)   { const d = new Date(to); d.setHours(23, 59, 59, 999); params.set('to', d.toISOString()); }
  params.set('limit', '200');
  let events = [];
  try { events = await GET('/pause/events?' + params.toString()); }
  catch (err) { list.innerHTML = '<div class="empty-state">Could not load pause notes.</div>'; return; }
  list.innerHTML = '';
  if (!events.length) {
    list.appendChild(el('div', { className: 'empty-state', textContent: 'No pause notes in this range.' }));
    return;
  }
  events.forEach(e => {
    const row = el('div', { className: 'pause-note-row' });
    const top = el('div', { className: 'pause-note-top' },
      el('span', { className: 'pause-note-when', textContent: formatLocalTime(e.pausedAt) }),
      el('span', { className: 'pause-note-op', textContent: e.operatorName + (e.department ? ' · ' + e.department : '') }),
    );
    row.appendChild(top);
    row.appendChild(el('div', { className: 'pause-note-text', textContent: e.note || '' }));
    list.appendChild(row);
  });
}

/* ─── System settings (administrator+) ─────────────────────────────────────── */
async function loadSystemSettings() {
  const panel = document.getElementById('systemSettings');
  if (!panel) return;
  const isAdmin = hasRole('administrator');
  // Show the admin-only blocks only to administrators+
  document.querySelectorAll('[data-admin-only]').forEach(elm => { elm.hidden = !isAdmin; });
  if (!isAdmin) return;

  let s;
  try { s = await GET('/settings'); }
  catch (err) { panel.innerHTML = '<div class="empty-state">Could not load settings.</div>'; return; }

  panel.innerHTML = '';
  const mk = (labelText, input) => {
    const row = el('div', { className: 'setting-row' });
    row.appendChild(el('label', { className: 'setting-label', textContent: labelText }));
    row.appendChild(input);
    return row;
  };

  // Branding
  panel.appendChild(el('h3', { className: 'settings-group-title', textContent: 'Branding' }));
  const nameInput = el('input', { type: 'text', className: 'setting-input', value: s.brand_customer_name || '' });
  panel.appendChild(mk('Customer name', nameInput));
  const colourInput = el('input', { type: 'text', className: 'setting-input', value: s.brand_primary_colour || '', placeholder: '#2e75b6' });
  panel.appendChild(mk('Primary colour (hex)', colourInput));
  const loginInput = el('input', { type: 'text', className: 'setting-input', maxlength: '300', value: s.brand_login_text || '' });
  panel.appendChild(mk('Login screen text', loginInput));

  // Thresholds
  panel.appendChild(el('h3', { className: 'settings-group-title', textContent: 'Thresholds' }));
  const targetInput = el('input', { type: 'number', min: '1', max: '100', className: 'setting-input', value: s.productivity_target_pct });
  panel.appendChild(mk('Productivity target %', targetInput));
  const warnInput = el('input', { type: 'number', min: '1', max: '100', className: 'setting-input', value: s.warning_threshold_pct });
  panel.appendChild(mk('Wall board warning at % of target', warnInput));
  const overdueInput = el('input', { type: 'number', min: '1', max: '200', className: 'setting-input', value: s.overdue_threshold_pct });
  panel.appendChild(mk('Wall board overdue at % of target', overdueInput));
  const noTgtInput = el('input', { type: 'number', min: '1', max: '1440', className: 'setting-input', value: s.no_target_warning_minutes });
  panel.appendChild(mk('No-target warning after (minutes)', noTgtInput));

  panel.appendChild(el('h3', { className: 'settings-group-title', textContent: 'Planner output targets' }));
  panel.appendChild(el('p', { className: 'settings-note', textContent: 'Planned £ output the Planner checks each day and week against. Set 0 to show the totals without flagging under-target.' }));
  const outDailyInput = el('input', { type: 'number', min: '0', max: '100000000', step: '100', className: 'setting-input', value: s.output_target_daily });
  panel.appendChild(mk('Daily output target (£)', outDailyInput));
  const outWeeklyInput = el('input', { type: 'number', min: '0', max: '100000000', step: '100', className: 'setting-input', value: s.output_target_weekly });
  panel.appendChild(mk('Weekly output target (£)', outWeeklyInput));

  // Feature toggles — superuser only (commercial / security levers).
  const isSuperuser = hasRole('superuser');
  const featureDefs = [
    ['feature_time_check', 'Time Check review'],
    ['feature_raised_hands', 'Raised hands'],
    ['feature_messaging', 'Messaging'],
    ['feature_availability', 'Productivity availability'],
    ['feature_quality_rft', 'Quality (RFT) reporting'],
    ['feature_two_factor', 'Two-factor authentication'],
  ];
  const featInputs = {};
  if (isSuperuser) {
    panel.appendChild(el('h3', { className: 'settings-group-title', textContent: 'Features & security (superuser)' }));
    panel.appendChild(el('p', { className: 'settings-note', textContent: 'These control licensed features and security for the whole instance.' }));
    featureDefs.forEach(([key, label]) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = s[key] === true;
      featInputs[key] = cb;
      const row = el('label', { className: 'setting-toggle' });
      row.appendChild(cb);
      row.appendChild(el('span', { textContent: label }));
      panel.appendChild(row);
    });
  }

  const saveBtn = el('button', { className: 'btn btn-primary', textContent: 'Save Settings', style: 'margin-top:16px;' });
  const msg = el('span', { className: 'settings-msg', style: 'margin-left:12px;' });
  saveBtn.addEventListener('click', async () => {
    // Operational settings — editable by the customer's administrator.
    const payload = {
      brand_customer_name: nameInput.value.trim(),
      brand_primary_colour: colourInput.value.trim(),
      brand_login_text: loginInput.value.trim(),
      productivity_target_pct: parseInt(targetInput.value, 10),
      warning_threshold_pct: parseInt(warnInput.value, 10),
      overdue_threshold_pct: parseInt(overdueInput.value, 10),
      no_target_warning_minutes: parseInt(noTgtInput.value, 10),
      output_target_daily: parseInt(outDailyInput.value, 10) || 0,
      output_target_weekly: parseInt(outWeeklyInput.value, 10) || 0,
    };
    // Feature/security keys only included when a superuser is editing them.
    if (isSuperuser) {
      featureDefs.forEach(([key]) => { payload[key] = featInputs[key].checked; });
    }
    saveBtn.disabled = true; msg.textContent = '';
    try {
      await api('PUT', '/settings', { settings: payload });
      msg.textContent = 'Saved. Some changes apply after a refresh.'; msg.style.color = 'var(--green, #22a06b)';
      toast('Settings saved.', 'success');
    } catch (err) {
      msg.textContent = err.message; msg.style.color = 'var(--red, #ef4444)';
    } finally { saveBtn.disabled = false; }
  });
  const actions = el('div', {});
  actions.appendChild(saveBtn); actions.appendChild(msg);
  panel.appendChild(actions);
}

/* ─── Productivity reasons management (manager+) ───────────────────────────── */
async function loadReasonsAdmin() {
  const list = document.getElementById('reasonsList');
  if (!list) return;
  list.innerHTML = '<div class="empty-state">Loading...</div>';
  let reasons = [];
  try { reasons = await GET('/admin/reasons'); }
  catch (err) { list.innerHTML = '<div class="empty-state">Could not load reasons.</div>'; return; }
  list.innerHTML = '';
  reasons.forEach(r => list.appendChild(renderReasonRow(r)));
}

function renderReasonRow(r) {
  const row = el('div', { className: 'reason-row' + (r.isActive ? '' : ' reason-inactive') });
  const left = el('div', { className: 'reason-left' });
  left.appendChild(el('span', { className: 'reason-label', textContent: r.label }));
  const tag = r.isAvailable
    ? el('span', { className: 'reason-tag reason-tag-counts', textContent: 'Counts' })
    : el('span', { className: 'reason-tag reason-tag-excluded', textContent: 'Excluded' });
  left.appendChild(tag);
  if (!r.isActive) left.appendChild(el('span', { className: 'reason-tag reason-tag-off', textContent: 'Hidden' }));
  row.appendChild(left);

  const actions = el('div', { className: 'reason-actions' });
  const editBtn = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Edit' });
  editBtn.addEventListener('click', () => openReasonEditor(r));
  actions.appendChild(editBtn);
  const toggleBtn = el('button', { className: 'btn btn-ghost btn-sm', textContent: r.isActive ? 'Hide' : 'Show' });
  toggleBtn.addEventListener('click', async () => {
    toggleBtn.disabled = true;
    try { await PATCH('/admin/reasons/' + r.id, { isActive: !r.isActive }); loadReasonsAdmin(); }
    catch (err) { toast(err.message, 'error'); toggleBtn.disabled = false; }
  });
  actions.appendChild(toggleBtn);
  row.appendChild(actions);
  return row;
}

function openReasonEditor(existing) {
  const isNew = !existing;
  const wrap = el('div', { className: 'reason-editor' });
  const labelInput = el('input', { type: 'text', maxlength: '60', className: 'reason-input',
    placeholder: 'e.g. Training', value: existing ? existing.label : '' });
  wrap.appendChild(el('label', { className: 'reason-field-label', textContent: 'Label' }));
  wrap.appendChild(labelInput);

  wrap.appendChild(el('label', { className: 'reason-field-label', textContent: 'Does this count toward productivity?' }));
  const select = el('select', { className: 'reason-input' });
  const optCounts = el('option', { value: 'true', textContent: 'Counts (available but idle — e.g. break)' });
  const optExcl = el('option', { value: 'false', textContent: 'Excluded (not available — e.g. training)' });
  select.appendChild(optCounts); select.appendChild(optExcl);
  select.value = existing ? String(existing.isAvailable) : 'false';
  wrap.appendChild(select);

  const saveBtn = el('button', { className: 'btn btn-primary', textContent: isNew ? 'Add Reason' : 'Save Changes' });
  saveBtn.addEventListener('click', async () => {
    const label = labelInput.value.trim();
    if (!label) { toast('A label is required.', 'error'); return; }
    saveBtn.disabled = true;
    const body = { label, isAvailable: select.value === 'true' };
    try {
      if (isNew) await POST('/admin/reasons', body);
      else       await PATCH('/admin/reasons/' + existing.id, body);
      closeModal(); toast('Reason saved.', 'success'); _availReasons = null; _pauseReasons = null; loadReasonsAdmin();
    } catch (err) { toast(err.message, 'error'); saveBtn.disabled = false; }
  });
  wrap.appendChild(saveBtn);
  openModal(isNew ? 'Add Reason' : 'Edit Reason', wrap, []);
}
document.getElementById('btnAddTargetPage') && document.getElementById('btnAddTargetPage').addEventListener('click', () => openTargetModal(null, 'targetTimesPageList'));
document.getElementById('btnAddReason') && document.getElementById('btnAddReason').addEventListener('click', () => openReasonEditor(null));
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
const ROLES_REQUIRING_TOTP = ['manager', 'planner', 'administrator', 'superuser'];
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
  const pauseType = state.activePauseType || '';
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

  // Show overtime override button when auto-paused by the schedule
  const existingOT = document.getElementById('btnOvertimeOverride');
  if (existingOT) existingOT.remove();
  if (isPaused && pauseType === 'schedule') {
    const otBtn = el('button', {
      id: 'btnOvertimeOverride',
      className: 'btn btn-overtime',
      textContent: '\u23F1 Override \u2014 Working Overtime',
    });
    otBtn.addEventListener('click', async () => {
      otBtn.disabled = true;
      try {
        // Resume the timer and mark as overtime_override so the schedule won't re-pause it
        await POST('/pause/' + state.activeTimerId + '/resume', { overtimeOverride: true });
        state.activeIsPaused  = false;
        state.activePausedAt  = null;
        state.activePauseType = 'overtime_override';
        updatePauseUI();
        toast('Overtime override active \u2014 your timer will not be auto-paused again tonight.', 'success');
      } catch (err) {
        toast(err.message, 'error');
        otBtn.disabled = false;
      }
    });
    // Place it on its own row BELOW the action buttons, not inside that flex row.
    const actionsRow = document.querySelector('#pageTimer .active-actions');
    if (actionsRow && actionsRow.parentNode) {
      actionsRow.parentNode.insertBefore(otBtn, actionsRow.nextSibling);
    } else {
      const pauseBtnEl = document.getElementById('btnPauseTimer');
      if (pauseBtnEl && pauseBtnEl.parentNode) {
        pauseBtnEl.parentNode.insertBefore(otBtn, pauseBtnEl.nextSibling);
      }
    }
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
  const btn = document.getElementById('btnPauseTimer');
  if (state.activeIsPaused) {
    btn.disabled = true;
    try {
      const t = await POST('/pause/' + state.activeTimerId + '/resume', {});
      state.activeIsPaused = false; state.activePausedAt = null; state.activeTotalPausedSeconds = t.totalPausedSeconds || 0;
      updatePauseUI(); toast('Timer resumed.', 'success');
    } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
  } else {
    // Ask for a reason so training/meetings/absence can be excluded from
    // productivity availability. Reasons are the managed list from the server.
    openPauseReasonPicker();
  }
});

let _pauseReasons = null;
async function loadPauseReasons() {
  if (_pauseReasons) return _pauseReasons;
  try { _pauseReasons = await GET('/pause/reasons'); }
  catch (_) { _pauseReasons = [{ id: null, label: 'Break', isAvailable: true }, { id: null, label: 'Other', isAvailable: true }]; }
  return _pauseReasons;
}

async function openPauseReasonPicker() {
  const reasons = await loadPauseReasons();
  const wrap = el('div', { className: 'pause-reason-list' });
  wrap.appendChild(el('p', { className: 'pause-reason-intro', textContent: 'Why are you pausing? This keeps productivity figures fair.' }));

  async function submitPause(r, note) {
    closeModal();
    const btn = document.getElementById('btnPauseTimer'); btn.disabled = true;
    try {
      const body = { reason: r.label, reasonId: r.id };
      if (note) body.note = note;
      const t = await POST('/pause/' + state.activeTimerId + '/pause', body);
      state.activeIsPaused = true; state.activePausedAt = t.pausedAt;
      updatePauseUI(); toast('Timer paused: ' + r.label, '');
    } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
  }

  reasons.forEach(r => {
    // "Other" needs a short free-text detail before pausing, so it opens an inline
    // note box instead of pausing on the first tap. Every other reason is one tap.
    const isOther = r.id === 'avr_other' || (r.label || '').trim().toLowerCase() === 'other';
    const row = el('button', { className: 'pause-reason-btn' + (r.isAvailable ? '' : ' pause-reason-na') });
    row.appendChild(el('span', { className: 'pause-reason-label', textContent: r.label }));
    if (!r.isAvailable) row.appendChild(el('span', { className: 'pause-reason-tag', textContent: 'excluded from productivity' }));

    if (isOther) {
      const editor = el('div', { className: 'pause-other-editor', hidden: true });
      const input  = el('input', { type: 'text', maxlength: '200', className: 'pause-other-input', placeholder: 'Briefly, what is the reason?' });
      const go     = el('button', { className: 'btn btn-primary btn-sm', textContent: 'Pause' });
      go.disabled = true;
      input.addEventListener('input', () => { go.disabled = input.value.trim().length === 0; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); go.click(); } });
      go.addEventListener('click', () => submitPause(r, input.value.trim()));
      editor.appendChild(input); editor.appendChild(go);
      row.addEventListener('click', () => {
        const opening = editor.hidden;
        editor.hidden = !opening;
        if (opening) setTimeout(() => input.focus(), 0);
      });
      wrap.appendChild(row);
      wrap.appendChild(editor);
    } else {
      row.addEventListener('click', () => submitPause(r, null));
      wrap.appendChild(row);
    }
  });
  openModal('Pause Job', wrap, []);
}

let pausePollInterval = null;
function startPausePoll() {
  if (pausePollInterval) clearInterval(pausePollInterval);
  pausePollInterval = setInterval(async () => {
    if (state.currentPage !== 'timer' || !state.activeTimerId) return;
    try {
      const t = await GET('/timers/' + state.activeTimerId); if (!t) return;
      const waspaused = state.activeIsPaused, wasHandRaised = state.activeHandRaised;
      state.activeIsPaused = t.isPaused || false; state.activePausedAt = t.pausedAt || null;
      state.activePauseType = t.pauseType || null;
      state.activeTotalPausedSeconds = t.totalPausedSeconds || 0; state.activeHandRaised = t.handRaised || false;
      if (waspaused !== state.activeIsPaused) {
        updatePauseUI();
        if (state.activeIsPaused && state.activePauseType === 'schedule') {
          toast('Your timer has been automatically paused — tap Override to work overtime.', '');
        } else if (!state.activeIsPaused) {
          toast('Your timer has automatically resumed for the new working day.', 'success');
        } else {
          toast('Your timer has been paused.', '');
        }
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

/* ─── Time Check target review ─────────────────────────────────────────────── */

// Seconds -> nearest whole-minute {hours, minutes}, never zero.
function tcSecsToHM(s) {
  const totalMin = Math.max(1, Math.round((s || 0) / 60));
  return { hours: Math.floor(totalMin / 60), minutes: totalMin % 60 };
}

// Cached pending Time Check reviews, used to build the tile in Today at a Glance.
let _pendingTimeChecks = [];

// Cached raised hands, used to build the clickable Raised Hands tile + modal.
let _raisedHands = [];

// Builds the clickable Raised Hands tile from the cached list. Clicking the tile
// (other than the Lower All button) opens a modal listing each raised hand.
function buildHandTile() {
  const count = _raisedHands ? _raisedHands.length : 0;
  const tile = el('div', { className: 'home-hand-tile' + (count > 0 ? ' active' : ''), id: 'homeHandTile' });
  if (count > 0) {
    tile.style.cursor = 'pointer';
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');
    tile.addEventListener('click', e => { if (!e.target.closest('.home-lower-all-btn')) openRaisedHandsModal(); });
    tile.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('.home-lower-all-btn')) { e.preventDefault(); openRaisedHandsModal(); } });
  }
  const handLeft = el('div', { className: 'home-hand-left' });
  handLeft.appendChild(el('div', { className: 'home-hand-icon', textContent: '\u270b' }));
  const handInfo = el('div', {});
  handInfo.appendChild(el('div', { className: 'home-hand-value', textContent: count }));
  handInfo.appendChild(el('div', { className: 'home-hand-label', textContent: count === 1 ? 'Raised Hand' : 'Raised Hands' }));
  handLeft.appendChild(handInfo); tile.appendChild(handLeft);
  if (count > 0) {
    const lowerBtn = el('button', { className: 'btn btn-ghost btn-sm home-lower-all-btn', textContent: '\u270b Lower All' });
    lowerBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      lowerBtn.disabled = true; lowerBtn.textContent = 'Lowering\u2026';
      try { const r = await POST('/timers/lower-all-hands', {}); toast(r.message, 'success'); refreshRaisedHands(); }
      catch (err) { toast(err.message, 'error'); lowerBtn.disabled = false; lowerBtn.textContent = '\u270b Lower All'; }
    });
    tile.appendChild(lowerBtn);
  }
  return tile;
}

// Re-fetch raised hands and swap the tile in place (used after live events / actions).
function refreshRaisedHands() {
  if (!hasRole('supervisor')) return;
  const existing = document.getElementById('homeHandTile');
  if (!existing) return; // not on the home page
  GET('/timers/raised-hands').then(list => {
    _raisedHands = list || [];
    existing.replaceWith(buildHandTile());
    // If the modal is open, refresh its contents too.
    if (document.getElementById('raisedHandsModalBody')) refreshRaisedHandsModal();
  }).catch(() => {});
}

async function lowerOneHand(timerId) {
  try {
    await POST(`/timers/${timerId}/lower-hand`, {});
    toast('Hand lowered.', '');
    refreshRaisedHands();
    return true;
  } catch (err) { toast(err.message, 'error'); refreshRaisedHands(); return false; }
}

function openRaisedHandsModal() {
  GET('/timers/raised-hands')
    .then(list => {
      _raisedHands = list || [];
      const existing = document.getElementById('homeHandTile');
      if (existing) existing.replaceWith(buildHandTile());
      if (!_raisedHands.length) { toast('No raised hands right now.', ''); closeModal(); return; }
      openModal('Raised Hands', buildRaisedHandsModalBody(_raisedHands), []);
    })
    .catch(err => toast(err.message, 'error'));
}

function buildRaisedHandsModalBody(list) {
  const wrap = el('div', { className: 'rh-list', id: 'raisedHandsModalBody' });
  wrap.appendChild(el('p', { className: 'rh-intro', textContent: 'Operators currently requesting attention. Lower a hand once the operator has been helped.' }));
  list.forEach(r => {
    const row = el('div', { className: 'rh-row' });
    const info = el('div', { className: 'rh-info' });
    const head = el('div', { className: 'rh-head' });
    head.appendChild(el('span', { className: 'rh-op', textContent: '\u270b ' + r.operatorName }));
    info.appendChild(head);
    const meta = [];
    if (r.itemNumber)  meta.push('\uD83D\uDCE6 ' + r.itemNumber);
    if (r.workstation) meta.push('\uD83D\uDDA5 ' + r.workstation);
    if (r.department)  meta.push(r.department);
    if (r.standalone)  meta.push('no active job');
    const metaLine = el('div', { className: 'rh-meta' });
    metaLine.appendChild(el('span', { textContent: meta.join('  \u00B7  ') }));
    info.appendChild(metaLine);
    if (r.startedAt) {
      info.appendChild(el('div', { className: 'rh-time', textContent: (r.standalone ? 'Raised ' : 'Job started ') + new Date(r.startedAt).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) }));
    }
    row.appendChild(info);
    const actions = el('div', { className: 'rh-actions' });
    if (r.operatorId) {
      const msgBtn = el('button', { className: 'btn btn-ghost btn-sm', textContent: '\u2709 Message' });
      msgBtn.addEventListener('click', () => openSendMessageModal(r.operatorId, r.operatorName));
      actions.appendChild(msgBtn);
    }
    const lowerBtn = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Lower' });
    lowerBtn.addEventListener('click', async () => {
      lowerBtn.disabled = true;
      if (r.standalone) {
        try { await POST('/timers/lower-hand-standalone', { standaloneId: r.standaloneId }); refreshRaisedHands(); }
        catch (err) { toast(err.message, 'error'); refreshRaisedHands(); }
      } else {
        await lowerOneHand(r.timerId);
      }
    });
    actions.appendChild(lowerBtn);
    row.appendChild(actions);
    wrap.appendChild(row);
  });
  return wrap;
}

// Refresh the open modal's contents from the cache; close it when empty.
function refreshRaisedHandsModal() {
  const body = document.getElementById('modalBody');
  if (!body || !document.getElementById('raisedHandsModalBody')) return;
  if (!_raisedHands.length) { closeModal(); return; }
  body.innerHTML = '';
  body.appendChild(buildRaisedHandsModalBody(_raisedHands));
}

// Re-fetch pending reviews and update just the tile (used after live events / actions).
function refreshTimeCheckCount() {
  if (!hasRole('manager')) return;
  const existing = document.getElementById('homeTcTile');
  if (!existing) return; // not on the home page
  GET('/time-checks/pending').then(list => {
    _pendingTimeChecks = list || [];
    const fresh = buildTimeCheckTile();
    existing.replaceWith(fresh);
  }).catch(() => {});
}

// Live popup nudging an online manager. The queue card is the durable record.
function showTimeCheckPopup(data) {
  const popup = el('div', { className: 'time-check-popup', role: 'alertdialog', 'aria-label': 'Time Check completed' });
  const icon  = el('div', { className: 'tcp-icon', textContent: '\u23F1' });
  const bodyEl = el('div', { className: 'tcp-body' });
  bodyEl.appendChild(el('div', { className: 'tcp-title', textContent: 'Time Check Completed' }));
  bodyEl.appendChild(el('div', { className: 'tcp-name', textContent: esc(data.itemNumber) + '  \u00B7  ' + esc(data.operatorName) }));
  const cur = data.currentTargetSeconds != null ? formatHM(data.currentTargetSeconds) : 'none set';
  bodyEl.appendChild(el('div', { className: 'tcp-meta', textContent: 'Measured ' + formatDuration(data.measuredSeconds) + '  (current target: ' + cur + ')' }));
  const actions = el('div', { className: 'tcp-actions' });
  const setBtn = el('button', { className: 'btn btn-primary btn-sm', textContent: '\u2713 Set as Target' });
  setBtn.addEventListener('click', async () => {
    const hm = tcSecsToHM(data.measuredSeconds);
    setBtn.disabled = true;
    const ok = await applyTimeCheck(data.timerId, hm.hours, hm.minutes);
    if (ok) popup.remove(); else setBtn.disabled = false;
  });
  const adjBtn = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Adjust\u2026' });
  adjBtn.addEventListener('click', () => { popup.remove(); openTimeCheckModal(); });
  actions.appendChild(setBtn); actions.appendChild(adjBtn);
  bodyEl.appendChild(actions);
  const closeBtn = el('button', { className: 'tcp-close', textContent: '\u2715', 'aria-label': 'Dismiss notification' });
  closeBtn.addEventListener('click', () => popup.remove()); // leaves it in the queue
  popup.appendChild(icon); popup.appendChild(bodyEl); popup.appendChild(closeBtn);
  document.body.appendChild(popup);
  playPing('message');
  setTimeout(() => { if (popup.isConnected) popup.remove(); }, 30000);
}

async function applyTimeCheck(timerId, hours, minutes) {
  try {
    const r = await POST(`/time-checks/${timerId}/apply`, { hours, minutes });
    let msg = `Target set to ${formatHM(r.appliedSeconds)} for ${r.itemNumber}.`;
    if (r.supersededCount > 0) msg += ` ${r.supersededCount} other review${r.supersededCount !== 1 ? 's' : ''} for this item cleared.`;
    toast(msg, 'success');
    refreshTimeCheckCount();
    return true;
  } catch (err) { toast(err.message, 'error'); refreshTimeCheckCount(); return false; }
}

async function dismissTimeCheck(timerId) {
  try {
    await POST(`/time-checks/${timerId}/dismiss`, {});
    toast('Time Check dismissed.', '');
    refreshTimeCheckCount();
    return true;
  } catch (err) { toast(err.message, 'error'); refreshTimeCheckCount(); return false; }
}

function openTimeCheckModal() {
  GET('/time-checks/pending')
    .then(list => {
      if (!list || !list.length) { toast('No Time Checks left to review.', ''); closeModal(); refreshTimeCheckCount(); return; }
      openModal('Time Checks to Review', buildTimeCheckModalBody(list), []);
    })
    .catch(err => toast(err.message, 'error'));
}

function buildTimeCheckModalBody(list) {
  const wrap = el('div', { className: 'tcr-list' });
  wrap.appendChild(el('p', { className: 'tcr-intro', textContent: 'Set a measured run as the new Target Time for its item. Adjust the time first if you want to add an allowance.' }));
  list.forEach(r => {
    const row = el('div', { className: 'tcr-row' });
    const head = el('div', { className: 'tcr-head' });
    head.appendChild(el('span', { className: 'tcr-item', textContent: r.itemNumber }));
    head.appendChild(el('span', { className: 'tcr-op', textContent: r.operatorName }));
    row.appendChild(head);

    const cur = r.currentTargetSeconds != null ? formatHM(r.currentTargetSeconds) : 'none';
    const measured = formatDuration(r.measuredSeconds);
    let deltaTxt = '';
    if (r.currentTargetSeconds != null) {
      const d = r.measuredSeconds - r.currentTargetSeconds;
      deltaTxt = d === 0 ? ' (on target)' : `  (${d > 0 ? '+' : '-'}${formatDuration(Math.abs(d))} vs target)`;
    }
    row.appendChild(el('div', { className: 'tcr-meta', textContent: `Measured ${measured} \u00B7 current target ${cur}${deltaTxt}` }));

    const hm = tcSecsToHM(r.measuredSeconds);
    const controls = el('div', { className: 'tcr-controls' });
    const hInput = el('input', { type: 'number', min: '0', max: '99', value: String(hm.hours), className: 'tcr-num', 'aria-label': 'Target hours' });
    const mInput = el('input', { type: 'number', min: '0', max: '59', value: String(hm.minutes), className: 'tcr-num', 'aria-label': 'Target minutes' });
    controls.appendChild(el('span', { className: 'tcr-lbl', textContent: 'Target:' }));
    controls.appendChild(hInput); controls.appendChild(el('span', { textContent: 'h' }));
    controls.appendChild(mInput); controls.appendChild(el('span', { textContent: 'm' }));

    const applyBtn = el('button', { className: 'btn btn-primary btn-sm', textContent: 'Set as Target' });
    applyBtn.addEventListener('click', async () => {
      applyBtn.disabled = true;
      const ok = await applyTimeCheck(r.timerId, parseInt(hInput.value, 10), parseInt(mInput.value, 10));
      if (ok) refreshTimeCheckModal(); else applyBtn.disabled = false;
    });
    const dismissBtn = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Dismiss' });
    dismissBtn.addEventListener('click', async () => {
      dismissBtn.disabled = true;
      const ok = await dismissTimeCheck(r.timerId);
      if (ok) refreshTimeCheckModal(); else dismissBtn.disabled = false;
    });
    controls.appendChild(applyBtn); controls.appendChild(dismissBtn);
    row.appendChild(controls);
    wrap.appendChild(row);
  });
  return wrap;
}

// Re-fetch after an action so superseded siblings disappear; close when empty.
function refreshTimeCheckModal() {
  GET('/time-checks/pending')
    .then(list => {
      refreshTimeCheckCount();
      if (!list || !list.length) { closeModal(); return; }
      const body = document.getElementById('modalBody');
      if (body) { body.innerHTML = ''; body.appendChild(buildTimeCheckModalBody(list)); }
    })
    .catch(() => {});
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
  // Pending Time Check reviews feed a tile inside Today at a Glance (manager+).
  if (hasRole('manager')) {
    _pendingTimeChecks = await GET('/time-checks/pending').catch(() => []);
  }
  // Raised hands feed the clickable Raised Hands tile (supervisor+).
  if (hasRole('supervisor')) {
    _raisedHands = await GET('/timers/raised-hands').catch(() => []);
  }
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
    function homeScore(t, elMs) {
      const elS = elMs / 1000 - (t.totalPausedSeconds || 0);
      const pct = t.targetSeconds ? elS / t.targetSeconds : elS / noTargetOverdueSecs();
      if (t.handRaised)                             return [1,  0];
      if (t.timerCategory==='rework' && !t.isPaused)return [2, -elS];
      if (pct >= overdueFrac() && !t.isPaused)        return [3, -elS];
      if (pct >= warnFrac() && !t.isPaused)           return [4, -elS];
      if (!t.isPaused)                              return [5, -elS];
      if (t.timerCategory==='rework')               return [6, -elS];
      return                                               [7, -elS];
    }
    const [pa, sa] = homeScore(a, elA);
    const [pb, sb] = homeScore(b, elB);
    if (pa !== pb) return pa - pb;
    return sa - sb;
  });
  const grid = el('div', { className: 'home-active-grid' });
  timers.forEach(t => {
    const refMs   = t.isPaused && t.pausedAt ? new Date(t.pausedAt).getTime() : now;
    const localEl = Math.max(0, Math.floor((refMs - new Date(t.startedAt).getTime()) / 1000)) - (t.totalPausedSeconds || 0);
    const elapsed = t.netElapsedSeconds != null ? t.netElapsedSeconds : localEl;
    const isOver  = t.targetSeconds ? elapsed >= t.targetSeconds : elapsed > noTargetOverdueSecs();
    const isWarn  = !isOver && (t.targetSeconds ? elapsed / t.targetSeconds >= warnFrac() : elapsed > noTargetWarnSecs());
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
  // "Needs attention" tiles (Raised Hands, Time Checks) sit side by side.
  if (hasRole('supervisor')) {
    const attnRow = el('div', { className: 'home-attn-row', id: 'homeAttnRow' });
    attnRow.appendChild(buildHandTile());
    // Manager-only: Time Checks awaiting review, beside Raised Hands.
    if (hasRole('manager')) attnRow.appendChild(buildTimeCheckTile());
    body.appendChild(attnRow);
  }
}

// Builds the Time Checks tile from the cached pending list.
function buildTimeCheckTile() {
  const count = _pendingTimeChecks ? _pendingTimeChecks.length : 0;
  const tile = el('div', { className: 'home-tc-tile' + (count > 0 ? ' active' : ''), id: 'homeTcTile' });
  const left = el('div', { className: 'home-tc-left' });
  left.appendChild(el('div', { className: 'home-tc-icon', textContent: '\u23F1' }));
  const info = el('div', {});
  info.appendChild(el('div', { className: 'home-tc-value', textContent: count }));
  info.appendChild(el('div', { className: 'home-tc-label', textContent: count === 1 ? 'Time Check to Review' : 'Time Checks to Review' }));
  left.appendChild(info); tile.appendChild(left);
  if (count > 0) {
    const reviewBtn = el('button', { className: 'btn btn-primary btn-sm', textContent: 'Review' });
    reviewBtn.addEventListener('click', () => openTimeCheckModal());
    tile.appendChild(reviewBtn);
  }
  return tile;
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
  if (_adjustModalOpen) return; // don't redraw tiles while a supervisor is mid-edit
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

    // Priority sort — hand raised > rework > overdue > warning > active (by elapsed desc) > paused
    const _now = Date.now();
    function _tileScore(t) {
      const elapsedMs = _now - new Date(t.startedAt).getTime();
      const elapsedS  = elapsedMs / 1000 - (t.totalPausedSeconds || 0);
      const pct       = t.targetSeconds ? elapsedS / t.targetSeconds : (elapsedS / noTargetOverdueSecs());
      if (t.handRaised)               return [1,  0];           // hand raised — top priority
      if (t.timerCategory==='rework' && !t.isPaused) return [2, -elapsedS]; // active rework
      if (pct >= overdueFrac() && !t.isPaused)  return [3, -elapsedS];   // active overdue
      if (pct >= warnFrac() && !t.isPaused)  return [4, -elapsedS];   // active warning
      if (!t.isPaused)                return [5, -elapsedS];   // active on track
      if (t.timerCategory==='rework') return [6, -elapsedS];   // paused rework (above plain paused)
      return                                 [7, -elapsedS];   // paused standard, longest first
    }
    timers.sort((a, b) => {
      const [pa, sa] = _tileScore(a);
      const [pb, sb] = _tileScore(b);
      if (pa !== pb) return pa - pb;
      return sa - sb;
    });

    timers.forEach(t => {
      const sNet    = t.netElapsedSeconds != null ? t.netElapsedSeconds : null;
      const localEl = Math.max(0, Math.floor((Date.now() - new Date(t.startedAt).getTime()) / 1000)) - (t.totalPausedSeconds || 0);
      const elapsed = sNet !== null ? sNet : localEl;
      const tile    = el('div', { className: 'wallboard-tile' + (t.isPaused ? ' tile-paused' : '') });

      // Rework tiles get a warm orange background — visually unmissable from across the shopfloor
      const isRework = t.timerCategory === 'rework';
      if (isRework) {
        tile.classList.add('tile-rework');
      }

      if (!t.isPaused) {
        if (t.targetSeconds) {
          const pct = elapsed / t.targetSeconds;
          if (pct >= overdueFrac()) tile.classList.add('tile-overdue');
          else if (pct >= warnFrac()) tile.classList.add('tile-warning');
        } else {
          if (elapsed > noTargetOverdueSecs()) tile.classList.add('tile-overdue');
          else if (elapsed > noTargetWarnSecs()) tile.classList.add('tile-warning');
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
      // Rework badge — shown below item number on rework tiles
      if (isRework) {
        const rwBadge = el('div', { className: 'wb-rework-badge', textContent: '\uD83D\uDD04 RE-WORK' });
        tile.appendChild(rwBadge);
      }
      const opRow = el('div', { className: 'wb-operator-row' });
      opRow.appendChild(el('span', {
        className: 'presence-dot ' + (onlineSet.has(t.operatorId) ? 'online' : 'offline'),
        title: onlineSet.has(t.operatorId) ? 'Session active' : 'Not connected',
      }));
      opRow.appendChild(avatarEl({ fullName: t.operatorName, avatarUrl: t.avatarUrl }, 28));
      opRow.appendChild(el('span', { textContent: t.operatorName }));
      tile.appendChild(opRow);
      tile.appendChild(el('div', {
        className: 'wb-elapsed', textContent: formatDuration(elapsed),
        'data-timerid': t.id, 'data-startedat': t.startedAt,
        'data-pausedseconds': String(t.totalPausedSeconds || 0), 'data-ispaused': t.isPaused ? '1' : '0',
      }));
      tile.appendChild(el('div', { className: 'wb-started', textContent: 'Started ' + formatLocalTime(t.startedAt) }));
      if (t.workstation) tile.appendChild(el('div', { className: 'wb-notes', textContent: '\uD83D\uDDA5 ' + t.workstation }));
      if (t.woNumber)        tile.appendChild(el('div', { className: 'wb-notes', textContent: '\uD83D\uDCCB W/O: ' + t.woNumber }));
      if (t.routeCardNumber) tile.appendChild(el('div', { className: 'wb-notes', textContent: '\uD83D\uDD22 RC: '  + t.routeCardNumber }));
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

      // Supervisors+ can click a tile to adjust the running job's start time
      // (corrects a rogue timer). Clicks on the tile's own buttons are ignored.
      if (hasRole('supervisor')) {
        tile.classList.add('wb-tile-adjustable');
        tile.setAttribute('title', 'Click to adjust this job\u2019s start time');
        tile.addEventListener('click', e => {
          if (e.target.closest('button')) return; // let tile buttons do their own thing
          openAdjustTimerModal({
            id: t.id,
            itemNumber: t.itemNumber,
            operatorName: t.operatorName,
            startedAt: t.startedAt,
            completedAt: null, // running job — only the start time is adjustable
          }, null);
        });
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
        if (pct >= overdueFrac()) tile.classList.add('tile-overdue');
        else if (pct >= warnFrac()) tile.classList.add('tile-warning');
        fill.style.width = Math.round(Math.min(1, pct) * 100) + '%';
        fill.classList.toggle('over', pct >= 1);
        const lbl = tile.querySelector('.wb-target-label');
        if (lbl) {
          const rem = tgt - elapsed;
          lbl.textContent = '\uD83C\uDFAF Target: ' + formatHM(tgt) + '  \u2014  ' + (rem > 0 ? formatHM(rem) + ' remaining' : formatHM(Math.abs(rem)) + ' overdue');
          lbl.className   = 'wb-target-label' + (rem <= 0 ? ' overdue' : '');
        }
      } else {
        if (elapsed > noTargetOverdueSecs()) tile.classList.add('tile-overdue');
        else if (elapsed > noTargetWarnSecs()) tile.classList.add('tile-warning');
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

    // Priority sort — hand raised > rework > overdue > warning > active (by elapsed desc) > paused
    const _now = Date.now();
    function _tileScore(t) {
      const elapsedMs = _now - new Date(t.startedAt).getTime();
      const elapsedS  = elapsedMs / 1000 - (t.totalPausedSeconds || 0);
      const pct       = t.targetSeconds ? elapsedS / t.targetSeconds : (elapsedS / noTargetOverdueSecs());
      if (t.handRaised)               return [1,  0];           // hand raised — top priority
      if (t.timerCategory==='rework' && !t.isPaused) return [2, -elapsedS]; // active rework
      if (pct >= overdueFrac() && !t.isPaused)  return [3, -elapsedS];   // active overdue
      if (pct >= warnFrac() && !t.isPaused)  return [4, -elapsedS];   // active warning
      if (!t.isPaused)                return [5, -elapsedS];   // active on track
      if (t.timerCategory==='rework') return [6, -elapsedS];   // paused rework (above plain paused)
      return                                 [7, -elapsedS];   // paused standard, longest first
    }
    timers.sort((a, b) => {
      const [pa, sa] = _tileScore(a);
      const [pb, sb] = _tileScore(b);
      if (pa !== pb) return pa - pb;
      return sa - sb;
    });

    timers.forEach(t => {
      const sNet    = t.netElapsedSeconds != null ? t.netElapsedSeconds : null;
      const localEl = Math.max(0, Math.floor((Date.now() - new Date(t.startedAt).getTime()) / 1000)) - (t.totalPausedSeconds || 0);
      const elapsed = sNet !== null ? sNet : localEl;
      const tile    = el('div', { className: 'wbc-tile' + (t.isPaused ? ' tile-paused' : '') + (t.handRaised ? ' tile-hand-raised' : '') + (t.timerCategory === 'rework' ? ' tile-rework' : '') });
      if (!t.isPaused) {
        if (t.targetSeconds) {
          const pct = elapsed / t.targetSeconds;
          if (pct >= overdueFrac()) tile.classList.add('tile-overdue');
          else if (pct >= warnFrac()) tile.classList.add('tile-warning');
        } else {
          if (elapsed > noTargetOverdueSecs()) tile.classList.add('tile-overdue');
          else if (elapsed > noTargetWarnSecs()) tile.classList.add('tile-warning');
        }
      }
      const opRow = el('div', { className: 'wb-operator-row' });
      opRow.appendChild(el('span', {
        className: 'presence-dot ' + (onlineSet.has(t.operatorId) ? 'online' : 'offline'),
        title: onlineSet.has(t.operatorId) ? 'Session active' : 'Not connected',
      }));
      opRow.appendChild(avatarEl({ fullName: t.operatorName, avatarUrl: t.avatarUrl }, 22));
      opRow.appendChild(el('span', { textContent: t.operatorName }));
      tile.appendChild(opRow);
      tile.appendChild(el('div', { className: 'wbc-item', textContent: t.itemNumber }));
      if (t.isPaused)                      tile.appendChild(el('div', { className: 'wbc-paused-tag', textContent: '\u23f8' }));
      if (t.handRaised)                    tile.appendChild(el('div', { className: 'wbc-hand-tag',   textContent: '\u270b' }));
      if (t.timerCategory === 'rework')    tile.appendChild(el('div', { className: 'wbc-rework-tag', textContent: '\uD83D\uDD04' }));
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
        if (pct >= overdueFrac()) tile.classList.add('tile-overdue');
        else if (pct >= warnFrac()) tile.classList.add('tile-warning');
      } else {
        if (elapsed > noTargetOverdueSecs()) tile.classList.add('tile-overdue');
        else if (elapsed > noTargetWarnSecs()) tile.classList.add('tile-warning');
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
      if (hasRole('supervisor')) { showHandRaisedPopup(data); refreshRaisedHands(); }
      return; // no ping beyond the popup
    case 'hands_changed':
      if (hasRole('supervisor')) refreshRaisedHands();
      else refreshStandaloneHandBar(); // operator: their hand may have been lowered
      return; // silent tile/list refresh (a hand was lowered elsewhere)
    case 'time_check_review':
      if (hasRole('manager')) { showTimeCheckPopup(data); refreshTimeCheckCount(); }
      return; // popup carries its own ping
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

// ── Reports page with sub-tabs ────────────────────────────────────────────────
// Three independent sub-pages (Operator Productivity, Quality, Build Efficiency),
// each with its own date range. A tab's data loads the first time it is shown and
// is remembered for the session, so we never fetch all three at once.
const _reportTabsLoaded = { productivity: false, quality: false, build: false };

function _defaultReportDates() {
  const today = new Date().toISOString().slice(0, 10);
  const ago30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return { today, ago30 };
}

function loadReportsPage() {
  const { today, ago30 } = _defaultReportDates();
  [['productivityFrom','productivityTo'], ['qualityFrom','qualityTo'], ['buildFrom','buildTo']]
    .forEach(([f, t]) => {
      const ef = document.getElementById(f), et = document.getElementById(t);
      if (ef && !ef.value) ef.value = ago30;
      if (et && !et.value) et.value = today;
    });
  _reportTabsLoaded.productivity = false;
  _reportTabsLoaded.quality = false;
  _reportTabsLoaded.build = false;
  showReportTab('productivity');
}

function showReportTab(tab) {
  document.querySelectorAll('.report-tab').forEach(btn => {
    const on = btn.getAttribute('data-report-tab') === tab;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.report-panel').forEach(panel => {
    panel.hidden = panel.getAttribute('data-report-panel') !== tab;
  });
  if (!_reportTabsLoaded[tab]) {
    _reportTabsLoaded[tab] = true;
    if (tab === 'productivity') runProductivitySection();
    else if (tab === 'quality') runQualityReport();
    else if (tab === 'build')   runBuildReport();
  }
}

// Use delegation — buttons live inside panels that are hidden at load time.
document.addEventListener('click', e => {
  const tabBtn = e.target.closest && e.target.closest('.report-tab');
  if (tabBtn) { showReportTab(tabBtn.getAttribute('data-report-tab')); return; }
  if (e.target.id === 'btnChartSearch')         runCharts();
  if (e.target.id === 'btnProductivityRefresh') runProductivitySection();
  if (e.target.id === 'btnProductivityCSV')     exportProductivityCSV();
  if (e.target.id === 'btnQualityRefresh')      runQualityReport();
  if (e.target.id === 'btnBuildSearch')         runBuildReport();
  if (e.target.id === 'btnBuildExportCSV')      exportBuildCSV();
});

function _rangeParams(fromId, toId, extra) {
  const fromEl = document.getElementById(fromId);
  const toEl   = document.getElementById(toId);
  const from = fromEl && fromEl.value;
  const to   = toEl && toEl.value;
  const params = new URLSearchParams();
  if (from) params.set('from', new Date(from).toISOString());
  if (to)   { const d = new Date(to); d.setHours(23,59,59,999); params.set('to', d.toISOString()); }
  if (extra) Object.entries(extra).forEach(([k,v]) => params.set(k, v));
  return params;
}

// ── Build Efficiency tab: assembly times + item/throughput stats + overdue ────
async function runBuildReport() {
  const qs = _rangeParams('buildFrom', 'buildTo').toString();

  ['reportStatCards','reportItemTable','reportOperatorTable','reportTrendTable','reportOverdueGrid','reportAssemblyGrid']
    .forEach(id => { const n = document.getElementById(id); if (n) n.innerHTML = '<div class="empty-state">Loading\u2026</div>'; });

  let stats, operators, trends, overdue, assemblyData;
  try {
    [stats, operators, trends, overdue, assemblyData] = await Promise.all([
      GET(`/export/stats?${qs}`),
      GET(`/export/report/operators?${qs}`),
      GET(`/export/report/trends?${qs}`),
      GET(`/export/report/overdue?${qs}`),
      GET(`/export/assembly-summary?${qs}`),
    ]);
  } catch (err) {
    console.error('Build report fetch error:', err);
    const sc = document.getElementById('reportStatCards');
    if (sc) sc.innerHTML = `<div class="error-msg" style="padding:16px">Could not load report data: ${err.message}</div>`;
    return;
  }
  trends       = trends       || [];
  operators    = operators    || [];
  overdue      = overdue      || { byItem: [], byOperator: [] };
  assemblyData = assemblyData || { assemblies: [] };

  renderReportStatCards(stats);
  renderAssemblySummary(assemblyData?.assemblies || []);
  renderReportTrendTable(trends);
  renderReportItemTable(stats?.byItem || []);
  renderReportOperatorTable(operators);
  renderReportOverdue(overdue);
}

// ── Quality tab: Right First Time / rework ────────────────────────────────────
async function runQualityReport() {
  const qs = _rangeParams('qualityFrom', 'qualityTo').toString();
  const container = document.getElementById('reportQualityGrid');
  if (container) container.innerHTML = '<div class="empty-state">Loading\u2026</div>';
  try {
    const qualityData = await GET(`/export/quality?${qs}`);
    renderQualityReport(qualityData || { summary: {}, reworkByItem: [], reworkByOperator: [] });
  } catch (err) {
    if (container) container.innerHTML = `<div class="error-msg" style="padding:16px">Could not load quality data: ${err.message}</div>`;
  }
}

function exportBuildCSV() {
  const qs = _rangeParams('buildFrom', 'buildTo').toString();
  window.location.href = `/api/export/report/csv?${qs}`;
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

// ── PLANNER PAGE ───────────────────────────────────────────────────────────────
// Forward work planning. Supervisors+ view; managers add/edit/delete. Duration
// comes from the item's target time (x quantity) or a manager estimate; the
// Gantt bar length is the server-computed span across working days.

const _plannerState = { dept: '', viewStart: null, fullscreen: false, items: null, targets: { daily: 0, weekly: 0 } };
const _PLAN_WEEKS  = 4;    // weeks shown in the normal (in-page) board
const _PLAN_DAYW   = 46;   // px per day column
const _PLAN_LABELW = 320;  // px of the sticky Item/WO label column (matches CSS)

// How many week-columns to render. The normal board is a fixed 4 weeks; the
// full-screen board auto-fits as many whole weeks as the viewport width allows
// (never fewer than the normal view), so a big planning monitor is filled edge
// to edge instead of wasting space.
function plannerWeeks() {
  if (!_plannerState.fullscreen) return _PLAN_WEEKS;
  const avail = window.innerWidth - _PLAN_LABELW - 4; // 4px slack for the last border
  const fit = Math.floor(avail / (5 * _PLAN_DAYW));
  return Math.max(_PLAN_WEEKS, fit || _PLAN_WEEKS);
}

function plannerMonday(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return d.toISOString().slice(0, 10);
}
function plannerAddDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function plannerNiceDate(iso) { const d = new Date(iso + 'T12:00:00Z'); return d.getUTCDate() + ' ' + d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }); }
function fmtPlanMins(m) {
  if (m == null) return '—';
  const h = Math.floor(m / 60), mm = m % 60;
  return h > 0 ? (mm ? h + 'h ' + mm + 'm' : h + 'h') : mm + 'm';
}
// Full money (week cells, tooltips) and compact money (narrow day cells).
function plannerFmtMoney(n)  { return '£' + Math.round(n).toLocaleString('en-GB'); }
function plannerFmtMoneyK(n) {
  if (n >= 1000) return '£' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return '£' + Math.round(n);
}
// Spread each order-linked job's £ value evenly across its working days (Mon-Fri),
// returning a map of ISO date -> total planned value on that day across all jobs.
// Jobs with no value (manual / unlinked) contribute nothing. Days outside the
// visible window are still counted so week totals only include their visible part.
function plannerValueByDate(items) {
  const map = {};
  for (const it of items) {
    if (it.value == null || !(it.workingDays > 0)) continue;
    const per = it.value / it.workingDays;
    let placed = 0;
    for (let i = 0; placed < it.workingDays && i < 500; i++) {
      const cur = plannerAddDays(it.startDate, i);
      const dow = new Date(cur + 'T12:00:00Z').getUTCDay(); // 0 Sun .. 6 Sat
      if (dow >= 1 && dow <= 5) { map[cur] = (map[cur] || 0) + per; placed++; }
    }
  }
  return map;
}
// Working days (Mon-Fri) across the current window. PT works Mon-Fri by default;
// bar length uses the server's workingDays count so it stays correct regardless.
function plannerWindowDays() {
  const out = [];
  const weeks = plannerWeeks();
  for (let w = 0; w < weeks; w++) for (let i = 0; i < 5; i++) out.push(plannerAddDays(_plannerState.viewStart, w * 7 + i));
  return out;
}

function loadPlannerPage() {
  if (!_plannerState.viewStart) _plannerState.viewStart = plannerMonday(new Date().toISOString().slice(0, 10));
  const filter = document.getElementById('plannerDeptFilter');
  if (filter && !filter._wired) {
    filter._wired = true;
    filter.appendChild(el('option', { value: '', textContent: 'All departments' }));
    for (const d of DEPARTMENTS) filter.appendChild(el('option', { value: d, textContent: d }));
    filter.addEventListener('change', () => { _plannerState.dept = filter.value; renderPlanner(); });
  }
  const wire = (id, fn) => { const b = document.getElementById(id); if (b && !b._wired) { b._wired = true; b.addEventListener('click', fn); } };
  wire('planPrev',  () => { _plannerState.viewStart = plannerAddDays(_plannerState.viewStart, -7); renderPlanner(); });
  wire('planNext',  () => { _plannerState.viewStart = plannerAddDays(_plannerState.viewStart, 7);  renderPlanner(); });
  wire('planToday', () => { _plannerState.viewStart = plannerMonday(new Date().toISOString().slice(0, 10)); renderPlanner(); });
  const addBtn = document.getElementById('btnAddPlanned');
  if (addBtn) {
    addBtn.hidden = !canPlanWrite();
    if (!addBtn._wired) { addBtn._wired = true; addBtn.addEventListener('click', () => openPlannerForm(null)); }
  }
  const resetBtn = document.getElementById('btnPlannerReset');
  if (resetBtn) {
    resetBtn.hidden = !canPlanWrite();
    if (!resetBtn._wired) { resetBtn._wired = true; resetBtn.addEventListener('click', openClearModal); }
  }
  wire('planFullscreen', () => plannerToggleFullscreen(true));
  const summaryBtn = document.getElementById('btnOrderBookSummary');
  if (summaryBtn) {
    summaryBtn.hidden = !hasRole('manager');   // manager+ (includes planner)
    if (!summaryBtn._wired) { summaryBtn._wired = true; summaryBtn.addEventListener('click', openOrderBookReport); }
  }
  initOrderBook();
  renderPlanner();
}

// Manager-only destructive reset: clear the whole planner and/or the selected
// customer's order book. Each needs typing CLEAR to confirm; the server enforces
// the manager gate and logs it to the audit trail.
function openClearModal() {
  const customer = _obState.customer || '';

  function clearSection(opts) {
    const input = el('input', { type: 'text', placeholder: 'Type CLEAR to confirm', autocapitalize: 'characters' });
    input.disabled = !!opts.disabled;   // set via property: el() would apply a boolean attr even for false
    const btn = el('button', { className: 'btn btn-sm dev-danger', textContent: opts.label });
    btn.disabled = true;
    if (!opts.disabled) {
      input.addEventListener('input', () => { btn.disabled = input.value.trim().toUpperCase() !== 'CLEAR'; });
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await opts.action();
          toast(opts.done(res), 'success');
          input.value = '';
          renderPlanner();
          if (document.getElementById('obList')) { const c = document.getElementById('obCustomer'); if (c) c._filled = false; loadOrderBook(); }
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      });
    }
    return el('div', { className: 'clear-section' },
      el('div', { className: 'clear-title', textContent: opts.title }),
      el('div', { className: 'clear-desc', textContent: opts.desc }),
      el('div', { style: 'display:flex;gap:8px;margin-top:8px;' }, input, btn),
    );
  }

  const body = el('div', {},
    el('div', { className: 'clear-warn', textContent: '⚠ These actions are permanent and cannot be undone.' }),
    clearSection({
      title: 'Clear the planner',
      desc: 'Removes every planned job from the Gantt. Uploaded order books are untouched.',
      label: 'Clear planner',
      action: () => POST('/planner/clear', {}),
      done: r => 'Cleared ' + r.cleared + ' planned job' + (r.cleared !== 1 ? 's' : '') + '.',
    }),
    clearSection({
      title: 'Clear the order book' + (customer ? ' (' + customer + ')' : ''),
      desc: customer
        ? 'Removes the entire ' + customer + ' order book. Planned jobs are untouched.'
        : 'Pick a specific customer in the order-book panel first, then reopen this.',
      label: 'Clear order book',
      disabled: !customer,
      action: () => POST('/order-book/clear', { customer }),
      done: r => 'Cleared ' + r.cleared + ' line' + (r.cleared !== 1 ? 's' : '') + ' from the ' + r.customer + ' order book.',
    }),
  );
  openModal('Clear plan / order book', body, [ el('button', { className: 'btn btn-ghost', textContent: 'Close', onclick: () => closeModal() }) ]);
}

// The active board + range elements: the full-screen overlay when it is open,
// otherwise the in-page planner. Both are painted by the same code below.
function _plannerTargets() {
  const fs = _plannerState.fullscreen;
  return {
    board: document.getElementById(fs ? 'plannerFsBoard' : 'plannerBoard'),
    range: document.getElementById(fs ? 'plannerFsRange' : 'plannerRange'),
  };
}

// Fetch the planner from the server, cache it, then paint. renderPlanner is used
// on load and after any mutation; resizing/toggling full screen re-paints from
// the cache via _plannerPaint (no extra request).
async function renderPlanner() {
  const { board, range } = _plannerTargets();
  if (!board) return;
  board.innerHTML = '<div class="empty-state">Loading…</div>';
  const days = plannerWindowDays();
  if (range) range.textContent = plannerNiceDate(days[0]) + ' – ' + plannerNiceDate(days[days.length - 1]) + ' · Mon–Fri';
  try {
    const qs = _plannerState.dept ? '?department=' + encodeURIComponent(_plannerState.dept) : '';
    const resp = await GET('/planner' + qs);
    _plannerState.items = resp.items || [];
    _plannerState.targets = resp.targets || { daily: 0, weekly: 0 };
    _plannerPaint();
  } catch (err) {
    _plannerState.items = null;
    board.innerHTML = '';
    board.appendChild(el('div', { className: 'error-msg', style: 'padding:16px', textContent: err.message }));
  }
}

// Paint the cached planner into the active board. Recomputes the day window each
// time so a full-screen resize (which changes how many weeks fit) reflows without
// re-fetching.
function _plannerPaint() {
  const { board, range } = _plannerTargets();
  if (!board) return;
  const items = _plannerState.items;
  if (!items) return;
  const days = plannerWindowDays();
  if (range) range.textContent = plannerNiceDate(days[0]) + ' – ' + plannerNiceDate(days[days.length - 1]) + ' · Mon–Fri';
  board.innerHTML = '';
  const driftCount = items.filter(it => it.drift).length;
  if (driftCount) {
    board.appendChild(el('div', { className: 'planner-review',
      textContent: '⚠ ' + driftCount + ' planned job' + (driftCount !== 1 ? 's' : '') + ' need review: the order book changed under them (moved, removed, or quantity changed).' }));
  }
  board.appendChild(plannerBoard(items, days));
}

// ── Full-screen Gantt ─────────────────────────────────────────────────────────
// A fixed overlay (z-index below modals/toasts, so Edit/Add and toasts still work
// on top) that fills the browser window. It reuses the same board renderer, so
// drag-to-reschedule, drift badges and deadline markers all behave identically;
// it just fits more weeks across and more rows down. Esc or the Exit button
// closes it. Reflows on resize to keep the week count matched to the width.
let _plannerFsResizeTimer = null;
function _plannerFsResize() {
  clearTimeout(_plannerFsResizeTimer);
  _plannerFsResizeTimer = setTimeout(() => { if (_plannerState.fullscreen) _plannerPaint(); }, 150);
}
function _plannerFsKey(e) {
  if (e.key === 'Escape' && _plannerState.fullscreen) plannerToggleFullscreen(false);
}

function plannerToggleFullscreen(on) {
  _plannerState.fullscreen = on;
  let overlay = document.getElementById('plannerFsOverlay');

  if (on) {
    if (!overlay) {
      const rangeEl = el('div', { id: 'plannerFsRange', className: 'planner-range' });
      const deptSel = el('select', { id: 'plannerFsDept', className: 'planner-dept' });
      deptSel.appendChild(el('option', { value: '', textContent: 'All departments' }));
      for (const d of DEPARTMENTS) deptSel.appendChild(el('option', { value: d, textContent: d }));
      deptSel.value = _plannerState.dept;
      deptSel.addEventListener('change', () => {
        _plannerState.dept = deptSel.value;
        const inPage = document.getElementById('plannerDeptFilter');
        if (inPage) inPage.value = deptSel.value;  // keep the in-page filter in sync
        renderPlanner();
      });

      const bar = el('div', { className: 'planner-fs-bar' },
        el('div', { className: 'planner-fs-title', textContent: '📅 Planner' }),
        el('div', { className: 'planner-nav' },
          el('button', { className: 'btn btn-ghost btn-sm', textContent: '‹ Prev',
            onclick: () => { _plannerState.viewStart = plannerAddDays(_plannerState.viewStart, -7); renderPlanner(); } }),
          el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Today',
            onclick: () => { _plannerState.viewStart = plannerMonday(new Date().toISOString().slice(0, 10)); renderPlanner(); } }),
          el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Next ›',
            onclick: () => { _plannerState.viewStart = plannerAddDays(_plannerState.viewStart, 7); renderPlanner(); } }),
        ),
        rangeEl,
        deptSel,
        el('button', { className: 'btn btn-sm', textContent: '✕ Exit full screen',
          onclick: () => plannerToggleFullscreen(false) }),
      );
      const board = el('div', { id: 'plannerFsBoard', className: 'planner-board planner-fs-board' });
      overlay = el('div', { id: 'plannerFsOverlay', className: 'planner-fs-overlay' }, bar, board);
      document.body.appendChild(overlay);
    } else {
      overlay.hidden = false;
      const deptSel = document.getElementById('plannerFsDept');
      if (deptSel) deptSel.value = _plannerState.dept;
    }
    document.body.classList.add('planner-fs-open');
    window.addEventListener('resize', _plannerFsResize);
    document.addEventListener('keydown', _plannerFsKey);
    // Repaint from cache if we have it; otherwise fetch. Either way the overlay is
    // now the active target.
    if (_plannerState.items) _plannerPaint(); else renderPlanner();
  } else {
    if (overlay) overlay.hidden = true;
    document.body.classList.remove('planner-fs-open');
    window.removeEventListener('resize', _plannerFsResize);
    document.removeEventListener('keydown', _plannerFsKey);
    _plannerPaint();  // repaint the in-page board (week count reverts to normal)
  }
}

// A small chip describing how the order book has drifted under a planned job.
function plannerDriftBadge(drift) {
  if (!drift) return null;
  if (drift.type === 'removed')
    return el('span', { className: 'plan-drift plan-drift-removed', textContent: 'not in current order book' });
  if (drift.type === 'date_moved')
    return el('span', { className: 'plan-drift plan-drift-moved', textContent: 'requirement moved: ' + (drift.wasRequired || '?') + ' → ' + (drift.nowRequired || '?') });
  if (drift.type === 'qty_changed')
    return el('span', { className: 'plan-drift plan-drift-qty', textContent: 'order qty changed: ' + drift.fromQty + ' → ' + drift.toQty });
  return null;
}

function plannerBoard(items, days) {
  const today = new Date().toISOString().slice(0, 10);
  const canEdit = canPlanWrite();
  const inner = el('div', { className: 'planner-inner' });

  const head = el('div', { className: 'planner-headrow' });
  head.appendChild(el('div', { className: 'planner-labelhead', textContent: 'Item / WO' }));
  days.forEach((iso, i) => {
    const dt = new Date(iso + 'T12:00:00Z');
    const cls = 'planner-dayhead' + (i % 5 === 0 ? ' wk' : '') + (iso === today ? ' today' : '');
    head.appendChild(el('div', { className: cls },
      el('span', { className: 'dow', textContent: dt.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }).toUpperCase() }),
      el('span', { className: 'dnum', textContent: iso.slice(8) }),
    ));
  });
  inner.appendChild(head);

  if (!items.length) {
    inner.appendChild(el('div', { className: 'planner-emptyrow', textContent: 'No planned work yet.' }));
    return inner;
  }

  for (const it of items) {
    const row = el('div', { className: 'planner-jobrow' + (it.drift ? ' planner-jobrow-drift' : '') });
    // Label content is laid out horizontally (wide column, shallow rows) so more
    // jobs fit on one PC screen: item + WO on one line, meta on the next, actions
    // to the right. See .planner-joblabel in styles.css.
    const info = el('div', { className: 'planner-jobinfo' },
      el('div', { className: 'planner-jobtitle' },
        el('span', { className: 'planner-jobitem', textContent: it.itemNumber, title: it.itemNumber }),
        el('span', { className: 'planner-jobwo', textContent: it.woNumber ? 'PO ' + it.woNumber : '(no PO)', title: it.woNumber ? 'Purchasing Document ' + it.woNumber : 'No purchasing document' }),
      ),
      el('div', { className: 'planner-jobmeta', textContent: 'Qty ' + it.quantity + ' · ' + fmtPlanMins(it.totalMinutes) + ' · ' + it.durationSource + (it.worksOrder ? ' · WO ' + it.worksOrder : '') }),
    );
    const driftBadge = plannerDriftBadge(it.drift);
    if (driftBadge) info.appendChild(driftBadge);
    const label = el('div', { className: 'planner-joblabel' }, info);
    if (canEdit) {
      label.appendChild(el('div', { className: 'planner-jobactions' },
        el('button', { className: 'btn btn-sm btn-ghost', textContent: 'Edit', onclick: () => openPlannerForm(it) }),
        el('button', { className: 'btn btn-sm btn-ghost dev-danger', textContent: 'Delete', onclick: () => deletePlannerItem(it) }),
      ));
    }
    row.appendChild(label);

    const track = el('div', { className: 'planner-track' });
    days.forEach((iso, i) => {
      track.appendChild(el('div', { className: 'planner-daycell' + (i % 5 === 0 ? ' wk' : '') + (iso === today ? ' today' : '') }));
    });
    let startCol = days.indexOf(it.startDate);
    // A bar may only be dragged when it is drawn ON its real start date. If the
    // job starts before this window (or on a non-working day) the bar is drawn at
    // the nearest visible column instead, so dragging it would shift the job by
    // far more than the small nudge the visual implies. Those bars are shown
    // dashed and are not draggable; use Edit, or page to the week it starts in.
    const startsInWindow = startCol >= 0;
    if (startCol < 0) { for (let i = 0; i < days.length; i++) { if (days[i] >= it.startDate) { startCol = i; break; } } }
    if (startCol >= 0 && it.totalMinutes) {
      const span = Math.max(1, Math.min(it.workingDays || 1, days.length - startCol));
      const bar = el('div', {
        className: 'planner-bar ' + (it.durationSource === 'estimate' ? 'estimate' : 'target') + (startsInWindow ? '' : ' offwindow'),
        title: it.itemNumber + (it.woNumber ? ' / ' + it.woNumber : '') + ': ' + it.startDate + ' to ' + it.endDate + ' (' + it.workingDays + ' working days)'
             + (startsInWindow ? '' : '. Not draggable here: this bar is not drawn on its real start date. Page to the week it starts in, or use Edit.'),
      });
      bar.style.left  = (startCol * _PLAN_DAYW + 3) + 'px';
      bar.style.width = (span * _PLAN_DAYW - 6) + 'px';
      bar.textContent = it.itemNumber + ' · ' + fmtPlanMins(it.totalMinutes);
      if (canEdit && startsInWindow) makePlannerBarDraggable(bar, it, startCol, days);
      track.appendChild(bar);
    }
    // Deadline marker: the current customer required date, drawn on the row. If
    // the planned finish is past it, the marker turns red (job is late).
    if (it.currentRequiredBy) {
      const mCol = days.indexOf(it.currentRequiredBy);
      if (mCol >= 0) {
        const late = it.endDate && it.endDate > it.currentRequiredBy;
        const marker = el('div', {
          className: 'planner-deadline' + (late ? ' late' : ''),
          title: 'Required by ' + it.currentRequiredBy + (late ? ' — planned finish (' + it.endDate + ') is after this' : ''),
        });
        marker.style.left = (mCol * _PLAN_DAYW + _PLAN_DAYW - 2) + 'px';
        track.appendChild(marker);
      }
    }
    row.appendChild(track);
    inner.appendChild(row);
  }

  // ── Output totals: planned £ value per day and per week, vs the targets. Each
  // job's value is spread evenly over its working days; days/weeks that carry some
  // planned work but fall short of the target are highlighted (under-planned).
  // Empty days/weeks (nothing planned yet) are left neutral, not flagged, so the
  // far end of the horizon isn't a wall of red before it has been filled in.
  const valByDate = plannerValueByDate(items);
  const targets = _plannerState.targets || { daily: 0, weekly: 0 };

  const dayRow = el('div', { className: 'planner-totrow' });
  dayRow.appendChild(el('div', { className: 'planner-totlabel' },
    el('div', { className: 'planner-tottitle', textContent: 'Planned £ / day' }),
    el('div', { className: 'planner-totsub', textContent: targets.daily ? 'target ' + plannerFmtMoney(targets.daily) : 'no target set' }),
  ));
  days.forEach((iso, i) => {
    const v = valByDate[iso] || 0;
    const under = targets.daily > 0 && v > 0 && v < targets.daily;
    dayRow.appendChild(el('div', {
      className: 'planner-totcell' + (i % 5 === 0 ? ' wk' : '') + (under ? ' under' : (v > 0 ? ' ok' : '')),
      title: iso + ': ' + plannerFmtMoney(v) + (targets.daily ? ' of ' + plannerFmtMoney(targets.daily) + ' target' : ''),
      textContent: v > 0 ? plannerFmtMoneyK(v) : '–',
    }));
  });
  inner.appendChild(dayRow);

  const weekRow = el('div', { className: 'planner-totrow planner-totrow-week' });
  weekRow.appendChild(el('div', { className: 'planner-totlabel' },
    el('div', { className: 'planner-tottitle', textContent: 'Planned £ / week' }),
    el('div', { className: 'planner-totsub', textContent: targets.weekly ? 'target ' + plannerFmtMoney(targets.weekly) : 'no target set' }),
  ));
  const weeks = Math.round(days.length / 5);
  for (let w = 0; w < weeks; w++) {
    let sum = 0;
    for (let i = 0; i < 5; i++) sum += valByDate[days[w * 5 + i]] || 0;
    const under = targets.weekly > 0 && sum > 0 && sum < targets.weekly;
    weekRow.appendChild(el('div', {
      className: 'planner-totweek' + (under ? ' under' : (sum > 0 ? ' ok' : '')),
      title: 'Week of ' + days[w * 5] + ': ' + plannerFmtMoney(sum) + (targets.weekly ? ' of ' + plannerFmtMoney(targets.weekly) + ' target' : ''),
      textContent: sum > 0 ? plannerFmtMoney(sum) : '–',
    }));
  }
  inner.appendChild(weekRow);

  return inner;
}

// Drag a bar sideways to reschedule a planned job. Managers only (the server
// enforces it too). Snaps to working-day columns, and only the START date moves:
// duration is derived from the target time or estimate, so bars are deliberately
// not resizable. Pointer events (not HTML5 drag-and-drop) so this works with
// touch on the shopfloor tablets as well as a mouse.
function makePlannerBarDraggable(bar, item, startCol, days) {
  bar.classList.add('draggable');
  const origLabel = bar.textContent;
  let dragging = false, startX = 0, origLeft = 0, deltaCols = 0;

  bar.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;   // primary button / touch only
    dragging  = true;
    deltaCols = 0;
    startX    = e.clientX;
    origLeft  = parseFloat(bar.style.left) || 0;
    try { bar.setPointerCapture(e.pointerId); } catch (_) {}
    bar.classList.add('dragging');
    e.preventDefault();
  });

  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // Snap to whole day columns, clamped so the bar stays inside the window.
    let cols = Math.round((e.clientX - startX) / _PLAN_DAYW);
    cols = Math.max(-startCol, Math.min(days.length - 1 - startCol, cols));
    deltaCols = cols;
    bar.style.left  = (origLeft + cols * _PLAN_DAYW) + 'px';
    bar.textContent = item.itemNumber + ' · ' + plannerNiceDate(days[startCol + cols]);
  });

  const finishDrag = async (e) => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
    bar.textContent = origLabel;

    const newDate = days[startCol + deltaCols];
    if (!deltaCols || !newDate || newDate === item.startDate) { renderPlanner(); return; }
    try {
      await PATCH('/planner/' + item.id, { startDate: newDate });
      toast(item.itemNumber + ' moved to ' + plannerNiceDate(newDate), 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    renderPlanner();   // redraw from server truth (recomputed finish date)
  };
  bar.addEventListener('pointerup', finishDrag);
  bar.addEventListener('pointercancel', finishDrag);
}

function openPlannerForm(existing, prefill) {
  const isEdit = !!existing;
  const pf = prefill || {};
  const itemInput = el('input', { type: 'text', value: existing ? existing.itemNumber : (pf.itemNumber || ''), placeholder: 'e.g. PHL-1001', autocapitalize: 'characters' });
  // woInput holds KLA's Purchasing Document (the order-book link, prefilled from
  // the offering). worksInput is OUR works order, entered here (not on any upload).
  const woInput    = el('input', { type: 'text', value: existing ? (existing.woNumber || '') : (pf.woNumber || ''), placeholder: 'KLA purchasing document (optional)' });
  const worksInput = el('input', { type: 'text', value: existing ? (existing.worksOrder || '') : (pf.worksOrder || ''), placeholder: 'Our works order (optional)' });
  const dateInput = el('input', { type: 'date', value: existing ? existing.startDate : new Date().toISOString().slice(0, 10) });
  const qtyInput  = el('input', { type: 'number', min: '1', max: '9999', value: String(existing ? existing.quantity : (pf.quantity || 1)) });
  const hasEst    = existing && existing.estimatedMinutes != null;
  const estHInput = el('input', { type: 'number', min: '0', max: '999', value: hasEst ? String(Math.floor(existing.estimatedMinutes / 60)) : '', placeholder: 'h' });
  const estMInput = el('input', { type: 'number', min: '0', max: '59', value: hasEst ? String(existing.estimatedMinutes % 60) : '', placeholder: 'm' });
  const deptSel   = el('select', {});
  deptSel.appendChild(el('option', { value: '', textContent: '(none)' }));
  for (const d of DEPARTMENTS) deptSel.appendChild(el('option', { value: d, textContent: d }));
  deptSel.value = existing && existing.department ? existing.department : 'Production';

  // Backward scheduling: when planning an order-book item (prefill carries the
  // customer required date), default the start to Required date minus the job's
  // duration, MRP-style. The planner adjusts from there.
  const scheduleNote = el('div', { className: 'planner-schednote' });
  const currentDuration = () => {
    const qty = parseInt(qtyInput.value, 10) || 1;
    if (pf.perItemMinutes) return pf.perItemMinutes * qty;                 // target-time item
    const em = (parseInt(estHInput.value, 10) || 0) * 60 + (parseInt(estMInput.value, 10) || 0);
    return em > 0 ? em * qty : 0;                                          // estimate item
  };
  async function recomputeStart() {
    if (!pf.requiredDate) return;
    const mins = currentDuration();
    if (!(mins > 0)) { scheduleNote.textContent = 'Required by ' + pf.requiredDate + '. Enter an estimate to suggest a start.'; return; }
    try {
      const r = await GET('/planner/suggest-start?required=' + pf.requiredDate + '&minutes=' + Math.round(mins));
      const today = new Date().toISOString().slice(0, 10);
      if (r.startDate < today) {
        dateInput.value = today;
        scheduleNote.textContent = 'Required by ' + pf.requiredDate + '. Backward schedule is already in the past, so starting today (tight).';
      } else {
        dateInput.value = r.startDate;
        scheduleNote.textContent = 'Required by ' + pf.requiredDate + '. Start works back from the required date; adjust if you want buffer.';
      }
    } catch (_) { /* keep the default start */ }
  }

  // Quantity allocation note: how much of the order line is left, and a warning
  // (not a block) when the entered quantity over-plans it (e.g. MOQ over-builds).
  const allocNote = el('div', { className: 'planner-schednote' });
  function updateAllocNote() {
    if (pf.remainingQty == null) return;
    const qty = parseInt(qtyInput.value, 10) || 0;
    if (qty > pf.remainingQty) {
      allocNote.textContent = '⚠ Over-plans this order by ' + (qty - pf.remainingQty) + ' (' + Math.max(0, pf.remainingQty) + ' remaining on the line).';
      allocNote.classList.add('planner-warn');
    } else {
      allocNote.textContent = pf.remainingQty > 0
        ? pf.remainingQty + ' remaining on this order line.'
        : 'This line is already fully planned; adding more will over-build.';
      allocNote.classList.remove('planner-warn');
    }
  }

  const body = el('div', { className: 'planner-form' },
    el('label', { className: 'dev-form-label', textContent: 'Item Number' }), itemInput,
    el('label', { className: 'dev-form-label', textContent: 'Purchasing Document (KLA)' }), woInput,
    el('label', { className: 'dev-form-label', textContent: 'W/O Number (ours)' }), worksInput,
    el('label', { className: 'dev-form-label', textContent: 'Start date' }), dateInput,
    scheduleNote,
    el('label', { className: 'dev-form-label', textContent: 'Quantity' }), qtyInput,
    allocNote,
    el('label', { className: 'dev-form-label', textContent: 'Estimated time per item (used only if the item has no target time)' }),
    el('div', { style: 'display:flex;gap:8px' }, estHInput, estMInput),
    el('label', { className: 'dev-form-label', textContent: 'Department' }), deptSel,
  );

  if (pf.requiredDate) {
    qtyInput.addEventListener('input', recomputeStart);
    estHInput.addEventListener('input', recomputeStart);
    estMInput.addEventListener('input', recomputeStart);
    recomputeStart(); // initial backward-scheduled suggestion
  }
  if (pf.remainingQty != null) {
    qtyInput.addEventListener('input', updateAllocNote);
    updateAllocNote();
  }

  const save = el('button', { className: 'btn btn-primary', textContent: isEdit ? 'Save' : 'Add' });
  save.addEventListener('click', async () => {
    const payload = {
      itemNumber: itemInput.value.trim(),
      woNumber: woInput.value.trim(),
      worksOrder: worksInput.value.trim(),
      startDate: dateInput.value,
      quantity: parseInt(qtyInput.value, 10) || 1,
      estimatedHours: estHInput.value === '' ? null : parseInt(estHInput.value, 10),
      estimatedMinutes: estMInput.value === '' ? null : parseInt(estMInput.value, 10),
      department: deptSel.value || null,
      sourceRequiredBy: pf.requiredDate || null,
      sourcePoLine: pf.sourcePoLine || null,
      sourceOrderedQty: pf.sourceOrderedQty != null ? pf.sourceOrderedQty : null,
    };
    try {
      if (isEdit) await PATCH(`/planner/${existing.id}`, payload);
      else await POST('/planner', payload);
      closeModal();
      toast(isEdit ? 'Planned work updated' : 'Planned work added', 'success');
      renderPlanner();
      if (document.getElementById('obList')) renderOrderBook(); // refresh "planned" flags
    } catch (err) { toast(err.message, 'error'); }
  });
  openModal(isEdit ? 'Edit planned work' : 'Add planned work', body, [
    el('button', { className: 'btn btn-ghost', textContent: 'Cancel', onclick: () => closeModal() }),
    save,
  ]);
}

async function deletePlannerItem(it) {
  if (!confirm(`Remove planned work for ${it.itemNumber}?`)) return;
  try { await DELETE(`/planner/${it.id}`); toast('Removed', 'success'); renderPlanner(); }
  catch (err) { toast(err.message, 'error'); }
}

// ── ORDER BOOK (available to build) ────────────────────────────────────────────
// A customer's imported order book (e.g. KLA's weekly SAP export) drives an
// "available to build" offering on the Planner: order lines whose effective date
// (Required By, else Current Due Date) fall within the 8-week shippable window.
// Managers upload a CSV/tab export; the browser parses it and posts clean rows,
// and each line can be added straight onto the planner.

const _obState = { customer: '', collapsed: false, wired: false, horizon: '26', items: null };

function initOrderBook() {
  if (_obState.wired) { loadOrderBook(); return; }
  _obState.wired = true;

  const cust = document.getElementById('obCustomer');
  if (cust) cust.addEventListener('change', () => { _obState.customer = cust.value; renderOrderBook(); });

  // Horizon just filters what is shown from the already-loaded book — no refetch.
  const horizon = document.getElementById('obHorizon');
  if (horizon) { horizon.value = _obState.horizon; horizon.addEventListener('change', () => { _obState.horizon = horizon.value; paintOrderBook(); }); }

  const uploadBtn = document.getElementById('btnUploadOrderBook');
  const fileInput = document.getElementById('obFileInput');
  if (uploadBtn) uploadBtn.hidden = !canPlanWrite();
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) handleOrderBookFile(f);
      fileInput.value = '';
    });
  }

  const toggle = document.getElementById('btnToggleOrderBook');
  const panel  = document.getElementById('orderBookPanel');
  if (toggle && panel) toggle.addEventListener('click', () => {
    _obState.collapsed = !_obState.collapsed;
    panel.classList.toggle('collapsed', _obState.collapsed);
    toggle.textContent = _obState.collapsed ? 'Show' : 'Hide';
  });

  loadOrderBook();
}

async function loadOrderBook() {
  const cust = document.getElementById('obCustomer');
  if (cust && !cust._filled) {
    try {
      const customers = await GET('/order-book/customers');
      cust.innerHTML = '';
      cust.appendChild(el('option', { value: '', textContent: customers.length ? 'All customers' : 'No order book loaded' }));
      for (const c of customers) cust.appendChild(el('option', { value: c, textContent: c }));
      cust._filled = true;
      if (customers.length === 1) { cust.value = customers[0]; _obState.customer = customers[0]; }
    } catch (_) { /* offering endpoint will show the error */ }
  }
  renderOrderBook();
}

async function renderOrderBook() {
  const list = document.getElementById('obList');
  if (!list) return;
  list.innerHTML = '<div class="empty-state" style="padding:12px">Loading…</div>';
  try {
    const qs = _obState.customer ? `?customer=${encodeURIComponent(_obState.customer)}` : '';
    _obState.items = await GET(`/order-book/offering${qs}`);
    paintOrderBook();
  } catch (err) {
    _obState.items = null;
    list.innerHTML = '';
    list.appendChild(el('div', { className: 'error-msg', style: 'padding:12px', textContent: err.message }));
  }
}

// Paint the cached order book, applying the selected horizon. The whole book is
// held in _obState.items; changing the horizon re-paints without re-fetching.
function paintOrderBook() {
  const list = document.getElementById('obList');
  const summary = document.getElementById('obSummary');
  if (!list) return;
  const all = _obState.items || [];

  const dated   = all.filter(it => it.effectiveDate);
  const undated = all.filter(it => !it.effectiveDate);
  const inWin   = dated.filter(it => it.withinWindow).length;
  const beyond  = dated.length - inWin;
  const totalVal = all.reduce((s, it) => s + (it.lineValue || 0), 0);
  if (summary) {
    summary.textContent = all.length
      ? `${inWin} within 8 weeks · ${beyond} beyond · ${undated.length} undated · ${obMoney(totalVal)} total value`
      : 'No order book loaded for this customer.';
  }

  // Horizon: 'all' shows everything (including undated); a week count shows only
  // dated lines whose effective date is within that many weeks from today.
  const horizon = _obState.horizon || 'all';
  let shownDated = dated, shownUndated = undated;
  if (horizon !== 'all') {
    const cutoff = new Date(Date.now() + parseInt(horizon, 10) * 7 * 86400000).toISOString().slice(0, 10);
    shownDated = dated.filter(it => it.effectiveDate <= cutoff);
    shownUndated = [];   // undated lines only appear in the full 'All dates' view
  }

  list.innerHTML = '';
  if (!shownDated.length && !shownUndated.length) {
    list.appendChild(el('div', { className: 'empty-state', style: 'padding:12px',
      textContent: all.length ? 'Nothing in this horizon — widen it to see more of the book.' : 'Nothing available to build.' }));
    return;
  }
  list.appendChild(orderBookTable(shownDated, shownUndated));
}

function obMoney(v) {
  return '£' + (v || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Build one offering <tr>. Beyond-window and undated lines get a muted class so
// the in-window (shippable) lines stand out; the description is a hover tooltip.
function obRow(it, canPlan) {
  const itemCell = el('td', { className: 'ob-item' },
    el('span', { className: 'ob-item-no', textContent: it.itemNumber }));
  if (!it.hasTarget) itemCell.appendChild(el('span', { className: 'ob-notarget', title: 'No target time; you will enter an estimate when planning', textContent: 'no target' }));

  // Quantity cell: remaining of ordered, e.g. "4 of 7" (or "fully planned" / "over-planned by N").
  const qtyCell = el('td', { className: 'ob-qty' });
  if (it.overPlanned) qtyCell.appendChild(el('span', { className: 'ob-over', textContent: 'over-planned by ' + (it.plannedQty - it.quantity) }));
  else if (it.fullyPlanned) qtyCell.appendChild(el('span', { className: 'ob-planned', textContent: '✓ ' + it.quantity + ' planned' }));
  else qtyCell.appendChild(el('span', {}, String(it.remainingQty) + ' of ' + it.quantity));

  // Managers can always add (to over-build for MOQ, or to pull build-ahead work forward).
  const action = el('td', {});
  if (canPlan) action.appendChild(el('button', { className: 'btn btn-sm', textContent: it.remainingQty > 0 ? 'Add' : 'Add more', title: it.remainingQty > 0 ? 'Add to planner' : 'Add more (over-build)', onclick: () => addOfferingToPlanner(it) }));

  const rowClass = (it.fullyPlanned ? 'ob-row-planned ' : '') + (it.withinWindow ? '' : 'ob-row-beyond');
  return el('tr', { className: rowClass.trim(), title: it.description || '' },
    itemCell,
    el('td', { className: 'ob-date' + (it.overdue ? ' ob-overdue' : ''), textContent: it.effectiveDate || 'no date' }),
    qtyCell,
    el('td', { className: 'ob-value', textContent: it.lineValue != null ? obMoney(it.lineValue) : '' }),
    el('td', { className: 'ob-po', textContent: it.poNumber || '' }),
    action,
  );
}

// dated: in-date-order lines (in-window first, then build-ahead); undated: no
// required/due date. A divider marks the 8-week boundary and the undated group.
function orderBookTable(dated, undated) {
  const canPlan = canPlanWrite();
  const tbl = el('table', { className: 'dash-table ob-table' });
  tbl.appendChild(el('thead', {}, el('tr', {},
    el('th', { textContent: 'Item' }),
    el('th', { textContent: 'Required' }), el('th', { textContent: 'To build' }),
    el('th', { textContent: 'Value' }), el('th', { textContent: 'PO' }), el('th', { textContent: '' }),
  )));
  const tb = el('tbody', {});
  const divider = text => el('tr', { className: 'ob-divider' }, el('td', { colspan: '6', textContent: text }));

  let boundaryDone = false;
  for (const it of dated) {
    // Drop the boundary marker in once, before the first beyond-window line.
    if (!it.withinWindow && !boundaryDone) { tb.appendChild(divider('End of 8-week shippable window — build ahead below')); boundaryDone = true; }
    tb.appendChild(obRow(it, canPlan));
  }
  if (undated.length) {
    tb.appendChild(divider('No required date yet'));
    for (const it of undated) tb.appendChild(obRow(it, canPlan));
  }
  tbl.appendChild(tb);
  return tbl;
}

function addOfferingToPlanner(it) {
  // Default the quantity to what's still remaining on the line (min 1 so an
  // over-build for MOQ can still be planned when the line is already met).
  openPlannerForm(null, { itemNumber: it.itemNumber, quantity: Math.max(1, it.remainingQty), woNumber: it.poNumber,
    requiredDate: it.effectiveDate, perItemMinutes: it.perItemMinutes,
    sourcePoLine: it.poLine, sourceOrderedQty: it.quantity, remainingQty: it.remainingQty });
}

// ── Order Book Summary report (manager+) ──────────────────────────────────────
// Builds the printable weekly report of build-completion dates vs required dates
// for the customer's order lines, and opens it in a new tab ready to print /
// save as PDF. Data comes from GET /order-book/report; the report is a
// self-contained HTML document (isolated from the app's styles).
async function openOrderBookReport() {
  const customer = _obState.customer || 'KLA';
  const btn = document.getElementById('btnOrderBookSummary');
  if (btn) btn.disabled = true;
  try {
    const horizon = _obState.horizon || 'all';   // match the planner's "Next X weeks" selector
    const rep = await GET('/order-book/report?customer=' + encodeURIComponent(customer) + '&horizon=' + encodeURIComponent(horizon));
    const url = URL.createObjectURL(new Blob([buildOrderBookReportHtml(rep)], { type: 'text/html' }));
    const w = window.open(url, '_blank');
    if (!w) toast('Allow pop-ups for this site to open the report.', 'error');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    toast(err.message, 'error');
  } finally { if (btn) btn.disabled = false; }
}

function rptDate(iso, full) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', full
    ? { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }
    : { day: '2-digit', month: 'short', timeZone: 'UTC' });
}
function rptMoney(v)      { return '£' + Math.round(Number(v) || 0).toLocaleString('en-GB'); }
function rptMoneyShort(v) { v = Number(v) || 0; return v >= 1e6 ? '£' + (v / 1e6).toFixed(2) + 'm' : v >= 1e3 ? '£' + Math.round(v / 1e3) + 'k' : '£' + Math.round(v); }

function buildOrderBookReportHtml(rep) {
  const S = rep.summary || { openLines: 0, committedValue: 0, onTrack: 0, late: 0, awaiting: 0 };
  const tot = S.openLines || 1;
  const pct = n => (n / tot * 100).toFixed(1);
  const genFull = rptDate(rep.generatedAt, true);
  const weekOf  = rptDate(plannerMonday(rep.generatedAt), true);
  const preparedBy = (state.user && state.user.fullName) || '';
  const cust = esc(rep.customer || 'KLA');
  const scope = (rep.horizon && rep.horizon !== 'all') ? 'Next ' + rep.horizon + ' weeks' : 'Full order book';

  const vari = l => {
    if (l.varianceDays == null) return '<span class="var-none">n/a</span>';
    if (l.varianceDays === 0)   return '<span class="var-early">on time</span>';
    if (l.varianceDays > 0)     return '<span class="var-early">' + l.varianceDays + ' day' + (l.varianceDays !== 1 ? 's' : '') + ' early</span>';
    const n = -l.varianceDays;  return '<span class="var-late">' + n + ' day' + (n !== 1 ? 's' : '') + ' late</span>';
  };
  const chip = s => s === 'ontrack' ? '<span class="chip ok">On track</span>'
    : s === 'late' ? '<span class="chip late">Late</span>'
    : '<span class="chip wait">Awaiting schedule</span>';

  const rows = (rep.lines || []).map(l => `<tr class="${l.status === 'late' ? 'late-row' : ''}">
      <td class="item">${esc(l.item || '')}</td>
      <td class="desc">${esc(l.description || '')}</td>
      <td class="mono">${esc(l.po || '')}</td>
      <td class="r mono">${l.qty}</td>
      <td class="mono">${l.requiredBy ? rptDate(l.requiredBy) : '<span class="var-none">no date</span>'}</td>
      <td class="mono">${l.expected ? rptDate(l.expected) : '<span class="var-none">unplanned</span>'}</td>
      <td>${vari(l)}</td>
      <td>${chip(l.status)}</td>
      <td class="r val">${l.value != null ? rptMoney(l.value) : ''}</td>
    </tr>`).join('');

  const lateLines = (rep.lines || []).filter(l => l.status === 'late').sort((a, b) => a.varianceDays - b.varianceDays);
  const attnItems = lateLines.slice(0, 8).map(l =>
    `<li><span class="code">${esc(l.item || '')}</span><span class="desc">${esc(l.description || '')}</span><span class="slip">${-l.varianceDays} days late &middot; req ${rptDate(l.requiredBy)}</span></li>`).join('');
  const attn = lateLines.length ? `
    <div class="sec"><h2>Needs attention</h2><span class="rule"></span><span class="count">${Math.min(8, lateLines.length)} of ${lateLines.length} shown</span></div>
    <div class="attn"><div class="ah">&#9650; Lines forecast to finish after their required date</div>
      <ul>${attnItems}${lateLines.length > 8 ? `<li><span class="code">+ ${lateLines.length - 8} more</span></li>` : ''}</ul></div>` : '';

  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<title>Order Book Status Report - ${cust}</title>
<style>
:root{--paper:#fbfcfd;--sheet:#fff;--ink:#141922;--muted:#5a6675;--faint:#8a94a2;--hair:#e3e8ee;--hair2:#eef1f5;--brand:#2e75b6;--brand-deep:#1e3a5f;--ok:#1e7f5c;--ok-bg:#e7f4ee;--late:#c0392b;--late-bg:#fdecea;--wait:#8a94a2;--wait-bg:#eef1f4;--sans:ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,"SF Mono","Cascadia Code",Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased;padding:28px 20px 60px}
.sheet{max-width:900px;margin:0 auto;background:var(--sheet);border:1px solid var(--hair);border-radius:6px;box-shadow:0 1px 2px rgba(20,25,34,.04),0 12px 32px rgba(20,25,34,.06);padding:40px 44px 36px}
.mast{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:18px;border-bottom:2px solid var(--brand)}
.mast-left{display:flex;flex-direction:column;gap:14px}
.brand{display:flex;align-items:center;gap:11px}
.brand .mark{width:26px;height:26px;border-radius:5px;background:var(--brand);position:relative;flex:0 0 auto}
.brand .mark::after{content:"";position:absolute;inset:7px;border:2px solid #fff;border-radius:2px}
.brand .name{font-weight:800;letter-spacing:.14em;font-size:15px;color:var(--brand-deep)}
.brand .sub{font-size:11px;letter-spacing:.06em;color:var(--muted);margin-top:1px}
.mast .title{font-size:23px;font-weight:800;letter-spacing:-.01em;margin:0}
.mast .for{font-size:13px;color:var(--muted);margin-top:3px}
.mast .for b{color:var(--ink)}
.meta{text-align:right;font-family:var(--mono);font-size:11.5px;color:var(--muted);line-height:1.7;white-space:nowrap}
.meta b{color:var(--ink)}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--hair);border:1px solid var(--hair);border-radius:6px;overflow:hidden;margin:22px 0 18px}
.kpi{background:var(--sheet);padding:13px 15px 14px}
.kpi .lab{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);font-weight:700}
.kpi .num{font-family:var(--mono);font-size:23px;font-weight:600;margin-top:6px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi .cap{font-size:11px;color:var(--muted);margin-top:1px}
.kpi.good .num{color:var(--ok)}.kpi.bad .num{color:var(--late)}.kpi.wait .num{color:var(--wait)}
.dist{margin:0 0 26px}
.dist-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px}
.dist-head .t{font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;color:var(--muted)}
.dist-head .r{font-family:var(--mono);font-size:11.5px;color:var(--faint)}
.bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--hair2)}
.bar span{display:block}.bar .s-ok{background:var(--ok)}.bar .s-late{background:var(--late)}.bar .s-wait{background:var(--wait)}
.legend{display:flex;gap:20px;margin-top:9px;font-size:11.5px;color:var(--muted)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}
.legend b{color:var(--ink);font-family:var(--mono)}
.sec{display:flex;align-items:center;gap:10px;margin:0 0 11px}
.sec h2{font-size:13px;font-weight:800;margin:0}.sec .rule{flex:1;height:1px;background:var(--hair)}
.sec .count{font-family:var(--mono);font-size:11px;color:var(--faint)}
.attn{border:1px solid var(--late-bg);background:#fffafa;border-left:3px solid var(--late);border-radius:6px;padding:13px 16px;margin-bottom:26px}
.attn .ah{font-size:12px;font-weight:800;color:var(--late);margin-bottom:8px;display:flex;align-items:center;gap:7px}
.attn ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.attn li{display:flex;gap:10px;align-items:baseline;font-size:12.5px}
.attn li .code{font-family:var(--mono);font-weight:600;color:var(--ink);flex:0 0 118px}
.attn li .desc{color:var(--muted);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.attn li .slip{font-family:var(--mono);color:var(--late);font-weight:600;flex:0 0 auto}
table{width:100%;border-collapse:collapse;font-size:12.5px}
thead th{text-align:left;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);font-weight:700;padding:0 12px 8px;border-bottom:1.5px solid var(--ink)}
th.r,td.r{text-align:right}
tbody td{padding:11px 12px;border-bottom:1px solid var(--hair2);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.item{font-family:var(--mono);font-weight:600;white-space:nowrap}
.desc{color:var(--muted)}.val{font-family:var(--mono);white-space:nowrap}
.var-early{color:var(--ok);font-family:var(--mono);white-space:nowrap}
.var-late{color:var(--late);font-weight:600;font-family:var(--mono);white-space:nowrap}
.var-none{color:var(--faint)}
tr.late-row td{background:linear-gradient(90deg,var(--late-bg),transparent 60%)}
tr.late-row .item{box-shadow:inset 2px 0 0 var(--late)}
.chip{display:inline-block;font-size:10.5px;font-weight:700;padding:2.5px 9px;border-radius:20px;white-space:nowrap}
.chip.ok{color:var(--ok);background:var(--ok-bg)}.chip.late{color:var(--late);background:var(--late-bg)}.chip.wait{color:#586372;background:var(--wait-bg)}
.tfoot{font-size:11px;color:var(--faint);margin-top:12px;padding-top:11px;border-top:1px solid var(--hair)}
footer{max-width:900px;margin:20px auto 0;display:flex;justify-content:space-between;gap:20px;font-size:10.5px;color:var(--faint);padding:0 4px}
footer b{color:var(--muted)}
@media print{@page{size:A4;margin:13mm}body{background:#fff;padding:0}.sheet{max-width:none;margin:0;border:0;border-radius:0;box-shadow:none;padding:0}thead{display:table-header-group}tr{break-inside:avoid}.attn,.kpis{break-inside:avoid}footer{margin-top:14px}}
</style></head><body>
<div class="sheet">
  <header class="mast">
    <div class="mast-left">
      <div class="brand"><div class="mark"></div><div><div class="name">PHILTRONICS</div><div class="sub">Production Planning</div></div></div>
      <div><h1 class="title">Order Book Status Report</h1><div class="for">Prepared for <b>${cust}</b> &middot; build completion against required dates</div></div>
    </div>
    <div class="meta">Report date <b>${genFull}</b><br>Week commencing <b>${weekOf}</b><br>Scope <b>${esc(scope)}</b><br>Prepared by <b>${esc(preparedBy)}</b></div>
  </header>
  <section class="kpis">
    <div class="kpi"><div class="lab">Open lines</div><div class="num">${S.openLines}</div><div class="cap">on the order book</div></div>
    <div class="kpi"><div class="lab">Committed value</div><div class="num">${rptMoneyShort(S.committedValue)}</div><div class="cap">${rptMoney(S.committedValue)} total</div></div>
    <div class="kpi good"><div class="lab">On track</div><div class="num">${S.onTrack}</div><div class="cap">complete on or before</div></div>
    <div class="kpi bad"><div class="lab">Late</div><div class="num">${S.late}</div><div class="cap">finish after required</div></div>
    <div class="kpi wait"><div class="lab">Awaiting schedule</div><div class="num">${S.awaiting}</div><div class="cap">not yet planned</div></div>
  </section>
  <section class="dist">
    <div class="dist-head"><div class="t">Delivery confidence</div><div class="r">${S.openLines} lines &middot; by line count</div></div>
    <div class="bar"><span class="s-ok" style="width:${pct(S.onTrack)}%"></span><span class="s-late" style="width:${pct(S.late)}%"></span><span class="s-wait" style="width:${pct(S.awaiting)}%"></span></div>
    <div class="legend"><span><i style="background:var(--ok)"></i>On track <b>${S.onTrack}</b></span><span><i style="background:var(--late)"></i>Late <b>${S.late}</b></span><span><i style="background:var(--wait)"></i>Awaiting schedule <b>${S.awaiting}</b></span></div>
  </section>
  ${attn}
  <div class="sec"><h2>Line item detail</h2><span class="rule"></span><span class="count">${S.openLines} lines &middot; by required date</span></div>
  <table>
    <thead><tr><th>Item</th><th>Description</th><th>PO</th><th class="r">Qty</th><th>Required by</th><th>Expected completion</th><th>Variance</th><th>Status</th><th class="r">Value</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="tfoot">Expected completion is Philtronics' current planned build finish date, scheduled across working days. Lines awaiting schedule are not yet planned.</div>
</div>
<footer><span>Commercial in confidence &middot; prepared by Philtronics Ltd for ${cust} account management</span><span>Generated by <b>Work Time</b> &middot; pt-worktime.srscloud.co.uk</span></footer>
</body></html>`;
}

async function handleOrderBookFile(file) {
  const customer = (prompt('Customer name for this order book:', _obState.customer || 'KLA') || '').trim();
  if (!customer) return;
  let text;
  try { text = await file.text(); } catch (_) { toast('Could not read the file.', 'error'); return; }
  let parsed;
  try { parsed = parseOrderBookText(text); }
  catch (err) { toast('Could not parse the file: ' + err.message, 'error'); return; }
  if (!parsed.rows.length) { toast('No buildable rows found in the file.', 'error'); return; }
  // Preview so a mis-read (wrong date format, missing values) is caught before it
  // replaces the live order book.
  const sampleDate = (parsed.rows.find(r => r.requiredBy) || {}).requiredBy
                  || (parsed.rows.find(r => r.dueDate) || {}).dueDate || 'none found';
  const totalValue = parsed.rows.reduce((s, r) => s + (r.lineValue || 0), 0);
  const preview = 'Import ' + parsed.rows.length + ' order lines for ' + customer + '?\n\n'
    + 'Dates read as ' + parsed.dateFormat + ' (first date: ' + sampleDate + ').\n'
    + 'Total value: £' + totalValue.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '\n\n'
    + 'Check the date and total look right. This replaces the current ' + customer + ' order book.';
  if (!confirm(preview)) return;
  try {
    const res = await POST('/order-book', { customer, rows: parsed.rows });
    toast(`Imported ${res.imported} lines for ${customer}.`, 'success');
    const cust = document.getElementById('obCustomer');
    if (cust) cust._filled = false;
    _obState.customer = customer;
    await loadOrderBook();
    if (cust) cust.value = customer;
    renderOrderBook();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Order-book parsing (pure; unit-tested) ─────────────────────────────────────
function okbPad2(n) { return String(n).padStart(2, '0'); }
function okbParseDate(s, dayFirst) {
  s = (s || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;                       // already ISO
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!m) return null;
  const a = +m[1], b = +m[2], yy = +m[3];
  const mm = dayFirst ? b : a;                                        // format detected per-file
  const dd = dayFirst ? a : b;
  if (yy === 9999 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null; // 9999 = SAP "no date"
  return yy + '-' + okbPad2(mm) + '-' + okbPad2(dd);
}
// Decide whether the file's dates are day-first (UK) or month-first (US) from the
// data itself: a value > 12 in the first position can only be a day (UK); > 12 in
// the second can only be a day (US). Majority wins; ambiguous defaults to UK
// (day-first) -- this is a UK deployment and the SAP export is DD/MM/YYYY. A tie
// (including the all-low-days case where nothing disambiguates) must NOT fall back
// to US, or every date gets its day and month swapped. Genuine US files still win
// only when they show strictly more month-first evidence.
function okbDetectDayFirst(dateStrings) {
  let dayFirst = 0, monthFirst = 0;
  for (const s of dateStrings) {
    const m = (s || '').trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.]\d{4}$/);
    if (!m) continue;
    const a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) dayFirst++;
    else if (b > 12 && a <= 12) monthFirst++;
  }
  return dayFirst >= monthFirst;
}
function okbNum(s) {
  s = (s || '').replace(/[£$€,\s]/g, '').trim();                      // strip currency + thousands separators
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function okbSplitLine(line, delim) {
  if (delim === '\t') return line.split('\t');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function parseOrderBookText(text) {
  text = String(text).replace(/^﻿/, '');                        // strip Excel UTF-8 BOM
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim().length);
  if (!lines.length) return { rows: [], skippedBlank: 0, dateFormat: null };
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const header = okbSplitLine(lines[0], delim).map(h => h.trim().toLowerCase());
  const findCol = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const idx = {
    part:    findCol('part number'),          desc:  findCol('material description', 'description', 'part description', 'material text', 'item description'),
    req:     findCol('required by'),          due:   findCol('current due date'),
    created: findCol('po creation date'),
    qty:     findCol('bal due qty'),          value: findCol('line value', 'value'),
    po:      findCol('purchasing document'),  line:  findCol('item'),  rework: findCol('rework'),
  };
  if (idx.part < 0) throw new Error('no "Part Number" column found in the header');

  const fields = lines.slice(1).map(l => okbSplitLine(l, delim));

  // Detect the date format (UK day-first vs US month-first) from all date cells.
  const dateCells = [];
  for (const f of fields) for (const j of [idx.req, idx.due, idx.created]) {
    if (j >= 0 && j < f.length) dateCells.push(f[j]);
  }
  const dayFirst = okbDetectDayFirst(dateCells);

  const rows = []; let skippedBlank = 0;
  for (const f of fields) {
    const get = j => (j >= 0 && j < f.length ? f[j] : '');
    const itemNumber = get(idx.part).trim();
    if (!itemNumber) { skippedBlank++; continue; }                   // service/repair lines carry no part number
    rows.push({
      poNumber:    get(idx.po).trim(),
      poLine:      get(idx.line).trim(),
      itemNumber,
      description: get(idx.desc).trim(),
      requiredBy:  okbParseDate(get(idx.req), dayFirst),
      dueDate:     okbParseDate(get(idx.due), dayFirst),
      quantity:    parseInt(get(idx.qty), 10) || 0,
      lineValue:   okbNum(get(idx.value)),
      // Rework flag is the letter 'L'; a stray number in this column is not a
      // rework marker (matches server/lib/xlsx-demand.js).
      rework:      /[a-z]/i.test(get(idx.rework)),
    });
  }
  return { rows, skippedBlank, dateFormat: dayFirst ? 'DD/MM/YYYY' : 'MM/DD/YYYY' };
}

// ── PUSH / PULL PAGE ──────────────────────────────────────────────────────────
// KLA's two weekly sheets, diffed week-over-week: what demand pulled in (needed
// sooner), pushed out (later), was added or dropped, weighted by order-book value.
const _pp = { report: null, cur: 0, wired: false, customer: 'KLA' };
const PP_NS = 'http://www.w3.org/2000/svg';
const PP_PULL = '#d9772e', PP_PUSH = '#3f8fd6', PP_ADD = '#1fa06e', PP_AMBER = '#e0a92e';
const _PP_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function ppSvg(t, a) { const e = document.createElementNS(PP_NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; }
function ppMoney(n) { n = Math.round(n || 0); const a = Math.abs(n); if (a >= 1e6) return '£' + (n / 1e6).toFixed(2) + 'm'; if (a >= 1e3) return '£' + (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k'; return '£' + n.toLocaleString(); }
function ppMoneyFull(n) { return '£' + Math.round(n || 0).toLocaleString(); }
function ppFmtWeek(iso) { if (!iso) return ''; const p = iso.split('-'); return (+p[2]) + ' ' + _PP_MON[+p[1] - 1]; }
function ppMonShort(ym) { const p = ym.split('-'); return _PP_MON[+p[1] - 1] + ' ' + p[0].slice(2); }
function ppShiftDate(iso) { if (!iso) return '–'; const p = iso.split('-'); return p[2] + '/' + p[1]; }

function ppTipEl() { let t = document.getElementById('ppTipEl'); if (!t) { t = el('div', { id: 'ppTipEl', className: 'pp-tip' }); document.body.appendChild(t); } return t; }
function ppShowTip(html, x, y) { const t = ppTipEl(); t.innerHTML = html; t.style.opacity = 1; const r = t.getBoundingClientRect(); let nx = x + 14, ny = y + 14; if (nx + r.width > innerWidth - 8) nx = x - r.width - 14; if (ny + r.height > innerHeight - 8) ny = y - r.height - 14; t.style.left = nx + 'px'; t.style.top = ny + 'px'; }
function ppHideTip() { const t = document.getElementById('ppTipEl'); if (t) t.style.opacity = 0; }

function ppReadB64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('Could not read ' + file.name)); r.readAsDataURL(file); });
}

async function loadPushPullPage() {
  if (!_pp.wired) {
    _pp.wired = true;
    const toggle = document.getElementById('ppUploadToggle');
    const panel = document.getElementById('ppUploadPanel');
    if (toggle && panel) toggle.addEventListener('click', () => { panel.hidden = !panel.hidden; toggle.textContent = panel.hidden ? 'Upload this week' : 'Close'; });
    const up = document.getElementById('ppUploadBtn');
    if (up) up.addEventListener('click', ppUpload);
    const clr = document.getElementById('ppClearBtn');
    if (clr) clr.addEventListener('click', ppOpenClearModal);
    const cust = document.getElementById('ppCustomer');
    if (cust) cust.addEventListener('change', () => { _pp.customer = cust.value; ppLoadReport(cust.value); });
    const d = document.getElementById('ppDate'); if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);
  }
  await ppFillCustomers();
  await ppLoadReport(_pp.customer);
}

async function ppFillCustomers() {
  const sel = document.getElementById('ppCustomer'); if (!sel) return;
  let list = []; try { list = await GET('/push-pull/customers'); } catch (_) {}
  if (!list.length) list = [_pp.customer || 'KLA'];
  if (!list.includes(_pp.customer)) _pp.customer = list[0];
  sel.innerHTML = '';
  for (const c of list) sel.appendChild(el('option', { value: c, textContent: c }));
  sel.value = _pp.customer;
}

async function ppUpload() {
  const of = document.getElementById('ppOrderFile').files[0];
  const pf = document.getElementById('ppPriorityFile').files[0];
  const date = document.getElementById('ppDate').value;
  const customer = document.getElementById('ppCustomerName').value.trim() || 'KLA';
  const note = document.getElementById('ppUploadNote');
  if (!of || !pf) { note.textContent = 'Choose both spreadsheets.'; return; }
  if (!date) { note.textContent = 'Pick the week (Tuesday).'; return; }
  note.textContent = 'Uploading…';
  try {
    const [orderBookB64, priorityB64] = await Promise.all([ppReadB64(of), ppReadB64(pf)]);
    const res = await POST('/push-pull/snapshot', { customer, snapshotDate: date, orderBookB64, priorityB64 });
    toast('Uploaded ' + res.orderLines + ' order lines and ' + res.priorityLines + ' demand lines for ' + customer + '.', 'success');
    note.textContent = '';
    document.getElementById('ppOrderFile').value = '';
    document.getElementById('ppPriorityFile').value = '';
    _pp.customer = customer;
    await ppFillCustomers();
    await ppLoadReport(customer);
  } catch (err) { note.textContent = err.message; toast(err.message, 'error'); }
}

// Manager+ "start again": wipe every uploaded week for the selected customer.
// Confirmed by typing CLEAR, mirroring the Planner's clear modal.
function ppOpenClearModal() {
  const customer = _pp.customer || 'KLA';
  const input = el('input', { type: 'text', placeholder: 'Type CLEAR to confirm', autocapitalize: 'characters' });
  const btn = el('button', { className: 'btn btn-sm dev-danger', textContent: 'Clear all weeks' });
  btn.disabled = true;   // set via property: el() would apply a boolean attr even for false
  input.addEventListener('input', () => { btn.disabled = input.value.trim().toUpperCase() !== 'CLEAR'; });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await POST('/push-pull/clear', { customer });
      toast('Cleared ' + res.cleared + ' uploaded week' + (res.cleared !== 1 ? 's' : '') + ' for ' + res.customer + '.', 'success');
      closeModal();
      await ppFillCustomers();
      await ppLoadReport(_pp.customer);
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  });
  const body = el('div', {},
    el('div', { className: 'clear-warn', textContent: '⚠ This permanently deletes every uploaded Push/Pull week and cannot be undone.' }),
    el('div', { className: 'clear-section' },
      el('div', { className: 'clear-title', textContent: 'Clear Push/Pull (' + customer + ')' }),
      el('div', { className: 'clear-desc', textContent: 'Removes every uploaded week for ' + customer + ' and its reporting. The live Planner order book is untouched.' }),
      el('div', { style: 'display:flex;gap:8px;margin-top:8px;' }, input, btn),
    ),
  );
  openModal('Clear Push/Pull', body, [ el('button', { className: 'btn btn-ghost', textContent: 'Close', onclick: () => closeModal() }) ]);
}

async function ppLoadReport(customer) {
  const body = document.getElementById('ppBody'); if (!body) return;
  body.innerHTML = ''; body.appendChild(el('div', { className: 'empty-state', style: 'padding:24px', textContent: 'Loading…' }));
  try {
    const rep = await GET('/push-pull/report?customer=' + encodeURIComponent(customer));
    _pp.report = rep; _pp.cur = Math.max(0, (rep.transitions || []).length - 1);
    ppRender();
  } catch (err) { body.innerHTML = ''; body.appendChild(el('div', { className: 'error-msg', style: 'padding:16px', textContent: err.message })); }
}

function ppRender() {
  const body = document.getElementById('ppBody'); if (!body) return;
  const rep = _pp.report; body.innerHTML = '';
  if (!rep || !rep.perWeek.length) {
    body.appendChild(el('div', { className: 'pp-empty' },
      el('div', { className: 'pp-empty-title', textContent: 'No weeks uploaded yet' }),
      el('div', { textContent: 'Use "Upload this week" to add KLA’s order book and priority-requirements spreadsheets. Upload two or more weeks to see the push/pull.' })));
    return;
  }
  body.appendChild(ppStepper(rep));
  if (!rep.transitions.length) {
    body.appendChild(el('div', { className: 'pp-note-panel', textContent: 'One week uploaded. Add a second week to compare and reveal the push/pull.' }));
    body.appendChild(ppProfileSection(rep));
    return;
  }
  body.appendChild(ppControls(rep));
  body.appendChild(ppKpis());
  body.appendChild(ppProfileSection(rep));
  body.appendChild(ppScatterSection());
  body.appendChild(ppMoversSection());
  body.appendChild(ppTakeaway(rep));
}

function ppStepper(rep) {
  const wrap = el('div', { className: 'pp-stepper' });
  rep.perWeek.forEach((w, i) => {
    const prev = i > 0 ? rep.perWeek[i - 1] : null;
    const card = el('div', { className: 'pp-snap' + (i === rep.perWeek.length - 1 ? ' now' : '') },
      el('div', { className: 'pp-snap-dow', textContent: 'Snapshot' }),
      el('div', { className: 'pp-snap-date', textContent: ppFmtWeek(w.week) + ' ' + w.week.slice(0, 4) }),
      el('div', { className: 'pp-snap-oblab', textContent: 'Order book' }),
      el('div', { className: 'pp-snap-ob', textContent: ppMoneyFull(w.orderBookValue) }),
      el('div', { className: 'pp-snap-meta', textContent: w.demandSlots + ' demand lines · ' + w.obLines + ' PO lines' }));
    if (prev) {
      const diff = w.orderBookValue - prev.orderBookValue;
      card.appendChild(el('div', { className: 'pp-snap-delta ' + (diff >= 0 ? 'up' : 'down'), textContent: (diff >= 0 ? '+' : '−') + ppMoney(Math.abs(diff)) + ' order book' }));
    }
    wrap.appendChild(card);
  });
  return wrap;
}

function ppControls(rep) {
  const head = el('div', { className: 'pp-sec-head' },
    el('div', {},
      el('h3', { className: 'pp-sec-title', textContent: 'What moved in one week' }),
      el('p', { className: 'pp-sec-sub', textContent: 'Pulled in = KLA now needs it sooner (expedite pressure); pushed out = later (built stock waits, cash tied up). Values are the demand £ whose timing shifted.' })));
  const seg = el('div', { className: 'pp-seg' });
  rep.transitions.forEach((t, i) => {
    const b = el('button', { textContent: ppFmtWeek(t.from) + ' → ' + ppFmtWeek(t.to), onclick: () => { _pp.cur = i; ppRender(); } });
    b.setAttribute('aria-pressed', i === _pp.cur);
    seg.appendChild(b);
  });
  head.appendChild(seg);
  return head;
}

function ppKpis() {
  const t = _pp.report.transitions[_pp.cur], s = t.sums, net = s.pushOut - s.pullIn;
  const grid = el('div', { className: 'pp-kpis' });
  const cards = [
    { c: 'pull', dot: PP_PULL, lab: 'Pulled in (sooner)', big: ppMoney(s.pullIn), meta: s.pullInN + ' parts now needed earlier' },
    { c: 'push', dot: PP_PUSH, lab: 'Pushed out (later)', big: ppMoney(s.pushOut), meta: s.pushOutN + ' parts slipped later' },
    { c: 'net', dot: PP_AMBER, lab: 'Net timing swing', big: (net >= 0 ? 'out ' : 'in ') + ppMoney(Math.abs(net)), meta: 'push minus pull · direction of the week' },
    { c: 'new', dot: PP_ADD, lab: 'Brand-new demand', big: ppMoney(s.added), meta: s.addedN + ' new parts · ' + s.droppedN + ' dropped' },
  ];
  for (const k of cards) {
    grid.appendChild(el('div', { className: 'pp-kpi pp-k-' + k.c },
      el('div', { className: 'pp-kpi-lab' }, el('span', { className: 'pp-dot', style: 'background:' + k.dot }), document.createTextNode(k.lab)),
      el('div', { className: 'pp-kpi-big', textContent: k.big }),
      el('div', { className: 'pp-kpi-meta', textContent: k.meta })));
  }
  return grid;
}

function ppProfileSection(rep) {
  const sec = el('div', { className: 'pp-section' });
  sec.appendChild(el('div', { className: 'pp-sec-head' }, el('div', {},
    el('h3', { className: 'pp-sec-title', textContent: 'The order book breathing' }),
    el('p', { className: 'pp-sec-sub', textContent: 'Demand value by the month KLA needs it, drawn for each uploaded week. Watch the near months empty and later months swell as demand marches outward.' }))));
  const card = el('div', { className: 'pp-card' });
  const months = rep.months;
  if (!months.length) { card.appendChild(el('div', { className: 'empty-state', textContent: 'No dated demand yet.' })); sec.appendChild(card); return sec; }
  const W = 1000, H = 330, mL = 62, mR = 16, mT = 14, mB = 40;
  const svg = ppSvg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'pp-chart' });
  const maxV = Math.max(1, ...rep.profile.flatMap(p => p.values));
  const x = i => mL + (months.length <= 1 ? 0 : i * (W - mL - mR) / (months.length - 1));
  const y = v => H - mB - (v / maxV) * (H - mT - mB);
  for (let i = 0; i <= 4; i++) { const v = maxV * i / 4, yy = y(v); svg.appendChild(ppSvg('line', { x1: mL, y1: yy, x2: W - mR, y2: yy, class: 'pp-grid' })); const tl = ppSvg('text', { x: mL - 8, y: yy + 4, 'text-anchor': 'end', class: 'pp-axis' }); tl.textContent = ppMoney(v); svg.appendChild(tl); }
  months.forEach((m, i) => { const tx = ppSvg('text', { x: x(i), y: H - mB + 18, 'text-anchor': 'middle', class: 'pp-axis' }); tx.textContent = ppMonShort(m); svg.appendChild(tx); });
  const n = rep.profile.length;
  rep.profile.forEach((p, idx) => {
    const latest = idx === n - 1;
    const shade = latest ? PP_AMBER : ('rgba(154,161,184,' + (0.35 + 0.4 * (idx / Math.max(1, n - 1))) + ')');
    let d = ''; p.values.forEach((v, i) => { d += (i ? 'L' : 'M') + x(i) + ' ' + y(v) + ' '; });
    if (latest) { svg.appendChild(ppSvg('path', { d: d + 'L' + x(months.length - 1) + ' ' + (H - mB) + ' L' + x(0) + ' ' + (H - mB) + ' Z', fill: PP_AMBER, 'fill-opacity': .08 })); }
    svg.appendChild(ppSvg('path', { d, fill: 'none', stroke: shade, 'stroke-width': latest ? 2.6 : 1.6, 'stroke-linejoin': 'round' }));
    if (latest) p.values.forEach((v, i) => {
      const c = ppSvg('circle', { cx: x(i), cy: y(v), r: 3.4, fill: PP_AMBER, stroke: '#161a25', 'stroke-width': 1.5 }); c.style.cursor = 'pointer';
      c.addEventListener('mousemove', e => ppShowTip('<b>' + esc(ppMonShort(months[i])) + '</b>' + rep.profile.map(pp => '<div class="pp-tip-row"><span>' + esc(ppFmtWeek(pp.week)) + '</span><span>' + ppMoneyFull(pp.values[i]) + '</span></div>').join(''), e.clientX, e.clientY));
      c.addEventListener('mouseleave', ppHideTip); svg.appendChild(c);
    });
  });
  card.appendChild(svg);
  const leg = el('div', { className: 'pp-legend' });
  rep.profile.forEach((p, i) => leg.appendChild(el('span', { className: 'pp-lg' }, el('span', { className: 'pp-lg-line', style: 'background:' + (i === n - 1 ? PP_AMBER : 'rgba(154,161,184,' + (0.35 + 0.4 * (i / Math.max(1, n - 1))) + ')') }), document.createTextNode(ppFmtWeek(p.week)))));
  card.appendChild(leg);
  sec.appendChild(card);
  return sec;
}

function ppScatterSection() {
  const t = _pp.report.transitions[_pp.cur];
  const pts = t.movers.filter(m => m.cat === 'pullIn' || m.cat === 'pushOut');
  const sec = el('div', { className: 'pp-section' });
  sec.appendChild(el('div', { className: 'pp-sec-head' }, el('div', {},
    el('h3', { className: 'pp-sec-title', textContent: 'Every move, one dot a part' }),
    el('p', { className: 'pp-sec-sub', textContent: 'Left = pulled in (sooner), right = pushed out (later). Height = demand £ affected. Bubble size = quantity. Hover for detail.' }))));
  const card = el('div', { className: 'pp-card' });
  if (!pts.length) { card.appendChild(el('div', { className: 'empty-state', textContent: 'No timing shifts this week.' })); sec.appendChild(card); return sec; }
  const W = 1000, H = 360, mL = 64, mR = 20, mT = 16, mB = 44;
  const svg = ppSvg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'pp-chart' });
  const maxShift = Math.max(30, ...pts.map(p => Math.abs(p.shift)));
  const maxVal = Math.max(1, ...pts.map(p => p.val));
  const maxQty = Math.max(1, ...pts.map(p => p.qty));
  const x = s => mL + (s + maxShift) / (2 * maxShift) * (W - mL - mR);
  const yv = v => H - mB - (Math.sqrt(v) / Math.sqrt(maxVal)) * (H - mT - mB);
  const rq = q => 5 + (Math.sqrt(Math.max(q, 1)) / Math.sqrt(maxQty)) * 15;
  [0, .25, .5, 1].forEach(f => { const v = maxVal * f, yy = yv(v); svg.appendChild(ppSvg('line', { x1: mL, y1: yy, x2: W - mR, y2: yy, class: 'pp-grid' })); const tl = ppSvg('text', { x: mL - 8, y: yy + 4, 'text-anchor': 'end', class: 'pp-axis' }); tl.textContent = ppMoney(v); svg.appendChild(tl); });
  svg.appendChild(ppSvg('line', { x1: x(0), y1: mT, x2: x(0), y2: H - mB, class: 'pp-zero' }));
  [-maxShift, -maxShift / 2, 0, maxShift / 2, maxShift].forEach(s => { const tx = ppSvg('text', { x: x(s), y: H - mB + 18, 'text-anchor': 'middle', class: 'pp-axis' }); tx.textContent = (s > 0 ? '+' : '') + Math.round(s) + 'd'; svg.appendChild(tx); });
  const l1 = ppSvg('text', { x: mL + 2, y: H - mB + 36, 'text-anchor': 'start', class: 'pp-axis-lab', fill: PP_PULL }); l1.textContent = '◄ pulled in (sooner)'; svg.appendChild(l1);
  const l2 = ppSvg('text', { x: W - mR - 2, y: H - mB + 36, 'text-anchor': 'end', class: 'pp-axis-lab', fill: PP_PUSH }); l2.textContent = 'pushed out (later) ►'; svg.appendChild(l2);
  pts.slice().sort((a, b) => b.val - a.val).forEach(p => {
    const col = p.cat === 'pullIn' ? PP_PULL : PP_PUSH;
    const c = ppSvg('circle', { cx: x(p.shift), cy: yv(p.val), r: rq(p.qty), fill: col, 'fill-opacity': .42, stroke: col, 'stroke-width': 1.5 }); c.style.cursor = 'pointer';
    c.addEventListener('mousemove', e => ppShowTip('<b class="pp-tip-part">' + esc(p.part) + '</b><div class="pp-tip-desc">' + esc(p.desc || '') + '</div>' +
      '<div class="pp-tip-row"><span>Shift</span><span>' + (p.shift > 0 ? '+' : '') + p.shift + 'd ' + (p.cat === 'pullIn' ? 'earlier' : 'later') + '</span></div>' +
      '<div class="pp-tip-row"><span>Required</span><span>' + ppShiftDate(p.from) + ' → ' + ppShiftDate(p.to) + '</span></div>' +
      '<div class="pp-tip-row"><span>Qty</span><span>' + Math.round(p.qty) + '</span></div>' +
      '<div class="pp-tip-row"><span>Value</span><span>' + ppMoneyFull(p.val) + '</span></div>', e.clientX, e.clientY));
    c.addEventListener('mouseleave', ppHideTip); svg.appendChild(c);
  });
  card.appendChild(svg);
  card.appendChild(el('div', { className: 'pp-legend' },
    el('span', { className: 'pp-lg' }, el('span', { className: 'pp-lg-sw', style: 'background:' + PP_PULL }), document.createTextNode('Pulled in')),
    el('span', { className: 'pp-lg' }, el('span', { className: 'pp-lg-sw', style: 'background:' + PP_PUSH }), document.createTextNode('Pushed out')),
    el('span', { className: 'pp-lg pp-lg-muted', textContent: 'bubble = qty' })));
  sec.appendChild(card);
  return sec;
}

function ppMoversSection() {
  const t = _pp.report.transitions[_pp.cur];
  const rows = t.movers.filter(m => m.cat === 'pullIn' || m.cat === 'pushOut').slice(0, 12);
  const sec = el('div', { className: 'pp-section' });
  sec.appendChild(el('div', { className: 'pp-sec-head' }, el('div', {},
    el('h3', { className: 'pp-sec-title', textContent: 'Biggest movers' }),
    el('p', { className: 'pp-sec-sub', textContent: 'The dozen largest timing swings by value – the parts driving this week’s push/pull, and the ones worth a call to KLA.' }))));
  const wrap = el('div', { className: 'pp-tbl-wrap' });
  const tbl = el('table', { className: 'dash-table pp-tbl' });
  tbl.appendChild(el('thead', {}, el('tr', {},
    el('th', { textContent: 'Part' }), el('th', { textContent: 'Description' }), el('th', { textContent: 'Move' }),
    el('th', { textContent: 'Required date' }), el('th', { className: 'num', textContent: 'Qty' }), el('th', { className: 'num', textContent: 'Value' }))));
  const tb = el('tbody', {});
  for (const m of rows) {
    const pull = m.cat === 'pullIn';
    tb.appendChild(el('tr', {},
      el('td', { className: 'pp-part', textContent: m.part }),
      el('td', { className: 'pp-desc', title: m.desc || '', textContent: m.desc || '' }),
      el('td', {}, el('span', { className: 'pp-chip ' + (pull ? 'pull' : 'push'), textContent: (pull ? '▼ ' : '▲ +') + m.shift + 'd' })),
      el('td', { className: 'pp-dates', textContent: ppShiftDate(m.from) + ' → ' + ppShiftDate(m.to) }),
      el('td', { className: 'num', textContent: String(Math.round(m.qty)) }),
      el('td', { className: 'num', textContent: ppMoneyFull(m.val) })));
  }
  tbl.appendChild(tb); wrap.appendChild(tbl); sec.appendChild(wrap);
  return sec;
}

function ppTakeaway(rep) {
  const t = rep.transitions[_pp.cur], s = t.sums;
  const toWeek = rep.perWeek.find(w => w.week === t.to);
  const ob = toWeek ? toWeek.orderBookValue : 0;
  const churn = s.pullIn + s.pushOut + s.added + s.dropped;
  const nervous = ob ? (churn / ob * 100) : 0;
  const net = s.pushOut - s.pullIn;
  const sec = el('div', { className: 'pp-section' });
  sec.appendChild(el('h3', { className: 'pp-sec-title', textContent: 'What it means for Philtronics' }));
  const box = el('div', { className: 'pp-takeaway' });
  box.appendChild(el('p', {}, document.createTextNode('In the week to '), el('b', { textContent: ppFmtWeek(t.to) }), document.createTextNode(', KLA re-timed '), el('b', { textContent: ppMoneyFull(churn) }), document.createTextNode(' of demand against an order book of '), el('b', { textContent: ppMoneyFull(ob) }), document.createTextNode(' – a schedule nervousness of '), el('b', { textContent: Math.round(nervous) + '%' }), document.createTextNode('. That is the share of the book that moved, was added or dropped in a week.')));
  box.appendChild(el('p', {},
    el('span', { className: 'pp-hl-pull', textContent: ppMoneyFull(s.pullIn) }), document.createTextNode(' pulled forward (' + s.pullInN + ' parts needed sooner: expedite and material-chase pressure), while '),
    el('span', { className: 'pp-hl-push', textContent: ppMoneyFull(s.pushOut) }), document.createTextNode(' pushed back (' + s.pushOutN + ' parts: stock that now waits, tying up cash and floor space). Net drift '), el('b', { textContent: (net >= 0 ? 'outward ' + ppMoneyFull(net) : 'inward ' + ppMoneyFull(-net)) }), document.createTextNode('.')));
  sec.appendChild(box);
  return sec;
}

// ── CHARTS PAGE ───────────────────────────────────────────────────────────────

function loadChartsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const ago30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (!document.getElementById('chartFrom').value) {
    document.getElementById('chartFrom').value = ago30;
    document.getElementById('chartTo').value   = today;
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

function drawBarChart(containerId, { labels, datasets, title, yLabel, lineData }) {
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
    const rect = svgEl('rect', { x: lx, y: H - 18, width: 12, height: 12, fill: ds.color, rx: 2 });
    svg.appendChild(rect);
    const t = svgEl('text', { x: lx + 16, y: H - 8, fill: CHART_COLORS.text, 'font-size': '11', 'font-family': 'sans-serif' });
    t.textContent = ds.label;
    svg.appendChild(t);
    lx += ds.label.length * 7 + 30;
  });

  // Optional line overlay drawn inline
  if (lineData && lineData.data && lineData.data.some(v => v > 0)) {
    const ld = lineData;
    const lMax = Math.max(...ld.data, 1);
    const points = ld.data.map((val, gi) => {
      const x = PAD.left + gi * groupW + groupW / 2;
      const y = PAD.top + chartH - (val / lMax) * chartH;
      return `${x},${y}`;
    });
    if (points.length > 1) {
      svg.appendChild(svgEl('polyline', { points: points.join(' '),
        fill: 'none', stroke: ld.color, 'stroke-width': '2',
        'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: '0.9' }));
    }
    ld.data.forEach((val, gi) => {
      const x = PAD.left + gi * groupW + groupW / 2;
      const y = PAD.top + chartH - (val / lMax) * chartH;
      const c = svgEl('circle', { cx: x, cy: y, r: 4, fill: ld.color });
      const tt = svgEl('title'); tt.textContent = `${ld.label}: ${Math.round(val)}`;
      c.appendChild(tt); svg.appendChild(c);
    });
    // Add to legend
    svg.appendChild(svgEl('circle', { cx: lx + 6, cy: H - 12, r: 6, fill: ld.color }));
    const lt = svgEl('text', { x: lx + 16, y: H - 8, fill: CHART_COLORS.text, 'font-size': '11', 'font-family': 'sans-serif' });
    lt.textContent = ld.label; svg.appendChild(lt);
  }
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
  const el2 = document.getElementById('chartDailyTrendSVG');
  if (!el2) return;
  if (!rows || !rows.length) {
    el2.innerHTML = '<div style="padding:40px 0;text-align:center;color:var(--text2);font-size:14px">No completed jobs found for this date range.</div>';
    return;
  }
  const labels  = rows.map(r => new Date(r.day).toLocaleDateString('en-GB', { day:'2-digit', month:'short' }));
  const jobs    = rows.map(r => r.jobs_completed || 0);
  const overdue = rows.map(r => r.overdue_count  || 0);
  const avgSecs = rows.map(r => r.avg_seconds     || 0);
  drawBarChart('chartDailyTrendSVG', {
    labels,
    datasets: [
      { label: 'Jobs Completed', data: jobs,    color: CHART_COLORS.blue },
      { label: 'Over Target',    data: overdue, color: CHART_COLORS.red  },
    ],
    yLabel: 'Jobs',
    lineData: { data: avgSecs, color: CHART_COLORS.amber, label: 'Avg Secs' },
  });
}

function renderChartItemOnTime(rows) {
  const el2 = document.getElementById('chartItemOnTimeSVG');
  if (!el2) return;
  const withTarget = (rows || []).filter(r => r.target_seconds).slice(0, 12);
  if (!withTarget.length) {
    el2.innerHTML = '<div style="padding:40px 0;text-align:center;color:var(--text2);font-size:14px">No items with target times set.</div>';
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
  const el2 = document.getElementById('chartOperatorSVG');
  if (!el2) return;
  if (!rows || !rows.length) {
    el2.innerHTML = '<div style="padding:40px 0;text-align:center;color:var(--text2);font-size:14px">No operator data for this date range.</div>';
    return;
  }
  const labels  = rows.map(r => r.operator_name.split(' ')[0]);
  const jobs    = rows.map(r => r.jobs_completed || 0);
  const overdue = rows.map(r => r.overdue_count  || 0);
  const avgSecs = rows.map(r => r.avg_seconds     || 0);
  drawBarChart('chartOperatorSVG', {
    labels,
    datasets: [
      { label: 'Jobs Completed', data: jobs,    color: CHART_COLORS.blue },
      { label: 'Over Target',    data: overdue, color: CHART_COLORS.red  },
    ],
    yLabel: 'Jobs',
    lineData: { data: avgSecs, color: CHART_COLORS.amber, label: 'Avg Secs' },
  });
}


function renderReportStatCards(stats) {
  const container = document.getElementById('reportStatCards');
  if (!container) return;
  if (!stats) { container.innerHTML = '<div class="empty-state">No data available.</div>'; return; }
  const items     = stats.byItem || [];
  const totalJobs = items.reduce((s, r) => s + r.count, 0);
  const overCount = items.filter(r => r.target_seconds && Math.round(r.avg_seconds) > r.target_seconds).length;
  const onTimePct = items.length ? Math.round((items.length - overCount) / items.length * 100) : 100;
  const cards = [
    { label: 'Jobs Completed',    value: totalJobs        },
    { label: 'Item Types',        value: items.length     },
    { label: 'On-Time Rate',      value: onTimePct + '%'  },
    { label: 'Items Over Target', value: overCount        },
  ];
  container.innerHTML = '';
  cards.forEach(({ label, value }) => {
    const card = el('div', { className: 'stat-card' });
    card.appendChild(el('div', { className: 'stat-label', textContent: label }));
    card.appendChild(el('div', { className: 'stat-value', textContent: value }));
    container.appendChild(card);
  });
}

function renderProductivityTable(rows, targetPct = 80, hasDaily = false) {
  const container = document.getElementById('reportProductivityTable');
  if (!container) return;
  if (!rows || !rows.length) {
    container.innerHTML = '<div class="empty-state">No operator data for this date range.</div>';
    return;
  }
  container.innerHTML = '';

  const targetBar = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:12px;font-size:13px;color:var(--text2)' });
  targetBar.appendChild(el('span', { textContent: `Target: ${targetPct}% productive` }));
  if (hasRole('administrator')) {
    const editBtn = el('button', { className: 'btn btn-ghost btn-sm', textContent: '\u270f Edit Target' });
    editBtn.addEventListener('click', () => openEditTargetModal(targetPct));
    targetBar.appendChild(editBtn);
  }
  container.appendChild(targetBar);

  const table = el('table', { className: 'dash-table', style: 'margin-bottom:24px' });
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', { textContent: 'Operator' }),
    el('th', { textContent: 'Dept' }),
    el('th', { textContent: 'Active' }),
    el('th', { textContent: 'Available' }),
    el('th', { textContent: 'Productivity' }),
    el('th', { textContent: 'vs Target' }),
    el('th', { textContent: 'Timers' }),
  )));
  const tbody = el('tbody', {});
  rows.forEach(r => {
    const pct = r.productivityPct;
    const vs  = r.vsTarget !== undefined ? r.vsTarget : pct - targetPct;
    const barColor = pct >= targetPct ? 'var(--green)' : pct >= targetPct * 0.7 ? 'var(--amber)' : 'var(--red)';
    const tr = el('tr', {});
    tr.appendChild(el('td', { textContent: r.operatorName, style: 'font-weight:600' }));
    tr.appendChild(el('td', { textContent: r.department || '\u2014', style: 'color:var(--text2)' }));
    tr.appendChild(el('td', { textContent: r.activeHoursDisplay }));
    tr.appendChild(el('td', { textContent: r.availableHoursDisplay, style: 'color:var(--text2)' }));
    const pctCell = el('td', {});
    const barWrap = el('div', { style: 'display:flex;align-items:center;gap:8px' });
    const bar = el('div', { style: 'flex:1;background:var(--bg3);border-radius:4px;height:8px;min-width:80px;position:relative' });
    bar.appendChild(el('div', { style: `width:${pct}%;background:${barColor};height:8px;border-radius:4px` }));
    const marker = el('div', { style: `position:absolute;left:${Math.min(targetPct,99)}%;top:-3px;width:2px;height:14px;background:var(--text3);border-radius:1px`, title: `Target: ${targetPct}%` });
    bar.appendChild(marker);
    barWrap.appendChild(bar);
    barWrap.appendChild(el('span', { textContent: pct + '%', style: `font-weight:700;color:${barColor};min-width:36px` }));
    pctCell.appendChild(barWrap);
    tr.appendChild(pctCell);
    const vsColor = vs >= 0 ? 'var(--green)' : 'var(--red)';
    tr.appendChild(el('td', { textContent: (vs >= 0 ? '+' : '') + vs + '%', style: `color:${vsColor};font-weight:600` }));
    tr.appendChild(el('td', { textContent: r.timerCount, style: 'color:var(--text2)' }));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);

  if (hasDaily && rows[0]?.daily?.length) {
    const days = rows[0].daily.map(d => d.date);
    const bdWrap = el('div', { style: 'overflow-x:auto' });
    bdWrap.appendChild(el('div', { style: 'font-size:11px;font-weight:700;letter-spacing:.1em;color:var(--text2);margin-bottom:8px;text-transform:uppercase', textContent: 'Daily Breakdown' }));
    const dt = el('table', { className: 'dash-table', style: 'min-width:500px' });
    const htr = el('tr', {}, el('th', { textContent: 'Date' }));
    rows.forEach(r => htr.appendChild(el('th', { textContent: r.operatorName.split(' ')[0], style: 'text-align:center' })));
    dt.appendChild(el('thead', {}, htr));
    const dtb = el('tbody', {});
    days.forEach(date => {
      const dtr = el('tr', {});
      dtr.appendChild(el('td', { textContent: new Date(date).toLocaleDateString('en-GB', { weekday:'short', day:'2-digit', month:'short' }), style: 'white-space:nowrap;font-weight:600' }));
      rows.forEach(r => {
        const dd = (r.daily || []).find(d => d.date === date);
        if (!dd || dd.availableMins === 0) { dtr.appendChild(el('td', { textContent: '\u2014', style: 'text-align:center;color:var(--text2)' })); return; }
        const c = dd.productivityPct >= targetPct ? 'var(--green)' : dd.productivityPct >= targetPct * 0.7 ? 'var(--amber)' : 'var(--red)';
        dtr.appendChild(el('td', { textContent: dd.productivityPct + '%', style: `text-align:center;font-weight:700;color:${c}` }));
      });
      dtb.appendChild(dtr);
    });
    const avgTr = el('tr', { style: 'border-top:2px solid var(--border)' });
    avgTr.appendChild(el('td', { textContent: 'Average', style: 'font-weight:700' }));
    rows.forEach(r => {
      const c = r.productivityPct >= targetPct ? 'var(--green)' : r.productivityPct >= targetPct * 0.7 ? 'var(--amber)' : 'var(--red)';
      avgTr.appendChild(el('td', { textContent: r.productivityPct + '%', style: `text-align:center;font-weight:700;color:${c}` }));
    });
    dtb.appendChild(avgTr);
    dt.appendChild(dtb);
    bdWrap.appendChild(dt);
    container.appendChild(bdWrap);
  }
}

function openEditTargetModal(currentTarget) {
  const body = el('div', {});
  body.appendChild(el('p', { textContent: 'Set the productivity target for all operators. Affects colour coding and vs Target column across all reports and dashboards.', style: 'margin-bottom:16px;font-size:14px;color:var(--text2)' }));
  const input = el('input', { id: 'targetPctInput', type: 'number', min: '1', max: '100', value: String(currentTarget), style: 'width:100%;padding:12px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:16px' });
  body.appendChild(el('div', { className: 'form-group' }, el('label', { for: 'targetPctInput', textContent: 'Productivity Target (%)' }), input));
  const errDiv = el('div', { className: 'error-msg' }); body.appendChild(errDiv);
  const btnSave   = el('button', { className: 'btn btn-primary', textContent: 'Save Target' });
  const btnCancel = el('button', { className: 'btn btn-ghost',   textContent: 'Cancel' });
  btnCancel.addEventListener('click', closeModal);
  btnSave.addEventListener('click', async () => {
    const val = parseInt(document.getElementById('targetPctInput').value, 10);
    if (isNaN(val) || val < 1 || val > 100) { errDiv.textContent = 'Please enter a number between 1 and 100.'; return; }
    btnSave.disabled = true;
    try {
      await api('PUT', '/config/productivity_target_pct', { value: val });
      toast(`Productivity target updated to ${val}%`, 'success');
      closeModal();
      if (state.currentPage === 'reports') runProductivitySection();
    } catch (err) { errDiv.textContent = err.message; btnSave.disabled = false; }
  });
  openModal('Edit Productivity Target', body, [btnCancel, btnSave]);
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
function renderAssemblySummary(assemblies) {
  const container = document.getElementById('reportAssemblyGrid');
  if (!container) return;
  container.innerHTML = '';

  if (!assemblies || !assemblies.length) {
    container.appendChild(el('div', { className: 'empty-state', textContent: 'No assemblies with W/O numbers found for this date range.' }));
    return;
  }

  // CSV export button
  const csvBtn = el('button', { className: 'btn btn-ghost btn-sm', textContent: '\u2193 Export CSV',
    style: 'margin-bottom:12px' });
  csvBtn.addEventListener('click', () => {
    const from = document.getElementById('buildFrom')?.value;
    const to   = document.getElementById('buildTo')?.value;
    const ps   = new URLSearchParams();
    if (from) ps.set('from', new Date(from).toISOString());
    if (to)   { const d = new Date(to); d.setHours(23,59,59,999); ps.set('to', d.toISOString()); }
    window.location.href = `/api/export/assembly-summary/csv?${ps}`;
  });
  container.appendChild(csvBtn);

  // Filter bar
  const filterBar = el('div', { style: 'display:flex;gap:8px;margin-bottom:14px;align-items:center;flex-wrap:wrap' });
  const searchInput = el('input', { type: 'text', placeholder: 'Filter by item, W/O or route card\u2026',
    style: 'flex:1;min-width:200px;padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px' });
  const multiToggle = el('button', { className: 'btn btn-ghost btn-sm',
    textContent: 'Multi-operator only',
    style: 'white-space:nowrap' });
  let showMultiOnly = false;
  multiToggle.addEventListener('click', () => {
    showMultiOnly = !showMultiOnly;
    multiToggle.style.color = showMultiOnly ? 'var(--accent)' : '';
    multiToggle.style.borderColor = showMultiOnly ? 'var(--accent)' : '';
    renderCards();
  });
  filterBar.appendChild(searchInput);
  filterBar.appendChild(multiToggle);
  container.appendChild(filterBar);

  const cardsWrap = el('div', {});
  container.appendChild(cardsWrap);

  function renderCards() {
    cardsWrap.innerHTML = '';
    const q = searchInput.value.toLowerCase();
    const filtered = assemblies.filter(a => {
      if (showMultiOnly && !a.multiOperator) return false;
      if (q) {
        const hay = [a.itemNumber, a.woNumber, a.routeCardNumber || ''].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      cardsWrap.appendChild(el('div', { className: 'empty-state', textContent: 'No assemblies match the current filter.' }));
      return;
    }

    filtered.forEach(a => {
      const card = el('div', { style: 'background:var(--bg2);border-radius:12px;padding:16px;margin-bottom:12px;border:1px solid var(--border)' });

      // Card header
      const hdr = el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px' });
      const left = el('div', {});
      left.appendChild(el('div', { textContent: a.itemNumber,
        style: 'font-size:18px;font-weight:700;color:var(--accent)' }));
      const meta = el('div', { style: 'display:flex;gap:8px;margin-top:4px;flex-wrap:wrap' });
      meta.appendChild(el('span', { textContent: 'W/O: ' + a.woNumber,
        style: 'font-size:13px;color:var(--text2);background:var(--bg3);padding:2px 8px;border-radius:4px' }));
      if (a.routeCardNumber) {
        meta.appendChild(el('span', { textContent: 'RC: ' + a.routeCardNumber,
          style: 'font-size:13px;color:var(--text2);background:var(--bg3);padding:2px 8px;border-radius:4px' }));
      }
      if (a.department) {
        meta.appendChild(el('span', { textContent: a.department,
          style: 'font-size:13px;color:var(--text2);background:var(--bg3);padding:2px 8px;border-radius:4px' }));
      }
      if (a.multiOperator) {
        meta.appendChild(el('span', { textContent: '\uD83D\uDC65 Multi-operator',
          style: 'font-size:12px;font-weight:700;color:var(--purple,#a855f7);background:rgba(168,85,247,.12);padding:2px 8px;border-radius:4px' }));
      }
      left.appendChild(meta);
      hdr.appendChild(left);
      card.appendChild(hdr);

      // Time summary row
      const times = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:14px' });
      const timeItems = [
        { label: 'Combined Time', value: a.combinedDisplay || '\u2014', color: 'var(--text)', tip: 'Total operator-hours across all contributors' },
        { label: 'Elapsed Time',  value: a.elapsedDisplay  || '\u2014', color: 'var(--green)', tip: 'Wall-clock time from first start to last stop' },
        { label: 'Overlap',       value: a.overlapSeconds > 0 ? a.overlapDisplay : 'None', color: a.overlapSeconds > 0 ? 'var(--amber)' : 'var(--text2)', tip: 'Time operators worked simultaneously' },
        { label: 'Contributors',  value: a.operatorCount + ' operator' + (a.operatorCount !== 1 ? 's' : ''), color: 'var(--text)' },
      ];
      timeItems.forEach(({ label, value, color, tip }) => {
        const box = el('div', { style: 'background:var(--bg3);border-radius:8px;padding:10px 12px' });
        box.appendChild(el('div', { textContent: label, style: 'font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px' }));
        const v = el('div', { textContent: value, style: `font-size:18px;font-weight:700;color:${color}` });
        if (tip) v.title = tip;
        box.appendChild(v);
        times.appendChild(box);
      });
      card.appendChild(times);

      // Operator breakdown table
      const tbl = el('table', { className: 'dash-table' });
      tbl.appendChild(el('thead', {}, el('tr', {},
        el('th', { textContent: 'Operator' }),
        el('th', { textContent: 'Workstation' }),
        el('th', { textContent: 'Time on Assembly' }),
        el('th', { textContent: 'Stints' }),
        el('th', { textContent: '% of Combined' }),
      )));
      const tbody = el('tbody', {});
      a.operators.forEach(op => {
        const pct = a.combinedSeconds > 0
          ? Math.round(op.totalSeconds / a.combinedSeconds * 100) : 0;
        const barColor = pct > 60 ? 'var(--blue)' : 'var(--accent)';
        const tr = el('tr', {});
        tr.appendChild(el('td', { textContent: op.operatorName, style: 'font-weight:600' }));
        tr.appendChild(el('td', { textContent: op.workstation || '\u2014', style: 'color:var(--text2)' }));
        tr.appendChild(el('td', { textContent: op.totalDisplay || '\u2014', style: 'font-weight:700;color:var(--text)' }));
        tr.appendChild(el('td', { textContent: op.stints.length, style: 'color:var(--text2)' }));
        const pctCell = el('td', {});
        const barWrap = el('div', { style: 'display:flex;align-items:center;gap:8px' });
        const bar = el('div', { style: 'flex:1;background:var(--bg3);border-radius:3px;height:6px' });
        bar.appendChild(el('div', { style: `width:${pct}%;background:${barColor};height:6px;border-radius:3px` }));
        barWrap.appendChild(bar);
        barWrap.appendChild(el('span', { textContent: pct + '%', style: 'min-width:36px;font-size:12px;color:var(--text2)' }));
        pctCell.appendChild(barWrap);
        tr.appendChild(pctCell);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      card.appendChild(tbl);
      cardsWrap.appendChild(card);
    });
  }

  searchInput.addEventListener('input', renderCards);
  renderCards();
}
function renderQualityReport(data) {
  const container = document.getElementById('reportQualityGrid');
  if (!container) return;
  container.innerHTML = '';

  const s = data?.summary || {};
  const reworkByItem     = data?.reworkByItem     || [];
  const reworkByOperator = data?.reworkByOperator || [];

  const rftRate  = s.rftRate  ?? 100;
  const rftColor = rftRate >= 95 ? 'var(--green)' : rftRate >= 80 ? 'var(--amber)' : 'var(--red)';

  // ── RFT summary cards ───────────────────────────────────────────────────
  const cards = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:20px' });
  [
    { label: 'Right First Time',      value: rftRate + '%',                      color: rftColor,        tip: 'Assemblies with no rework timers' },
    { label: 'Assemblies tracked',    value: s.totalAssemblies ?? 0,             color: 'var(--text)' },
    { label: 'Passed first time',     value: s.rftCount ?? 0,                    color: 'var(--green)' },
    { label: 'Required rework',       value: s.reworkAssemblies ?? 0,            color: s.reworkAssemblies ? 'var(--red)' : 'var(--text2)' },
    { label: 'Total work time',       value: s.totalWorkDisplay   || '0m',       color: 'var(--text)' },
    { label: 'Total rework time',     value: s.totalReworkDisplay || '0m',       color: s.totalReworkSecs ? 'var(--amber)' : 'var(--text2)' },
    { label: 'Rework as % of hours',  value: (s.reworkPct ?? 0) + '%',          color: s.reworkPct ? 'var(--amber)' : 'var(--text2)' },
  ].forEach(({ label, value, color, tip }) => {
    const card = el('div', { style: 'background:var(--bg2);border-radius:10px;padding:14px 16px;border:1px solid var(--border)' });
    card.appendChild(el('div', { textContent: label, style: 'font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px' }));
    const v = el('div', { textContent: value, style: `font-size:22px;font-weight:700;color:${color}` });
    if (tip) v.title = tip;
    card.appendChild(v);
    cards.appendChild(card);
  });
  container.appendChild(cards);

  if (!s.totalAssemblies) {
    container.appendChild(el('div', { className: 'empty-state', textContent: 'No assembly data with W/O numbers found for this period.' }));
    return;
  }

  // ── RFT gauge bar ────────────────────────────────────────────────────────
  const gaugeWrap = el('div', { style: 'background:var(--bg2);border-radius:10px;padding:16px;margin-bottom:16px;border:1px solid var(--border)' });
  gaugeWrap.appendChild(el('div', { textContent: 'Right First Time Rate', style: 'font-size:13px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px' }));
  const gaugeBar = el('div', { style: 'background:var(--bg3);border-radius:6px;height:24px;position:relative;overflow:hidden' });
  gaugeBar.appendChild(el('div', { style: `width:${rftRate}%;background:${rftColor};height:24px;border-radius:6px;transition:width .6s ease` }));
  const gaugeLabel = el('div', { textContent: rftRate + '%', style: `position:absolute;right:12px;top:3px;font-weight:700;font-size:14px;color:var(--text)` });
  gaugeBar.appendChild(gaugeLabel);
  gaugeWrap.appendChild(gaugeBar);
  const targets = el('div', { style: 'display:flex;gap:16px;margin-top:8px;font-size:12px;color:var(--text2)' });
  targets.appendChild(el('span', { textContent: '■ 95%+ Target', style: 'color:var(--green)' }));
  targets.appendChild(el('span', { textContent: '■ 80-95% Acceptable', style: 'color:var(--amber)' }));
  targets.appendChild(el('span', { textContent: '■ Below 80% Needs attention', style: 'color:var(--red)' }));
  gaugeWrap.appendChild(targets);
  container.appendChild(gaugeWrap);

  if (!reworkByItem.length) {
    container.appendChild(el('div', { className: 'empty-state', textContent: 'No rework timers recorded in this period.' }));
    return;
  }

  // ── Two column tables ────────────────────────────────────────────────────
  const cols = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:14px' });

  // Rework by item
  const itemCard = el('div', { style: 'background:var(--bg2);border-radius:10px;padding:16px;border:1px solid var(--border)' });
  itemCard.appendChild(el('div', { textContent: 'Rework — by Item', style: 'font-size:13px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px' }));
  const iTbl = el('table', { className: 'dash-table' });
  iTbl.appendChild(el('thead', {}, el('tr', {},
    el('th', { textContent: 'Item' }),
    el('th', { textContent: 'Rework Jobs' }),
    el('th', { textContent: 'Rework Time' }),
  )));
  const iTbody = el('tbody', {});
  reworkByItem.forEach(r => {
    iTbody.appendChild(el('tr', {},
      el('td', { textContent: r.itemNumber, className: 'perf-item' }),
      el('td', { textContent: r.reworkCount, style: 'color:var(--red);font-weight:700' }),
      el('td', { textContent: r.reworkHoursDisplay }),
    ));
  });
  iTbl.appendChild(iTbody); itemCard.appendChild(iTbl);
  cols.appendChild(itemCard);

  // Rework by operator
  const opCard = el('div', { style: 'background:var(--bg2);border-radius:10px;padding:16px;border:1px solid var(--border)' });
  opCard.appendChild(el('div', { textContent: 'Rework — by Operator', style: 'font-size:13px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px' }));
  const oTbl = el('table', { className: 'dash-table' });
  oTbl.appendChild(el('thead', {}, el('tr', {},
    el('th', { textContent: 'Operator' }),
    el('th', { textContent: 'Rework Jobs' }),
    el('th', { textContent: 'Rework Time' }),
  )));
  const oTbody = el('tbody', {});
  reworkByOperator.forEach(r => {
    oTbody.appendChild(el('tr', {},
      el('td', { textContent: r.operatorName, style: 'font-weight:600' }),
      el('td', { textContent: r.reworkCount, style: 'color:var(--red);font-weight:700' }),
      el('td', { textContent: r.reworkHoursDisplay }),
    ));
  });
  oTbl.appendChild(oTbody); opCard.appendChild(oTbl);
  cols.appendChild(opCard);
  container.appendChild(cols);
}



init();