// Nested categories: colors, navigation between levels, add/rename/delete.
//
// Classic script, not a module: see the note in index.html.

// ── Categories (nested) ────────────────────────────────────────────────
function getChildren(parentId) {
  return categories.filter(c => c.parentId === parentId);
}

function getDescendantIds(id) {
  const result = [];
  const stack  = [id];
  while (stack.length) {
    const current = stack.pop();
    for (const c of categories) {
      if (c.parentId === current) {
        result.push(c.id);
        stack.push(c.id);
      }
    }
  }
  return result;
}

// Category color: whatever was explicitly picked when it was created.
// - string  → a literal hex color, chosen freely via the color picker.
// - number  → legacy: an index into the old fixed --cat-0..5 palette,
//             from categories created back when that's all there was.
// - missing → older still, from before any picker existed — falls back to
//             a stable hash of the id instead of losing color entirely.
const CATEGORY_HUES = 6;
function catColorVar(cat) {
  if (cat && typeof cat.color === 'string') return cat.color;
  const idx = cat && typeof cat.color === 'number' ? cat.color : (cat ? cat.id % CATEGORY_HUES : 0);
  return `var(--cat-${idx})`;
}

// Each level remembers where it was scrolled when you drilled into a child,
// and going back returns you there — while a freshly opened level starts
// at the top. Both as in any iOS navigation stack. Keyed by category id,
// with null for the root.
const scrollMemory = new Map();

function parentCategoryId(id) {
  const cat = categories.find(c => c.id === id);
  return cat ? (cat.parentId ?? null) : null;
}

function navigateToCategory(id) {
  scrollMemory.set(currentCategoryId, window.scrollY);
  currentCategoryId = id;
  render();
  window.scrollTo(0, 0);
}

// The back chevron: the same slide-away animation a swipe back finishes
// with (see "Swipe right to go back"), so tapping and swiping feel like
// one gesture.
function navigateUp() {
  if (currentCategoryId === null || nav || backSwipe) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    beginNavTransition();
    endNavTransition(true);
    return;
  }
  beginNavTransition();
  settleNav(true, 0);
}

// An inline input swapped in place of the "+" button, so adding a category
// feels like typing a task into the add field instead of a separate
// native-popup interaction.
function startAddCategory() {
  addingCategory = true;
  addingCategoryColor = '#4C6899'; // just a starting point — freely changeable before confirming
  render();
  const input = document.getElementById('categoryAddInput');
  if (input) input.focus();
}

// Called as the native color picker reports a new value. Doesn't go
// through render() — that would wipe out whatever name the user has
// already typed (a fresh render rebuilds the input from scratch, empty).
function selectAddCategoryColor(hex) {
  addingCategoryColor = hex;
  // Opening the color picker blurs the name field; the blur handler
  // already ignores that (see skipNextCategoryBlur), but bring focus back
  // so typing can continue without an extra tap.
  const input = document.getElementById('categoryAddInput');
  if (input) input.focus();
}

// Names must be unique app-wide (not just among siblings) — two categories
// with the same name is confusing regardless of where they sit in the tree.
function categoryNameExists(name, excludeId = null) {
  const lower = name.toLowerCase();
  return categories.some(c => c.id !== excludeId && c.name.toLowerCase() === lower);
}

function commitAddCategory() {
  const input = document.getElementById('categoryAddInput');
  addingCategory = false;
  if (!input) { render(); return; }
  const name = input.value.trim();
  if (name) {
    if (categoryNameExists(name)) {
      alert(`A category named "${name}" already exists.`);
      addingCategory = true;
      render();
      const retryInput = document.getElementById('categoryAddInput');
      if (retryInput) { retryInput.value = name; retryInput.focus(); }
      return;
    }
    categories.push({ id: Date.now(), name, color: addingCategoryColor, parentId: currentCategoryId, createdAt: new Date().toISOString() });
    saveCategories();
  }
  render();
}

function cancelAddCategory() {
  addingCategory = false;
  render();
}

function renameOrDeleteCurrentCategory() {
  if (currentCategoryId === null) return; // can't rename/delete the root
  const cat = categories.find(c => c.id === currentCategoryId);
  if (!cat) return;

  const input = prompt('Rename category (clear the text and press OK to delete):', cat.name);
  if (input === null) return; // cancelled
  const trimmed = input.trim();

  if (trimmed === '') {
    const idsToDelete = new Set([cat.id, ...getDescendantIds(cat.id)]);
    const ok = confirm(`Delete "${cat.name}"${idsToDelete.size > 1 ? ' and its subcategories' : ''}? Tasks inside will be moved to Uncategorized — nothing is deleted.`);
    if (!ok) return;
    tasks.forEach(t => {
      if (t.categoryId !== null && t.categoryId !== undefined && idsToDelete.has(t.categoryId)) {
        t.categoryId = null;
      }
    });
    categories = categories.filter(c => !idsToDelete.has(c.id));
    currentCategoryId = cat.parentId;
    save();
    saveCategories();
    render();
    return;
  }

  if (trimmed !== cat.name) {
    if (categoryNameExists(trimmed, cat.id)) {
      alert(`A category named "${trimmed}" already exists.`);
      return;
    }
    cat.name = trimmed;
    saveCategories();
    render();
  }
}

function assignTaskCategory(taskId, categoryIdStr) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  task.categoryId = categoryIdStr === '' ? null : Number(categoryIdStr);
  save();
  render();
}
