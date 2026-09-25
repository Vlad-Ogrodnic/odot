// App state and localStorage persistence (tasks, categories, settings).
//
// Classic script, not a module: see the note in index.html.

// ── State ──────────────────────────────────────────────────────────────
let tasks  = [];
let filter = 'all';
let editingId = null; // task being edited in place (only with the taskDetails setting off)
let categories = [];
let currentCategoryId = null; // null = root/"All"
let addingCategory = false;
let addingCategoryColor = '#4C6899'; // hex color chosen so far in the in-progress add-category form
// Opening the color picker blurs the name input, which would otherwise
// commit (and tear down) the add-category form mid-selection. Set on pointerdown —
// which reliably fires before blur on both touch and mouse — and consumed
// once by the input's blur handler. More robust here than relying on
// focus-event relatedTarget, which touch-triggered blur on iOS Safari
// doesn't always populate.
let skipNextCategoryBlur = false;
let doneWindow = 'all'; // 'today' | 'week' | 'month' | 'all' — only relevant when filter === 'done'

const STORAGE_KEY    = 'todo_tasks_v1';
const CATEGORIES_KEY = 'todo_categories_v1';
const SETTINGS_KEY   = 'todo_settings_v1';

// Display preferences from the settings sheet. Stored as a partial object
// merged over these defaults, so a setting added later just picks up its
// default on devices that saved settings before it existed.
const DEFAULT_SETTINGS = {
  rootShowsAll:    true, // main screen shows every task (false: only uncategorized ones)
  showCompletedAt: true, // done tasks show when they were completed
  taskDetails:     true, // tapping a task's text opens its detail sheet (false: edits the text in place)
  groupByDue:      false, // All/Active views split into Overdue/Today/Tomorrow/... sections, ordered by due date
};
let settings = { ...DEFAULT_SETTINGS };

// When this device last exported a backup (ISO string), or null if never.
// Its own key rather than part of `settings`: it's a record of something
// that happened, not a preference.
const LAST_BACKUP_KEY = 'todo_last_backup_v1';
let lastBackupAt = null;

// ── Persistence ────────────────────────────────────────────────────────
function load() {
  try {
    tasks = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    tasks = [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (e) {
    console.warn('Storage write failed:', e);
  }
}

function loadCategories() {
  try {
    categories = JSON.parse(localStorage.getItem(CATEGORIES_KEY) || '[]');
  } catch {
    categories = [];
  }
}

function saveCategories() {
  try {
    localStorage.setItem(CATEGORIES_KEY, JSON.stringify(categories));
  } catch (e) {
    console.warn('Storage write failed:', e);
  }
}

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Storage write failed:', e);
  }
}

function loadLastBackup() {
  try {
    lastBackupAt = localStorage.getItem(LAST_BACKUP_KEY);
  } catch {
    lastBackupAt = null;
  }
}

function saveLastBackup() {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, lastBackupAt);
  } catch (e) {
    console.warn('Storage write failed:', e);
  }
}
