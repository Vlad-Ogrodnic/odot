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
        ${editingId === task.id
          ? `<input class="edit-input" id="edit-${task.id}" type="text" maxlength="300"
                    value="${escAttr(task.text)}"
                    autocomplete="off" autocorrect="on" spellcheck="true"
                    onkeydown="if(event.key==='Enter'){this.blur();}else if(event.key==='Escape'){cancelEdit();}"
                    onblur="commitEdit(${task.id})">`
          : `<div class="task-main" onclick="startEdit(${task.id})">
               <div class="task-text ${task.done ? 'done' : ''}">${escHtml(task.text)}</div>
               ${renderTaskMeta(task)}
             </div>`
        }
        ${renderCategoryLabel(task)}
      </div>
    </div>
  `).join('');
}

function renderTitleGroup() {
  if (currentCategoryId === null) {
    return `<h1 class="app-title">Tasks v21</h1>`;
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

// The small line under a task's text. Only completion time for now; tasks
// done before completedAt existed have none, so they show nothing rather
// than a made-up time.
function renderTaskMeta(task) {
  if (!settings.showCompletedAt || !task.done || !task.completedAt) return '';
  const when = formatCompletedAt(task.completedAt);
  return when ? `<div class="task-meta">Completed ${when}</div>` : '';
}

// "today, 14:32" / "yesterday, 09:05" / "Monday, 18:00" within the past
// week, then "12 Sep" (plus the year once it's not this year). Month and
// day names are spelled out here instead of via toLocale*String, which
// would follow the phone's language and mix it into this English UI.
const MONTHS   = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatCompletedAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now  = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // Calendar-day difference, not elapsed/24h — 23:50 yesterday is
  // "yesterday" at 00:10 today. Rounded because a DST switch makes one
  // day 23 or 25 hours long.
  const dayStart = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(d)) / (24 * 60 * 60 * 1000));
  if (days === 0) return `today, ${time}`;
  if (days === 1) return `yesterday, ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[d.getDay()]}, ${time}`;
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? date : `${date} ${d.getFullYear()}`;
}

// ── Helpers ────────────────────────────────────────────────────────────
function escHtml(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

function escAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
