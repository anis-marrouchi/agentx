// --- The Hub keeps its state across a repaint, browser side (#2101 R21) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure. The Hub reads its data again
// every 60 s and render() rebuilds whole sections with innerHTML, so an
// open <details>, a "show all" list and the scroll position were lost.
// keepSnap() reads them from the page as it is; keepApply() puts them back
// on what render() drew. A section is found again by the id of the box it
// sits in plus its summary text; one that is gone, or new, keeps its own
// default. The scroll comes back only while the page, view and filters are
// the same (the hash), so moving to another page still starts at its top.
// The quick fix of R21 (a); moving the Hub to components is R21 (b).

export const WALL_KEEP_SCRIPT = String.raw`
  function keepBox(el) {
    var b = el.parentNode && el.parentNode.closest ? el.parentNode.closest('[id]') : null;
    return b ? b.id : '';
  }
  function keepKey(d) {
    var s = d.querySelector('summary');
    return keepBox(d) + '|' + (s ? String(s.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '');
  }
  // Elements the reader scrolled inside (a list with its own scroll bar),
  // by the box they sit in and their class.
  var keepScrolled = [];
  // The class from the attribute: on an SVG element className is an object.
  function keepCls(el) { return String((el.getAttribute && el.getAttribute('class')) || ''); }
  function keepScrollKey(el) { return (el.id ? '#' + el.id : keepBox(el) + '|' + keepCls(el)); }
  document.addEventListener('scroll', function (ev) {
    var t = ev.target;
    if (!t || t === document || !t.closest || !t.closest('.ax-wall') || keepScrolled.indexOf(t) >= 0) return;
    keepScrolled.push(t);
    if (keepScrolled.length > 20) keepScrolled.shift();
  }, true);
  function keepFind(sel, key, keyOf) {
    var all = document.querySelectorAll(sel);
    for (var i = 0; i < all.length; i++) if (keyOf(all[i]) === key) return all[i];
    return null;
  }
  // A fold that keeps its own open state: the side tree's (data-lt-key) and
  // any marked data-keep-own (the Agents Sheet's folds, which open on an error).
  function keepOwn(d) { return d.hasAttribute('data-lt-key') || d.hasAttribute('data-keep-own'); }
  function keepSnap(where) {
    var k = { where: where, y: window.scrollY || 0, open: {}, lists: {}, inner: [] };
    document.querySelectorAll('.ax-wall details').forEach(function (d) { if (!keepOwn(d)) k.open[keepKey(d)] = !!d.open; });
    document.querySelectorAll('.ax-wall [data-more-list]').forEach(function (l) {
      if (!l.hidden) k.lists[keepBox(l) + '|' + l.getAttribute('data-more-list')] = true;
    });
    keepScrolled.forEach(function (el) { if (el.scrollTop > 0) k.inner.push({ key: keepScrollKey(el), cls: keepCls(el), top: el.scrollTop }); });
    return k;
  }
  function keepApply(k, where) {
    document.querySelectorAll('.ax-wall details').forEach(function (d) {
      if (keepOwn(d)) return;
      var was = k.open[keepKey(d)];
      if (was === true && !d.open) d.open = true;
      else if (was === false && d.open) d.open = false;
    });
    document.querySelectorAll('.ax-wall [data-more-list]').forEach(function (l) {
      if (!l.hidden || !k.lists[keepBox(l) + '|' + l.getAttribute('data-more-list')]) return;
      l.hidden = false;
      var b = l.parentNode && l.parentNode.querySelector('[data-more="' + l.getAttribute('data-more-list') + '"]');
      if (b) b.textContent = b.textContent.replace('show all', 'hide');
    });
    if (where !== k.where) return;
    keepScrolled = [];
    k.inner.forEach(function (s) {
      var sel = s.key.charAt(0) === '#' ? s.key : '.ax-wall ' + String(s.cls).trim().split(/\s+/).map(function (c) { return '.' + c; }).join('');
      var el = s.key.charAt(0) === '#' ? document.getElementById(s.key.slice(1)) : (s.cls ? keepFind(sel, s.key, keepScrollKey) : null);
      if (el && el.scrollTop !== s.top) { el.scrollTop = s.top; keepScrolled.push(el); }
    });
    if ((window.scrollY || 0) !== k.y && window.scrollTo) window.scrollTo(0, k.y);
  }
  /** Runs paint() and keeps what the reader opened and where they were.
   *  Keeping is a nicety: if it fails the page still draws with its
   *  defaults, and render() never throws because of it (Hakim C2). */
  function keepState(paint) {
    var where = String(location.hash || '') + '|' + S.page + '|' + S.post + '|' + S.view;
    var k = null;
    try { k = keepSnap(S.keepWhere); } catch (e) { keepFailed('snap', e); }
    try { return paint(); } finally {
      S.keepWhere = where;
      if (k) { try { keepApply(k, where); } catch (e) { keepFailed('apply', e); } }
    }
  }
  function keepFailed(step, e) {
    try { if (window.console && console.warn) console.warn('[hub] keep ' + step + ' skipped: ' + String(e && e.message || e)); } catch (_) { /* no console */ }
  }
`
