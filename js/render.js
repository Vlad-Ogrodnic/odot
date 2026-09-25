// Filtering and rendering the current view, plus small HTML helpers.
//
// Classic script, not a module: see the note in index.html.

// ── Filter ─────────────────────────────────────────────────────────────
function setFilter(f, btn) {
  filter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  render();
}

function setDoneWindow(w) {
  doneWindow = w;
  render();
}

// A task with no completedAt (done before this existed) falls back to
// createdAt, so it still lands somewhere sensible instead of never
// matching a window.
function isWithinWindow(task, window) {
  if (window === 'all') return true;
  const ts = new Date(task.completedAt || task.createdAt).getTime();
  if (Number.isNaN(ts)) return true;
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  if (window === 'today') return new Date(ts).toDateString() === new Date(now).toDateString();
  if (window === 'week')  return now - ts < 7 * DAY;
  if (window === 'month') return now - ts < 30 * DAY;
  return true;
}

function renderDoneWindowChips() {
  if (filter !== 'done') return '';
  const options = [['today', 'Today'], ['week', 'Last week'], ['month', 'Last month'], ['all', 'All time']];
  const chips = options
    .map(([val, label]) => `<button class="window-btn ${doneWindow === val ? 'active' : ''}" onclick="setDoneWindow('${val}')">${label}</button>`)
    .join('');
  return `<div class="window-chips">${chips}</div>`;
}

