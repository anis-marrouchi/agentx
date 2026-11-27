// --- Behaviour of the shared primitives (Hub review S3, components.ts) ---
//
// One script for every page drawn by renderShell (shell.ts):
//   - [data-tip]: one tooltip above the control after 600ms, at once on
//     keyboard focus, with a shortcut chip from data-tip-key (C14).
//   - .ax-menu: the row `...` menu opens from its trigger, arrow keys move,
//     Esc, Tab, a pick or a click outside close it (C12).
//   - .ax-tabs: click, arrow keys, Home and End select a tab (C16).
//   - window.axConfirm({ title, body, action }): a confirm dialog with a
//     ghost Cancel and a destructive action; Esc cancels. Resolves true
//     only when the action is chosen (C13, C11).
// Everything is delegated from document, so pages that redraw their HTML
// need no wiring.

export const AX_COMPONENTS_SCRIPT = String.raw`<script>
(function () {
  // --- Tooltip ---
  var tip = null, next = null, timer = 0;
  function key(k) { return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' + k : 'Ctrl+' + k; }
  function tipHide() { clearTimeout(timer); next = null; if (tip) tip.hidden = true; }
  function tipShow(el) {
    if (!el.isConnected) return;
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'ax-tip';
      tip.setAttribute('aria-hidden', 'true');
      document.body.appendChild(tip);
    }
    tip.textContent = el.getAttribute('data-tip');
    var k = el.getAttribute('data-tip-key');
    if (k) { var kbd = document.createElement('kbd'); kbd.textContent = key(k); tip.appendChild(kbd); }
    tip.hidden = false;
    var b = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    var top = b.top - h - 4, side = 'top';
    if (top < 8) { top = b.bottom + 4; side = 'bottom'; }
    tip.setAttribute('data-side', side);
    tip.style.top = top + 'px';
    tip.style.left = Math.max(8, Math.min(b.left + b.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
  }
  document.addEventListener('pointerover', function (ev) {
    if (ev.pointerType === 'touch') return;
    var el = ev.target.closest && ev.target.closest('[data-tip]');
    if (el === next) return;
    tipHide();
    if (!el) return;
    next = el;
    timer = setTimeout(function () { tipShow(el); }, 600);
  });
  document.addEventListener('focusin', function (ev) {
    var el = ev.target.closest && ev.target.closest('[data-tip]');
    tipHide();
    if (el && el.matches(':focus-visible')) { next = el; tipShow(el); }
  });
  document.addEventListener('focusout', tipHide);
  document.addEventListener('pointerdown', tipHide);

  // --- Row ... menu ---
  var menu = null;
  function menuItems() { return Array.prototype.slice.call(menu.content.querySelectorAll('[role=menuitem]')); }
  function menuClose(refocus) {
    if (!menu) return;
    var m = menu; menu = null;
    m.content.hidden = true;
    m.btn.setAttribute('aria-expanded', 'false');
    if (refocus) m.btn.focus();
  }
  function menuOpen(btn) {
    var content = btn.parentElement.querySelector('.ax-menu__content');
    if (!content) return;
    menuClose(false); tipHide();
    menu = { btn: btn, content: content };
    btn.setAttribute('aria-expanded', 'true');
    content.hidden = false;
    var b = btn.getBoundingClientRect(), w = content.offsetWidth, h = content.offsetHeight;
    var up = b.bottom + 4 + h > innerHeight - 8 && b.top - 4 - h > 8;
    content.style.top = (up ? b.top - 4 - h : b.bottom + 4) + 'px';
    content.style.left = Math.max(8, b.right - w) + 'px';
    content.style.transformOrigin = (up ? 'bottom' : 'top') + ' right';
    var first = menuItems()[0];
    if (first) first.focus();
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('.ax-menu > [aria-haspopup=menu]');
    if (t) { if (menu && menu.btn === t) menuClose(true); else menuOpen(t); return; }
    if (!menu) return;
    var item = ev.target.closest && ev.target.closest('[role=menuitem]');
    if (item && menu.content.contains(item)) menuClose(true);
    else if (!menu.content.contains(ev.target)) menuClose(false);
  });
  document.addEventListener('scroll', function (ev) {
    tipHide();
    if (menu && !menu.content.contains(ev.target)) menuClose(false);
  }, true);

  // --- Tabs ---
  function tabSelect(tab) {
    var list = tab.closest('.ax-tabs');
    var changed = tab.getAttribute('aria-selected') !== 'true';
    list.querySelectorAll('[role=tab]').forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      var panel = t.getAttribute('aria-controls');
      panel = panel && document.getElementById(panel);
      if (panel) panel.hidden = !on;
    });
    tab.focus();
    if (changed) list.dispatchEvent(new CustomEvent('ax-tab', { bubbles: true, detail: { value: tab.getAttribute('data-value') } }));
  }
  document.addEventListener('click', function (ev) {
    var tab = ev.target.closest && ev.target.closest('.ax-tabs > [role=tab]');
    if (tab) tabSelect(tab);
  });

  // --- Keys for the menu and the tabs ---
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') tipHide();
    if (menu && menu.content.contains(ev.target)) {
      var items = menuItems(), i = items.indexOf(ev.target), n = items.length;
      if (ev.key === 'Escape') { ev.preventDefault(); menuClose(true); }
      else if (ev.key === 'Tab') menuClose(false);
      else if (n && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) { ev.preventDefault(); items[(i + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n].focus(); }
      else if (n && (ev.key === 'Home' || ev.key === 'End')) { ev.preventDefault(); items[ev.key === 'Home' ? 0 : n - 1].focus(); }
      return;
    }
    var tab = ev.target.closest && ev.target.closest('.ax-tabs > [role=tab]');
    if (!tab) return;
    var tabs = Array.prototype.slice.call(tab.parentElement.querySelectorAll('[role=tab]'));
    var j = tabs.indexOf(tab), m = tabs.length, to = -1;
    if (ev.key === 'ArrowRight') to = (j + 1) % m;
    else if (ev.key === 'ArrowLeft') to = (j + m - 1) % m;
    else if (ev.key === 'Home') to = 0;
    else if (ev.key === 'End') to = m - 1;
    if (to < 0) return;
    ev.preventDefault();
    tabSelect(tabs[to]);
  });

  // --- Confirm dialog ---
  window.axConfirm = function (o) {
    return new Promise(function (done) {
      var d = document.createElement('dialog'), ok = false;
      d.className = 'ax-dialog';
      d.setAttribute('data-slot', 'dialog');
      d.setAttribute('role', 'alertdialog');
      d.setAttribute('aria-labelledby', 'ax-dialog-t');
      d.innerHTML = '<h2 class="ax-dialog__t" id="ax-dialog-t"></h2>' +
        (o.body ? '<p class="ax-dialog__d" id="ax-dialog-d"></p>' : '') +
        '<div class="ax-dialog__f"><button type="button" class="ax-btn ax-btn--ghost" data-slot="button">Cancel</button>' +
        '<button type="button" class="ax-btn ax-btn--danger" data-slot="button"></button></div>';
      d.querySelector('.ax-dialog__t').textContent = o.title;
      if (o.body) { d.querySelector('.ax-dialog__d').textContent = o.body; d.setAttribute('aria-describedby', 'ax-dialog-d'); }
      var b = d.querySelectorAll('.ax-dialog__f > button');
      b[1].textContent = o.action;
      b[0].onclick = function () { d.close(); };
      b[1].onclick = function () { ok = true; d.close(); };
      // Esc fires "cancel" and closes the dialog; every way out ends here.
      d.addEventListener('close', function () { d.remove(); done(ok); });
      document.body.appendChild(d);
      d.showModal();
      b[0].focus();
    });
  };
})();
</script>`
