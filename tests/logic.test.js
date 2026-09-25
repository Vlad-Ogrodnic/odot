// Unit tests for the app's pure logic: calendar math, due-date labels,
// grouping by due date, recurrence, series stats, reordering.
//
// Run from the project folder (takes well under a second, no install):
//   node --test
// (It finds *.test.js files by itself; Node 24 no longer accepts a folder
// as the argument.)
//
// Not part of the app — index.html doesn't load it and sw.js doesn't cache
// it, so it has no effect on the app or on deploying it.

// A fixed timezone that has DST, so date edge cases (a 23- or 25-hour day)
// behave the same on any machine. Must be set before any Date is created.
process.env.TZ = 'Europe/Bucharest';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');
const vm       = require('node:vm');

// The DOM-free app scripts, loaded the way the browser does: classic scripts
// sharing one global scope, in index.html's order.
const APP_FILES = ['state.js', 'tasks.js', 'categories.js', 'settings.js', 'render.js', 'recurrence.js'];

// A fresh copy of the app with its clock frozen at `now` (local time).
// Returns { app, run }: `app` exposes the app's functions; `run(code)`
// evaluates code inside it (needed for its let/const state, like `tasks`).
function loadApp(now) {
  let frozen = new Date(now).getTime();
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(frozen);
    }
    static now() { return frozen; }
  }
  const storage = new Map();
  const sandbox = {
    Date: FakeDate,
    console,
    localStorage: {
      getItem:    key => (storage.has(key) ? storage.get(key) : null),
      setItem:    (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
  };
  vm.createContext(sandbox);
  for (const file of APP_FILES) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  sandbox.render = () => {}; // nothing to draw into here
  const run = code => vm.runInContext(code, sandbox);
  run('settings = { ...DEFAULT_SETTINGS }');
  return {
    app: sandbox,
    run,
    setTasks: list => run(`tasks = ${JSON.stringify(list)}`),
    getTasks: () => JSON.parse(run('JSON.stringify(tasks)')),
    setNow:   when => { frozen = new RealDate(when).getTime(); },
  };
}

// Friday 25 Sep 2026, 14:00 local — "now" for most tests below.
const NOW = '2026-09-25T14:00:00';
const task = (id, extra = {}) => ({ id, text: `Task ${id}`, done: false, createdAt: '2026-09-01T10:00:00.000Z', categoryId: null, ...extra });

// ── Calendar basics ────────────────────────────────────────────────────
test('calendarDayDiff counts calendar days, across a DST change too', () => {
  const { app } = loadApp(NOW);
  // Clocks go back on 25 Oct 2026 in Bucharest: that day is 25 hours long.
  assert.equal(app.calendarDayDiff(new Date(2026, 9, 24, 12, 0), new Date(2026, 9, 26, 0, 30)), 2);
  assert.equal(app.calendarDayDiff(new Date(2026, 8, 25, 23, 50), new Date(2026, 8, 26, 0, 10)), 1);
  assert.equal(app.calendarDayDiff(new Date(2026, 8, 25), new Date(2026, 8, 20)), -5);
});

test('parseDueDate accepts real dates only', () => {
  const { app } = loadApp(NOW);
  assert.ok(app.parseDueDate('2028-02-29'));
  assert.equal(app.parseDueDate('2027-02-29'), null);
  assert.equal(app.parseDueDate('2026-02-31'), null);
  assert.equal(app.parseDueDate('2026-9-5'), null);
  assert.equal(app.parseDueDate(undefined), null);
  const d = app.parseDueDate('2026-10-25');
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 9, 25, 0]); // local midnight, not UTC
});

