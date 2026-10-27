// --- Set up the org, browser side (#1420) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// headers(), getJson(), avatar() and render(). The markup comes from
// orgSetupHtml() in wall-org-setup.ts; S.org is the Wall's own read of
// /api/admin/org. Each change is one POST /api/admin/org/chart, then the
// org is read again. The page repaints only when what it shows changed,
// so a refresh never resets a list or a field in use.

export const WALL_ORG_SETUP_SCRIPT = String.raw`
  var OS = { msg: '', bad: false, painted: '' };
  function orgFace(m) { return m.kind === 'person' ? avatar(m.name, 'sm', true) : avatar(m.id, 'sm'); }
  /** Called from the Wall's render() for the setup page. */
  function renderOrgSetup(page) {
    var on = page === 'orgsetup';
    $('wall-orgsetup').hidden = !on;
    if (!on) return;
    var o = S.org;
    var key = JSON.stringify([o && o.exists, o && o.canEdit, o && o.setup, o && o.choices, OS.msg, OS.bad]);
    if (key === OS.painted) return;
    OS.painted = key;
    $('wall-orgsetup').innerHTML = o && o.error
      ? '<p class="ax-wall__empty">Could not read the org chart: ' + esc(o.error) + '. The rest of the Wall still works.</p>'
      : orgSetupHtml(o, { text: OS.msg, bad: OS.bad }, orgFace);
  }
  async function loadOrg() {
    try { S.org = await getJson('/api/admin/org'); }
    catch (e) { S.org = { error: e.message }; }
    render();
  }
  async function orgChange(change, button) {
    if (button) button.disabled = true;
    try {
      var h = headers();
      h['Content-Type'] = 'application/json';
      var r = await fetch('/api/admin/org/chart', { method: 'POST', headers: h, body: JSON.stringify(change) });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      OS.msg = (d.summary || 'Saved') + '. Saved.'; OS.bad = false;
      await loadOrg();
    } catch (e) {
      OS.msg = e.message; OS.bad = true;
      render();
    }
    if (button) button.disabled = false;
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('[data-os]') : null;
    if (!b) return;
    var op = b.getAttribute('data-os');
    if (op === 'add-member') {
      if (!$('wos-add-member').value) return;
      orgChange({ op: op, member: $('wos-add-member').value, role: $('wos-add-role').value }, b);
    } else if (op === 'add-relation') {
      orgChange({ op: op, from: $('wos-rel-from').value, type: $('wos-rel-type').value, to: $('wos-rel-to').value }, b);
    } else if (op === 'set-role') {
      orgChange({ op: op, member: b.getAttribute('data-os-member'), role: $('wos-role-' + b.getAttribute('data-os-i')).value }, b);
    } else if (op === 'remove-member') {
      orgChange({ op: op, member: b.getAttribute('data-os-member') }, b);
    } else if (op === 'remove-relation') {
      orgChange({ op: op, from: b.getAttribute('data-os-from'), type: b.getAttribute('data-os-type'), to: b.getAttribute('data-os-to') }, b);
    }
  });
`

export const WALL_ORG_SETUP_CSS = `
.wos { padding: 4px 16px 32px; }
.wos__lead { margin: 4px 0 8px; color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.wos__msg { min-height: 1.4em; margin: 0 0 4px; font-size: var(--ax-fs-sm); }
.wos__msg.is-bad { color: var(--ax-red-ink, var(--ax-err)); }
.wos__h { display: flex; align-items: baseline; gap: 8px; margin: 18px 0 6px; font-size: var(--ax-fs); }
.wos__form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; margin: 6px 0 10px; }
.wos__form label, .wos__role { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.wos select, .wos input { font: inherit; font-size: var(--ax-fs-sm); min-width: 0; max-width: 100%; padding: 5px 8px; border-radius: var(--ax-radius-sm); border: 1px solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text); }
.wos__rows { list-style: none; margin: 0; padding: 0; }
.wos__row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 10px 0; border-bottom: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); }
.wos__who { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; flex: 1 1 160px; min-width: 0; }
.wos__who .chip { font-size: var(--ax-fs-xs); }
.wos .k { color: var(--ax-muted); }
.wos__role { flex: 0 1 200px; }
.wos__acts { display: flex; gap: 6px; }
.wos__line.is-dotted-line .wos__who .k { font-style: italic; }
.wos__legend { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 18px 0 0; padding: 10px 12px; font-size: var(--ax-fs-sm); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-bg-elev); }
.wos__legend dt { font-weight: 600; }
.wos__legend dd { margin: 0; color: var(--ax-text-2); }
@media (max-width: 640px) {
  .wos { padding: 4px 12px 24px; }
  .wos__form > * { flex: 1 1 100%; }
  .wos__role { flex: 1 1 100%; }
  .wos__legend { grid-template-columns: 1fr; }
  .wos__legend dd { margin-bottom: 4px; }
}
`
