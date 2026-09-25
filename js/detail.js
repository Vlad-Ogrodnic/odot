// Task detail sheet, opened by tapping a task's text: title, notes, due
// date/time, info, delete. Every change saves as it's made (no Cancel);
// the list behind re-renders when the sheet closes.
//
// Classic script, not a module: see the note in index.html.

const detailOverlayEl = document.getElementById('detailOverlay');
const detailSheetEl   = document.getElementById('detailSheet');
const detailHandleEl  = document.getElementById('detailHandle');
const detailBodyEl    = document.getElementById('detailBody');
const detailTitleEl   = document.getElementById('detailTitle');
const detailNotesEl   = document.getElementById('detailNotes');

const SHEET_EASE         = 'cubic-bezier(0.2, 0.8, 0.2, 1)'; // same landing feel as the swipe back
const SHEET_MIN_MS       = 150; // close/snap-back duration bounds; within them it follows the finger's speed
const SHEET_MAX_MS       = 280;
const SHEET_DISMISS_PART = 0.25; // drag down at least this fraction of the sheet's height to dismiss...
const SHEET_FLICK        = 0.5;  // ...or release moving down at least this fast (px/ms)
const SHEET_SAMPLE_MS    = 100;  // window of recent finger positions used to measure release velocity

let detailId      = null;  // id of the task being shown, or null when the sheet is closed
let detailClosing = false; // true during the close animation
let sheetDrag     = null;  // an in-progress drag of the sheet by its handle

function detailTask() {
  return detailId === null ? null : tasks.find(t => t.id === detailId) || null;
}

// ── Open / close ───────────────────────────────────────────────────────
function openDetail(id) {
  const task = tasks.find(t => t.id === id);
  if (!task || detailId !== null) return;
  detailId = id;

  detailTitleEl.value = task.text;
  detailNotesEl.value = task.notes || '';
  renderDetailDue();
  renderDetailInfo();

  resetSheetStyles();
  detailOverlayEl.classList.add('visible');
  lockPageScroll(); // see js/settings.js — nothing behind the sheet scrolls while it's up
  detailBodyEl.scrollTop = 0;
  // Only measurable once visible (a display:none textarea has no height).
  autosize(detailTitleEl);
  autosize(detailNotesEl);
}

// `velocity` (px/ms, downward) lets a flick-to-dismiss carry on at the
// finger's speed; a tap on Done or the backdrop starts from rest.
function closeDetail(velocity = 0) {
  if (detailId === null || detailClosing) return;
  detailClosing = true;
  // Dismisses the keyboard, and lets an emptied title revert (onDetailTitleBlur).
  if (detailSheetEl.contains(document.activeElement)) document.activeElement.blur();
  render(); // the list behind picks up everything changed in here

  const height   = detailSheetEl.offsetHeight;
  const current  = sheetOffset();
  const speed    = Math.max(velocity, 1.2);
  const ms       = Math.round(Math.min(SHEET_MAX_MS, Math.max(SHEET_MIN_MS, (height - current) / speed)));

  void detailSheetEl.offsetWidth; // commit the start position so the transition has something to animate from
  detailSheetEl.style.transition   = `transform ${ms}ms ${SHEET_EASE}`;
  detailSheetEl.style.transform    = `translateY(${height}px)`;
  detailOverlayEl.style.transition = `background-color ${ms}ms ${SHEET_EASE}`;
  detailOverlayEl.style.backgroundColor = 'rgba(0, 0, 0, 0)';

  // A timeout, not transitionend — same reasoning as the other settles here.
  setTimeout(() => {
    detailOverlayEl.classList.remove('visible');
    resetSheetStyles();
    unlockPageScroll(); // only now: the page must not jump while the sheet is still sliding off it
    detailId = null;
    detailClosing = false;
  }, ms);
}

function resetSheetStyles() {
  detailSheetEl.style.transition   = '';
  detailSheetEl.style.transform    = '';
  detailOverlayEl.style.transition = '';
  detailOverlayEl.style.backgroundColor = '';
}

// How far the sheet is currently dragged down, from its inline transform.
function sheetOffset() {
  const m = /translateY\(([-\d.]+)px\)/.exec(detailSheetEl.style.transform);
  return m ? Number(m[1]) : 0;
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

// ── Title & notes ──────────────────────────────────────────────────────
function onDetailTitleInput() {
  // Titles are one line; a pasted multi-line text becomes one line.
  if (detailTitleEl.value.includes('\n')) {
    detailTitleEl.value = detailTitleEl.value.replace(/\s*\n\s*/g, ' ');
  }
  autosize(detailTitleEl);
  const task = detailTask();
  const text = detailTitleEl.value.trim();
  if (task && text) {
    task.text = text;
    save();
  }
}

// Return finishes editing the title instead of inserting a line break.
function onDetailTitleKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    detailTitleEl.blur();
  }
}

