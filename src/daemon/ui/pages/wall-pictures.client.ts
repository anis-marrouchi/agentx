// --- Profile pictures on the Wall (#1425) ---
//
// An agent's profile and a person on the People page show Upload, Replace
// and Remove picture for the members this machine keeps: /api/admin/pictures
// says which (`editable`). An agent on another machine keeps its picture
// there, so its profile has no buttons here. Writes go to PUT and DELETE
// /api/admin/pictures/<agent|person>/<id>, behind the dashboard token
// (pictures-panel.ts): only the owner reaches them. The rules are checked
// here for a quick answer; the server decides.

export const WALL_PICTURES_SCRIPT = String.raw`
  var PIC_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  function picKind(person) { return person ? 'person' : 'agent'; }
  function canEditPicture(id, person) {
    var e = S.pics && S.pics.editable;
    return !!(e && e[picKind(person)] && e[picKind(person)].indexOf(id) >= 0);
  }
  function picName(kind, id) { return kind === 'person' ? personName(id) : nameOf(id); }
  /** The picture buttons for an agent or a person; '' when this machine does not keep them. */
  function pictureActsHtml(id, person) {
    if (!canEditPicture(id, person)) return '';
    var kind = picKind(person), has = !!pictureOf(id, person), note = S.picNote && S.picNote.kind === kind && S.picNote.id === id ? S.picNote.text : '';
    return '<div class="wpc-pic"><label class="ax-btn ax-btn--ghost wpc-pic__file">' + (has ? 'Replace picture' : 'Upload picture') +
        '<input type="file" accept="image/png,image/jpeg,image/webp" data-pic-set="' + esc(id) + '" data-pic-kind="' + kind + '" aria-label="Picture for ' + esc(picName(kind, id)) + ': PNG, JPEG or WebP, 1 MB at most"></label>' +
      (has ? '<button type="button" class="ax-btn ax-btn--ghost" data-pic-remove="' + esc(id) + '" data-pic-kind="' + kind + '">Remove picture</button>' : '') +
      '<span class="wdo__n" role="status" aria-live="polite">' + esc(note) + '</span></div>';
  }
  async function reloadPictures() {
    try { S.pics = await getJson('/api/admin/pictures'); } catch (e) { /* keep what is shown */ }
  }
  async function pictureWrite(method, kind, id, file) {
    var h = headers();
    if (file) h['Content-Type'] = file.type || 'application/octet-stream';
    try {
      var r = await fetch('/api/admin/pictures/' + kind + '/' + encodeURIComponent(id), { method: method, headers: h, body: file || undefined });
      var b = await r.json().catch(function () { return {}; });
      return r.ok ? { ok: true } : { ok: false, error: b.error || ('HTTP ' + r.status) };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  function refocusPicture(kind, id) {
    var again = document.querySelector('[data-pic-set="' + id + '"][data-pic-kind="' + kind + '"]');
    if (again) again.focus();
  }
  async function setPictureOf(kind, id, file) {
    var bad = PIC_TYPES.indexOf(file.type) < 0 ? 'Use a PNG, JPEG or WebP picture' + (file.type === 'image/svg+xml' ? ': SVG is not accepted.' : '.')
      : file.size > 1048576 ? 'The picture is ' + (file.size / 1048576).toFixed(1) + ' MB; the limit is 1 MB.' : '';
    if (bad) { S.picNote = { kind: kind, id: id, text: bad }; render(); return; }
    S.picNote = { kind: kind, id: id, text: 'Saving…' }; render();
    var r = await pictureWrite('PUT', kind, id, file);
    if (r.ok) await reloadPictures();
    S.picNote = { kind: kind, id: id, text: r.ok ? 'Picture set.' : 'Not set: ' + r.error };
    render();
    refocusPicture(kind, id);
  }
  async function removePictureOf(kind, id) {
    if (!window.confirm('Remove the picture of ' + picName(kind, id) + '? The initials show again.')) return;
    var r = await pictureWrite('DELETE', kind, id);
    if (r.ok) await reloadPictures();
    S.picNote = { kind: kind, id: id, text: r.ok ? 'Picture removed.' : 'Not removed: ' + r.error };
    render();
    refocusPicture(kind, id);
  }
  document.addEventListener('change', function (ev) {
    var input = ev.target.closest ? ev.target.closest('input[data-pic-set]') : null;
    if (!input || !input.files || !input.files[0]) return;
    var file = input.files[0];
    input.value = '';
    setPictureOf(input.getAttribute('data-pic-kind'), input.getAttribute('data-pic-set'), file);
  });
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('[data-pic-remove]') : null;
    if (b) removePictureOf(b.getAttribute('data-pic-kind'), b.getAttribute('data-pic-remove'));
  });
`
export const WALL_PICTURES_CSS = `
/* Picture buttons on an agent's profile (#1425); the file input stays focusable. */
.wpc-pic { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.wpc-pic .ax-btn { font-size: var(--ax-fs-xs); padding: 4px 14px; }
.wpc-pic__file { position: relative; cursor: pointer; }
.wpc-pic__file input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.wpc-pic__file:focus-within { outline: 2px solid var(--ax-accent); outline-offset: 2px; }
`