// ── Render ─────────────────────────────────────────────────────────────
// `root` is the live page by default; swiping back also renders the parent
// level into a detached copy of it (see beginNavTransition), which is why
// elements are looked up within root rather than by document-wide id.
function render(root = document) {
  const $ = id => root.querySelector('#' + id);
  const listEl      = $('taskList');
  const countEl     = $('taskCount');

  // Any open swipe or in-progress drag is visually reset by a fresh render.
  openSwipeId = null;

  // Title area (root heading, or back/name/options when inside a category),
  // the child-category chip row, and the Done-only time-window row.
  const titleGroupEl = $('titleGroup');
  titleGroupEl.innerHTML = renderTitleGroup();
  titleGroupEl.dataset.categoryDrop = currentCategoryId === null ? '' : String(currentCategoryId);
  $('categoryChips').innerHTML = renderCategoryChips();
  $('doneWindowChips').innerHTML = renderDoneWindowChips();
  // The quiet "back up soon" dot on the settings gear (see js/settings.js).
  root.querySelector('.settings-btn').classList.toggle('backup-due', isBackupDue());

  // A category view includes tasks filed directly in it AND anywhere in its
  // subtree — so "Done" under "Work" also shows done tasks from "Work/Client
  // A", instead of only tasks filed in "Work" itself. At root this means
  // every task in the app — unless the "Show all tasks on main screen"
  // setting is off, in which case root shows only uncategorized tasks.
  const inScope = (currentCategoryId === null && !settings.rootShowsAll)
    ? new Set([null])
    : new Set([currentCategoryId, ...getDescendantIds(currentCategoryId)]);
  const categoryTasks = tasks.filter(t => inScope.has(t.categoryId ?? null));
  const total       = categoryTasks.length;
  const doneCount   = categoryTasks.filter(t => t.done).length;
  const activeCount = total - doneCount;

  // Update count label
  if (total === 0) {
    countEl.textContent = 'No tasks yet';
  } else {
    countEl.textContent = `${activeCount} remaining · ${doneCount} done`;
  }

  // Further filter by status tab (and, in Done, the time window) on top of
  // the category scope above
  const visible = categoryTasks.filter(t => {
    if (filter === 'active') return !t.done;
    if (filter === 'done')   return  t.done && isWithinWindow(t, doneWindow);
    return true;
  });

  // Empty state
  if (visible.length === 0) {
    const msgs = {
      all:    { icon: '📝', title: 'Nothing here yet',     sub: 'Type a task above and tap Add' },
      active: { icon: '✅', title: 'All caught up!',       sub: 'No active tasks remaining'     },
      done:   doneWindow === 'all'
        ? { icon: '🎯', title: 'Nothing completed yet', sub: 'Finish a task to see it here' }
        : { icon: '🎯', title: 'Nothing here',          sub: 'No tasks completed in this time range' },
    };
    // Main screen filtered down to uncategorized tasks, and there are none:
    // say why it's empty, instead of "nothing here yet" while the user
    // knows full well they have tasks.
    const m = (total === 0 && currentCategoryId === null && !settings.rootShowsAll && tasks.length > 0)
      ? { icon: '🗂', title: 'No uncategorized tasks', sub: 'Tasks in categories are hidden here — see Settings' }
      : msgs[filter];
    listEl.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">${m.icon}</span>
        <div class="empty-title">${m.title}</div>
        <div class="empty-sub">${m.sub}</div>
      </div>`;
    return;
  }

  // Task items
  listEl.innerHTML = visible.map((task, index) => `
    <div class="task-item-wrapper" id="task-${task.id}" data-id="${task.id}">
      <div class="delete-reveal" onclick="deleteTask(${task.id})" aria-label="Delete task">
        <svg class="icon delete-reveal-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 6h18"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          <path d="M10 11v6"/>
          <path d="M14 11v6"/>
        </svg>
      </div>
      <div class="task-row">
        <div class="task-number">${index + 1}</div>
        <div class="check-circle ${task.done ? 'done' : ''}"
             onclick="toggleTask(${task.id})"
             role="checkbox"
             aria-checked="${task.done}"
             aria-label="Mark complete">
          <span class="checkmark">✓</span>
        </div>
        <div class="task-main" onclick="openDetail(${task.id})">
          <div class="task-text ${task.done ? 'done' : ''}">${escHtml(task.text)}</div>
          ${renderTaskMeta(task)}
        </div>
        ${renderCategoryLabel(task)}
      </div>
    </div>
  `).join('');
}

function renderTitleGroup() {
  if (currentCategoryId === null) {
    return `<h1 class="app-title">Tasks v22</h1>`;
  }
  const cat   = categories.find(c => c.id === currentCategoryId);
  const name  = cat ? escHtml(cat.name) : 'Category';
  const color = catColorVar(cat);
  return `
    <button class="back-btn" onclick="navigateUp()" aria-label="Back">‹</button>
    <h1 class="category-title" style="color:${color}">${name}</h1>
    <button class="more-btn" onclick="renameOrDeleteCurrentCategory()" aria-label="Category options">⋯</button>
  `;
}

// Children are pure navigation (tap to drill in) — never a "selected
// filter" — so every chip renders the same way, in its own color, with no
// active/inactive distinction to invent. The trailing "›" echoes the
// header's "‹" back button: one visual language for "this moves you".
function renderCategoryChips() {
  const children = getChildren(currentCategoryId);
  const chips = children
    .map(c => `<button class="cat-chip" data-category-drop="${c.id}" style="color:${catColorVar(c)}" onclick="navigateToCategory(${c.id})">${escHtml(c.name)} ›</button>`)
    .join('');
  const addControl = addingCategory
    ? `<div class="add-cat-form">
         <input type="color" class="category-color-input" id="categoryColorInput"
                value="${addingCategoryColor}" aria-label="Category color"
                onpointerdown="skipNextCategoryBlur=true"
                oninput="selectAddCategoryColor(this.value)">
         <input class="category-add-input" id="categoryAddInput" type="text" maxlength="60"
                placeholder="Category name" autocomplete="off"
                onkeydown="if(event.key==='Enter'){this.blur();}else if(event.key==='Escape'){cancelAddCategory();}"
                onblur="if(skipNextCategoryBlur){skipNextCategoryBlur=false;}else{commitAddCategory();}">
       </div>`
    : `<button class="add-cat-btn" onclick="startAddCategory()" aria-label="Add category">+</button>`;
  return chips + addControl;
}

// Passive indicator only — re-filing a task is done by pressing and holding
// it, then dragging onto a category chip or the title area (see
// startPress/beginDrag/onDragMove/onDragEnd), not by picking from a control
// here. Only shown when the task's actual category differs from the one
// currently being browsed, since that's the only time it's not already
// obvious (aggregated views mix subcategories).
function renderCategoryLabel(task) {
  const taskCategoryId = task.categoryId ?? null;
  if (taskCategoryId === currentCategoryId) return '';
  const cat   = categories.find(c => c.id === taskCategoryId);
  const name  = cat ? cat.name : 'Uncategorized';
  const color = cat ? catColorVar(cat) : 'var(--text-dimmer)';
  return `<span class="category-label" style="color:${color}">${escHtml(name)}</span>`;
}

// The small line under a task's text: when it's due (active tasks) or when
// it was completed (done tasks — the due date no longer matters then), plus
// a notes icon if it has notes. Tasks done before completedAt existed have
// no completion time, so they show nothing rather than a made-up one.
const ICON_CALENDAR = '<svg class="icon meta-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="17" rx="2.5"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/></svg>';
const ICON_NOTES    = '<svg class="icon meta-icon" viewBox="0 0 24 24" aria-label="Has notes"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';

function renderTaskMeta(task) {
  const items = [];
  if (task.done) {
    if (settings.showCompletedAt && task.completedAt) {
      const when = formatCompletedAt(task.completedAt);
      if (when) items.push(`<span class="meta-item">Completed ${when}</span>`);
    }
  } else {
    const due = describeDue(task);
    if (due) items.push(`<span class="meta-item${due.overdue ? ' overdue' : ''}">${ICON_CALENDAR}${due.label}</span>`);
  }
  if (task.notes) items.push(`<span class="meta-item">${ICON_NOTES}</span>`);
  return items.length ? `<div class="task-meta">${items.join('')}</div>` : '';
}

// Month and day names are spelled out here instead of via toLocale*String,
// which would follow the phone's language and mix it into this English UI.
const MONTHS         = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS       = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Calendar days from `from` to `to` (positive when `to` is later), not
// elapsed time / 24h — 23:50 yesterday is 1 day ago at 00:10 today.
// Rounded because a DST switch makes one day 23 or 25 hours long.
function calendarDayDiff(from, to) {
  const dayStart = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((dayStart(to) - dayStart(from)) / (24 * 60 * 60 * 1000));
}

const pad2 = n => String(n).padStart(2, '0');
const formatTime = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// "12 Sep", plus the year once it's not the current one.
function formatShortDate(d, now = new Date()) {
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? date : `${date} ${d.getFullYear()}`;
}

// "25 Sep 2026, 14:03" — the unambiguous form, for the detail sheet's info.
function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${formatTime(d)}`;
}

// "today, 14:32" / "yesterday, 09:05" / "Monday, 18:00" within the past
// week, then "12 Sep".
function formatCompletedAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = calendarDayDiff(d, new Date());
  if (days === 0) return `today, ${formatTime(d)}`;
  if (days === 1) return `yesterday, ${formatTime(d)}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[d.getDay()]}, ${formatTime(d)}`;
  return formatShortDate(d);
}

