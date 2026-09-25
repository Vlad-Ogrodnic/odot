// Task operations (add/toggle/delete/reorder) and editing a task's text in
// place. The detail sheet (used instead when the "Task details" setting is
// on) lives in js/detail.js.
//
// Classic script, not a module: see the note in index.html.

// ── Task operations ────────────────────────────────────────────────────
function addTask() {
  const input = document.getElementById('taskInput');
  const text  = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }

  // Appended, not prepended: the list reads top-down in the order tasks
  // were added (the user's choice). No scroll-to-new-task — the input sits
  // above the list and stays focused for adding several in a row, so
  // scrolling down to each new task would pull the input off-screen and
  // make iOS bounce back up to it on the next keystroke.
  tasks.push({
    id:        Date.now(),
    text,
    done:      false,
    createdAt: new Date().toISOString(),
    categoryId: currentCategoryId,
  });

  save();
  input.value = '';
  input.focus();
  render();
}

function toggleTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  task.done = !task.done;
  if (task.done) {
    task.completedAt = new Date().toISOString();
    // A repeating task hands over to its next occurrence (js/recurrence.js);
    // unchecking this one later leaves that next one in place.
    if (task.repeat) spawnNextOccurrence(task);
  }
  save();
  render();
}

function deleteTask(id) {
  tasks = tasks.filter(t => t.id !== id);
  save();
  render();
}

// Reorders by id, not raw array index: the visible list (after status AND
// category filtering) is a scattered subset of `tasks`, so the dragged/target
// positions from the DOM can't be spliced directly into the full array.
// Instead: compute the new relative order of just the visible ids, then walk
// the full array substituting visible tasks from that new order in place —
// every non-visible task keeps its original position untouched.
function commitReorder(visibleIds, fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  const newOrder = visibleIds.slice();
  const [movedId] = newOrder.splice(fromIndex, 1);
  newOrder.splice(toIndex, 0, movedId);

  const byId = new Map(tasks.map(t => [t.id, t]));
  const visibleSet = new Set(visibleIds);
  let cursor = 0;
  tasks = tasks.map(t => visibleSet.has(t.id) ? byId.get(newOrder[cursor++]) : t);
  save();
}

// ── Tapping a task's text ──────────────────────────────────────────────
// Opens the detail sheet, or — with the "Task details" setting off, for
// anyone who'd rather keep tasks simple — edits the text right in the row.
function onTaskTextTap(id) {
  if (settings.taskDetails) openDetail(id);
  else startEdit(id);
}

// ── Editing in place ───────────────────────────────────────────────────
function startEdit(id) {
  editingId = id;
  render();
  const input = document.getElementById(`edit-${id}`);
  if (input) {
    input.focus();
    const len = input.value.length;
    input.setSelectionRange(len, len); // cursor at end, not select-all — editing should extend text, not wipe it
  }
}

function commitEdit(id) {
  const input = document.getElementById(`edit-${id}`);
  if (!input) return; // already committed/cancelled
  const value = input.value.trim();
  const task  = tasks.find(t => t.id === id);
  if (task && value) {
    task.text = value;
    save();
  }
  editingId = null;
  render();
}

function cancelEdit() {
  editingId = null;
  render();
}
