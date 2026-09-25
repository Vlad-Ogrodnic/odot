// Repeating tasks: the rules, when the next occurrence falls, and the
// "done 25 of 30" stats for a series. Pure date logic, no DOM — covered by
// tests/logic.test.js.
//
// Classic script, not a module: see the note in index.html.

// A task's `repeat` (only ever alongside a `dueDate`):
//   { every: N, unit: 'day' | 'weekday' | 'week' | 'month' | 'year', anchorDay? }
// 'weekday' = Monday–Friday, always every 1. `anchorDay` (month/year only)
// is the day of the month the series is meant to fall on, so "monthly on
// the 31st" can land on the 30th in a short month and still come back to
// the 31st after it, instead of drifting to the 30th for good.
//
// Every instance of a repeating task carries the same `seriesId` (the id of
// the first one), and a completed instance remembers the one it spawned in
// `nextId`, so checking it off again after an accidental uncheck doesn't
// spawn a duplicate.
const REPEAT_UNITS = ['day', 'weekday', 'week', 'month', 'year'];

const REPEAT_PRESETS = {
  daily:    { every: 1, unit: 'day' },
  weekdays: { every: 1, unit: 'weekday' },
  weekly:   { every: 1, unit: 'week' },
  monthly:  { every: 1, unit: 'month' },
  yearly:   { every: 1, unit: 'year' },
};

function isValidRepeat(r) {
  return !!r && typeof r === 'object'
    && REPEAT_UNITS.includes(r.unit)
    && Number.isInteger(r.every) && r.every >= 1 && r.every <= 365
    && (r.unit !== 'weekday' || r.every === 1)
    && (r.anchorDay === undefined || (Number.isInteger(r.anchorDay) && r.anchorDay >= 1 && r.anchorDay <= 31));
}

// Which entry of the Repeat picker a rule corresponds to.
function repeatPresetKey(r) {
  if (!isValidRepeat(r)) return 'never';
  const preset = Object.keys(REPEAT_PRESETS).find(k => REPEAT_PRESETS[k].unit === r.unit && REPEAT_PRESETS[k].every === r.every);
  return preset || 'custom';
}

// "Daily", "Weekdays", "Every 2 weeks"...
function describeRepeat(r) {
  if (!isValidRepeat(r)) return '';
  const names = { day: 'Daily', weekday: 'Weekdays', week: 'Weekly', month: 'Monthly', year: 'Yearly' };
  if (r.every === 1) return names[r.unit];
  return `Every ${r.every} ${r.unit}s`;
}

// Month and year rules remember which day of the month they're for (see
// above); anything else doesn't need an anchor.
function syncRepeatAnchor(task) {
  if (!task.repeat) return;
  const due = parseDueDate(task.dueDate);
  if (due && (task.repeat.unit === 'month' || task.repeat.unit === 'year')) task.repeat.anchorDay = due.getDate();
  else delete task.repeat.anchorDay;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

// One step of the rule from local calendar date `d`. Always built with
// new Date(y, m, d) — calendar arithmetic, immune to DST's 23/25-hour days.
function advanceByRule(d, r) {
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  switch (r.unit) {
    case 'day':  return new Date(y, m, day + r.every);
    case 'week': return new Date(y, m, day + 7 * r.every);
    case 'weekday': {
      let next = new Date(y, m, day + 1);
      while (next.getDay() === 0 || next.getDay() === 6) next = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1);
      return next;
    }
    case 'month':
    case 'year': {
      const months = r.unit === 'month' ? r.every : 12 * r.every;
      const target = new Date(y, m + months, 1);
      const want   = r.anchorDay || day;
      return new Date(target.getFullYear(), target.getMonth(), Math.min(want, daysInMonth(target.getFullYear(), target.getMonth())));
    }
  }
  return null;
}

// Safety net for the loops below; real series are nowhere near this long.
const MAX_OCCURRENCE_STEPS = 50000;

// The due date ("YYYY-MM-DD") for the instance that replaces `task` once
// it's checked off: the first occurrence after its own due date that also
// isn't today or earlier. So an overdue weekly-Monday task done on a
// Wednesday moves to next Monday (not a Monday already gone), a daily one
// done today moves to tomorrow, and one done early (due Friday, done
// Wednesday) moves to the Friday after.
function nextDueDate(task, now = new Date()) {
  const due = parseDueDate(task.dueDate);
  if (!due || !isValidRepeat(task.repeat)) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const limit = due > today ? due : today;
  let d = due;
  for (let i = 0; i < MAX_OCCURRENCE_STEPS; i++) {
    d = advanceByRule(d, task.repeat);
    if (d > limit) return toDueDateString(d);
  }
  return null;
}

// { done, expected, since } for a series: how many instances were
// completed, out of how many occurrences the rule has had since the series
// began (up to today, or the latest completed one if that was done early).
// Today's occurrence doesn't count as missed while it's still open.
function seriesStats(seriesId, now = new Date()) {
  const members = tasks.filter(t => t.seriesId === seriesId);
  const dates   = members.map(t => parseDueDate(t.dueDate)).filter(Boolean);
  if (!dates.length) return null;
  const done  = members.filter(t => t.done).length;
  const since = new Date(Math.min(...dates));
  // The rule currently in force: the open instance's, else the latest one's.
  const rule = (members.find(t => !t.done && isValidRepeat(t.repeat)) || [...members].reverse().find(t => isValidRepeat(t.repeat)))?.repeat;
  if (!rule) return { done, expected: done, since };

  const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const doneDues = members.filter(t => t.done).map(t => parseDueDate(t.dueDate)).filter(Boolean);
  const limit    = new Date(Math.max(today, ...doneDues));
  let expected = 0;
  for (let d = since, i = 0; d <= limit && i < MAX_OCCURRENCE_STEPS; d = advanceByRule(d, rule), i++) expected++;
  const todayStr = toDueDateString(today);
  if (members.some(t => !t.done && t.dueDate === todayStr)) expected--;
  return { done, expected: Math.max(expected, done), since };
}

// The instance that takes over when a repeating task is checked off: same
// text, notes, category, time and rule, due on the next occurrence, placed
// right after it in the manual order. Returns it, or null if there's
// nothing to spawn (not repeating, no date, or already spawned earlier).
function spawnNextOccurrence(task, now = new Date()) {
  if (task.nextId != null && tasks.some(t => t.id === task.nextId)) return null;
  const nextDate = nextDueDate(task, now);
  if (!nextDate) return null;
  if (task.seriesId == null) task.seriesId = task.id;

  const copy = {
    id:         newTaskId(),
    text:       task.text,
    done:       false,
    createdAt:  now.toISOString(),
    categoryId: task.categoryId ?? null,
    dueDate:    nextDate,
    repeat:     { ...task.repeat },
    seriesId:   task.seriesId,
  };
  if (task.dueTime) copy.dueTime = task.dueTime;
  if (task.notes)   copy.notes   = task.notes;

  tasks.splice(tasks.indexOf(task) + 1, 0, copy);
  task.nextId = copy.id;
  return copy;
}

// Ids are creation timestamps; this also stays unique when two tasks are
// created within the same millisecond (a check-off that spawns a copy).
function newTaskId() {
  return tasks.reduce((max, t) => Math.max(max, t.id + 1), Date.now());
}
