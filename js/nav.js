// Swipe right (or tap the back chevron) to go back out of a category.
//
// Classic script, not a module: see the note in index.html.

// ── Swipe right to go back ───────────────────────────────────────────
// Modeled on iOS's own back swipe — the full-screen kind iOS 26 gives
// every app, not just the left-edge one. Inside a category, a rightward
// swipe starting anywhere slides the whole current screen off to the right
// under the finger, 1:1, revealing the parent level underneath, which
// drifts in from a slight leftward offset (parallax) while a dim over it
// lifts. Letting go past halfway, or with a rightward flick, finishes the
// slide at the finger's speed; otherwise it springs back and nothing
// changes. Vertical-first touches stay native scrolls; a leftward swipe on
// a row is still swipe-to-delete.
//
// The parent is a real render of that level into a copy of the page
// (render(root)) — not a screenshot — shown at the scroll position it was
// left at. The live page itself stays untouched until the slide actually
// completes, so the element under the finger is never ripped out of the
// DOM mid-gesture (touch events stop reaching the document if it is,
// which would take away the scroll lock above).
const pageEl = document.getElementById('page');

const NAV_ARM        = 8;    // px of horizontal-dominant travel that commits a touch to swiping back (same as a row swipe)
const NAV_PARALLAX   = 0.3;  // fraction of the screen width the parent level starts offset to the left
const NAV_DIM        = 0.15; // opacity of the dim over the parent level at the start
const NAV_FLICK      = 0.35; // px/ms: a release this fast decides the outcome by direction alone
const NAV_MIN_MS     = 180;  // settle animation duration bounds; within them it matches the finger's speed
const NAV_MAX_MS     = 350;  //   (and a tapped back button, starting from rest, gets the max — iOS's pop duration)
const NAV_EASE       = 'cubic-bezier(0.2, 0.8, 0.2, 1)'; // fast start, long gentle landing — like UIKit's spring
const NAV_SAMPLE_MS  = 100;  // window of recent finger positions used to measure release velocity

let backSwipe          = null; // the touch being tracked as a possible/actual swipe back
let nav                = null; // the transition on screen: { parentId, underlay, dim, width, x }
let navClickGuardUntil = 0;

// Armed on every eligible touch, in the capture phase so it's set before
// the row funnel's own pointerdown runs (that funnel checks for it when
// deciding a rightward move isn't its to handle). Touch only: a mouse
// drag on desktop should stay a mouse drag.
document.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch' || !e.isPrimary) return;
  if (currentCategoryId === null || nav || backSwipe) return;
  // Busy with something else that a sideways swipe would clash with — a
  // held row, an open delete button (a press anywhere just closes it
  // first), text being typed (a task edited in place, a category name), or
  // a sheet (settings, task details) open over the page.
  if (dragState || openSwipeId !== null || editingId !== null || addingCategory) return;
  if (e.target.closest('input, textarea, .sheet-overlay')) return;

  backSwipe = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: 0, active: false, samples: [] };
  document.addEventListener('pointermove', onBackMove);
  document.addEventListener('pointerup', onBackEnd);
  document.addEventListener('pointercancel', onBackEnd);
}, true);

function stopBackTracking() {
  document.removeEventListener('pointermove', onBackMove);
  document.removeEventListener('pointerup', onBackEnd);
  document.removeEventListener('pointercancel', onBackEnd);
  backSwipe = null;
}

function onBackMove(e) {
  const s = backSwipe;
  if (!s || e.pointerId !== s.pointerId) return;

  if (!s.active) {
    // The same touch was held long enough to pick a row up instead.
    if (dragState) { stopBackTracking(); return; }
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (Math.abs(dx) > NAV_ARM && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) { stopBackTracking(); return; } // leftward: a row swipe, or nothing
      s.active = true;
      // Measured from here, not from touch-down, so the screen doesn't
      // jump by the arming distance the moment it starts to move.
      s.originX = e.clientX;
      beginNavTransition();
    } else if (Math.abs(dy) > NAV_ARM) {
      stopBackTracking(); // a scroll
      return;
    } else {
      return;
    }
  }

  s.samples.push({ t: e.timeStamp, x: e.clientX });
  while (s.samples.length > 2 && e.timeStamp - s.samples[0].t > NAV_SAMPLE_MS) s.samples.shift();
  setNavOffset(Math.max(0, e.clientX - s.originX));
}

