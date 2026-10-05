// --- Phone app: swipe between tabs (#444) ---
//
// Inlined into /app after the tab script. A sideways swipe on the page pulls
// the next or the previous tab in under the finger and lands on it when the
// finger lifts far enough or fast enough; the rules are in
// app-swipe-logic.ts.
//
// The other tab scripts read `panel.hidden` to know which tab is on screen,
// and refresh on a tab `click`. So the neighbour is shown during the drag by
// a class, with `hidden` left alone, and landing clicks the tab: one way to
// change tab, whether by tap, key or swipe.
//
// With reduced motion nothing follows the finger and nothing slides; a
// completed swipe changes the tab at once.
//
// A touch keeps sending its events to the node it started on, even after a
// redraw has taken that node out of the page; then nothing reaches <main>
// and the page would stay half-dragged. A watcher on <main> notices the
// node going and lands the swipe where the finger was.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_SWIPE_SCRIPT = `
(function () {
  var main = document.querySelector('main');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role=tab]'));
  if (!main || tabs.length < 2) return;
  var reduce = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  var tabBar = document.querySelector('.tabs');
  var SLIDE_MS = 220;
  var g = null;        // the touch being followed
  var sliding = false; // the landing slide is running

  function still() { return !!(reduce && reduce.matches); }
  function panelOf(i) { return document.getElementById(tabs[i].getAttribute('aria-controls')); }
  function current() {
    for (var i = 0; i < tabs.length; i++) if (tabs[i].getAttribute('aria-selected') === 'true') return i;
    return 0;
  }
  function pathFrom(el) {
    var path = [];
    for (; el && el !== main; el = el.parentElement) {
      var cs = getComputedStyle(el);
      path.push({
        tag: el.tagName, touchAction: cs.touchAction, editable: el.isContentEditable,
        scrollsX: (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1,
      });
    }
    return path;
  }

  function unpeek() {
    if (!g.peek) return;
    g.peek.classList.remove('sw-peek');
    g.peek.style.top = '';
    g.peek.style.transform = '';
    g.peek = null;
  }
  // Show the tab on the side the finger is pulling from, beside this one.
  function peek(side) {
    if (g.side === side) return;
    unpeek();
    g.side = side;
    var i = g.index + side;
    if (i < 0 || i >= tabs.length) return;
    g.peek = panelOf(i);
    g.peek.style.top = main.scrollTop + 'px';
    g.peek.classList.add('sw-peek');
  }
  function place(x) {
    tabBar.style.setProperty('--tab-position', String(g.index - x / g.width));
    g.from.style.transform = 'translateX(' + x + 'px)';
    if (g.peek) g.peek.style.transform = 'translateX(' + (x + g.side * g.width) + 'px)';
  }
  // px per ms over the last moment of the touch, so a finger that rests
  // before it lifts is not a flick.
  function speed() {
    var now = Date.now();
    while (g.trail.length && now - g.trail[0].t > 120) g.trail.shift();
    var a = g.trail[0];
    return a && now > a.t ? (g.dx - a.dx) / (now - a.t) : 0;
  }
  function finish(to) {
    var s = g;
    main.classList.remove('sw-on', 'sw-slide');
    s.from.style.transform = '';
    unpeek();
    g = null;
    sliding = false;
    tabBar.style.setProperty('--tab-position', String(to));
    if (to === s.index) return;
    tabs[to].click();
    main.scrollTop = 0;
  }
  function end(cancelled) {
    if (!g || sliding) return;
    if (g.axis !== 'x') { g = null; return; }
    var to = cancelled ? g.index : swipeLanding(g.index, tabs.length, g.dx, g.width, speed());
    if (still()) { finish(to); return; }
    sliding = true;
    main.classList.add('sw-slide');
    place(to === g.index ? 0 : (to > g.index ? -g.width : g.width));
    setTimeout(function () { finish(to); }, SLIDE_MS + 30);
  }

  main.addEventListener('touchstart', function (ev) {
    if (sliding) return;
    if (g) { end(true); return; } // a second finger: let go
    if (ev.touches.length !== 1 || !swipeMayStart(pathFrom(ev.target))) return;
    var t = ev.touches[0];
    g = { x: t.clientX, y: t.clientY, trail: [{ dx: 0, t: Date.now() }], axis: '', dx: 0, side: 0, peek: null, index: current(), target: ev.target };
  }, { passive: true });
  // The touched node left the page: its events no longer arrive here.
  if (window.MutationObserver) {
    new window.MutationObserver(function () {
      if (!g || sliding || !g.target || main.contains(g.target)) return;
      if (g.axis === 'x') end(false); else g = null;
    }).observe(main, { childList: true, subtree: true });
  }
  main.addEventListener('touchmove', function (ev) {
    if (!g || sliding) return;
    var t = ev.touches[0], dx = t.clientX - g.x;
    if (!g.axis) {
      g.axis = swipeAxis(dx, t.clientY - g.y);
      if (g.axis === 'y') { g = null; return; }
      if (!g.axis) return;
      g.width = main.clientWidth;
      g.from = panelOf(g.index);
      main.classList.add('sw-on');
    }
    if (ev.cancelable) ev.preventDefault();
    g.dx = dx;
    g.trail.push({ dx: dx, t: Date.now() });
    if (g.trail.length > 8) g.trail.shift();
    if (still()) return;
    peek(dx < 0 ? 1 : -1);
    place(swipeOffset(g.index, tabs.length, dx));
  }, { passive: false });
  main.addEventListener('touchend', function () { end(false); });
  main.addEventListener('touchcancel', function () { end(true); });
})();
`

// The neighbour keeps its `hidden` attribute while it is pulled in; the class
// shows it, laid over the page at the height the owner has scrolled to.
export const APP_SWIPE_CSS = `
main { position: relative; }
main.sw-on { overflow: hidden; }
.sw-on > [role=tabpanel] { will-change: transform; }
.sw-slide > [role=tabpanel] { transition: transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1); }
main > .sw-peek {
  display: block; position: absolute; left: 0; right: 0; box-sizing: border-box; min-height: 100%;
  padding: 16px calc(16px + env(safe-area-inset-right)) 16px calc(16px + env(safe-area-inset-left));
}
main > #panel-chat.sw-peek { display: flex; flex-direction: column; }
@media (prefers-reduced-motion: reduce) { .sw-slide > [role=tabpanel] { transition: none; } }
`
