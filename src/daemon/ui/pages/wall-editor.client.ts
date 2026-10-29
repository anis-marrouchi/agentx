// --- Wall workflow editor page, browser side (#1524) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), writeHash() and render().
//
// The workflow editor is a Wall page now, not a tool page of its own:
// #page=editor&e-wf=<id> opens a workflow, #page=editor&e-new=1 starts a new
// one, and /workflows/editor?id=… redirects here (classic-routes.ts). The
// Workflows page's "Open in the editor" and "New workflow" open it in the
// same tab.
//
// The page has two columns: the Wall's nav, folded to its icons, and the
// editor, which has its own two (a side menu that folds away and the
// canvas). The editor is the React bundle in src/web/workflow-editor/,
// loaded the first time the page opens (window.AX_WALL_EDITOR.src) and
// mounted with window.AXWorkflowEditor.mount. It stays mounted while the
// page is open: the Wall's render() runs on every refresh, and only a
// different workflow mounts it again.
//
// Leaving with unsaved changes asks first; saying no returns to the
// editor. Saves and deletes go to /api/workflows, which only the owner may
// write (board-dashboard.ts); a viewer who is not the owner gets the editor
// to look at, with no Save.
//
// renderEditor(page) is the one call the Wall's render() makes; it returns
// false when the owner chose to stay, and the Wall then paints nothing else.

export const WALL_EDITOR_SCRIPT = String.raw`
  S.wed = { wf: '', isNew: false };
  var WED = { editor: null, key: '', hash: '', dirty: false, loading: false, failed: '' };
  function wedRead(q) { S.wed.wf = q.get('e-wf') || ''; S.wed.isNew = q.get('e-new') === '1'; }
  function wedWrite(q) { if (S.wed.wf) q.set('e-wf', S.wed.wf); if (S.wed.isNew) q.set('e-new', '1'); }
  function wedCfg() { return window.AX_WALL_EDITOR || {}; }

  /** The bundle, once: a script tag, then the ready event (main.tsx). */
  function wedLoad(done) {
    if (window.AXWorkflowEditor) { done(); return; }
    document.addEventListener('ax:workflow-editor-ready', function () { done(); }, { once: true });
    if (WED.loading) return;
    WED.loading = true;
    var s = document.createElement('script');
    s.src = wedCfg().src || '/assets/workflow-editor.global.js';
    s.onerror = function () { WED.loading = false; WED.failed = 'The editor could not be loaded. Refresh the page to try again.'; render(); };
    document.head.appendChild(s);
  }

  function wedUnmount() {
    if (!WED.editor) return;
    try { WED.editor.unmount(); } catch (e) { /* already gone */ }
    WED.editor = null; WED.key = ''; WED.dirty = false;
    $('wall-editor').innerHTML = '';
  }

  /** Back to Workflows, with this workflow open unless it was deleted. */
  function wedBack(gone) {
    location.hash = '#page=workflows' + (S.wed.wf && !S.wed.isNew && !gone ? '&w-open=' + encodeURIComponent(S.wed.wf) : '');
  }

  function wedMount(key) {
    $('wall-editor').innerHTML = '<div class="wed__root" id="wall-editor-root"></div>';
    WED.key = key;
    WED.editor = window.AXWorkflowEditor.mount($('wall-editor-root'), {
      workflowId: S.wed.wf || 'new-workflow',
      isNew: S.wed.isNew,
      owner: !!wedCfg().owner,
      onBack: wedBack,
      onDirty: function (d) { WED.dirty = !!d; },
      // A new workflow saved for the first time: the link names it now.
      onSaved: function (id) {
        S.wed.wf = id; S.wed.isNew = false;
        WED.key = 'wf:' + id;
        writeHash();
        WED.hash = location.hash;
      },
    });
  }

  function renderEditor(page) {
    var on = page === 'editor', host = $('wall-editor');
    host.hidden = !on;
    document.querySelector('.ax-wall').classList.toggle('is-editor', on);
    if (!on) {
      if (WED.editor && WED.dirty && !window.confirm('This workflow has changes that are not saved. Leave without saving?')) {
        location.hash = WED.hash;
        return false;
      }
      wedUnmount();
      return true;
    }
    WED.hash = location.hash;
    var key = S.wed.isNew ? 'new:' + S.wed.wf : 'wf:' + S.wed.wf;
    if (!S.wed.isNew && !S.wed.wf) {
      wedUnmount();
      host.innerHTML = '<p class="ax-wall__empty wed__msg">No workflow named. Open one from <a href="#page=workflows">Workflows</a>, or start a <a href="#page=editor&amp;e-new=1">new workflow</a>.</p>';
      return true;
    }
    if (WED.editor && WED.key === key) return true;
    if (WED.failed) { host.innerHTML = '<p class="ax-wall__empty wed__msg" role="alert">' + esc(WED.failed) + '</p>'; return true; }
    if (WED.editor) {
      if (WED.dirty && !window.confirm('This workflow has changes that are not saved. Open the other one anyway?')) return true;
      wedUnmount();
    }
    if (!window.AXWorkflowEditor) host.innerHTML = '<p class="ax-wall__empty wed__msg">Loading the editor…</p>';
    wedLoad(function () {
      // The page may have changed while the bundle loaded.
      if (S.page !== 'editor' || WED.editor) return;
      wedMount(S.wed.isNew ? 'new:' + S.wed.wf : 'wf:' + S.wed.wf);
    });
    return true;
  }
`

export const WALL_EDITOR_CSS = `
/* The editor page (#1524): the nav folds to its icons, the side column and
   the Wall's header go, and the editor takes the rest of the screen. */
.ax-wall.is-editor { grid-template-columns: 72px minmax(0, 1fr); justify-content: stretch; }
.ax-wall.is-editor .ax-wall__aside, .ax-wall.is-editor .ax-wall__head, .ax-wall.is-editor .ax-wall__newpost { display: none; }
.ax-wall.is-editor .ax-wall__main { grid-row: 1; border-right: 0; border-top: 0; margin-top: 0; min-height: 0; }
.ax-wall.is-editor .ax-wall__nav { padding: 12px 8px; align-items: center; }
.ax-wall.is-editor .ax-wall__logo small, .ax-wall.is-editor .ax-wall__item span, .ax-wall.is-editor .ax-wall__navfoot { display: none; }
.ax-wall.is-editor .ax-wall__logo { padding: 8px 0 16px; }
.ax-wall.is-editor .ax-wall__nav > .ax-wall__navlbl { font-size: 0; padding: 0; height: 1px; width: 32px; background: var(--ax-border-2); margin: 8px 0; }
.ax-wall.is-editor .ax-wall__n { position: absolute; top: 4px; right: 0; min-width: 18px; line-height: 18px; padding: 0 4px; font-size: 11px; }
.ax-wall.is-editor .ax-wall__n.is-zero { display: none; }
#wall-editor { height: 100vh; height: 100dvh; display: flex; flex-direction: column; }
#wall-editor .wed__root { flex: 1; min-height: 0; }
.wed__msg { padding: 48px 16px; text-align: center; }
@media (max-width: 640px) {
  .ax-wall.is-editor { grid-template-columns: minmax(0, 1fr); }
  .ax-wall.is-editor .ax-wall__main { grid-column: 1; }
  .ax-wall.is-editor .ax-wall__nav { padding: 0 4px; align-items: stretch; }
  /* Above the phone's bottom bar. */
  #wall-editor { height: calc(100vh - 56px); height: calc(100dvh - 56px); }
}
`
