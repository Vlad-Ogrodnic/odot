// Touch handling on task rows: tap, swipe-to-delete, press-and-hold to
// drag (reorder / re-file), edge auto-scroll, and the page-wide scroll lock.
//
// Classic script, not a module: see the note in index.html.

// ── Tap / swipe-to-delete / press-and-hold-to-reorder ────────────────────
// All three are one gesture funnel, delegated from the list container so
// listeners survive full re-renders. Any press on a row starts "pending":
// release quickly with little movement and it's an ordinary tap (native
// click fires on the checkbox/text beneath, untouched by any of this);
// move sideways past the threshold first and it resolves as swipe-to-delete;
// move vertically first and it's left as a normal page scroll; hold still
// long enough and it "picks up" the row for reordering/re-filing — the same
// vertical-drag + category-drop-target mechanics as before, just entered by
// a hold instead of a dedicated handle.
const taskListEl = document.getElementById('taskList');

const SWIPE_OPEN      = -76; // px the row slides to reveal the delete button
const SWIPE_THRESHOLD = 40;  // px drag needed to toggle open/closed
const LONG_PRESS_MS   = 250; // hold duration before a still press picks the row up
const PICKUP_MS       = 120; // pop animation when a row is first picked up
const SETTLE_MS       = 160; // ease-into-place animation when a row is dropped
// Keep SETTLE_MS < LONG_PRESS_MS: beginDrag() cancels any pending settle
// via clearTimeout(settleTimer), with no check for which row it belonged
// to. That's fine only because a new drag can't physically arm until
// LONG_PRESS_MS after its own touch starts, by which point a shorter
// previous settle has always already finished on its own.
const AUTOSCROLL_ZONE = 80;  // px band at the list's visible top/bottom edge where a held row scrolls the page
const AUTOSCROLL_MAX  = 900; // px/s at the very edge of that band (eases in quadratically from its inner side)
const AUTOSCROLL_ARM  = 12;  // px the finger must travel after pickup before edge-scrolling can start,
                             // so picking up a row that already sits near an edge doesn't lurch the page
const headerEl = document.querySelector('.header');

let openSwipeId       = null; // id of the currently swiped-open row, if any
let pressState        = null;
let longPressTimer    = null;
let dragState         = null;
let settleTimer       = null; // pending post-drop commit; cancelled by re-grabbing the same row mid-settle
let suppressClick     = false;
let highlightedDropEl = null; // category chip/title currently hovered while dragging

function updateDropHighlight(dropEl) {
  if (highlightedDropEl === dropEl) return;
  if (highlightedDropEl) highlightedDropEl.classList.remove('drop-target-hover');
  highlightedDropEl = dropEl || null;
  if (highlightedDropEl) highlightedDropEl.classList.add('drop-target-hover');
}