// A task can't be left without a title: an emptied one snaps back to the
// last saved text once editing ends (nothing empty was ever saved).
function onDetailTitleBlur() {
  const task = detailTask();
  if (task && !detailTitleEl.value.trim()) {
    detailTitleEl.value = task.text;
    autosize(detailTitleEl);
  }
}

function onDetailNotesInput() {
  autosize(detailNotesEl);
  const task = detailTask();
  if (!task) return;
  if (detailNotesEl.value.trim()) task.notes = detailNotesEl.value;
  else delete task.notes; // whitespace-only counts as no notes (and no notes icon in the list)
  save();
}

// ── Due date & time ────────────────────────────────────────────────────
// Stored as local "YYYY-MM-DD" / "HH:MM" strings — see parseDueDate in
// js/render.js for why. A time only ever exists alongside a date.
function setDetailHasDate(on) {
  const task = detailTask();
  if (!task) return;
  if (on) {
    task.dueDate = toDueDateString(new Date()); // starts on today, like Reminders
  } else {
    delete task.dueDate;
    delete task.dueTime;
  }
  save();
  renderDetailDue();
}

function setDetailDate(value) {
  const task = detailTask();
  if (!task) return;
  if (parseDueDate(value)) {
    task.dueDate = value;
  } else {
    // The native picker's own Clear/Reset leaves an empty value.
    delete task.dueDate;
    delete task.dueTime;
  }
  save();
  renderDetailDue();
}

function setDetailHasTime(on) {
  const task = detailTask();
  if (!task || !task.dueDate) return;
  if (on) {
    // The next full hour, like Reminders — a sensible start to adjust from.
    task.dueTime = `${pad2(Math.min(23, new Date().getHours() + 1))}:00`;
  } else {
    delete task.dueTime;
  }
  save();
  renderDetailDue();
}

function setDetailTime(value) {
  const task = detailTask();
  if (!task) return;
  if (DUE_TIME_RE.test(value)) task.dueTime = value;
  else delete task.dueTime;
  save();
  renderDetailDue();
}

// Shows/hides the pickers to match the task's current due date/time.
function renderDetailDue() {
  const task    = detailTask();
  const due     = task ? parseDueDate(task.dueDate) : null;
  const hasTime = !!due && DUE_TIME_RE.test(task.dueTime || '');

  document.getElementById('detailDateSwitch').checked = !!due;
  document.getElementById('detailDateRow').hidden     = !due;
  document.getElementById('detailTimeToggle').hidden  = !due;
  document.getElementById('detailTimeSwitch').checked = hasTime;
  document.getElementById('detailTimeRow').hidden     = !hasTime;

  if (due) {
    document.getElementById('detailDate').value = task.dueDate;
    document.getElementById('detailDateHint').textContent = relativeDayHint(due);
  }
  if (hasTime) document.getElementById('detailTime').value = task.dueTime;
}

// Next to the picker (which shows the date in the phone's own format):
// how far away that is — "Today", "Friday, in 4 days", "Monday, 2 days ago".
function relativeDayHint(due) {
  const days = calendarDayDiff(new Date(), due);
  if (days === 0)  return 'Today';
  if (days === 1)  return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  const weekday = WEEKDAYS[due.getDay()];
  return days > 0 ? `${weekday}, in ${days} days` : `${weekday}, ${-days} days ago`;
}

// ── Info & delete ──────────────────────────────────────────────────────
function renderDetailInfo() {
  const task = detailTask();
  if (!task) return;
  const cat   = categories.find(c => c.id === (task.categoryId ?? null));
  const lines = [
    cat ? `In <span style="color:${catColorVar(cat)}">${escHtml(cat.name)}</span>` : 'No category',
  ];
  const created = formatDateTime(task.createdAt);
  if (created) lines.push(`Created ${created}`);
  const completed = task.done && task.completedAt ? formatDateTime(task.completedAt) : '';
  if (completed) lines.push(`Completed ${completed}`);
  document.getElementById('detailInfo').innerHTML = lines.map(l => `<div>${l}</div>`).join('');
}

function deleteFromDetail() {
  if (detailId === null || detailClosing) return;
  // Asked first — unlike the list's swipe (which already takes two steps:
  // swipe, then tap the revealed button), this is a single tap.
  if (!confirm('Delete this task?')) return;
  const id = detailId;
  closeDetail();
  deleteTask(id);
}

