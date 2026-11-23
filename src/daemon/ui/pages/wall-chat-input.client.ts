// --- Hub chat: the ask box, with files and the mic (#2101 PR 2, R14) ---
//
// The ask box keeps what the widget does: type, attach files, record a
// voice message. A file goes up as soon as it is picked
// (POST /api/assistant/upload, kept on the node that runs the agent) and
// shows as a chip until the message is sent. The mic records in the
// browser; the recording is written down by the widget's and the phone's
// code (POST /api/assistant/voice/transcribe → app-voice.ts transcribeVia),
// the transcript is sent as the message, so it stays in the thread, and
// the answer is said back in the agent's voice
// (POST /api/assistant/voice/speak → app-voice.ts speakVia). The
// push-to-talk key and voice commands are #2108, not here.
//
// It talks to the chat (wall-chat.client.ts) through window.AXHubChat:
// send(text, {spoken}), node(), agent(), headers(); it sets attachments(),
// onSent() and onSpokenAnswer(answer) there.

/** Files one message may carry (assistant-upload.ts ATTACH_MAX). */
const ATTACH_MAX = 5

const ICON_CLIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15.5 7.6"/></svg>'
const ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>'

/** The composer row: files, the message, the mic and Send. */
export function wallChatInputHtml(): string {
  return `<div class="hc__files hc__files--draft" id="hc-files" hidden></div>
      <p class="hc__voice" id="hc-voice" role="status" hidden></p>
      <div class="hc__row"><button type="button" class="hc__tool" id="hc-attach" aria-label="Attach files" title="Attach files">${ICON_CLIP}</button><input type="file" id="hc-file" multiple hidden>` +
    `<textarea id="hc-text" rows="1" maxlength="4000" placeholder="Message…" aria-label="Message"></textarea>` +
    `<button type="button" class="hc__tool" id="hc-mic" aria-label="Record a voice message" aria-pressed="false" title="Record a voice message" hidden>${ICON_MIC}</button>` +
    `<button class="ax-btn" id="hc-send" type="submit">Send</button></div>`
}