// A capturing click listener lets us swallow the "tap" that merely closed
// an open swipe, so it doesn't also fire the checkbox/edit handler beneath it.
taskListEl.addEventListener('click', e => {
  // dragState (not just suppressClick): pointer capture is supposed to
  // route the eventual pointerup — and whatever click iOS synthesizes
  // from it — to the dragged row, but Safari's touch-to-click pipeline
  // doesn't reliably honor capture the way mouse-based pointer capture
  // does. With siblings visually sliding into the dragged row's old slot
  // mid-drag, a misrouted click can land on whichever row now happens to
  // sit at the finger's screen position — toggling its checkbox or
  // opening it for edit for an instant. No click is ever a real, intended
  // one while a drag is in flight, so swallow all of them unconditionally.
  if (suppressClick || dragState) {
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

// Belt-and-suspenders on top of the CSS user-select:none (styles.css): on real
// iOS Safari, a sustained hold can still visually kick off native text
// selection (most reliably on a short, isolated run like the category
// label) even though user-select says it isn't selectable. selectstart
// fires right as that's about to happen, so canceling it here stops it
// outright — the CSS alone wasn't enough on-device.
taskListEl.addEventListener('selectstart', e => {
  if (e.target.closest('.edit-input')) return; // editing still needs real text selection
  e.preventDefault();
});

// Last line of defense against that same long-press selection, which has
// outlasted every other measure here before: if one appears anyway while
// a row is held, clear it the moment it does.
document.addEventListener('selectionchange', () => {
  if (!dragState) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) sel.removeAllRanges();
});

// Native scrolling stays on for any touch (touch-action: pan-y) until the
// touch becomes one of our own gestures — then this locks the page in
// place for the rest of it, like a native list does once a row is picked
// up or swiped sideways, or a screen is being swiped back. Pointer events
// can't do this on iOS (preventDefault on pointermove never stops a
// scroll); a non-passive touchmove listener can, but only if it's already
// attached when the touch begins — hence registered once, up front, rather
// than per gesture. On iOS pointermove fires before its touchmove, so the
// gesture state below is already up to date by the time this runs.
document.addEventListener('touchmove', e => {
  const mode = pressState?.mode;
  const ours = mode === 'drag' || mode === 'swipe' || backSwipe?.active;
  if (ours && e.cancelable) e.preventDefault();
}, { passive: false });

taskListEl.addEventListener('pointerdown', e => {
  // Actively editing — this is a real text field, let it handle its own
  // touch behavior (cursor placement, native select-word/select-all)
  // undisturbed rather than arming the row-press machinery under it.
  if (e.target.closest('.edit-input')) return;

  suppressClick = false;

  const wrapperEl = e.target.closest('.task-item-wrapper');
  const targetId  = wrapperEl ? Number(wrapperEl.dataset.id) : null;

  // Tapping/pressing anywhere while a different row is swiped open just
  // closes that row first.
  if (openSwipeId !== null && openSwipeId !== targetId) {
    closeSwipe();
    suppressClick = true;
  }

  const deleteBtn = e.target.closest('.delete-reveal');
  const row       = e.target.closest('.task-row');

  if (deleteBtn) return; // let its own onclick handle deletion
  if (row) {
    // Belt-and-suspenders alongside the app-wide user-select:none and the
    // selectstart/selectionchange guards above against iOS's native
    // long-press text selection. (Doesn't block native scrolling —
    // preventDefault on a pointer event never does.)
    e.preventDefault();
    startPress(e, row);
  }
});

function closeSwipe() {
  if (openSwipeId == null) return;
  const row = taskListEl.querySelector(`#task-${openSwipeId} .task-row`);
  if (row) {
    row.style.transition = 'transform 0.2s ease';
    row.style.transform  = 'translateX(0px)';
  }
  openSwipeId = null;
}

function startPress(e, row) {
  const wrapper = row.closest('.task-item-wrapper');
  const id      = Number(wrapper.dataset.id);
  const isOpen  = openSwipeId === id;

  pressState = {
    id, row, wrapper,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    lastX:  e.clientX, // latest finger position, so a pickup starts exactly where the finger is now
    lastY:  e.clientY,
    baseX:  isOpen ? SWIPE_OPEN : 0,
    wasOpen: isOpen,
    mode: null, // null (pending) | 'swipe' | 'scroll' | 'drag'
  };

  // Pointer capture is deferred until a gesture is actually confirmed
  // (swipe or drag) — capturing immediately would retarget the plain-tap
  // click event to the row itself, breaking checkbox toggling and
  // tap-to-edit.
  row.style.transition = 'none';
  row.addEventListener('pointermove', onPressMove);
  row.addEventListener('pointerup', onPressEnd);
  row.addEventListener('pointercancel', onPressEnd);

  longPressTimer = setTimeout(beginDrag, LONG_PRESS_MS);
}

function onPressMove(e) {
  if (!pressState) return;

  if (pressState.mode === 'drag') {
    onDragMove(e);
    return;
  }

  pressState.lastX = e.clientX;
  pressState.lastY = e.clientY;
  const dx = e.clientX - pressState.startX;
  const dy = e.clientY - pressState.startY;

  if (pressState.mode === null) {
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) && dx > 0 && backSwipe) {
      // Rightward inside a category is the swipe back, which is already
      // tracking this same touch (it arms on pointerdown, before this
      // funnel, and only when no row is swiped open). Step aside entirely.
      endPress();
      return;
    } else if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      clearTimeout(longPressTimer);
      pressState.mode = 'swipe';
      // Capture now that a swipe is confirmed, so a plain tap elsewhere
      // still targets the checkbox/text underneath undisturbed.
      pressState.row.setPointerCapture(pressState.pointerId);
    } else if (Math.abs(dy) > 8) {
      // Early vertical movement reads as an attempt to scroll the page,
      // not pick the row up — cancel the hold and let it scroll normally.
      clearTimeout(longPressTimer);
      pressState.mode = 'scroll';
    }
  }

  if (pressState.mode === 'swipe') {
    const x = Math.max(SWIPE_OPEN, Math.min(0, pressState.baseX + dx));
    pressState.row.style.transform = `translateX(${x}px)`;
  }
  // mode 'scroll', or still pending: nothing to do here.
}

