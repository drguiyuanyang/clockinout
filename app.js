/* ClockIn&Out v3
 *
 * Overlap policy: for records with correctedHours set, totals use correctedHours
 * for the task subtotal, but overlap with Daily work is still computed from the
 * original checkIn/checkOut intervals (the only interval we have).
 */
(function () {
  'use strict';

  const KEYS = {
    records: 'clockinout:v2:records',
    sessions: 'clockinout:v2:sessions',
    tasks: 'clockinout:v2:tasks',
    migrated: 'clockinout:v2:migratedFromV1',
    savedNames: 'clockinout:v3:savedExtraNames',
    lastExtra: 'clockinout:v3:lastExtraName',
    feedbackSent: 'clockinout:v3:feedbackSent',
    newsSeen: 'clockinout:v3:newsSeen'
  };
  const OLD = { records: 'punchclock:records', session: 'punchclock:session' };
  const MAIN_ID = 'daily';
  const MAIN_NAME = 'Daily work';
  const LOCK_DAYS = 7;
  const FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLScaKGcbmSAMBF5P_KDTkSQF8rpkV4VLnMnIKWL_DKkl07t9BA/formResponse';
  const FORM_ENTRIES = { q1: 'entry.1098279369', q2: 'entry.1648032177', q3: 'entry.1104486592', q4: 'entry.694728927' };
  const PRICE_OPTS = ['US$29 for 3 months to try', 'US$49 for 6 months', 'US$99 a year'];

  let records = [];
  let sessions = [];
  let tasks = [{ id: MAIN_ID, name: MAIN_NAME, isMain: true }];
  let savedExtraNames = [];
  let lastExtraName = '';
  let tickTimer = null;
  let sheetMode = null;
  let teamsQ1 = '';
  let teamsQ2 = '';
  let newsQueue = [];

  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function getStore(key) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
    catch (e) { return null; }
  }
  function setStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { toast('Could not save'); }
  }

  function localDateStr(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parseLocalDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function combineLocal(dateStr, timeStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [hh, mm] = timeStr.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, 0, 0);
  }
  function fmtTime(isoOrDate) {
    const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtTimeSec(d) {
    d = d instanceof Date ? d : new Date(d);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtDateShort(dateStr) {
    const d = parseLocalDate(dateStr);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return days[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()];
  }
  function fmtCorrectedAt(iso) {
    const d = new Date(iso);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return 'Corrected ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() + ', ' + fmtTime(d);
  }
  function hoursBetween(a, b) { return (new Date(b) - new Date(a)) / 3600000; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function effectiveHours(rec) {
    return (rec.correctedHours != null) ? rec.correctedHours : rec.hours;
  }
  function isOvernightTimes(inT, outT) { return outT < inT; }
  function isOvernightRec(rec) {
    const a = new Date(rec.checkIn), b = new Date(rec.checkOut);
    return localDateStr(a) !== localDateStr(b);
  }
  function startOfWeekMon(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - day);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function endOfWeekSun(d) {
    const s = startOfWeekMon(d);
    const e = new Date(s);
    e.setDate(e.getDate() + 7);
    return e;
  }
  function isLockedDate(dateStr) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const min = new Date(today); min.setDate(min.getDate() - (LOCK_DAYS - 1));
    return parseLocalDate(dateStr) < min;
  }
  function dateMinMax() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const min = new Date(today); min.setDate(min.getDate() - (LOCK_DAYS - 1));
    return { min: localDateStr(min), max: localDateStr(today) };
  }
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2600);
  }
  function reduceMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function save() {
    setStore(KEYS.records, records);
    setStore(KEYS.sessions, sessions);
    setStore(KEYS.tasks, tasks);
    setStore(KEYS.savedNames, savedExtraNames);
    setStore(KEYS.lastExtra, lastExtraName);
  }

  function rememberExtraName(name) {
    name = (name || '').trim();
    if (!name || name === MAIN_NAME) return;
    savedExtraNames = savedExtraNames.filter(n => n.toLowerCase() !== name.toLowerCase());
    savedExtraNames.unshift(name);
    lastExtraName = name;
  }

  function migrateV1() {
    if (getStore(KEYS.migrated)) return;
    const oldRecs = getStore(OLD.records);
    const oldSession = getStore(OLD.session);
    let changed = false;
    if (Array.isArray(oldRecs) && oldRecs.length && records.length === 0) {
      for (const r of oldRecs) {
        records.push({
          id: r.id || uid(),
          taskId: MAIN_ID,
          taskName: MAIN_NAME,
          date: r.date,
          checkIn: r.checkIn,
          checkOut: r.checkOut,
          hours: round2(r.hours),
          correctedHours: null,
          correctedAt: null
        });
      }
      changed = true;
    }
    if (oldSession && oldSession.checkIn && sessions.length === 0) {
      sessions.push({ taskId: MAIN_ID, name: MAIN_NAME, checkIn: oldSession.checkIn });
      changed = true;
    }
    if (changed) save();
    setStore(KEYS.migrated, true);
  }

  function load() {
    records = getStore(KEYS.records) || [];
    sessions = getStore(KEYS.sessions) || [];
    const t = getStore(KEYS.tasks);
    if (Array.isArray(t) && t.length) tasks = t;
    if (!tasks.find(x => x.id === MAIN_ID)) {
      tasks.unshift({ id: MAIN_ID, name: MAIN_NAME, isMain: true });
    }
    savedExtraNames = getStore(KEYS.savedNames) || [];
    lastExtraName = getStore(KEYS.lastExtra) || '';
    // Backfill names from existing extra tasks
    tasks.filter(x => !x.isMain && x.id !== MAIN_ID).forEach(x => {
      if (x.name && !savedExtraNames.some(n => n.toLowerCase() === x.name.toLowerCase())) {
        savedExtraNames.push(x.name);
      }
    });
    migrateV1();
    render();
    fetchNews();
  }

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  function sessionFor(taskId) { return sessions.find(s => s.taskId === taskId); }
  function mainSession() { return sessionFor(MAIN_ID); }
  function extraSessions() { return sessions.filter(s => s.taskId !== MAIN_ID); }
  function taskName(id) {
    const t = tasks.find(x => x.id === id);
    return t ? t.name : (id === MAIN_ID ? MAIN_NAME : 'Task');
  }

  function buildCheckoutISO(dateStr, inTime, outTime) {
    const checkIn = combineLocal(dateStr, inTime);
    let checkOut = combineLocal(dateStr, outTime);
    if (outTime < inTime) checkOut.setDate(checkOut.getDate() + 1);
    return { checkIn, checkOut };
  }

  function findOrCreateExtraTask(name) {
    name = (name || '').trim();
    if (!name) return null;
    let t = tasks.find(x => x.id !== MAIN_ID && x.name.toLowerCase() === name.toLowerCase());
    if (!t) {
      const id = 't-' + name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Math.random().toString(36).slice(2, 5);
      t = { id, name, isMain: false };
      tasks.push(t);
    }
    rememberExtraName(t.name);
    return t;
  }

  function checkInTask(taskId, name) {
    if (sessionFor(taskId)) return;
    const now = new Date();
    const nm = name || taskName(taskId);
    sessions.push({ taskId, name: nm, checkIn: now.toISOString() });
    if (!tasks.find(t => t.id === taskId)) {
      tasks.push({ id: taskId, name: nm, isMain: taskId === MAIN_ID });
    }
    if (taskId !== MAIN_ID) rememberExtraName(nm);
    save(); render();
  }

  function endSession(taskId) {
    const s = sessionFor(taskId);
    if (!s) return null;
    const now = new Date();
    const checkIn = new Date(s.checkIn);
    const rec = {
      id: uid(),
      taskId: s.taskId,
      taskName: s.name,
      date: localDateStr(checkIn),
      checkIn: checkIn.toISOString(),
      checkOut: now.toISOString(),
      hours: round2(hoursBetween(checkIn, now)),
      correctedHours: null,
      correctedAt: null
    };
    records.unshift(rec);
    sessions = sessions.filter(x => x.taskId !== taskId);
    return rec;
  }

  function checkOutTask(taskId, opts) {
    const animate = !!(opts && opts.animate);
    const flyEl = document.querySelector('.status-time.live');
    const from = (animate && flyEl && !reduceMotion()) ? flyEl.getBoundingClientRect() : null;
    const flyText = from ? flyEl.textContent : '';
    const rec = endSession(taskId);
    if (!rec) return;
    save();
    render();
    if (from) playClockOutAnim(from, flyText, rec.id);
  }

  function checkOutAll(opts) {
    const animate = !!(opts && opts.animate);
    const flyEl = document.querySelector('.status-time.live');
    const from = (animate && flyEl && !reduceMotion()) ? flyEl.getBoundingClientRect() : null;
    const flyText = from ? flyEl.textContent : '';
    const ids = sessions.map(s => s.taskId);
    let firstId = null;
    ids.forEach(id => { const r = endSession(id); if (r && !firstId) firstId = r.id; });
    save();
    render();
    if (from && firstId) playClockOutAnim(from, flyText, firstId);
  }

  function playClockOutAnim(fromRect, text, recId) {
    const dest = document.querySelector('.record[data-id="' + recId + '"]') || document.querySelector('.record');
    if (!dest) return;
    dest.classList.add('appearing');
    const to = dest.getBoundingClientRect();
    const fly = document.createElement('div');
    fly.className = 'fly-time';
    fly.textContent = text;
    fly.style.top = fromRect.top + 'px';
    fly.style.left = '0';
    fly.style.width = '100%';
    fly.style.textAlign = 'center';
    fly.style.opacity = '1';
    document.body.appendChild(fly);
    const startMidX = fromRect.left + fromRect.width / 2;
    const endMidX = to.left + to.width / 2;
    const endY = to.top + Math.min(20, to.height / 4);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fly.style.transform = 'translate(' + (endMidX - startMidX) + 'px,' + (endY - fromRect.top) + 'px) scale(.45)';
        fly.style.opacity = '0';
      });
    });
    setTimeout(() => {
      fly.remove();
      dest.classList.remove('appearing');
    }, 750);
  }

  function renameTask(taskId, newName) {
    newName = (newName || '').trim();
    if (!newName) return;
    const t = tasks.find(x => x.id === taskId);
    const oldName = t ? t.name : '';
    if (t) t.name = newName;
    sessions.forEach(s => { if (s.taskId === taskId) s.name = newName; });
    records.forEach(r => { if (r.taskId === taskId) r.taskName = newName; });
    if (taskId !== MAIN_ID) {
      savedExtraNames = savedExtraNames.map(n => (n === oldName ? newName : n));
      if (!savedExtraNames.some(n => n.toLowerCase() === newName.toLowerCase())) savedExtraNames.unshift(newName);
      lastExtraName = newName;
    }
    save(); render();
  }

  function intervalOverlapHours(a0, a1, b0, b1) {
    const start = Math.max(+new Date(a0), +new Date(b0));
    const end = Math.min(+new Date(a1), +new Date(b1));
    return end > start ? (end - start) / 3600000 : 0;
  }
  function recordsInRange(start, end) {
    return records.filter(r => {
      const t = new Date(r.checkIn);
      return t >= start && t < end;
    });
  }
  function computeTotals(start, end) {
    const subset = recordsInRange(start, end);
    const daily = subset.filter(r => r.taskId === MAIN_ID);
    const byTask = {};
    for (const r of subset) {
      if (!byTask[r.taskId]) byTask[r.taskId] = { taskId: r.taskId, name: r.taskName, hours: 0, overlap: 0 };
      byTask[r.taskId].hours += effectiveHours(r);
    }
    for (const r of subset) {
      if (r.taskId === MAIN_ID) continue;
      let ov = 0;
      for (const d of daily) ov += intervalOverlapHours(r.checkIn, r.checkOut, d.checkIn, d.checkOut);
      byTask[r.taskId].overlap += ov;
    }
    Object.values(byTask).forEach(t => {
      t.hours = round2(t.hours);
      t.overlap = round2(t.overlap);
    });
    return byTask;
  }

  function render() {
    renderCards();
    renderTotals();
    renderRecords();
    clearInterval(tickTimer);
    if (sessions.length) {
      updateLiveClock();
      tickTimer = setInterval(updateLiveClock, 1000);
    }
  }

  function elapsedText(iso) {
    const mins = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000));
    return Math.floor(mins / 60) + 'h ' + pad(mins % 60) + 'm elapsed';
  }

  function updateLiveClock() {
    const nowEl = document.querySelector('.status-time.live');
    if (nowEl) nowEl.textContent = fmtTimeSec(new Date());
    document.querySelectorAll('[data-elapsed]').forEach(el => {
      el.textContent = elapsedText(el.getAttribute('data-elapsed'));
    });
  }

  function renderCards() {
    const root = document.getElementById('cards');
    const main = mainSession();
    const extras = extraSessions();
    let html = '';

    html += '<div class="status-card" data-card="daily">';
    html += '<div class="task-name">' + esc(MAIN_NAME) + '</div>';
    if (main) {
      html += '<div class="status-time active live">' + esc(fmtTimeSec(new Date())) + '</div>';
      html += '<div class="clocked-at">Clocked in at ' + esc(fmtTime(main.checkIn)) + '</div>';
      html += '<div class="elapsed" data-elapsed="' + esc(main.checkIn) + '">' + elapsedText(main.checkIn) + '</div>';
      html += '<button type="button" class="punch out" data-act="checkout-main">Clock Out</button>';
    } else {
      html += '<div class="status-label">Not clocked in</div>';
      html += '<div class="status-time idle-empty">00:00:00</div>';
      html += '<button type="button" class="punch" data-act="checkin-main">Clock In</button>';
    }
    html += '</div>';

    for (const s of extras) {
      html += '<div class="status-card secondary" data-card="' + esc(s.taskId) + '">';
      html += '<div class="task-name">' + esc(s.name) +
        ' <button type="button" class="pencil" data-act="rename" data-task="' + esc(s.taskId) + '" aria-label="Rename">✎</button></div>';
      html += '<div class="clocked-at">Clocked in at ' + esc(fmtTime(s.checkIn)) + '</div>';
      html += '<button type="button" class="edit-link" data-act="edit-session" data-task="' + esc(s.taskId) + '">Edit</button>';
      html += '<div class="elapsed" data-elapsed="' + esc(s.checkIn) + '">' + elapsedText(s.checkIn) + '</div>';
      if (!main) {
        html += '<button type="button" class="punch out" data-act="checkout-one" data-task="' + esc(s.taskId) + '">Clock Out</button>';
      }
      html += '</div>';
    }
    root.innerHTML = html;
  }

  function renderTotals() {
    const now = new Date();
    const week = computeTotals(startOfWeekMon(now), endOfWeekSun(now));
    const month = computeTotals(new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1));
    function chip(title, map) {
      const order = [];
      if (map[MAIN_ID]) order.push(map[MAIN_ID]);
      Object.values(map).filter(t => t.taskId !== MAIN_ID).sort((a, b) => a.name.localeCompare(b.name)).forEach(t => order.push(t));
      if (!order.length) {
        return '<div class="total-chip"><div class="period">' + title + '</div>' +
          '<div class="task-row"><div class="task-line"><span class="tn">' + esc(MAIN_NAME) + '</span><span class="th">0.0 h</span></div></div></div>';
      }
      let h = '<div class="total-chip"><div class="period">' + title + '</div>';
      for (const t of order) {
        h += '<div class="task-row"><div class="task-line"><span class="tn">' + esc(t.name) + '</span><span class="th">' + t.hours.toFixed(1) + ' h</span></div>';
        if (t.taskId !== MAIN_ID && t.overlap > 0) {
          h += '<div class="overlap">' + t.overlap.toFixed(1) + ' h overlaps ' + esc(MAIN_NAME) + '</div>';
        }
        h += '</div>';
      }
      return h + '</div>';
    }
    document.getElementById('totals').innerHTML = chip('This week', week) + chip('This month', month);
  }

  function renderRecords() {
    const root = document.getElementById('records');
    const empty = document.getElementById('emptyMsg');
    const sorted = [...records].sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn));
    empty.classList.toggle('hidden', sorted.length > 0);
    root.innerHTML = sorted.map(rec => {
      const locked = isLockedDate(rec.date);
      const overnight = isOvernightRec(rec);
      const eff = effectiveHours(rec);
      const corrected = rec.correctedHours != null;
      let hoursHtml = '<div class="hours">' + eff.toFixed(1) + ' h' + (corrected ? '<span class="dot"></span>' : '') + '</div>';
      if (corrected) hoursHtml += '<div class="hours-orig">' + rec.hours.toFixed(1) + ' h</div>';
      return '<button type="button" class="record" data-act="open-rec" data-id="' + esc(rec.id) + '">' +
        '<div class="left"><div class="date-row">' +
        '<span class="date">' + esc(fmtDateShort(rec.date)) + '</span>' +
        (locked ? '<span class="lock" aria-label="Locked">🔒</span>' : '') +
        '<span class="task-tag">· ' + esc(rec.taskName) + '</span></div>' +
        '<div class="times">' + esc(fmtTime(rec.checkIn)) + ' – ' + esc(fmtTime(rec.checkOut)) +
        (overnight ? ' <span class="plus1">+1</span>' : '') + '</div></div>' +
        '<div style="display:flex;align-items:center"><div class="hours-wrap">' + hoursHtml + '</div><span class="chev">›</span></div></button>';
    }).join('');
  }

  function openSheet(html) {
    document.getElementById('sheet').innerHTML = '<div class="sheet-handle"></div>' + html;
    document.getElementById('overlay').classList.remove('hidden');
  }
  function closeSheet() {
    sheetMode = null;
    document.getElementById('overlay').classList.add('hidden');
    document.getElementById('sheet').innerHTML = '';
  }

  function openChooser() {
    sheetMode = 'chooser';
    let items = sessions.map(s =>
      '<button type="button" class="chooser-item" data-act="choose" data-task="' + esc(s.taskId) + '">' +
      '<span>' + esc(s.name) + '</span><span class="sub">since ' + esc(fmtTime(s.checkIn)) + '</span></button>'
    ).join('');
    if (sessions.length > 1) {
      const label = sessions.length === 2 ? 'Both' : 'All';
      items += '<button type="button" class="chooser-item both" data-act="choose-all"><span>' + label + '</span><span class="sub">check out all</span></button>';
    }
    openSheet('<h3>Which task?</h3><div class="chooser-list">' + items + '</div>' +
      '<div class="sheet-actions"><button type="button" class="btn-cancel" data-act="close">Cancel</button></div>');
  }

  function openEditSession(taskId) {
    const s = sessionFor(taskId);
    if (!s) return;
    sheetMode = 'edit-session';
    openSheet(
      '<h3>Edit clock-in time</h3>' +
      '<div class="field"><label>Clock in</label><input type="time" id="sessTime" value="' + esc(fmtTime(s.checkIn)) + '"></div>' +
      '<div class="sheet-actions">' +
      '<button type="button" class="btn-primary" data-act="save-session" data-task="' + esc(taskId) + '">Save</button>' +
      '<button type="button" class="btn-cancel" data-act="close">Cancel</button></div>'
    );
  }

  function openRename(taskId) {
    sheetMode = 'rename';
    const cur = taskName(taskId);
    openSheet(
      '<h3>Rename</h3>' +
      '<div class="field"><label>Name</label><input type="text" id="renameInput" value="' + esc(cur) + '" maxlength="40"></div>' +
      '<div class="sheet-actions">' +
      '<button type="button" class="btn-primary" data-act="save-rename" data-task="' + esc(taskId) + '">Save</button>' +
      '<button type="button" class="btn-cancel" data-act="close">Cancel</button></div>'
    );
    setTimeout(() => { const el = document.getElementById('renameInput'); if (el) el.focus(); }, 50);
  }

  function handleAnotherTask() {
    const available = savedExtraNames.filter(n => {
      const t = tasks.find(x => x.id !== MAIN_ID && x.name.toLowerCase() === n.toLowerCase());
      return !t || !sessionFor(t.id);
    });
    if (savedExtraNames.length >= 2) {
      openStartTaskSheet();
      return;
    }
    if (savedExtraNames.length === 1 && available.length === 1) {
      startExtraByName(savedExtraNames[0]);
      return;
    }
    openNewTaskSheet();
  }

  function openStartTaskSheet() {
    sheetMode = 'start-task';
    const items = savedExtraNames.map(n =>
      '<button type="button" class="chooser-item" data-act="start-named" data-name="' + esc(n) + '"><span>' + esc(n) + '</span></button>'
    ).join('');
    openSheet(
      '<h3>Start a task</h3><div class="chooser-list">' + items +
      '<button type="button" class="chooser-item both" data-act="new-task"><span>New task</span></button></div>' +
      '<div class="sheet-actions" style="margin-top:12px"><button type="button" class="btn-cancel" data-act="close">Cancel</button></div>'
    );
  }

  function openNewTaskSheet() {
    sheetMode = 'new-task';
    const pre = lastExtraName || '';
    openSheet(
      '<h3>New task</h3>' +
      '<div class="field"><label>Name</label><input type="text" id="newTaskName" value="' + esc(pre) + '" maxlength="40"></div>' +
      '<div class="sheet-actions">' +
      '<button type="button" class="btn-primary" data-act="save-new-task">Save</button>' +
      '<button type="button" class="btn-cancel" data-act="close">Cancel</button></div>'
    );
    setTimeout(() => { const el = document.getElementById('newTaskName'); if (el) el.focus(); }, 50);
  }

  function startExtraByName(name) {
    const t = findOrCreateExtraTask(name);
    if (!t) return;
    closeSheet();
    checkInTask(t.id, t.name);
  }

  function openRecord(id) {
    const rec = records.find(r => r.id === id);
    if (!rec) return;
    if (isLockedDate(rec.date)) openLocked(rec);
    else openEditRecent(rec);
  }

  function openEditRecent(rec) {
    sheetMode = 'edit-recent';
    const overnight = isOvernightRec(rec);
    const taskOpts = tasks.map(t =>
      '<option value="' + esc(t.id) + '"' + (t.id === rec.taskId ? ' selected' : '') + '>' + esc(t.name) + '</option>'
    ).join('');
    openSheet(
      '<h3>Edit record</h3>' +
      '<div class="field"><label>Task</label><select id="edTask">' + taskOpts + '</select></div>' +
      '<div class="field"><label>Date</label><input type="date" id="edDate" value="' + esc(rec.date) + '"></div>' +
      '<div class="field"><label>Clock in</label><input type="time" id="edIn" value="' + esc(fmtTime(rec.checkIn)) + '"></div>' +
      '<div class="field"><label>Clock out</label><div class="field-row">' +
      '<input type="time" id="edOut" value="' + esc(fmtTime(rec.checkOut)) + '">' +
      '<span class="badge-nextday' + (overnight ? '' : ' hidden') + '" id="edPlus">+1 day</span></div></div>' +
      '<div class="computed"><span class="lbl">Hours</span><span class="val" id="edHours">' + effectiveHours(rec).toFixed(1) + ' h</span></div>' +
      '<div class="sheet-actions">' +
      '<button type="button" class="btn-primary" data-act="save-recent" data-id="' + esc(rec.id) + '">Save</button>' +
      '<button type="button" class="btn-cancel" data-act="close">Cancel</button>' +
      '<button type="button" class="btn-danger-text" data-act="delete-ask" data-id="' + esc(rec.id) + '">Delete</button></div>'
    );
    wireOvernightPreview();
  }

  function wireOvernightPreview() {
    const inEl = document.getElementById('edIn');
    const outEl = document.getElementById('edOut');
    const dateEl = document.getElementById('edDate');
    const plus = document.getElementById('edPlus');
    const hoursEl = document.getElementById('edHours');
    if (!inEl || !outEl) return;
    const upd = () => {
      const overnight = isOvernightTimes(inEl.value, outEl.value);
      if (plus) plus.classList.toggle('hidden', !overnight);
      if (dateEl && dateEl.value && inEl.value && outEl.value) {
        const { checkIn, checkOut } = buildCheckoutISO(dateEl.value, inEl.value, outEl.value);
        hoursEl.textContent = round2(hoursBetween(checkIn, checkOut)).toFixed(1) + ' h';
      }
    };
    inEl.oninput = outEl.oninput = dateEl.oninput = upd;
  }

  function openLocked(rec) {
    sheetMode = 'locked';
    const hasCorr = rec.correctedHours != null;
    openSheet(
      '<h3>Record <span style="font-size:13px;font-weight:500;color:var(--muted)">🔒</span></h3>' +
      '<div class="field"><label>Task</label><input class="readonly" disabled value="' + esc(rec.taskName) + '"></div>' +
      '<div class="field"><label>Date</label><input class="readonly" disabled value="' + esc(rec.date) + '"></div>' +
      '<div class="field"><label>Clock in</label><input class="readonly" disabled value="' + esc(fmtTime(rec.checkIn)) + '"></div>' +
      '<div class="field"><label>Clock out</label><input class="readonly" disabled value="' + esc(fmtTime(rec.checkOut)) + '"></div>' +
      '<div class="computed"><span class="lbl">Original hours</span><span class="val" style="font-weight:500;color:var(--muted);text-decoration:line-through">' + rec.hours.toFixed(1) + ' h</span></div>' +
      '<label class="check-row" data-act="toggle-na"><div class="check-box' + (hasCorr ? ' on' : '') + '" id="naBox">' + (hasCorr ? '✓' : '') + '</div><span>Not accurate</span></label>' +
      '<div class="field' + (hasCorr ? '' : ' hidden') + '" id="corrField"><label>Corrected total hours</label>' +
      '<input type="number" id="corrHours" step="0.1" min="0" inputmode="decimal" value="' + (hasCorr ? esc(String(rec.correctedHours)) : '') + '"></div>' +
      '<div class="timestamp' + (rec.correctedAt ? '' : ' hidden') + '" id="corrStamp">' + (rec.correctedAt ? esc(fmtCorrectedAt(rec.correctedAt)) : '') + '</div>' +
      '<div class="sheet-actions">' +
      '<button type="button" class="btn-primary" data-act="save-locked" data-id="' + esc(rec.id) + '">Save</button>' +
      '<button type="button" class="btn-cancel" data-act="close">Cancel</button></div>'
    );
  }

  function openAddMissed() {
    sheetMode = 'add-missed';
    const { min, max } = dateMinMax();
    const taskOpts = tasks.map(t =>
      '<option value="' + esc(t.id) + '"' + (t.id === MAIN_ID ? ' selected' : '') + '>' + esc(t.name) + '</option>'
    ).join('');
    openSheet(
      '<h3>Add missed shift</h3>' +
      '<div class="field"><label>Task</label><select id="amTask">' + taskOpts + '</select></div>' +
      '<div class="field"><label>Date</label><input type="date" id="amDate" min="' + min + '" max="' + max + '" value="' + max + '"></div>' +
      '<div class="field"><label>Clock in</label><input type="time" id="amIn" value="09:00"></div>' +
      '<div class="field"><label>Clock out</label><div class="field-row">' +
      '<input type="time" id="amOut" value="17:00">' +
      '<span class="badge-nextday hidden" id="amPlus">+1 day</span></div></div>' +
      '<div class="computed"><span class="lbl">Hours</span><span class="val" id="amHours">8.0 h</span></div>' +
      '<div class="sheet-actions">' +
      '<button type="button" class="btn-primary" data-act="save-missed">Save</button>' +
      '<button type="button" class="btn-cancel" data-act="close">Cancel</button></div>'
    );
    const upd = () => {
      const inV = document.getElementById('amIn').value;
      const outV = document.getElementById('amOut').value;
      const date = document.getElementById('amDate').value;
      document.getElementById('amPlus').classList.toggle('hidden', !isOvernightTimes(inV, outV));
      if (date && inV && outV) {
        const { checkIn, checkOut } = buildCheckoutISO(date, inV, outV);
        document.getElementById('amHours').textContent = round2(hoursBetween(checkIn, checkOut)).toFixed(1) + ' h';
      }
    };
    document.getElementById('amIn').oninput = document.getElementById('amOut').oninput = document.getElementById('amDate').oninput = upd;
  }

  function openDeleteConfirm(id) {
    sheetMode = 'delete';
    openSheet(
      '<h3>Delete record?</h3>' +
      '<div class="sheet-actions">' +
      '<button type="button" class="btn-primary" style="background:var(--danger)" data-act="delete-yes" data-id="' + esc(id) + '">Delete</button>' +
      '<button type="button" class="btn-cancel" data-act="close">Cancel</button></div>'
    );
  }

  function openExportPick() {
    sheetMode = 'export-pick';
    const ids = [];
    const seen = new Set();
    records.forEach(r => { if (!seen.has(r.taskId)) { seen.add(r.taskId); ids.push(r.taskId); } });
    if (!ids.includes(MAIN_ID)) ids.unshift(MAIN_ID);
    const items = ids.map(id => {
      const name = taskName(id);
      const n = records.filter(r => r.taskId === id).length;
      return '<button type="button" class="chooser-item" data-act="export-task" data-task="' + esc(id) + '">' +
        '<span>' + esc(name) + '</span><span class="sub">' + n + '</span></button>';
    }).join('');
    openSheet(
      '<h3>Export CSV</h3><div class="chooser-list">' + items + '</div>' +
      '<div class="sheet-actions"><button type="button" class="btn-cancel" data-act="close">Cancel</button></div>'
    );
  }

  function openExportActions(taskId) {
    sheetMode = 'export-actions';
    openSheet(
      '<h3>Export CSV</h3>' +
      '<div class="chooser-list">' +
      '<button type="button" class="chooser-item both" data-act="export-download" data-task="' + esc(taskId) + '"><span>Save to Downloads</span></button>' +
      '<button type="button" class="chooser-item" data-act="export-share" data-task="' + esc(taskId) + '"><span>Send to my manager</span></button>' +
      '</div>' +
      '<div class="sheet-actions" style="margin-top:12px"><button type="button" class="btn-cancel" data-act="close">Cancel</button></div>'
    );
  }

  function csvEscape(v) {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildTaskCSV(taskId) {
    const name = taskName(taskId);
    const header = ['Task', 'Date', 'Check In', 'Check Out', 'Hours', 'Corrected Hours', 'Corrected At'];
    const rows = [header];
    const list = records.filter(r => r.taskId === taskId).sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));
    let total = 0;
    list.forEach(r => {
      total += effectiveHours(r);
      rows.push([
        r.taskName,
        r.date,
        fmtTime(r.checkIn),
        fmtTime(r.checkOut),
        r.hours.toFixed(2),
        r.correctedHours != null ? Number(r.correctedHours).toFixed(2) : '',
        r.correctedAt || ''
      ]);
    });
    rows.push(['Total', '', '', '', round2(total).toFixed(2), '', '']);
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'task';
    return { csv, filename: 'clockinout-' + slug + '.csv', name };
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportDownload(taskId) {
    const { csv, filename } = buildTaskCSV(taskId);
    downloadBlob(new Blob([csv], { type: 'text/csv' }), filename);
    closeSheet();
  }

  function exportShare(taskId) {
    const { csv, filename, name } = buildTaskCSV(taskId);
    const blob = new Blob([csv], { type: 'text/csv' });
    const file = new File([blob], filename, { type: 'text/csv' });
    const nav = navigator;
    if (nav.share && nav.canShare && nav.canShare({ files: [file] })) {
      nav.share({ files: [file], title: name }).catch(() => downloadBlob(blob, filename));
    } else {
      downloadBlob(blob, filename);
    }
    closeSheet();
  }

  function parseCSV(text) {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim().length);
    if (!lines.length) return { header: [], rows: [] };
    const parseLine = line => {
      const out = []; let cur = ''; let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') q = false;
          else cur += c;
        } else {
          if (c === '"') q = true;
          else if (c === ',') { out.push(cur); cur = ''; }
          else cur += c;
        }
      }
      out.push(cur);
      return out;
    };
    const header = parseLine(lines[0]).map(h => h.trim());
    const rows = lines.slice(1).map(parseLine);
    return { header, rows };
  }

  function dupKey(rec) {
    return [rec.taskId, rec.date, fmtTime(rec.checkIn), fmtTime(rec.checkOut)].join('|');
  }

  function importCSVText(text) {
    const { header, rows } = parseCSV(text);
    if (!header.length) throw new Error('Empty CSV');
    const lower = header.map(h => h.toLowerCase());
    const isV1 = lower.includes('date') && lower.includes('check in') && lower.includes('check out') && !lower.includes('task');
    const isV2 = lower.includes('task') && lower.includes('date');
    if (!isV1 && !isV2) throw new Error('Unrecognised CSV');

    const idx = name => lower.indexOf(name);
    const pending = [];
    for (const row of rows) {
      if (!row.length || row.every(c => !String(c).trim())) continue;
      let taskNameVal, date, inT, outT, hours, corrH = null, corrAt = null, taskId;
      if (isV1) {
        date = row[idx('date')]?.trim();
        inT = row[idx('check in')]?.trim();
        outT = row[idx('check out')]?.trim();
        hours = parseFloat(row[idx('hours')]);
        taskNameVal = MAIN_NAME;
        taskId = MAIN_ID;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (!inT || !outT || isNaN(hours)) throw new Error('Invalid row');
      } else {
        taskNameVal = (row[idx('task')] || '').trim();
        if (/^(total|subtotal)$/i.test(taskNameVal)) continue;
        date = (row[idx('date')] || '').trim();
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        inT = row[idx('check in')]?.trim();
        outT = row[idx('check out')]?.trim();
        hours = parseFloat(row[idx('hours')]);
        if (!inT || !outT || isNaN(hours)) throw new Error('Invalid row');
        const ci = idx('corrected hours');
        const ca = idx('corrected at');
        if (ci >= 0 && row[ci] && String(row[ci]).trim() !== '') corrH = parseFloat(row[ci]);
        if (ca >= 0 && row[ca] && String(row[ca]).trim() !== '') corrAt = String(row[ca]).trim();
        if (!taskNameVal) taskNameVal = MAIN_NAME;
        const existing = tasks.find(t => t.name.toLowerCase() === taskNameVal.toLowerCase());
        if (existing) taskId = existing.id;
        else if (taskNameVal === MAIN_NAME) taskId = MAIN_ID;
        else taskId = 't-' + taskNameVal.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Math.random().toString(36).slice(2, 5);
      }
      const { checkIn, checkOut } = buildCheckoutISO(date, inT, outT);
      pending.push({
        id: uid(),
        taskId, taskName: taskNameVal,
        date,
        checkIn: checkIn.toISOString(),
        checkOut: checkOut.toISOString(),
        hours: round2(hours),
        correctedHours: (corrH != null && !isNaN(corrH)) ? round2(corrH) : null,
        correctedAt: corrAt
      });
    }

    const existing = new Set(records.map(dupKey));
    let added = 0, skipped = 0;
    for (const p of pending) {
      if (existing.has(dupKey(p))) { skipped++; continue; }
      if (!tasks.find(t => t.id === p.taskId)) {
        tasks.push({ id: p.taskId, name: p.taskName, isMain: p.taskId === MAIN_ID });
      }
      if (p.taskId !== MAIN_ID) rememberExtraName(p.taskName);
      records.push(p);
      existing.add(dupKey(p));
      added++;
    }
    save();
    render();
    toast('Imported ' + added + (skipped ? ', skipped ' + skipped : ''));
    return { added, skipped };
  }

  // ----- help / teams / news -----
  let deferredInstall = null;
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
  }
  function updateInstallBtn() {
    const btn = document.getElementById('installAppBtn');
    if (!btn) return;
    const show = !isStandalone() && !!deferredInstall;
    btn.classList.toggle('hidden', !show);
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstall = e;
    updateInstallBtn();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    updateInstallBtn();
  });

  function openHelp() {
    document.getElementById('helpBtn').classList.add('on');
    document.getElementById('helpOverlay').classList.remove('hidden');
    updateInstallBtn();
  }
  function closeHelp() {
    document.getElementById('helpBtn').classList.remove('on');
    document.getElementById('helpOverlay').classList.add('hidden');
  }

  let teamsThanksTimer = null;
  function clearTeamsThanksTimer() {
    if (teamsThanksTimer) { clearTimeout(teamsThanksTimer); teamsThanksTimer = null; }
  }

  function resetTeamsForm() {
    teamsQ1 = '';
    teamsQ2 = '';
    document.querySelectorAll('#q1seg .seg-opt').forEach(b => b.classList.remove('on'));
    document.querySelectorAll('#q2choices .choice').forEach(b => b.classList.remove('on'));
    const t = document.getElementById('q3text'); if (t) t.value = '';
    const e = document.getElementById('q4email'); if (e) e.value = '';
    const q1 = document.querySelector('#teamsSheet .q'); if (q1) q1.classList.remove('invalid');
    document.getElementById('teamsSend').classList.remove('hidden');
    document.getElementById('teamsThanks').classList.add('hidden');
  }

  function openTeams() {
    clearTeamsThanksTimer();
    resetTeamsForm();
    document.getElementById('teamsBtn').classList.add('on');
    document.getElementById('teamsOverlay').classList.remove('hidden');
    document.getElementById('teamsSheet').scrollTop = 0;
    closeLightbox();
  }
  function closeTeams() {
    clearTeamsThanksTimer();
    document.getElementById('teamsBtn').classList.remove('on');
    document.getElementById('teamsOverlay').classList.add('hidden');
    closeLightbox();
  }
  function openLightbox(src) {
    document.getElementById('lightboxImg').src = src;
    document.getElementById('lightbox').classList.remove('hidden');
  }
  function closeLightbox() {
    document.getElementById('lightbox').classList.add('hidden');
    document.getElementById('lightboxImg').removeAttribute('src');
  }

  function validEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  function buildFormPayload() {
    const params = new URLSearchParams();
    params.set(FORM_ENTRIES.q1, teamsQ1);
    if (teamsQ2 && PRICE_OPTS.includes(teamsQ2)) params.set(FORM_ENTRIES.q2, teamsQ2);
    const q3 = (document.getElementById('q3text').value || '').trim();
    const q4 = (document.getElementById('q4email').value || '').trim();
    if (q3) params.set(FORM_ENTRIES.q3, q3);
    if (q4) params.set(FORM_ENTRIES.q4, q4);
    return { params, q3, q4 };
  }

  function submitTeamsFeedback() {
    const q1box = document.querySelector('#teamsSheet .q');
    if (teamsQ1 !== 'Yes' && teamsQ1 !== 'No') {
      if (q1box) q1box.classList.add('invalid');
      return { ok: false, reason: 'q1' };
    }
    if (q1box) q1box.classList.remove('invalid');
    const { params, q4 } = buildFormPayload();
    if (q4 && !validEmail(q4)) { toast('Enter a valid email'); return { ok: false, reason: 'email' }; }

    const body = params.toString();
    return fetch(FORM_URL, { method: 'POST', mode: 'no-cors', body: params, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      .then(() => {
        setStore(KEYS.feedbackSent, { at: new Date().toISOString() });
        document.getElementById('teamsSend').classList.add('hidden');
        document.getElementById('teamsThanks').classList.remove('hidden');
        document.getElementById('teamsSheet').scrollTop = document.getElementById('teamsSheet').scrollHeight;
        clearTeamsThanksTimer();
        teamsThanksTimer = setTimeout(() => {
          teamsThanksTimer = null;
          closeTeams();
          resetTeamsForm();
        }, 1500);
        return { ok: true, body };
      })
      .catch(() => {
        toast("Couldn't send. Try again later.");
        return { ok: false, reason: 'offline' };
      });
  }

  function fetchNews() {
    fetch('./news.json', { cache: 'no-store' }).then(r => {
      if (!r.ok) return;
      return r.json();
    }).then(data => {
      if (!data || !Array.isArray(data.messages)) return;
      const seen = getStore(KEYS.newsSeen) || [];
      newsQueue = data.messages.filter(m => m && m.id && !seen.includes(m.id));
      showNextNews();
    }).catch(() => {});
  }

  function showNextNews() {
    if (!newsQueue.length) {
      document.getElementById('newsOverlay').classList.add('hidden');
      return;
    }
    const m = newsQueue[0];
    document.getElementById('newsTitle').textContent = m.title || '';
    document.getElementById('newsBody').textContent = m.body || '';
    document.getElementById('newsOverlay').classList.remove('hidden');
  }

  function dismissNews() {
    if (!newsQueue.length) return;
    const m = newsQueue.shift();
    const seen = getStore(KEYS.newsSeen) || [];
    if (m && m.id && !seen.includes(m.id)) {
      seen.push(m.id);
      setStore(KEYS.newsSeen, seen);
    }
    showNextNews();
  }

  // ----- events -----
  document.getElementById('anotherTaskBtn').onclick = handleAnotherTask;
  document.getElementById('exportBtn').onclick = openExportPick;
  document.getElementById('addMissedBtn').onclick = openAddMissed;
  document.getElementById('backdrop').onclick = closeSheet;
  document.getElementById('helpBtn').onclick = openHelp;
  document.getElementById('helpBackdrop').onclick = closeHelp;
  document.getElementById('installAppBtn').onclick = () => {
    if (!deferredInstall || typeof deferredInstall.prompt !== 'function') return;
    deferredInstall.prompt();
    deferredInstall = null;
    updateInstallBtn();
  };
  document.getElementById('teamsBtn').onclick = openTeams;
  document.getElementById('teamsClose').onclick = closeTeams;
  document.getElementById('teamsBackdrop').onclick = () => { if (document.getElementById('lightbox').classList.contains('hidden')) closeTeams(); };
  document.getElementById('lightboxClose').onclick = closeLightbox;
  document.getElementById('lightbox').onclick = e => { if (e.target.id === 'lightbox') closeLightbox(); };
  document.getElementById('teamsSend').onclick = () => { submitTeamsFeedback(); };
  document.getElementById('newsOk').onclick = dismissNews;
  document.getElementById('newsBackdrop').onclick = dismissNews;

  document.body.addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');

    if (act === 'checkin-main') { checkInTask(MAIN_ID, MAIN_NAME); return; }
    if (act === 'checkout-main') {
      if (sessions.length > 1) openChooser();
      else if (mainSession()) checkOutTask(MAIN_ID, { animate: true });
      else if (sessions.length === 1) checkOutTask(sessions[0].taskId, { animate: true });
      return;
    }
    if (act === 'checkout-one') { checkOutTask(btn.getAttribute('data-task'), { animate: true }); return; }
    if (act === 'edit-session') { openEditSession(btn.getAttribute('data-task')); return; }
    if (act === 'rename') { openRename(btn.getAttribute('data-task')); return; }
    if (act === 'open-rec') { openRecord(btn.getAttribute('data-id')); return; }
    if (act === 'close') { closeSheet(); return; }
    if (act === 'choose') { checkOutTask(btn.getAttribute('data-task'), { animate: true }); closeSheet(); return; }
    if (act === 'choose-all') { checkOutAll({ animate: true }); closeSheet(); return; }
    if (act === 'start-named') { startExtraByName(btn.getAttribute('data-name')); return; }
    if (act === 'new-task') { openNewTaskSheet(); return; }
    if (act === 'save-new-task') {
      const name = (document.getElementById('newTaskName').value || '').trim();
      if (!name) return;
      startExtraByName(name);
      return;
    }
    if (act === 'save-rename') {
      const tid = btn.getAttribute('data-task');
      const name = (document.getElementById('renameInput').value || '').trim();
      if (!name) return;
      renameTask(tid, name);
      closeSheet();
      return;
    }
    if (act === 'save-session') {
      const tid = btn.getAttribute('data-task');
      const s = sessionFor(tid);
      const time = document.getElementById('sessTime').value;
      if (!s || !time) return;
      const day = localDateStr(new Date(s.checkIn));
      const next = combineLocal(day, time);
      if (next > new Date()) { toast('Cannot be in the future'); return; }
      s.checkIn = next.toISOString();
      save(); closeSheet(); render();
      return;
    }
    if (act === 'save-recent') {
      const id = btn.getAttribute('data-id');
      const rec = records.find(r => r.id === id);
      if (!rec) return;
      const taskId = document.getElementById('edTask').value;
      const date = document.getElementById('edDate').value;
      const inV = document.getElementById('edIn').value;
      const outV = document.getElementById('edOut').value;
      if (!date || !inV || !outV) return;
      const t = tasks.find(x => x.id === taskId);
      const { checkIn, checkOut } = buildCheckoutISO(date, inV, outV);
      rec.taskId = taskId;
      rec.taskName = t ? t.name : taskName(taskId);
      rec.date = date;
      rec.checkIn = checkIn.toISOString();
      rec.checkOut = checkOut.toISOString();
      rec.hours = round2(hoursBetween(checkIn, checkOut));
      rec.correctedHours = null;
      rec.correctedAt = null;
      save(); closeSheet(); render();
      return;
    }
    if (act === 'delete-ask') { openDeleteConfirm(btn.getAttribute('data-id')); return; }
    if (act === 'delete-yes') {
      const id = btn.getAttribute('data-id');
      records = records.filter(r => r.id !== id);
      save(); closeSheet(); render();
      return;
    }
    if (act === 'toggle-na') {
      const box = document.getElementById('naBox');
      const on = !box.classList.contains('on');
      box.classList.toggle('on', on);
      box.textContent = on ? '✓' : '';
      document.getElementById('corrField').classList.toggle('hidden', !on);
      return;
    }
    if (act === 'save-locked') {
      const id = btn.getAttribute('data-id');
      const rec = records.find(r => r.id === id);
      if (!rec) return;
      const on = document.getElementById('naBox').classList.contains('on');
      if (!on) {
        rec.correctedHours = null;
        rec.correctedAt = null;
      } else {
        const v = parseFloat(document.getElementById('corrHours').value);
        if (isNaN(v) || v < 0) { toast('Enter corrected hours'); return; }
        rec.correctedHours = round2(v);
        rec.correctedAt = new Date().toISOString();
      }
      save(); closeSheet(); render();
      return;
    }
    if (act === 'save-missed') {
      const taskId = document.getElementById('amTask').value;
      const date = document.getElementById('amDate').value;
      const inV = document.getElementById('amIn').value;
      const outV = document.getElementById('amOut').value;
      const { min, max } = dateMinMax();
      if (!date || date < min || date > max) { toast('Date must be within 7 days'); return; }
      if (!inV || !outV) return;
      const t = tasks.find(x => x.id === taskId);
      const { checkIn, checkOut } = buildCheckoutISO(date, inV, outV);
      if (taskId !== MAIN_ID && t) rememberExtraName(t.name);
      records.unshift({
        id: uid(),
        taskId,
        taskName: t ? t.name : taskName(taskId),
        date,
        checkIn: checkIn.toISOString(),
        checkOut: checkOut.toISOString(),
        hours: round2(hoursBetween(checkIn, checkOut)),
        correctedHours: null,
        correctedAt: null
      });
      save(); closeSheet(); render();
      return;
    }
    if (act === 'export-task') { openExportActions(btn.getAttribute('data-task')); return; }
    if (act === 'export-download') { exportDownload(btn.getAttribute('data-task')); return; }
    if (act === 'export-share') { exportShare(btn.getAttribute('data-task')); return; }
    if (act === 'zoom-thumb') { openLightbox(btn.getAttribute('data-src')); return; }
    if (act === 'q1') {
      teamsQ1 = btn.getAttribute('data-val');
      document.querySelectorAll('#q1seg .seg-opt').forEach(b => b.classList.toggle('on', b === btn));
      const q1 = document.querySelector('#teamsSheet .q');
      if (q1) q1.classList.remove('invalid');
      return;
    }
    if (act === 'q2') {
      const val = btn.getAttribute('data-val');
      teamsQ2 = (teamsQ2 === val) ? '' : val;
      document.querySelectorAll('#q2choices .choice').forEach(b => b.classList.toggle('on', b.getAttribute('data-val') === teamsQ2));
      return;
    }
  });

  window.ClockInOut = {
    KEYS, OLD, MAIN_ID, MAIN_NAME, FORM_URL, FORM_ENTRIES,
    getState: () => ({ records, sessions, tasks, savedExtraNames, lastExtraName, teamsQ1, teamsQ2 }),
    setState: (s) => {
      if (s.records !== undefined) records = s.records;
      if (s.sessions !== undefined) sessions = s.sessions;
      if (s.tasks !== undefined) tasks = s.tasks;
      if (s.savedExtraNames !== undefined) savedExtraNames = s.savedExtraNames;
      if (s.lastExtraName != null) lastExtraName = s.lastExtraName;
      save(); render();
    },
    checkInTask, checkOutTask, checkOutAll, renameTask, handleAnotherTask,
    startExtraByName, findOrCreateExtraTask, rememberExtraName,
    importCSVText, buildTaskCSV, exportDownload, exportShare, openExportPick,
    computeTotals, startOfWeekMon, endOfWeekSun,
    isLockedDate, dateMinMax, buildCheckoutISO, hoursBetween, effectiveHours,
    dupKey, render, load, save, localDateStr, fmtTime, fmtTimeSec, round2,
    openChooser, openAddMissed, openRecord, closeSheet,
    openHelp, closeHelp, openTeams, closeTeams, openLightbox, closeLightbox,
    updateInstallBtn, isStandalone,
    submitTeamsFeedback, buildFormPayload, fetchNews, dismissNews, showNextNews,
    validEmail
  };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  load();
})();
