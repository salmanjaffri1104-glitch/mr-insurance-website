// ============================================================================
// Mr Insurance Dashboard — standalone frontend (no build step, vanilla JS)
// ----------------------------------------------------------------------------
// SECURITY: this page contains NO client data. Everything loads from the API
// only after the owner logs in. The session token lives in sessionStorage
// (this tab only) and is cleared on logout or when the tab closes.
// The password is never stored here — it is typed on the login screen and
// checked once by the Worker (POST /api/login).
// ============================================================================
(function () {
  'use strict';

  var API_BASE = (window.APP_CONFIG && window.APP_CONFIG.API_BASE) || '';
  var OWNER_NAME = 'Ali Salman';
  var OWNER_PHONE = '0336-3598210'; // shown in every message so clients call back here
  var TOKEN_KEY = 'mi-dashboard-token';

  var state = { me: null, srs: [], clients: [], history: [], dashboard: null, tab: 'aaj' };
  // state.me = { role: 'admin'|'sr', srId, srName, srPhone } — set at login.

  // ---------- pure helpers (also unit-tested in Node) ----------------------

  function normalizeWaNumber(phone) {
    var d = String(phone || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.indexOf('92') === 0 && d.length === 12) return d;      // already 92xxxxxxxxxx
    if (d.charAt(0) === '0' && d.length === 11) return '92' + d.slice(1);
    if (d.length === 10 && d.charAt(0) === '3') return '92' + d; // leading 0 dropped
    return d;
  }

  function waLink(phone, message) {
    var num = normalizeWaNumber(phone);
    if (!num || num.length < 11) return '';
    return 'https://wa.me/' + num + '?text=' + encodeURIComponent(message);
  }

  function fmtRs(amount) {
    return 'Rs ' + Number(amount || 0).toLocaleString('en-US');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var p = iso.split('-');
    return parseInt(p[2], 10) + ' ' + months[parseInt(p[1], 10) - 1] + ' ' + p[0];
  }

  function daysBetween(a, b) {
    var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    var da = Date.UTC(pa[0], pa[1] - 1, pa[2]);
    var db = Date.UTC(pb[0], pb[1] - 1, pb[2]);
    return Math.round((db - da) / 86400000);
  }

  function todayLocal() {
    var d = new Date();
    var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function bucketFor(nextDueDate, today) {
    var d = daysBetween(today, nextDueDate);
    if (d < 0) return 'overdue';
    if (d === 0) return 'dueToday';
    if (d <= 7) return 'upcoming7';
    return 'later';
  }

  function freqLabel(f) {
    return { monthly: 'Monthly', quarterly: 'Quarterly', half_yearly: 'Half yearly', yearly: 'Yearly' }[f] || f;
  }

  // Reminder message. sender defaults to the owner (admin). When an SR sends
  // it, the message is signed with the SR's own name + number — the client
  // replies to the SR who serves them.
  function reminderMessage(c, sender) {
    sender = sender || { name: OWNER_NAME, phone: OWNER_PHONE, title: 'Sales Manager' };
    return 'Assalam-o-Alaikum ' + c.name + ', aap ki State Life policy ' +
      (c.policyNo || '') + ' ki premium ' + fmtRs(c.premiumAmount) + ' ' +
      fmtDate(c.nextDueDate) + ' ko due hai. Baraye meharbani waqt par ada karein. ' +
      '— ' + sender.name + ', ' + sender.title + ', State Life Insurance (' + sender.phone + ')';
  }

  function messageSender() {
    if (state.me && state.me.role === 'sr') {
      return { name: state.me.srName, phone: state.me.srPhone || OWNER_PHONE, title: 'Sales Representative' };
    }
    return { name: OWNER_NAME, phone: OWNER_PHONE, title: 'Sales Manager' };
  }

  function srAlertMessage(sr, c) {
    return 'Assalam-o-Alaikum ' + sr.name + ', aap ke client ' + c.name +
      ' (policy ' + (c.policyNo || '') + ') ki premium ' + fmtRs(c.premiumAmount) +
      ' ' + fmtDate(c.nextDueDate) + ' ko due hai. Baraye meharbani client ko yaad dila dein. — ' + OWNER_NAME;
  }

  function srBulkAlertMessage(sr, clients) {
    var lines = clients.map(function (c, i) {
      return (i + 1) + '. ' + c.name + ' — policy ' + (c.policyNo || '') +
        ', ' + fmtRs(c.premiumAmount) + ', due ' + fmtDate(c.nextDueDate);
    });
    return 'Assalam-o-Alaikum ' + sr.name + ', aap ke ye clients premium due hain:\n' +
      lines.join('\n') + '\nBaraye meharbani in ko yaad dila dein. — ' + OWNER_NAME;
  }

  // ---------- DOM helpers ---------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  // ---------- API -----------------------------------------------------------

  function getToken() { return sessionStorage.getItem(TOKEN_KEY) || ''; }

  async function api(path, options) {
    options = options || {};
    var headers = { 'Content-Type': 'application/json' };
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var res = await fetch(API_BASE + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (res.status === 401) { showLogin('Session khatam ho gaya — dobara login karein.'); throw new Error('unauthorized'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }

  async function apiLogin(code) {
    var res = await fetch(API_BASE + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('Login failed (' + res.status + ')'));
    return data;
  }

  // ---------- login gate ----------------------------------------------------

  function showLogin(message) {
    sessionStorage.removeItem(TOKEN_KEY);
    $('app').hidden = true;
    $('login-screen').hidden = false;
    $('login-screen').style.display = '';
    window.scrollTo(0, 0);
    var err = $('login-error');
    if (message) { err.textContent = message; err.hidden = false; }
    else { err.hidden = true; }
    $('login-password').value = '';
    $('login-password').type = 'password';
    $('show-password').checked = false;
    $('login-password').focus();
  }

  function showApp() {
    $('login-screen').hidden = true;
    // Inline hide: works even if the browser still holds an old styles.css
    // in cache (its display:flex used to override the [hidden] attribute).
    $('login-screen').style.display = 'none';
    $('app').hidden = false;
    window.scrollTo(0, 0);
  }

  async function tryResumeSession() {
    if (!API_BASE || API_BASE.indexOf('REPLACE-WITH') !== -1) {
      showLogin('API abhi set nahi hai — config.js mein Worker URL daalein (deploy guide dekhein).');
      return;
    }
    if (!getToken()) { showLogin(); return; }
    try {
      await loadAll();
      showApp();
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message);
    }
  }

  // ---------- data loading --------------------------------------------------

  async function loadAll() {
    var dash = await api('/api/dashboard');
    state.dashboard = dash;
    state.me = dash.me || null;
    state.srs = dash.srs;
    var cl = await api('/api/clients');
    state.clients = cl.clients;
    fillSrSelects();
    applyRoleUI();
    render();
  }

  // Role-based view: an SR sees only their own clients, no SR Team tab, no
  // SR filter, no SR picker in the client form, and no "SR ko Batayein".
  // (The server enforces the same limits — this only changes the display.)
  function isSr() { return !!(state.me && state.me.role === 'sr'); }

  function applyRoleUI() {
    var sr = isSr();
    var teamTab = document.querySelector('[data-tab="team"]');
    if (teamTab) teamTab.hidden = sr;
    var teamPanel = $('tab-team');
    if (teamPanel && sr) teamPanel.hidden = true;
    $('client-sr-filter').hidden = sr;
    $('f-sr-row').hidden = sr;
    var roleEl = $('header-role');
    if (sr) {
      roleEl.textContent = 'SR: ' + state.me.srName + ' — sirf aap ke apne clients dikhaye ja rahe hain';
      if (state.tab === 'team') switchTab('aaj');
    } else {
      roleEl.textContent = 'Admin — Ali Salman (sab SRs, sab clients)';
    }
  }

  async function loadHistory() {
    var h = await api('/api/history?limit=200');
    state.history = h.history;
    renderHistory();
  }

  function fillSrSelects() {
    var filter = $('client-sr-filter');
    var current = filter.value;
    filter.innerHTML = '<option value="">Sab SRs</option>' +
      state.srs.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('');
    filter.value = current;
    var formSel = $('f-sr');
    // SRs only ever add clients under themselves.
    var opts = isSr() && state.me
      ? state.srs.filter(function (s) { return s.id === state.me.srId; })
      : state.srs;
    formSel.innerHTML = opts.map(function (s) {
      return '<option value="' + s.id + '">' + esc(s.name) + '</option>';
    }).join('');
  }

  // ---------- rendering -----------------------------------------------------

  function srById(id) {
    for (var i = 0; i < state.srs.length; i++) if (state.srs[i].id === id) return state.srs[i];
    return { id: id, name: '', phone: '' };
  }

  function dueText(c) {
    var today = state.dashboard ? state.dashboard.today : todayLocal();
    var d = daysBetween(today, c.nextDueDate);
    if (d < 0) return { text: (-d) + ' din late', cls: 'overdue' };
    if (d === 0) return { text: 'Aaj due hai', cls: 'due-today' };
    if (d === 1) return { text: 'Kal due hai', cls: 'upcoming' };
    return { text: d + ' din reh gaye', cls: 'upcoming' };
  }

  function clientCardHTML(c, opts) {
    opts = opts || {};
    var b = bucketFor(c.nextDueDate, state.dashboard ? state.dashboard.today : todayLocal());
    var dt = dueText(c);
    var sr = srById(c.srId);
    var link = waLink(c.phone, reminderMessage(c, messageSender()));
    var srLink = sr.phone ? waLink(sr.phone, srAlertMessage(sr, c)) : '';
    var html = '<article class="client-card ' + b + '">' +
      '<h3>' + esc(c.name) + '</h3>' +
      '<p class="client-meta">SR: ' + esc(sr.name) +
      (c.policyNo ? ' &nbsp;•&nbsp; Policy: ' + esc(c.policyNo) : '') +
      (c.planName ? ' &nbsp;•&nbsp; Plan: ' + esc(c.planName) : '') + '</p>' +
      '<p class="client-meta">Phone: ' + (c.phone ? esc(c.phone) : '— number nahi hai') +
      ' &nbsp;•&nbsp; ' + esc(freqLabel(c.frequency)) + '</p>' +
      '<p class="client-amount">' + esc(fmtRs(c.premiumAmount)) + '</p>' +
      '<p class="due-line ' + dt.cls + '">Due: ' + esc(fmtDate(c.nextDueDate)) + ' — ' + esc(dt.text) + '</p>' +
      '<div class="card-actions">';
    if (link) {
      html += '<button class="btn btn-small btn-whatsapp" data-act="remind" data-id="' + c.id + '">WhatsApp Reminder</button>';
    } else {
      html += '<button class="btn btn-small btn-whatsapp" disabled>WhatsApp Reminder</button>';
    }
    html += '<button class="btn btn-small btn-paid" data-act="paid" data-id="' + c.id + '">Ada Ho Gaya</button>';
    // "SR ko Batayein" is the admin's job — SRs never see it (they ARE the SR).
    if (srLink && !isSr()) {
      html += '<button class="btn btn-small" data-act="sr-alert" data-id="' + c.id + '">SR ko Batayein</button>';
    }
    if (opts.manage) {
      html += '<button class="btn btn-small" data-act="edit" data-id="' + c.id + '">Edit</button>' +
        '<button class="btn btn-small btn-danger" data-act="delete" data-id="' + c.id + '">Delete</button>';
    }
    html += '</div>';
    if (!link) html += '<p class="hint">Client ka number nahi hai — reminder nahi bheja ja sakta. Number add karein.</p>';
    if (!sr.phone && !isSr()) html += '<p class="hint">SR ka number nahi hai — “SR ko Batayein” ke liye SR Team tab mein number add karein.</p>';
    html += '</article>';
    return html;
  }

  function renderAaj() {
    var dash = state.dashboard;
    if (!dash) return;
    var c = dash.counts;
    $('aaj-summary').innerHTML =
      '<div class="summary-card red"><div class="num">' + c.overdue + '</div><div class="lbl">Late clients • ' + esc(fmtRs(c.overdueAmount)) + '</div></div>' +
      '<div class="summary-card amber"><div class="num">' + c.dueToday + '</div><div class="lbl">Aaj due • ' + esc(fmtRs(c.dueTodayAmount)) + '</div></div>' +
      '<div class="summary-card green"><div class="num">' + c.upcoming7 + '</div><div class="lbl">Agle 7 din • ' + esc(fmtRs(c.upcoming7Amount)) + '</div></div>' +
      '<div class="summary-card"><div class="num">' + c.totalClients + '</div><div class="lbl">Kul clients</div></div>';
    $('header-date').textContent = 'Aaj: ' + fmtDate(dash.today);
    var sections = [['list-overdue', dash.due.overdue], ['list-due-today', dash.due.dueToday], ['list-upcoming', dash.due.upcoming7]];
    sections.forEach(function (pair) {
      var el = $(pair[0]);
      var list = pair[1];
      el.innerHTML = list.length
        ? list.map(function (cl) { return clientCardHTML(cl); }).join('')
        : '<p class="empty">Koi client nahi hai.</p>';
    });
  }

  function renderClients() {
    var q = ($('client-search').value || '').toLowerCase();
    var srFilter = $('client-sr-filter').value;
    var list = state.clients.filter(function (c) {
      if (srFilter && String(c.srId) !== srFilter) return false;
      if (!q) return true;
      return (c.name + ' ' + (c.policyNo || '') + ' ' + (c.phone || '')).toLowerCase().indexOf(q) !== -1;
    });
    $('clients-count').textContent = list.length + ' clients dikhaye ja rahe hain (kul ' + state.clients.length + ')';
    $('list-clients').innerHTML = list.length
      ? list.map(function (c) { return clientCardHTML(c, { manage: true }); }).join('')
      : '<p class="empty">Koi client nahi mila.</p>';
  }

  function renderTeam() {
    var dash = state.dashboard;
    var today = dash ? dash.today : todayLocal();
    $('list-srs').innerHTML = state.srs.map(function (sr) {
      var dueClients = state.clients.filter(function (c) {
        return c.srId === sr.id && bucketFor(c.nextDueDate, today) !== 'later';
      });
      var note = '';
      if (sr.id === 7) note = '<p class="hint">Irtiza Haider aap khud hain — in ke clients ke reminder aap ke number (' + OWNER_PHONE + ') se jayenge.</p>';
      var html = '<article class="sr-card"><h3>' + esc(sr.name) + '</h3>' +
        '<p class="client-meta">Phone: ' + (sr.phone ? esc(sr.phone) : '— number nahi hai') + '</p>' +
        '<div class="sr-stats"><span>Clients: <b>' + sr.clientCount + '</b></span>' +
        '<span>Due: <b>' + sr.dueCount + '</b></span>' +
        '<span>Late: <b>' + sr.overdueCount + '</b></span>' +
        '<span>Due raqam: <b>' + esc(fmtRs(sr.dueAmount)) + '</b></span></div>' +
        '<div class="card-actions">' +
        '<button class="btn btn-small btn-whatsapp" data-sr-alert-all="' + sr.id + '"' +
        (sr.phone && dueClients.length ? '' : ' disabled') + '>Sab Due Clients ka Alert Bhejein</button></div>' +
        '<div class="sr-phone-row"><input type="tel" placeholder="SR ka number (03xx-xxxxxxx)" value="' + esc(sr.phone || '') + '" data-sr-phone="' + sr.id + '">' +
        '<button class="btn btn-small" data-sr-save-phone="' + sr.id + '">Number Save Karein</button></div>' +
        note + '</article>';
      return html;
    }).join('');
  }

  function renderHistory() {
    var el = $('list-history');
    if (!state.history.length) {
      el.innerHTML = '<p class="empty">Abhi koi record nahi hai.</p>';
      return;
    }
    el.innerHTML = state.history.map(function (h) {
      var label = h.type === 'reminder' ? 'Reminder' : h.type === 'sr_alert' ? 'SR Alert' : 'Payment';
      var when = h.createdAt ? h.createdAt.replace('T', ' ').slice(0, 16) : '';
      return '<div class="history-item"><span class="tag ' + esc(h.type) + '">' + label + '</span><div>' +
        esc(h.detail) + '</div><time>' + esc(when) + '</time></div>';
    }).join('');
  }

  function render() {
    renderAaj();
    renderClients();
    renderTeam();
  }

  function switchTab(name) {
    // SRs have no SR Team tab — never let them open it.
    if (name === 'team' && isSr()) name = 'aaj';
    state.tab = name;
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    ['aaj', 'clients', 'team', 'history'].forEach(function (n) {
      $('tab-' + n).hidden = n !== name;
    });
    if (name === 'history') loadHistory().catch(function (e) { if (e.message !== 'unauthorized') toast(e.message); });
  }

  // ---------- actions -------------------------------------------------------

  function findClient(id) {
    for (var i = 0; i < state.clients.length; i++) if (state.clients[i].id === id) return state.clients[i];
    return null;
  }

  async function doRemind(id) {
    var c = findClient(id);
    if (!c) return;
    var link = waLink(c.phone, reminderMessage(c, messageSender()));
    if (!link) { toast('Client ka number nahi hai.'); return; }
    window.open(link, '_blank');
    try { await api('/api/clients/' + id + '/reminded', { method: 'POST' }); } catch (e) { /* log failure is non-fatal */ }
    toast('Reminder khul gaya — WhatsApp mein Send dabayein.');
  }

  async function doSrAlert(id) {
    // Admin-only action; the button is hidden for SRs, but guard anyway.
    if (isSr()) return;
    var c = findClient(id);
    if (!c) return;
    var sr = srById(c.srId);
    var link = sr.phone ? waLink(sr.phone, srAlertMessage(sr, c)) : '';
    if (!link) { toast('SR ka number nahi hai.'); return; }
    window.open(link, '_blank');
    try { await api('/api/clients/' + id + '/sr-alert', { method: 'POST' }); } catch (e) { /* non-fatal */ }
    toast('SR alert khul gaya — WhatsApp mein Send dabayein.');
  }

  async function doSrBulkAlert(srId) {
    // Admin-only action; the button is hidden for SRs, but guard anyway.
    if (isSr()) return;
    var sr = srById(srId);
    var today = state.dashboard ? state.dashboard.today : todayLocal();
    var dueClients = state.clients.filter(function (c) {
      return c.srId === srId && bucketFor(c.nextDueDate, today) !== 'later';
    });
    if (!sr.phone || !dueClients.length) return;
    var link = waLink(sr.phone, srBulkAlertMessage(sr, dueClients));
    window.open(link, '_blank');
    for (var i = 0; i < dueClients.length; i++) {
      try { await api('/api/clients/' + dueClients[i].id + '/sr-alert', { method: 'POST' }); } catch (e) { /* non-fatal */ }
    }
    toast(dueClients.length + ' due clients ka alert SR ko bhejne ke liye khul gaya.');
  }

  async function doPaid(id) {
    var c = findClient(id);
    if (!c) return;
    if (!window.confirm(c.name + ' ki premium Rs ' + Number(c.premiumAmount).toLocaleString('en-US') + ' ada ho gayi? Agli due date aage barh jayegi.')) return;
    try {
      var res = await api('/api/clients/' + id + '/paid', { method: 'POST' });
      toast('Ada ho gaya — agli due: ' + fmtDate(res.nextDueDate));
      await loadAll();
    } catch (e) { if (e.message !== 'unauthorized') toast(e.message); }
  }

  async function doDelete(id) {
    var c = findClient(id);
    if (!c) return;
    if (!window.confirm('Kya ' + c.name + ' (policy ' + (c.policyNo || '') + ') ko delete karna hai?')) return;
    try {
      await api('/api/clients/' + id, { method: 'DELETE' });
      toast('Client delete ho gaya.');
      await loadAll();
    } catch (e) { if (e.message !== 'unauthorized') toast(e.message); }
  }

  // ---------- client form ---------------------------------------------------

  function openClientForm(client) {
    $('client-form-error').hidden = true;
    if (client) {
      $('client-modal-title').textContent = 'Client Edit Karein';
      $('f-id').value = client.id;
      $('f-name').value = client.name;
      $('f-phone').value = client.phone || '';
      $('f-policy').value = client.policyNo || '';
      $('f-plan').value = client.planName || '';
      $('f-premium').value = client.premiumAmount;
      $('f-frequency').value = client.frequency;
      $('f-due').value = client.nextDueDate;
      $('f-sr').value = String(client.srId);
    } else {
      $('client-modal-title').textContent = 'Naya Client';
      $('client-form').reset();
      $('f-id').value = '';
      $('f-frequency').value = 'yearly';
    }
    $('client-modal').hidden = false;
    $('f-name').focus();
  }

  function closeClientForm() { $('client-modal').hidden = true; }

  async function saveClientForm(ev) {
    ev.preventDefault();
    var err = $('client-form-error');
    var body = {
      name: $('f-name').value.trim(),
      phone: $('f-phone').value.trim(),
      policyNo: $('f-policy').value.trim(),
      planName: $('f-plan').value.trim(),
      premiumAmount: parseInt($('f-premium').value, 10),
      frequency: $('f-frequency').value,
      nextDueDate: $('f-due').value,
      srId: parseInt($('f-sr').value, 10),
    };
    if (!body.name) { err.textContent = 'Client ka naam zaroori hai.'; err.hidden = false; return; }
    if (!body.nextDueDate) { err.textContent = 'Next due date zaroori hai.'; err.hidden = false; return; }
    if (!(body.premiumAmount >= 0)) { err.textContent = 'Premium 0 ya zyada hona chahiye.'; err.hidden = false; return; }
    var id = $('f-id').value;
    try {
      if (id) {
        await api('/api/clients/' + id, { method: 'PUT', body: body });
        toast('Client update ho gaya.');
      } else {
        await api('/api/clients', { method: 'POST', body: body });
        toast('Naya client add ho gaya.');
      }
      closeClientForm();
      await loadAll();
    } catch (e) {
      if (e.message === 'unauthorized') return;
      err.textContent = e.message;
      err.hidden = false;
    }
  }

  // ---------- events --------------------------------------------------------

  function bindEvents() {
    // "Password dikhayein" tick — code likhte waqt dikhaye taake ghalat
    // type hone par pata chal jaye; login screen khulte hi phir chhupa de.
    $('show-password').addEventListener('change', function () {
      $('login-password').type = this.checked ? 'text' : 'password';
      $('login-password').focus();
    });

    $('login-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var code = $('login-password').value;
      var err = $('login-error');
      try {
        var data = await apiLogin(code);
        sessionStorage.setItem(TOKEN_KEY, data.token);
        // Who logged in? Admin (Ali) or one SR — the role decides the view.
        state.me = { role: data.role || 'admin', srId: data.srId || null,
          srName: data.srName || OWNER_NAME, srPhone: data.srPhone || OWNER_PHONE };
        err.hidden = true;
        await loadAll();
        showApp();
      } catch (e) {
        err.textContent = e.message === 'unauthorized' ? 'Wrong password.' : e.message;
        err.hidden = false;
      }
    });

    $('logout-btn').addEventListener('click', async function () {
      try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
      showLogin();
      toast('Logout ho gaya.');
    });

    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { switchTab(t.dataset.tab); });
    });

    $('client-search').addEventListener('input', renderClients);
    $('client-sr-filter').addEventListener('change', renderClients);
    $('add-client-btn').addEventListener('click', function () { openClientForm(null); });
    $('client-modal-cancel').addEventListener('click', closeClientForm);
    $('client-modal').addEventListener('click', function (ev) { if (ev.target === $('client-modal')) closeClientForm(); });
    $('client-form').addEventListener('submit', saveClientForm);

    // Delegated clicks: client cards + SR team buttons (re-rendered content).
    document.addEventListener('click', async function (ev) {
      var btn = ev.target.closest('[data-act]');
      if (btn) {
        var id = parseInt(btn.dataset.id, 10);
        var act = btn.dataset.act;
        if (act === 'remind') doRemind(id);
        else if (act === 'paid') doPaid(id);
        else if (act === 'sr-alert') doSrAlert(id);
        else if (act === 'delete') doDelete(id);
        else if (act === 'edit') { var c = findClient(id); if (c) openClientForm(c); }
        return;
      }
      var bulk = ev.target.closest('[data-sr-alert-all]');
      if (bulk) { doSrBulkAlert(parseInt(bulk.dataset.srAlertAll, 10)); return; }
      var save = ev.target.closest('[data-sr-save-phone]');
      if (save) {
        var srId = parseInt(save.dataset.srSavePhone, 10);
        var input = document.querySelector('[data-sr-phone="' + srId + '"]');
        var phone = input ? input.value.trim() : '';
        try {
          await api('/api/srs/' + srId, { method: 'PUT', body: { phone: phone } });
          toast('SR ka number save ho gaya.');
          await loadAll();
        } catch (e) { if (e.message !== 'unauthorized') toast(e.message); }
      }
    });
  }

  // ---------- boot ----------------------------------------------------------

  bindEvents();
  tryResumeSession();

  // Expose pure helpers for Node unit tests (harmless in the browser).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeWaNumber: normalizeWaNumber, waLink: waLink, fmtRs: fmtRs,
      fmtDate: fmtDate, daysBetween: daysBetween, bucketFor: bucketFor, freqLabel: freqLabel,
      reminderMessage: reminderMessage, srAlertMessage: srAlertMessage, srBulkAlertMessage: srBulkAlertMessage };
  }
})();