// A due date is stored as a local calendar date "YYYY-MM-DD" (and an
// optional "HH:MM"), never as an ISO timestamp — so "Friday" stays Friday
// whatever timezone the phone is in. Built with new Date(y, m, d), because
// new Date("YYYY-MM-DD") would parse it as UTC midnight and can land on the
// previous day locally.
const DUE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DUE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseDueDate(str) {
  const m = DUE_DATE_RE.exec(str || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Rejects impossible dates like "2026-02-31", which Date would otherwise
  // quietly roll over into March.
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

function toDueDateString(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// { label, overdue } for an active task's due date, or null if it has none.
// "Today" / "Tomorrow" / "Yesterday"; weekday plus date within a week either
// way ("Fri, 3 Oct"); further out just the date ("12 Oct"). " · 14:00"
// appended when a time is set.
function describeDue(task) {
  const due = parseDueDate(task.dueDate);
  if (!due) return null;
  const now  = new Date();
  const days = calendarDayDiff(now, due);
  let label;
  if (days === 0)               label = 'Today';
  else if (days === 1)          label = 'Tomorrow';
  else if (days === -1)         label = 'Yesterday';
  else if (Math.abs(days) < 7)  label = `${WEEKDAYS_SHORT[due.getDay()]}, ${due.getDate()} ${MONTHS[due.getMonth()]}`;
  else                          label = formatShortDate(due, now);
  const time = DUE_TIME_RE.test(task.dueTime || '') ? task.dueTime : null;
  if (time) label += ` · ${time}`;
  // "HH:MM" strings compare correctly as plain strings (zero-padded, 24h).
  const overdue = days < 0 || (days === 0 && time !== null && time < formatTime(now));
  return { label, overdue };
}

// ── Helpers ────────────────────────────────────────────────────────────
function escHtml(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}