// Stops tracking the current press without acting on it.
function endPress() {
  clearTimeout(longPressTimer);
  pressState.row.removeEventListener('pointermove', onPressMove);
  pressState.row.removeEventListener('pointerup', onPressEnd);
  pressState.row.removeEventListener('pointercancel', onPressEnd);
  pressState = null;
}

function onPressEnd(e) {
  if (!pressState) return;
  clearTimeout(longPressTimer);

  const { row, id, mode, wasOpen } = pressState;
  row.removeEventListener('pointermove', onPressMove);
  row.removeEventListener('pointerup', onPressEnd);
  row.removeEventListener('pointercancel', onPressEnd);

  if (mode === 'drag') {
    onDragEnd();
  } else if (mode === 'swipe') {
    const dx = e.clientX - pressState.startX;
    const finalX = pressState.baseX + dx;
    const shouldOpen = finalX < -SWIPE_THRESHOLD;
    row.style.transition = 'transform 0.2s ease';
    row.style.transform  = shouldOpen ? `translateX(${SWIPE_OPEN}px)` : 'translateX(0px)';
    openSwipeId = shouldOpen ? id : null;
  } else if (mode === null && wasOpen) {
    // A plain tap on a row that was already open just closes it.
    row.style.transition = 'transform 0.2s ease';
    row.style.transform  = 'translateX(0px)';
    openSwipeId = null;
    suppressClick = true;
  }
  // Otherwise (plain tap on a closed row, or a scroll): do nothing and let
  // the native click fire on the checkbox/text beneath.

  pressState = null;
}

// Fires after LONG_PRESS_MS of holding still — "picks up" the row for
// reordering/re-filing. A no-op if the touch already resolved as a swipe/
// scroll, or was released, before the timer got here.
function beginDrag() {
  if (!pressState || pressState.mode !== null) return;
  pressState.mode = 'drag';
  openSwipeId = null; // this row can't still be "open" once it's being dragged
  // Re-grabbing a row before its previous drop finished settling should
  // start clean, not race with that drop's still-pending commit/render.
  clearTimeout(settleTimer);

  const wrapper = pressState.wrapper;
  pressState.row.setPointerCapture(pressState.pointerId);
  pressState.row.style.transform = ''; // clear any partial swipe offset
  pressState.row.style.transition = '';

  const wrappers   = Array.from(taskListEl.querySelectorAll('.task-item-wrapper'));
  const startIndex = wrappers.indexOf(wrapper);
  const visibleIds = wrappers.map(w => Number(w.dataset.id));
  // Every row's own layout box, measured once up front: rows differ in
  // height (long tasks wrap), so reordering can't assume they're all as
  // tall as the dragged one. offsetTop/offsetHeight rather than
  // getBoundingClientRect because they ignore transforms (a sibling still
  // mid-slideIn, the pickup pop below) and don't change as the page scrolls.
  const layouts = wrappers.map(w => ({ top: w.offsetTop, height: w.offsetHeight }));

  dragState = {
    startIndex, currentIndex: startIndex, wrapper, wrappers, visibleIds, layouts,
    startY: pressState.lastY, startScrollY: window.scrollY,
    lastX:  pressState.lastX, lastY: pressState.lastY,
    autoScrollArmed: false, scrollCarry: 0, lastFrame: null, rafId: null, dropped: false,
    dropTarget: undefined,
  };

  wrapper.classList.add('dragging');
  // The dragged row otherwise occludes whatever is really underneath it
  // (it paints above normal-flow siblings while its z-index is raised),
  // which would make elementFromPoint find itself instead of the chip/
  // header actually being hovered — so it's excluded from hit-testing.
  wrapper.style.pointerEvents = 'none';

  // A quick pop on pickup — the "grabbed it" feedback native drag
  // reordering (Shortcuts, Home Screen icons) gives instantly.
  wrapper.style.transition = `transform ${PICKUP_MS}ms ease`;
  wrapper.style.transform  = 'scale(1.025)';

  dragState.rafId = requestAnimationFrame(autoScrollFrame);
}