export const WALL_CHAT_INPUT_SCRIPT = String.raw`
// The Hub chat's ask box: files and the mic (wall-chat-input.client.ts).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.AXHubChat;
  if (!api || !$('hc-form') || !$('hc-attach')) return;
  var ATTACH_MAX = ${ATTACH_MAX};
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function say(text, err) {
    var p = $('hc-voice');
    p.textContent = text || '';
    p.hidden = !text;
    p.className = 'hc__voice' + (err ? ' is-err' : '');
  }

  // --- Files: each goes up when picked, then waits as a chip ---
  var files = [], uploading = 0;
  function paintFiles() {
    var box = $('hc-files');
    box.innerHTML = files.map(function (f, i) {
      return '<span class="hc__file' + (f.path ? '' : ' is-wait') + '">' + esc(f.name) + (f.path ? '' : ' …') +
        '<button type="button" data-hc-unattach="' + i + '" aria-label="Remove ' + esc(f.name) + '">×</button></span>';
    }).join('');
    box.hidden = !files.length;
  }
  function upload(file) {
    var entry = { name: file.name || 'file', path: '' };
    files.push(entry); uploading++; paintFiles();
    var q = new URLSearchParams();
    q.set('agent', api.agent()); q.set('name', entry.name);
    var node = api.node(); if (node) q.set('node', node);
    return fetch('/api/assistant/upload?' + q.toString(), {
      method: 'POST', headers: api.headers({ 'Content-Type': 'application/octet-stream' }), body: file,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || !d.path) throw new Error(d.error || ('HTTP ' + r.status));
        entry.path = d.path; entry.name = d.name || entry.name;
      });
    }).catch(function (e) {
      files = files.filter(function (f) { return f !== entry; });
      say('Not attached: ' + entry.name + ' (' + (e && e.message || 'failed') + ')', true);
    }).then(function () { uploading--; paintFiles(); });
  }
  $('hc-attach').addEventListener('click', function () {
    if (!api.agent()) { say('Pick an agent first.', true); return; }
    $('hc-file').click();
  });
  $('hc-file').addEventListener('change', function () {
    var list = Array.prototype.slice.call($('hc-file').files || []);
    var room = ATTACH_MAX - files.length;
    if (list.length > room) say('A message carries ' + ATTACH_MAX + ' files at most.', true);
    else say('');
    list.slice(0, Math.max(0, room)).forEach(upload);
    $('hc-file').value = '';
  });
  $('hc-files').addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-hc-unattach]') : null;
    if (!b) return;
    files.splice(Number(b.getAttribute('data-hc-unattach')), 1);
    paintFiles();
  });
  api.attachments = function () {
    return files.filter(function (f) { return f.path; }).map(function (f) { return { name: f.name, path: f.path }; });
  };
  api.uploading = function () { return uploading > 0; };
  api.onSent = function () { files = []; paintFiles(); say(''); };

  // The answer to a spoken message is said back in the agent's voice; the
  // node answers with audio, or asks the browser to say it.
  var player = null;
  api.onSpokenAnswer = function (a) {
    fetch('/api/assistant/voice/speak', {
      method: 'POST', headers: api.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ threadId: a.threadId, node: a.node || undefined, text: a.text }),
    }).then(function (r) {
      var type = (r.headers && r.headers.get && r.headers.get('Content-Type')) || '';
      if (r.ok && type.indexOf('audio/') === 0) {
        return r.blob().then(function (b) {
          if (player) player.pause();
          player = new Audio(URL.createObjectURL(b));
          return player.play();
        });
      }
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (d.fallback === 'browser' && window.speechSynthesis && window.SpeechSynthesisUtterance) {
          window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(d.text || a.text));
          return;
        }
        if (!r.ok) say('Not said aloud: ' + (d.error || ('HTTP ' + r.status)), true);
      });
    }).catch(function () { say('Not said aloud: the node did not answer.', true); });
  };

  // --- The mic: record, write it down, send it, say the answer back ---
  var nav = window.navigator || {};
  var canRecord = !!(nav.mediaDevices && nav.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!canRecord) return;
  $('hc-mic').hidden = false;
  var rec = null, chunks = [], started = 0, stream = null, MAX_MS = 120000, stopTimer = null;
  function micOn(v) {
    $('hc-mic').setAttribute('aria-pressed', String(v));
    $('hc-mic').classList.toggle('is-on', v);
  }
  function release() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
  }
  function start() {
    if (!api.agent()) { say('Pick an agent first.', true); return; }
    nav.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      stream = s; chunks = [];
      rec = new window.MediaRecorder(s);
      rec.addEventListener('dataavailable', function (e) { if (e.data && e.data.size) chunks.push(e.data); });
      rec.addEventListener('stop', finish);
      rec.start();
      started = Date.now();
      micOn(true);
      say('Recording… press the mic again to send.');
      stopTimer = setTimeout(stop, MAX_MS);
    }).catch(function () { say('The browser did not give the microphone.', true); });
  }
  function stop() {
    clearTimeout(stopTimer);
    if (rec && rec.state !== 'inactive') rec.stop();
  }
  function finish() {
    var ms = Date.now() - started, type = (rec && rec.mimeType) || 'audio/webm';
    rec = null; micOn(false); release();
    var blob = new Blob(chunks, { type: type });
    if (!blob.size) { say('Nothing was recorded.', true); return; }
    say('Writing it down…');
    fetch('/api/assistant/voice/transcribe', {
      method: 'POST', headers: api.headers({ 'Content-Type': type.split(';')[0], 'X-Audio-Duration-Ms': String(ms) }), body: blob,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || !d.text) throw new Error(d.hint || d.error || ('HTTP ' + r.status));
        say('');
        return api.send(d.text, { spoken: true });
      });
    }).catch(function (e) { say('Not written down: ' + (e && e.message || 'failed'), true); });
  }
  $('hc-mic').addEventListener('click', function () { rec ? stop() : start(); });

})();
`