// ── Labels ─────────────────────────────────────────────────────────────
test('describeDue labels and overdue', () => {
  const { app } = loadApp(NOW);
  const due = (dueDate, dueTime) => app.describeDue(task(1, { dueDate, dueTime }));
  assert.deepEqual({ ...due('2026-09-25') },          { label: 'Today', overdue: false });
  assert.deepEqual({ ...due('2026-09-25', '13:00') }, { label: 'Today · 13:00', overdue: true });  // time already passed
  assert.deepEqual({ ...due('2026-09-25', '14:30') }, { label: 'Today · 14:30', overdue: false });
  assert.deepEqual({ ...due('2026-09-26', '09:00') }, { label: 'Tomorrow · 09:00', overdue: false });
  assert.deepEqual({ ...due('2026-09-24') },          { label: 'Yesterday', overdue: true });
  assert.deepEqual({ ...due('2026-09-29') },          { label: 'Tue, 29 Sep', overdue: false });
  assert.deepEqual({ ...due('2026-09-20') },          { label: 'Sun, 20 Sep', overdue: true });
  assert.deepEqual({ ...due('2026-10-02') },          { label: '2 Oct', overdue: false });     // a week out: just the date
  assert.deepEqual({ ...due('2027-01-05') },          { label: '5 Jan 2027', overdue: false }); // other year: with the year
  assert.equal(due(undefined), null);
});

test('formatCompletedAt', () => {
  const { app } = loadApp(NOW);
  assert.equal(app.formatCompletedAt(new Date(2026, 8, 25, 9, 5).toISOString()), 'today, 09:05');
  assert.equal(app.formatCompletedAt(new Date(2026, 8, 24, 23, 50).toISOString()), 'yesterday, 23:50');
  assert.equal(app.formatCompletedAt(new Date(2026, 8, 21, 8, 0).toISOString()), 'Monday, 08:00');
  assert.equal(app.formatCompletedAt(new Date(2026, 8, 12, 8, 0).toISOString()), '12 Sep');
  assert.equal(app.formatCompletedAt('garbage'), '');
});

// ── Grouping ───────────────────────────────────────────────────────────
test('groupTasksByDue: sections, date/time order, no-time counts as 23:59', () => {
  const { app, run } = loadApp(NOW);
  run("settings.groupByDue = true; filter = 'all'");
  const list = [
    task(1),                                                  // no date
    task(2,  { dueDate: '2026-09-25' }),                      // today, no time → after today's timed ones
    task(3,  { dueDate: '2026-09-25', dueTime: '23:58' }),
    task(4,  { dueDate: '2026-09-22' }),                      // overdue
    task(5,  { dueDate: '2026-09-28' }),                      // next 7 days
    task(6,  { dueDate: '2026-09-26', dueTime: '08:00' }),
    task(7,  { dueDate: '2026-10-20' }),                      // later
    task(8,  { done: true, completedAt: '2026-09-25T08:00:00.000Z' }),
    task(9,  { dueDate: '2026-09-26' }),
    task(10, { dueDate: '2026-09-25', dueTime: '09:00' }),    // today, but already passed → overdue
    task(11, { dueDate: '2026-09-25', dueTime: '23:58' }),    // same key as 3 → manual order keeps 3 first
  ];
  const sections = app.groupTasksByDue(list).map(s => [s.key, s.tasks.map(t => t.id)]);
  assert.deepEqual(JSON.parse(JSON.stringify(sections)), [
    ['overdue',   [4, 10]],
    ['today',     [3, 11, 2]],
    ['tomorrow',  [6, 9]],
    ['week',      [5]],
    ['later',     [7]],
    ['none',      [1]],
    ['completed', [8]],
  ]);
});

// ── Recurrence: next occurrence ────────────────────────────────────────
test('nextDueDate: daily, never in the past', () => {
  const { app } = loadApp(NOW);
  const daily = { every: 1, unit: 'day' };
  assert.equal(app.nextDueDate(task(1, { dueDate: '2026-09-25', repeat: daily })), '2026-09-26'); // due today
  assert.equal(app.nextDueDate(task(1, { dueDate: '2026-09-20', repeat: daily })), '2026-09-26'); // 5 days overdue → tomorrow, not the 21st
});