function onDragMove(e) {
  if (!dragState) return;
  dragState.lastX = e.clientX;
  dragState.lastY = e.clientY;
  if (Math.abs(e.clientY - dragState.startY) > AUTOSCROLL_ARM) dragState.autoScrollArmed = true;
  updateDrag();
}

// Positions the dragged row and its siblings for the finger's latest
// position. Driven both by finger movement (onDragMove) and by the page
// scrolling underneath a still finger (autoScrollFrame).
function updateDrag() {
  const d = dragState;
  // Finger travel plus however far the page has auto-scrolled since pickup:
  // the row lives in the scrolling content, so without the scroll term it
  // would drift away from the finger as the page moves under it.
  // Capped so the row's bottom never passes the last row's: a transformed
  // row still stretches the page's scrollable height, so dragging it lower
  // while edge-scrolling down would grow the page, scroll further, drag the
  // row lower still — scrolling off into blank space forever. (No cap going
  // up: the chips and header up there are re-file targets it must reach.)
  const last   = d.layouts[d.layouts.length - 1];
  const own    = d.layouts[d.startIndex];
  const offset = Math.min(
    (d.lastY - d.startY) + (window.scrollY - d.startScrollY),
    (last.top + last.height) - (own.top + own.height),
  );
  // No transition here — the row should track the finger 1:1 with no lag.
  // Only the pickup pop and the drop settle (below) animate.
  d.wrapper.style.transition = 'none';
  d.wrapper.style.transform  = `translateY(${offset}px) scale(1.025)`;

  // Dragging onto a category chip or the title area re-files the task
  // there instead of reordering it — check that before the reorder math.
  const dropEl = document.elementFromPoint(d.lastX, d.lastY)?.closest('[data-category-drop]');
  updateDropHighlight(dropEl || null);

  if (dropEl) {
    d.dropTarget = dropEl.dataset.categoryDrop;
    d.currentIndex = d.startIndex; // no reorder while re-filing
    d.wrappers.forEach(w => {
      if (w !== d.wrapper) w.style.transform = '';
    });
    return;
  }
  d.dropTarget = undefined;

  const newIndex = slotIndexFor(offset);
  if (newIndex === d.currentIndex) return; // siblings are already shifted for this slot

  const s = d.startIndex;
  const h = d.layouts[s].height;
  d.wrappers.forEach((w, i) => {
    if (w === d.wrapper) return;
    let shift = 0;
    if (i > s && i <= newIndex)      shift = -h;
    else if (i < s && i >= newIndex) shift = h;
    w.style.transition = 'transform 0.15s ease';
    w.style.transform  = shift ? `translateY(${shift}px)` : '';
  });

  d.currentIndex = newIndex;
}

// Which slot the dragged row would land in if dropped now, given how far
// it's been moved from its own. It swaps past a sibling once its leading
// edge (bottom going down, top going up) crosses that sibling's midpoint —
// the edge rather than its own center, so a tall row dragged past short
// ones (or a short one past tall ones) swaps as it visibly overlaps them
// instead of noticeably early or late. With equal heights this is exactly
// "half a row", same as before rows could differ.
function slotIndexFor(offset) {
  const { layouts, startIndex: s } = dragState;
  const top    = layouts[s].top + offset;
  const bottom = top + layouts[s].height;
  const mid    = i => layouts[i].top + layouts[i].height / 2;
  let i = s;
  if (offset > 0) { while (i + 1 < layouts.length && bottom > mid(i + 1)) i++; }
  else            { while (i - 1 >= 0 && top < mid(i - 1)) i--; }
  return i;
}

// How far the dragged row sits from its original spot once in slot
// `index`: the combined height of every sibling it moved past.
function slotOffset(index) {
  const { layouts, startIndex: s } = dragState;
  let y = 0;
  for (let i = s + 1; i <= index; i++) y += layouts[i].height;
  for (let i = index; i < s; i++)      y -= layouts[i].height;
  return y;
}

