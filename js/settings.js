// Settings sheet (display toggles) and export/import.
//
// Classic script, not a module: see the note in index.html.

// ── Settings sheet ─────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('settingRootShowsAll').checked    = settings.rootShowsAll;
  document.getElementById('settingShowCompletedAt').checked = settings.showCompletedAt;
  document.getElementById('settingTaskDetails').checked     = settings.taskDetails;
  document.getElementById('settingGroupByDue').checked      = settings.groupByDue;
  renderBackupStatus();
  document.getElementById('settingsOverlay').classList.add('visible');
  lockPageScroll();
}

function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  render(); // the list is visible behind the sheet, so the change shows immediately
}

function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('visible');
  unlockPageScroll();
}

// While a sheet is open the page behind it must not scroll — neither from
// a touch on the backdrop nor from a sheet's own scroll chaining through to
// it (overscroll-behavior only helps when the sheet itself has something to
// scroll). overflow:hidden on body isn't reliable on iOS, so the page is
// pinned in place with position:fixed at its current offset instead, and
// put back exactly there afterwards.
let lockedScrollY = null;

function lockPageScroll() {
  if (lockedScrollY !== null) return;
  lockedScrollY = window.scrollY;
  document.body.style.position = 'fixed';
  document.body.style.top      = `-${lockedScrollY}px`;
  document.body.style.left     = '0';
  document.body.style.right    = '0';
}

function unlockPageScroll() {
  if (lockedScrollY === null) return;
  document.body.style.position = '';
  document.body.style.top      = '';
  document.body.style.left     = '';
  document.body.style.right    = '';
  window.scrollTo(0, lockedScrollY);
  lockedScrollY = null;
}

// ── Backup reminder ────────────────────────────────────────────────────
// Everything lives only in this phone's localStorage — deleting the app from
// the Home Screen or clearing Safari's data loses it all. So: remember when
// the last export happened, show it under Backup, and put a small dot on the
// settings gear once a backup is overdue. Deliberately a quiet nudge, never
// a popup.
const BACKUP_REMIND_DAYS = 7;

function daysSinceLastBackup() {
  if (!lastBackupAt) return null;
  const then = new Date(lastBackupAt);
  if (Number.isNaN(then.getTime())) return null;
  // Calendar days (last night at 23:50 is "yesterday"), floored at 0 so a
  // phone clock set back in time can't produce "-1 days ago".
  return Math.max(0, calendarDayDiff(then, new Date()));
}

// Only once there's something worth losing.
function isBackupDue() {
  if (tasks.length === 0) return false;
  const days = daysSinceLastBackup();
  return days === null || days >= BACKUP_REMIND_DAYS;
}

function renderBackupStatus() {
  const el   = document.getElementById('backupStatus');
  const days = daysSinceLastBackup();
  el.textContent = days === null ? 'Never backed up — export to keep a copy outside the app'
                 : days === 0    ? 'Last backup: today'
                 : days === 1    ? 'Last backup: yesterday'
                 :                 `Last backup: ${days} days ago`;
  el.classList.toggle('due', isBackupDue());
}

function markBackedUp() {
  lastBackupAt = new Date().toISOString();
  saveLastBackup();
  renderBackupStatus();
  render(); // clears the dot on the gear
}

// ── Export / Import ────────────────────────────────────────────────────
function exportTasks() {
  if (tasks.length === 0 && categories.length === 0) {
    alert('Nothing to export yet.');
    return;
  }

  const json     = JSON.stringify({ categories, tasks }, null, 2);
  const filename = `tasks-${new Date().toISOString().slice(0, 10)}.json`;
  const file     = new File([json], filename, { type: 'application/json' });

  // On iOS, sharing the file lets you save it to Files, AirDrop it, etc.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    // Resolves only once the share actually went through (saved to Files,
    // AirDropped...); dismissing the share sheet rejects, and doesn't count.
    navigator.share({ files: [file], title: 'Tasks backup' }).then(markBackedUp, () => {});
    return;
  }

  // Desktop / unsupported browsers: fall back to a plain download.
  const url = URL.createObjectURL(file);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  markBackedUp(); // no way to know if the download was kept; assume so
}