test('nextDueDate: weekly, overdue and early', () => {
  const { app, setNow } = loadApp(NOW);
  const weekly = { every: 1, unit: 'week' };
  setNow('2026-09-23T10:00:00'); // a Wednesday
  assert.equal(app.nextDueDate(task(1, { dueDate: '2026-09-21', repeat: weekly })), '2026-09-28'); // Monday task done late → next Monday
  assert.equal(app.nextDueDate(task(1, { dueDate: '2026-09-25', repeat: weekly })), '2026-10-02'); // Friday task done early → the Friday after
  assert.equal(app.nextDueDate(task(1, { dueDate: '2026-09-23', repeat: { every: 2, unit: 'week' } })), '2026-10-07');
});

test('nextDueDate: weekdays skip the weekend', () => {
  const { app, setNow } = loadApp(NOW);
  const weekdays = { every: 1, unit: 'weekday' };
  assert.equal(app.nextDueDate(task(1, { dueDate: '2026-09-25', repeat: weekdays })), '2026-09-28'); // Fri → Mon
  setNow('2026-09-22T10:00:00');
  assert.equal(app.nextDueDate(task(1, { dueDate: '2026-09-22', repeat: weekdays })), '2026-09-23'); // Tue → Wed
});

test('nextDueDate: monthly on the 31st clamps, then returns to the 31st', () => {
  const { app, setNow } = loadApp(NOW);
  const monthly31 = { every: 1, unit: 'month', anchorDay: 31 };
  setNow('2026-01-31T10:00:00');
  assert.equal(app.nextDueDate(task(1, { dueDate: '2026-01-31', repeat: monthly31 })), '2026-02-28');
  setNow('2026-02-28T10:00:00');
  assert.equal(app.nextDueDate(task(1, { dueDate: '2026-02-28', repeat: monthly31 })), '2026-03-31');
  setNow('2026-03-31T10:00:00');
  assert.equal(app.nextDueDate(task(1, { dueDate: '2026-03-31', repeat: monthly31 })), '2026-04-30');
});

test('nextDueDate: yearly on 29 Feb', () => {
  const { app, setNow } = loadApp(NOW);
  const yearly29 = { every: 1, unit: 'year', anchorDay: 29 };
  setNow('2028-02-29T10:00:00');
  assert.equal(app.nextDueDate(task(1, { dueDate: '2028-02-29', repeat: yearly29 })), '2029-02-28');
  setNow('2031-02-28T10:00:00');
  assert.equal(app.nextDueDate(task(1, { dueDate: '2031-02-28', repeat: yearly29 })), '2032-02-29');
});

test('nextDueDate: daily across the DST change keeps whole days', () => {
  const { app, setNow } = loadApp(NOW);
  setNow('2026-10-25T10:00:00'); // the 25-hour day
  assert.equal(app.nextDueDate(task(1, { dueDate: '2026-10-25', repeat: { every: 1, unit: 'day' } })), '2026-10-26');
  setNow('2027-03-28T10:00:00'); // the 23-hour day
  assert.equal(app.nextDueDate(task(1, { dueDate: '2027-03-28', repeat: { every: 1, unit: 'day' } })), '2027-03-29');
});

test('isValidRepeat', () => {
  const { app } = loadApp(NOW);
  assert.ok(app.isValidRepeat({ every: 1, unit: 'day' }));
  assert.ok(app.isValidRepeat({ every: 3, unit: 'month', anchorDay: 31 }));
  assert.ok(!app.isValidRepeat({ every: 0, unit: 'day' }));
  assert.ok(!app.isValidRepeat({ every: 2, unit: 'weekday' }));
  assert.ok(!app.isValidRepeat({ every: 1, unit: 'fortnight' }));
  assert.ok(!app.isValidRepeat({ every: 1.5, unit: 'day' }));
  assert.ok(!app.isValidRepeat({ every: 1, unit: 'month', anchorDay: 32 }));
  assert.ok(!app.isValidRepeat('daily'));
  assert.ok(!app.isValidRepeat(null));
});