// ── Drag down to dismiss ───────────────────────────────────────────────
// From anywhere on the sheet, as with iOS's own sheets — not just the strip
// at the top, which is a stretch for a thumb. A touch that starts moving
// down while the sheet's content is scrolled to the top drags the sheet;
// anything else (content scrolled down, moving up, sideways) is left as a
// normal scroll of that content. The top strip (grabber + Done) is
// touch-action:none and drags straight away, with no need to decide.
// Not from a field that's being typed in: a drag there moves the cursor.
const SHEET_ARM = 6; // px of movement before deciding what a touch on the body is

detailSheetEl.addEventListener('pointerdown', e => {
  if (detailId === null || detailClosing || sheetDrag) return;
  if (e.target.closest('button')) return;
  const field = e.target.closest('input, textarea');
  if (field && field === document.activeElement) return;
  sheetDrag = {
    pointerId: e.pointerId,
    startX:    e.clientX,
    startY:    e.clientY,
    height:    detailSheetEl.offsetHeight,
    active:    false,
    samples:   [{ t: e.timeStamp, y: e.clientY }],
  };
  if (detailHandleEl.contains(e.target)) beginSheetDrag(e);
});

function beginSheetDrag(e) {
  const d = sheetDrag;
  d.active = true;
  d.startY = e.clientY; // measured from here, so the sheet doesn't jump by the arming distance
  detailSheetEl.setPointerCapture(e.pointerId);
  detailSheetEl.style.transition   = 'none';
  detailOverlayEl.style.transition = 'none';
  if (detailSheetEl.contains(document.activeElement)) document.activeElement.blur(); // keyboard away, as iOS does
}

// A drag that ended on a switch's label (or anything clickable) mustn't
// also count as a tap on it.
let sheetClickGuardUntil = 0;
detailSheetEl.addEventListener('click', e => {
  if (performance.now() < sheetClickGuardUntil) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

detailSheetEl.addEventListener('pointermove', e => {
  const d = sheetDrag;
  if (!d || e.pointerId !== d.pointerId) return;

  if (!d.active) {
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) < SHEET_ARM && Math.abs(dy) < SHEET_ARM) return;
    if (dy > 0 && dy > Math.abs(dx) && detailBodyEl.scrollTop <= 0) {
      beginSheetDrag(e);
    } else {
      sheetDrag = null; // scrolling the sheet's content — native, not ours
      return;
    }
  }

  const dy = Math.max(0, e.clientY - d.startY); // down only; the sheet is already fully open
  detailSheetEl.style.transform = `translateY(${dy}px)`;
  // The backdrop lightens as the sheet goes, reaching clear at the bottom.
  detailOverlayEl.style.backgroundColor = `rgba(0, 0, 0, ${0.5 * (1 - dy / d.height)})`;
  d.samples.push({ t: e.timeStamp, y: e.clientY });
  while (d.samples.length > 2 && e.timeStamp - d.samples[0].t > SHEET_SAMPLE_MS) d.samples.shift();
});

function endSheetDrag(e) {
  const d = sheetDrag;
  if (!d || e.pointerId !== d.pointerId) return;
  sheetDrag = null;
  if (!d.active) return; // a tap — leave it to the click

  sheetClickGuardUntil = performance.now() + 250;

  const dy     = sheetOffset();
  const recent = d.samples.filter(p => e.timeStamp - p.t <= SHEET_SAMPLE_MS);
  const v      = recent.length >= 2
    ? (recent[recent.length - 1].y - recent[0].y) / Math.max(1, recent[recent.length - 1].t - recent[0].t)
    : 0;

  if (e.type !== 'pointercancel' && (v > SHEET_FLICK || (v > -SHEET_FLICK && dy > d.height * SHEET_DISMISS_PART))) {
    closeDetail(v);
    return;
  }

  // Not far/fast enough: spring back up.
  const ms = Math.round(Math.min(SHEET_MAX_MS, Math.max(SHEET_MIN_MS, dy / Math.max(Math.abs(v), 1.2))));
  detailSheetEl.style.transition   = `transform ${ms}ms ${SHEET_EASE}`;
  detailSheetEl.style.transform    = 'translateY(0px)';
  detailOverlayEl.style.transition = `background-color ${ms}ms ${SHEET_EASE}`;
  detailOverlayEl.style.backgroundColor = '';
}

detailSheetEl.addEventListener('pointerup', endSheetDrag);
detailSheetEl.addEventListener('pointercancel', endSheetDrag);
