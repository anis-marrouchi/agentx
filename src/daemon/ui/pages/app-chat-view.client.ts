// --- Phone app: Chat rendering and offline cache (window.AXChatView) ---
//
// Loaded before APP_CHAT_SCRIPT. Markdown bubbles (the shared escape-first
// markdownToHtml, injected by app.ts, with its web pictures on), collapsed
// tool badges, the files an answer declared, the `agentx:ui` extras (link
// buttons, a poll, media), a full-screen picture viewer and the IndexedDB
// copy of each conversation, so History opens with no connection.
//
// Everything an agent wrote is escaped or set as text; only http(s) links
// and pictures survive, and links open outside the app. Declared files are
// only ever addressed by their random id under /api/app/files/.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_CHAT_VIEW_SCRIPT = `
window.AXChatView = (function () {
  var NL = String.fromCharCode(10), TAB = String.fromCharCode(9), FENCE = String.fromCharCode(96, 96, 96);
  // Cut a half-written agentx:ui block from a streaming reply so its raw
  // JSON never flashes; the finished reply arrives with it parsed.
  var PREVIEW_CUT = new RegExp('(^|' + NL + ')[ ' + TAB + ']*' + FENCE + '[ ' + TAB + ']*agentx:ui', 'i');
  var KEEP = 100;
  // Pictures shown inline in one answer; more stay links.
  var MAX_PICS = 8;
  var FILE_ID = /^[a-f0-9]{32}$/;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function httpUrl(u) {
    try { var x = new URL(String(u || ''), location.href); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : ''; } catch (e) { return ''; }
  }
  // Also cuts the file lines (<agentx-artifact>) the finished reply lists
  // below it.
  function preview(text) {
    var m = PREVIEW_CUT.exec(text), t = m ? text.slice(0, m.index) : text, k = t.indexOf('<agentx-artifact');
    return k >= 0 ? t.slice(0, k) : t;
  }

  // --- Full-screen pictures: one viewer, built once ---
  var viewer = null, opener = null;
  function closeViewer() {
    if (!viewer || viewer.hidden) return;
    viewer.hidden = true;
    viewer.querySelector('img').removeAttribute('src');
    if (opener && opener.focus) opener.focus();
    opener = null;
  }
  function openViewer(src, alt, from) {
    if (!viewer) {
      viewer = document.createElement('div');
      viewer.className = 'cx-viewer';
      viewer.setAttribute('role', 'dialog');
      viewer.setAttribute('aria-modal', 'true');
      viewer.setAttribute('aria-label', 'Picture');
      var pic = document.createElement('img'), shut = document.createElement('button');
      pic.referrerPolicy = 'no-referrer';
      shut.type = 'button'; shut.className = 'cx-viewer-close'; shut.textContent = 'Close';
      shut.addEventListener('click', closeViewer);
      viewer.addEventListener('click', function (ev) { if (ev.target === viewer) closeViewer(); });
      document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeViewer(); });
      viewer.appendChild(pic); viewer.appendChild(shut);
      document.body.appendChild(viewer);
    }
    var img = viewer.querySelector('img');
    img.src = src; img.alt = alt || '';
    opener = from || null;
    viewer.hidden = false;
    viewer.querySelector('button').focus();
  }
  // A picture as a button that opens it full screen.
  function picture(src, alt) {
    var b = document.createElement('button'), img = document.createElement('img');
    b.type = 'button'; b.className = 'cx-pic';
    b.setAttribute('aria-label', 'Open picture full screen' + (alt ? ': ' + alt : ''));
    img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.alt = alt || ''; img.src = src;
    b.appendChild(img);
    b.addEventListener('click', function () { openViewer(src, alt, b); });
    return b;
  }

  function md(text) {
    var d = document.createElement('div');
    d.className = 'md';
    try { d.innerHTML = markdownToHtml(String(text || ''), { images: MAX_PICS }); } catch (e) { d.textContent = text; }
    Array.prototype.slice.call(d.querySelectorAll('a')).forEach(function (a) {
      var h = /^https?:/i.test(a.getAttribute('href') || '') ? httpUrl(a.getAttribute('href')) : '';
      if (h) { a.href = h; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      else a.replaceWith(document.createTextNode(a.textContent));
    });
    // Web pictures only, checked again here; each opens full screen.
    Array.prototype.slice.call(d.querySelectorAll('img')).forEach(function (img) {
      var raw = img.getAttribute('src') || '', src = /^https?:/i.test(raw) ? httpUrl(raw) : '', alt = img.getAttribute('alt') || '';
      img.replaceWith(src ? picture(src, alt) : document.createTextNode(alt));
    });
    return d;
  }

  // The files an answer declared: pictures inline, sound and video with a
  // player, anything else as an Open link that downloads it.
  function renderFiles(box, files) {
    box.innerHTML = '';
    (files || []).forEach(function (f) {
      if (!f || !FILE_ID.test(String(f.id))) return;
      var url = '/api/app/files/' + f.id, name = String(f.name || 'file'), node;
      if (f.kind === 'image') node = picture(url, name);
      else if (f.kind === 'audio' || f.kind === 'video') {
        node = document.createElement('figure');
        var player = document.createElement(f.kind), cap = document.createElement('figcaption');
        player.controls = true; player.preload = 'metadata'; player.src = url;
        if (f.kind === 'video') player.setAttribute('playsinline', '');
        cap.textContent = name;
        node.appendChild(player); node.appendChild(cap);
      } else {
        node = document.createElement('a');
        node.className = 'cx-ui-btn cx-file'; node.href = url; node.download = name; node.textContent = 'Open ' + name;
      }
      box.appendChild(node);
    });
  }

  function setTools(el, tools) {
    if (!tools || !tools.length) return;
    var box = el.querySelector('.cx-tools');
    if (!box) {
      box = document.createElement('details');
      box.className = 'cx-tools';
      box.innerHTML = '<summary></summary><ul></ul>';
      el.insertBefore(box, el.firstChild);
    }
    var last = tools[tools.length - 1], bad = tools.filter(function (t) { return t.error; }).length;
    box.querySelector('summary').textContent = tools.length + (tools.length === 1 ? ' tool' : ' tools') +
      ' · ' + last.name + (last.arg ? ' (' + last.arg + ')' : '') + (bad ? ' · ' + bad + ' failed' : '');
    box.querySelector('ul').innerHTML = tools.map(function (t) {
      return '<li' + (t.error ? ' class="cx-bad"' : '') + '>' + esc(t.name) + (t.arg ? ' · ' + esc(t.arg) : '') + '</li>';
    }).join('');
  }

  function link(href, label) {
    var a = document.createElement('a');
    a.className = 'cx-ui-btn'; a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = label;
    return a;
  }
  function renderUi(box, ui, send) {
    box.innerHTML = '';
    if (!ui) return;
    var m = ui.media, u = m && httpUrl(m.url);
    if (u) {
      var node;
      if (m.type === 'image') { node = document.createElement('img'); node.loading = 'lazy'; node.alt = m.caption || 'Picture from the agent'; node.referrerPolicy = 'no-referrer'; node.src = u; }
      else if (m.type === 'video' || m.type === 'audio') { node = document.createElement(m.type); node.controls = true; node.preload = 'metadata'; node.src = u; }
      else node = link(u, m.caption || 'Open document');
      box.appendChild(node);
      if (m.caption && node.tagName !== 'A') { var c = document.createElement('p'); c.className = 'cx-note'; c.textContent = m.caption; box.appendChild(c); }
    }
    var btns = (ui.buttons || []).filter(function (b) { return httpUrl(b.url); });
    if (btns.length) {
      var row = document.createElement('div');
      row.className = 'cx-ui-row';
      btns.forEach(function (b) { row.appendChild(link(httpUrl(b.url), b.label)); });
      box.appendChild(row);
    }
    if (ui.poll && ui.poll.options) {
      // A poll answer is simply the next message in the conversation.
      var fs = document.createElement('fieldset'), lg = document.createElement('legend'), opts = document.createElement('div');
      lg.textContent = ui.poll.question; fs.appendChild(lg);
      opts.className = 'cx-ui-row'; fs.appendChild(opts);
      ui.poll.options.forEach(function (o) {
        if (ui.poll.multiple) {
          var l = document.createElement('label'), cb = document.createElement('input');
          cb.type = 'checkbox'; cb.value = o; l.appendChild(cb); l.appendChild(document.createTextNode(o)); opts.appendChild(l);
        } else {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'cx-ui-btn'; b.textContent = o;
          b.addEventListener('click', function () { send(o); });
          opts.appendChild(b);
        }
      });
      if (ui.poll.multiple) {
        var go = document.createElement('button');
        go.type = 'button'; go.className = 'cx-ui-btn'; go.textContent = 'Send answer';
        go.addEventListener('click', function () {
          var picked = Array.prototype.slice.call(fs.querySelectorAll('input:checked')).map(function (i) { return i.value; });
          if (picked.length) send(picked.join(', '));
        });
        fs.appendChild(go);
      }
      box.appendChild(fs);
    }
  }

  // Reads the agentx SSE wire from a fetch body: event: <kind>, data: <json>.
  function readStream(body, onEvent) {
    var reader = body.getReader(), dec = new TextDecoder(), buf = '';
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buf += dec.decode(r.value, { stream: true });
        var i;
        while ((i = buf.indexOf(NL + NL)) >= 0) {
          var rec = buf.slice(0, i), ev = 'message', data = '';
          buf = buf.slice(i + 2);
          rec.split(NL).forEach(function (line) {
            if (line.indexOf('event:') === 0) ev = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
          });
          if (data) { try { onEvent(ev, JSON.parse(data)); } catch (e) {} }
        }
        return pump();
      });
    }
    return pump();
  }

  // --- IndexedDB: whole conversations keyed by id, newest KEEP kept ---
  var dbp = null;
  function db() {
    if (!window.indexedDB) return Promise.reject(new Error('no indexedDB'));
    if (!dbp) dbp = new Promise(function (ok, no) {
      var r = indexedDB.open('agentx-app-chat', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('conversations', { keyPath: 'id' }); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { no(r.error); };
    });
    return dbp;
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (ok) {
        var tx = d.transaction('conversations', mode), req = fn(tx.objectStore('conversations'));
        tx.oncomplete = function () { ok(req && req.result); };
        tx.onerror = tx.onabort = function () { ok(null); };
      });
    }).catch(function () { return null; });
  }
  function cacheAll() {
    return idb('readonly', function (s) { return s.getAll(); }).then(function (a) {
      return (a || []).sort(function (x, y) { return y.updatedAt - x.updatedAt; });
    });
  }
  function cachePut(conv) {
    return idb('readwrite', function (s) { s.put(conv); }).then(cacheAll).then(function (all) {
      var old = all.slice(KEEP);
      if (old.length) return idb('readwrite', function (s) { old.forEach(function (c) { s.delete(c.id); }); });
    });
  }
  function cacheGet(id) { return idb('readonly', function (s) { return s.get(id); }); }
  function cacheDrop(id) { return idb('readwrite', function (s) { s.delete(id); }); }

  return { NL: NL, esc: esc, httpUrl: httpUrl, md: md, preview: preview, setTools: setTools, renderUi: renderUi, renderFiles: renderFiles,
    openViewer: openViewer, closeViewer: closeViewer, readStream: readStream,
    cachePut: cachePut, cacheGet: cacheGet, cacheAll: cacheAll, cacheDrop: cacheDrop };
})();
`