function onBackEnd(e) {
  const s = backSwipe;
  if (!s || e.pointerId !== s.pointerId) return;
  stopBackTracking();
  if (!s.active) return; // a tap, or too little movement to count — leave it to the click

  // The finger lifted after a real swipe; whatever element it ended on
  // mustn't also treat that as a tap.
  navClickGuardUntil = performance.now() + 250;

  if (e.type === 'pointercancel') { settleNav(false, 0); return; }

  // Velocity over just the last moment of the gesture, and zero if the
  // finger had come to rest before lifting.
  const recent = s.samples.filter(p => e.timeStamp - p.t <= NAV_SAMPLE_MS);
  const v = recent.length >= 2
    ? (recent[recent.length - 1].x - recent[0].x) / Math.max(1, recent[recent.length - 1].t - recent[0].t)
    : 0;
  const complete = v > NAV_FLICK || (v > -NAV_FLICK && nav.x > nav.width / 2);
  settleNav(complete, v);
}

document.addEventListener('click', e => {
  if (performance.now() < navClickGuardUntil) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

// Puts the parent level in place behind the current screen.
function beginNavTransition() {
  const parentId = parentCategoryId(currentCategoryId);

  const underlay = document.createElement('div');
  underlay.className = 'nav-underlay';
  const copy = pageEl.cloneNode(true);
  copy.removeAttribute('id');
  copy.removeAttribute('style');
  underlay.appendChild(copy);
  const dim = document.createElement('div');
  dim.className = 'nav-dim';
  document.body.append(underlay, dim);

  // Render the parent level into the copy (render() reads the level from
  // currentCategoryId), then strip the copy's ids so nothing that looks
  // elements up by id can ever land on it instead of the live page.
  const ownId = currentCategoryId;
  currentCategoryId = parentId;
  render(copy);
  currentCategoryId = ownId;
  copy.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  underlay.scrollTop = scrollMemory.get(parentId) ?? 0;

  pageEl.classList.add('nav-moving');
  nav = { parentId, underlay, dim, width: window.innerWidth, x: 0 };
  setNavOffset(0);
}

// x = how far the current screen has slid right, 0..width.
function setNavOffset(x) {
  const p = nav.width ? x / nav.width : 1; // a zero-width viewport (hidden/background tab) would otherwise divide by zero
  nav.x = x;
  pageEl.style.transform           = `translateX(${x}px)`;
  nav.underlay.style.transform     = `translateX(${-NAV_PARALLAX * nav.width * (1 - p)}px)`;
  nav.dim.style.opacity            = String(NAV_DIM * (1 - p));
}

// Animates the rest of the way — off screen (complete) or back into place
// — at roughly the speed the finger was going, so the motion carries on
// from the gesture instead of restarting at some fixed pace.
function settleNav(complete, velocity) {
  const to       = complete ? nav.width : 0;
  const distance = Math.abs(to - nav.x);
  const speed    = Math.max(Math.abs(velocity), 1); // px/ms; the floor keeps a slow release from crawling
  const ms       = Math.round(Math.min(NAV_MAX_MS, Math.max(NAV_MIN_MS, distance / speed)));

  // Commit the current position first, or a transition set up in the
  // same frame as the element was created (the back-button tap) would
  // have nothing to animate from and just jump.
  void pageEl.offsetWidth;
  const t = `transform ${ms}ms ${NAV_EASE}`;
  pageEl.style.transition       = t;
  nav.underlay.style.transition = t;
  nav.dim.style.transition      = `opacity ${ms}ms ${NAV_EASE}`;
  pageEl.style.pointerEvents    = 'none'; // no taps landing on a screen that's on its way out
  setNavOffset(to);

  // A timeout, not transitionend — same reason as the drag settle: a zero-
  // distance settle changes nothing, so transitionend would never fire.
  setTimeout(() => endNavTransition(complete), ms);
}

function endNavTransition(complete) {
  const { parentId, underlay, dim } = nav;
  // All in one go, so the very next frame already shows the finished
  // result: the live page rendered as the parent level at its remembered
  // scroll position — pixel-for-pixel what the copy behind it was showing.
  if (complete) {
    currentCategoryId = parentId;
    render();
    window.scrollTo(0, scrollMemory.get(parentId) ?? 0);
  }
  pageEl.classList.remove('nav-moving');
  pageEl.style.transition    = '';
  pageEl.style.transform     = '';
  pageEl.style.pointerEvents = '';
  underlay.remove();
  dim.remove();
  nav = null;
}