// ── Recurrence: checking off ───────────────────────────────────────────
test('checking off a repeating task spawns the next one right after it, once', () => {
  const { app, setTasks, getTasks } = loadApp(NOW);
  setTasks([
    task(1, { dueDate: '2026-09-25', dueTime: '08:00', notes: 'n', categoryId: 7, repeat: { every: 1, unit: 'day' } }),
    task(2),
  ]);
  app.toggleTask(1);
  let list = getTasks();
  assert.equal(list.length, 3);
  const [done, next, other] = list;
  assert.equal(done.done, true);
  assert.equal(done.seriesId, 1);
  assert.equal(next.dueDate, '2026-09-26');
  assert.equal(next.done, false);
  assert.deepEqual([next.text, next.notes, next.dueTime, next.categoryId, next.seriesId], ['Task 1', 'n', '08:00', 7, 1]);
  assert.deepEqual(next.repeat, { every: 1, unit: 'day' });
  assert.equal(done.nextId, next.id);
  assert.equal(other.id, 2);

  // An accidental uncheck + re-check leaves the spawned one alone and
  // doesn't spawn a second.
  app.toggleTask(1);
  app.toggleTask(1);
  list = getTasks();
  assert.equal(list.length, 3);
  assert.equal(list.filter(t => t.dueDate === '2026-09-26').length, 1);
});

test('checking off a non-repeating task spawns nothing', () => {
  const { app, setTasks, getTasks } = loadApp(NOW);
  setTasks([task(1, { dueDate: '2026-09-25' })]);
  app.toggleTask(1);
  assert.equal(getTasks().length, 1);
});

// ── Series stats & collapsing ──────────────────────────────────────────
test('seriesStats: done X of Y, today not counted as missed while open', () => {
  const { app, setTasks } = loadApp(NOW);
  const daily = { every: 1, unit: 'day' };
  const doneDays = [16, 17, 18, 19, 20, 21, 22];                 // done 7; missed the 23rd and 24th
  setTasks([
    ...doneDays.map(d => task(d, { dueDate: `2026-09-${d}`, repeat: daily, seriesId: 16, done: true, completedAt: `2026-09-${d}T18:00:00.000Z` })),
    task(99, { dueDate: '2026-09-25', repeat: daily, seriesId: 16 }), // today's, still open
  ]);
  const s = app.seriesStats(16);
  assert.equal(s.done, 7);
  assert.equal(s.expected, 9); // 16th..24th
  assert.equal(app.toDueDateString(s.since), '2026-09-16');
});

test('collapseDoneSeries keeps only the latest completed instance per series', () => {
  const { app } = loadApp(NOW);
  const list = [
    task(1, { done: true, seriesId: 1, completedAt: '2026-09-23T10:00:00.000Z' }),
    task(2, { done: true, seriesId: 1, completedAt: '2026-09-24T10:00:00.000Z' }),
    task(3, { seriesId: 1 }),                                          // the open one stays
    task(4, { done: true, completedAt: '2026-09-20T10:00:00.000Z' }),  // not a series: stays
  ];
  assert.deepEqual(app.collapseDoneSeries(list).map(t => t.id), [2, 3, 4]);
});

// ── Reordering ─────────────────────────────────────────────────────────
test('commitReorder moves within the visible subset, others stay put', () => {
  const { app, setTasks, getTasks } = loadApp(NOW);
  setTasks([task(1), task(2), task(3), task(4), task(5)]);
  // Visible: 1, 3, 5 (say 2 and 4 are filtered out). Drag 5 to the top.
  app.commitReorder([1, 3, 5], 2, 0);
  assert.deepEqual(getTasks().map(t => t.id), [5, 2, 1, 4, 3]);
});
