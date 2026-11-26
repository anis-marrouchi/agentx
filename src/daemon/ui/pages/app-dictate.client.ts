// --- Phone app: tap to speak a written answer (window.AXDictate, #2103) ---
//
// Loaded after APP_VOICE_AUDIO_SCRIPT: it records through the same
// window.AXVoiceIO the Voice tab uses, so there is one recorder in the app.
// Tap once to start, tap again to stop; the audio goes to
// POST /api/app/voice/transcribe (app-voice.ts) and the words are handed
// back to put in a text box. Nothing is sent from here: the person reads
// the words and sends them, so a wrong word can be fixed first.
//
// The mic is only ever opened by a tap. "Reply by voice" on a notification
// marks the button ready (attention), it never starts it: browsers refuse
// a mic that no tap asked for, and the owner should see it start.
//
// If the mic is refused or the words can't be written down, the box stays
// open for typing and keeps what is in it.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_DICTATE_SCRIPT = `
window.AXDictate = (function () {
  var MAX_MS = 120000;
  // o: { button, onText(text), onNote(message, bad) }
  function attach(o) {
    var IO = window.AXVoiceIO;
    var btn = o.button, rec = null, busy = false, timer = 0;
    function paint(state) {
      btn.setAttribute('data-state', state);
      btn.setAttribute('aria-pressed', state === 'listening' ? 'true' : 'false');
      btn.setAttribute('aria-label', dictateLabel(state));
      btn.title = dictateLabel(state);
    }
    function stop() {
      clearTimeout(timer);
      var r = rec; rec = null;
      if (!r) return;
      busy = true; paint('sending');
      r.stop(true).then(function (take) {
        if (!take) { busy = false; paint('idle'); o.onNote('Nothing was heard. Tap the mic and speak, or type.', true); return; }
        return fetch('/api/app/voice/transcribe', {
          method: 'POST', credentials: 'same-origin', body: take.blob,
          headers: { 'Content-Type': take.blob.type || 'audio/webm', 'X-Audio-Duration-Ms': String(take.ms) },
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (j) {
            busy = false; paint('idle');
            if (res.ok && j.text) { o.onText(j.text); o.onNote('Check the words, then send.', false); return; }
            o.onNote((j.error || 'Speech to text failed (HTTP ' + res.status + ').') + ' You can type instead.', true);
          });
        });
      }).catch(function () { busy = false; paint('idle'); o.onNote('Could not reach AgentX. You can type instead.', true); });
    }
    btn.addEventListener('click', function () {
      if (busy) return;
      if (rec) { stop(); return; }
      if (!IO || !IO.canRecord()) { o.onNote('This browser can’t record here. You can type instead.', true); return; }
      IO.unlock();
      busy = true; paint('listening');
      IO.record().then(function (r) {
        busy = false; rec = r;
        timer = setTimeout(stop, MAX_MS);
      }).catch(function (e) {
        busy = false; paint('idle');
        var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        o.onNote(denied ? 'The microphone is blocked. Allow it for this app in the phone’s settings, or type.' : 'Could not open the microphone. You can type instead.', true);
      });
    });
    paint('idle');
    return {
      // From "Reply by voice": the button stands out until it is tapped.
      ready: function () { paint('ready'); btn.classList.add('dc-ready'); try { btn.focus(); } catch (e) {} },
      cancel: function () { clearTimeout(timer); var r = rec; rec = null; busy = false; if (r) r.stop(false); paint('idle'); btn.classList.remove('dc-ready'); },
    };
  }
  return { attach: attach };
})();
`

export const APP_DICTATE_CSS = `
.dc-mic { min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
.dc-mic svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.dc-mic[data-state="listening"] { background: var(--ax-err); color: #fff; }
.dc-mic.dc-ready { outline: 3px solid var(--ax-accent, #2f6fed); outline-offset: 2px; animation: dc-pulse 1.2s ease-in-out infinite; }
@keyframes dc-pulse { 50% { outline-color: transparent; } }
@media (prefers-reduced-motion: reduce) { .dc-mic.dc-ready { animation: none; } }
`

/** The mic button's inner icon. */
export const DICTATE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>'
