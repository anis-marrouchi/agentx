// --- Phone app: Chat rendering and offline cache (window.AXChatView) ---
//
// Loaded before APP_CHAT_SCRIPT. Markdown bubbles (the shared escape-first
// markdownToHtml, injected by app.ts), collapsed tool badges, the
// `agentx:ui` extras (link buttons, a poll, media) and the IndexedDB copy of
// each conversation, so History opens with no connection.
//
// Everything an agent wrote is escaped or set as text; only http(s) links
// survive, and they open outside the app.
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

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function httpUrl(u) {
    try { var x = new URL(String(u || ''), location.href); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : ''; } catch (e) { return ''; }
  }
  function preview(text) { var m = PREVIEW_CUT.exec(text); return m ? text.slice(0, m.index) : text; }

  function md(text) {
    var d = document.createElement('div');
    d.className = 'md';
    try { d.innerHTML = markdownToHtml(String(text || '')); } catch (e) { d.textContent = text; }
    Array.prototype.slice.call(d.querySelectorAll('a')).forEach(function (a) {
      var h = /^https?:/i.test(a.getAttribute('href') || '') ? httpUrl(a.getAttribute('href')) : '';
      if (h) { a.href = h; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      else a.replaceWith(document.createTextNode(a.textContent));
    });
    return d;
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

  return { NL: NL, esc: esc, httpUrl: httpUrl, md: md, preview: preview, setTools: setTools, renderUi: renderUi, readStream: readStream,
    cachePut: cachePut, cacheGet: cacheGet, cacheAll: cacheAll, cacheDrop: cacheDrop };
})();
`