function handleImportFile(event) {
  const file = event.target.files[0];
  event.target.value = ''; // reset so importing the same file again still fires onchange
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      alert("That file isn't valid JSON.");
      return;
    }

    // Accept the legacy bare-array format (tasks only) as well as the
    // current { categories, tasks } shape.
    let importedTasks, importedCategories;
    if (Array.isArray(parsed)) {
      importedTasks = parsed;
      importedCategories = [];
    } else if (parsed && Array.isArray(parsed.tasks)) {
      importedTasks = parsed.tasks;
      importedCategories = Array.isArray(parsed.categories) ? parsed.categories : [];
    } else {
      alert('Expected a JSON file containing tasks (and optionally categories).');
      return;
    }

    // Merge categories first, matching by (name, resolved parent) so two
    // different branches can each have a same-named child without merging
    // into one. Recursion (rather than assuming file order) resolves a
    // category's parent on demand, memoized in categoryIdRemap.
    const categoryIdRemap = new Map(); // imported category id -> final id in `categories`
    const byImportedId    = new Map(importedCategories.filter(c => c && typeof c.id !== 'undefined').map(c => [c.id, c]));

    // Category names are unique app-wide, so a name match (regardless of
    // parent) unambiguously means "this is the same category" — matched
    // ones keep their existing local placement rather than being reparented
    // to wherever the import file had them.
    function resolveCategory(importedCat) {
      if (categoryIdRemap.has(importedCat.id)) return categoryIdRemap.get(importedCat.id);

      const importedName = typeof importedCat.name === 'string' ? importedCat.name : 'Unnamed';
      const existing = categories.find(c => c.name.toLowerCase() === importedName.toLowerCase());
      if (existing) {
        categoryIdRemap.set(importedCat.id, existing.id);
        return existing.id;
      }

      let finalParentId = null;
      if (importedCat.parentId !== null && importedCat.parentId !== undefined) {
        const parentImported = byImportedId.get(importedCat.parentId);
        finalParentId = parentImported ? resolveCategory(parentImported) : null;
      }

      let finalId = Date.now() + categories.length + categoryIdRemap.size;
      while (categories.some(c => c.id === finalId)) finalId++;
      categories.push({
        id: finalId,
        name: importedName,
        parentId: finalParentId,
        // Kept in either stored generation catColorVar() understands (hex
        // string, or old palette index) — strictly validated, since the
        // value is written unescaped into a style="" attribute and an
        // import file is untrusted input. Anything else falls back to no
        // color, which catColorVar() also handles.
        ...((typeof importedCat.color === 'string' && /^#[0-9a-f]{6}$/i.test(importedCat.color)) ||
            (Number.isInteger(importedCat.color) && importedCat.color >= 0 && importedCat.color < CATEGORY_HUES)
          ? { color: importedCat.color } : {}),
        createdAt: typeof importedCat.createdAt === 'string' ? importedCat.createdAt : new Date().toISOString(),
      });
      categoryIdRemap.set(importedCat.id, finalId);
      return finalId;
    }

    importedCategories.forEach(c => { if (c && typeof c.id !== 'undefined') resolveCategory(c); });

    // Merge tasks: unchanged dedupe-by-id logic, plus remapping categoryId
    // through the table built above (an unresolvable reference falls back
    // to Uncategorized rather than dropping the task).
    const existingIds = new Set(tasks.map(t => t.id));
    let added = 0, skipped = 0;

    for (const item of importedTasks) {
      if (!item || typeof item.text !== 'string' || !item.text.trim()) {
        skipped++;
        continue;
      }
      if (typeof item.id === 'number' && existingIds.has(item.id)) {
        skipped++;
        continue;
      }
      let id = typeof item.id === 'number' ? item.id : Date.now() + added;
      while (existingIds.has(id)) id++;
      existingIds.add(id);

      const categoryId = (item.categoryId !== null && item.categoryId !== undefined && categoryIdRemap.has(item.categoryId))
        ? categoryIdRemap.get(item.categoryId)
        : null;

      tasks.push({
        id,
        text:      item.text.trim(),
        done:      !!item.done,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
        ...(typeof item.completedAt === 'string' ? { completedAt: item.completedAt } : {}),
        // Detail-sheet fields, each validated to the exact shape the app
        // writes; anything else is dropped rather than half-trusted. A time
        // is only kept alongside a valid date, as the app itself does.
        ...(typeof item.notes === 'string' && item.notes.trim() ? { notes: item.notes.slice(0, 5000) } : {}),
        ...(parseDueDate(item.dueDate) ? { dueDate: item.dueDate } : {}),
        ...(parseDueDate(item.dueDate) && DUE_TIME_RE.test(item.dueTime || '') ? { dueTime: item.dueTime } : {}),
        // Repeat rule (only with a date), rebuilt from its known keys only;
        // seriesId links a repeating task's instances for its stats.
        // (nextId is deliberately not carried over — it only guards against
        // double-spawning, and the ids it points to may have been remapped.)
        ...(parseDueDate(item.dueDate) && isValidRepeat(item.repeat)
          ? { repeat: { every: item.repeat.every, unit: item.repeat.unit, ...(item.repeat.anchorDay ? { anchorDay: item.repeat.anchorDay } : {}) } }
          : {}),
        ...(Number.isInteger(item.seriesId) ? { seriesId: item.seriesId } : {}),
        categoryId,
      });
      added++;
    }

    save();
    saveCategories();
    render();
    alert(`Imported ${added} task${added === 1 ? '' : 's'}.` + (skipped ? ` Skipped ${skipped} invalid/duplicate.` : ''));
  };
  reader.readAsText(file);
}