// Scrolls the page while a held row sits near the top/bottom edge of the
// list's visible area, so a row can be moved further than one screen —
// faster the closer to the edge, like Reminders. Runs every frame for the
// whole drag (a finger resting in the zone sends no pointer events of its
// own to drive it).
function autoScrollFrame(now) {
  const d = dragState;
  if (!d || d.dropped) return;
  const dt = d.lastFrame === null ? 0 : Math.min(now - d.lastFrame, 50);
  d.lastFrame = now;

  // Hovering a re-file target means "drop it here", not "keep scrolling".
  const v = d.autoScrollArmed && d.dropTarget === undefined ? autoScrollVelocity(d.lastY) : 0;
  if (v) {
    // Page scroll positions only move in whole pixels, so fractional
    // per-frame amounts are carried over — otherwise slow speeds near the
    // zone's inner edge would round down to never moving at all.
    d.scrollCarry += v * dt / 1000;
    const step = Math.trunc(d.scrollCarry);
    if (step) {
      d.scrollCarry -= step;
      const before = window.scrollY;
      window.scrollBy(0, step);
      if (window.scrollY !== before) updateDrag();
    }
  } else {
    d.scrollCarry = 0;
  }
  d.rafId = requestAnimationFrame(autoScrollFrame);
}

// px/s to scroll for a finger at viewport y: negative (up) in the band just
// below the sticky header, positive (down) in the band at the screen's
// bottom, 0 elsewhere. The header itself is excluded — it's a re-file drop
// target (the current category), not part of the scroll zone.
function autoScrollVelocity(y) {
  const top    = headerEl.getBoundingClientRect().bottom;
  const bottom = window.innerHeight;
  let depth = 0;
  if (y < top) return 0;
  if (y < top + AUTOSCROLL_ZONE)         depth = y - (top + AUTOSCROLL_ZONE);
  else if (y > bottom - AUTOSCROLL_ZONE) depth = y - (bottom - AUTOSCROLL_ZONE);
  const t = Math.min(1, Math.abs(depth) / AUTOSCROLL_ZONE);
  return Math.sign(depth) * AUTOSCROLL_MAX * t * t;
}

function onDragEnd() {
  if (!dragState) return;
  const { wrapper, wrappers, startIndex, currentIndex, visibleIds, dropTarget } = dragState;

  dragState.dropped = true; // stops autoScrollFrame
  cancelAnimationFrame(dragState.rafId);
  updateDropHighlight(null);
  // dragState stays set through the settle below (cleared in the timeout,
  // not here) — the click listener checks it to swallow the stray click
  // iOS sometimes fires against a sibling right as the drag ends (see that
  // listener). Only the click/selectionchange guards read it until then,
  // so leaving it set this long doesn't block a fresh press elsewhere.

  // Ease the dragged row from wherever the finger left it into the gap its
  // siblings already opened up for it. The siblings themselves are left
  // exactly as onDragMove last shifted them — resetting them now, ahead of
  // the dragged row catching up, would snap them back to their pre-drag
  // spots while the dragged row is still animating toward a slot sized for
  // the shifted layout, i.e. the two would visibly disagree for 160ms.
  const finalY = dropTarget !== undefined ? 0 : slotOffset(currentIndex);
  wrapper.style.transition = `transform ${SETTLE_MS}ms ease`;
  wrapper.style.transform  = `translateY(${finalY}px) scale(1)`;

  // A plain timeout, not transitionend, drives the commit: dropping a row
  // back exactly where it started wouldn't change these style values, so
  // transitionend would never fire and everything would stay stuck mid-drag.
  settleTimer = setTimeout(() => {
    dragState = null;
    wrappers.forEach(w => {
      w.style.transition = '';
      w.style.transform  = '';
    });
    wrapper.classList.remove('dragging');
    wrapper.style.pointerEvents = '';

    if (dropTarget !== undefined) {
      assignTaskCategory(visibleIds[startIndex], dropTarget); // already re-renders
    } else {
      commitReorder(visibleIds, startIndex, currentIndex);
      render();
    }
  }, SETTLE_MS);
}
