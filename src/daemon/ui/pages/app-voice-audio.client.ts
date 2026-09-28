// --- Phone app: microphone and speaker (window.AXVoiceIO) ---
//
// Loaded before APP_VOICE_SCRIPT. Records with MediaRecorder in whatever
// format the browser has (webm/opus on Android and desktop, mp4/aac on
// iPhone), reads the microphone level through an AnalyserNode for the orb,
// and plays an answer through the same AudioContext so the orb can follow
// the voice it plays. With no audio to play, speechSynthesis speaks instead.
//
// iOS rules this follows: the microphone is asked for inside the press, and
// the AudioContext and speechSynthesis are unlocked on the first press, so
// an answer can play later without a tap. Web Audio also stays quiet while
// an iPhone's ring switch is on silent. The microphone is released after
// every recording, so the recording light never stays on.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_VOICE_AUDIO_SCRIPT = `
window.AXVoiceIO = (function () {
  var TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/aac'];
  var ac = null, playing = null;

  function mimeType() {
    if (!window.MediaRecorder) return null;
    if (!MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < TYPES.length; i++) if (MediaRecorder.isTypeSupported(TYPES[i])) return TYPES[i];
    return '';
  }
  function canRecord() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && window.isSecureContext !== false);
  }
  function context() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!ac && AC) { try { ac = new AC(); } catch (e) { ac = null; } }
    return ac;
  }
  // Inside a tap: wakes the AudioContext with a silent sound, and
  // speechSynthesis with an empty line, so both can speak later on their own.
  function unlock() {
    var c = context();
    if (c && c.state !== 'running') {
      if (c.resume) c.resume().catch(function () {});
      try { var src = c.createBufferSource(); src.buffer = c.createBuffer(1, 1, 22050); src.connect(c.destination); src.start(0); } catch (e) {}
    }
    if (window.speechSynthesis && !unlock.done) {
      unlock.done = true;
      try { var u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); } catch (e) {}
    }
  }
  function rmsOf(an, buf) {
    an.getFloatTimeDomainData(buf);
    var sum = 0;
    for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }
  function meterFor(node) {
    var c = context();
    if (!c || !c.createAnalyser) return null;
    var an = c.createAnalyser(); an.fftSize = 1024;
    node.connect(an);
    var buf = new Float32Array(an.fftSize);
    return { node: an, read: function () { return rmsOf(an, buf); } };
  }

  // One recording. Resolves once the microphone is open; stop(keep) ends it
  // and resolves with the audio (keep) or null.
  function record() {
    var type = mimeType();
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (stream) {
      var rec, chunks = [], started = Date.now(), src = null, meter = null;
      try { rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream); }
      catch (e) { stream.getTracks().forEach(function (t) { t.stop(); }); throw e; }
      rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
      var c = context();
      if (c) { try { src = c.createMediaStreamSource(stream); meter = meterFor(src); } catch (e) { meter = null; } }
      rec.start(250);
      function release() {
        stream.getTracks().forEach(function (t) { t.stop(); });
        try { if (src) src.disconnect(); } catch (e) {}
      }
      return {
        level: meter ? meter.read : null,
        stop: function (keep) {
          return new Promise(function (done) {
            var ms = Date.now() - started;
            rec.onstop = function () {
              release();
              var blobType = (rec.mimeType || type || 'audio/webm').split(';')[0];
              done(keep && chunks.length ? { blob: new Blob(chunks, { type: blobType }), ms: ms } : null);
            };
            try { rec.state === 'inactive' ? rec.onstop() : rec.stop(); } catch (e) { release(); done(null); }
          });
        },
      };
    });
  }

  // Plays mp3 bytes through the AudioContext. Resolves when it ends or is
  // stopped. onStart gets a meter for the orb.
  function playAudio(bytes, onStart) {
    var c = context();
    if (!c) return Promise.reject(new Error('no audio'));
    if (c.state === 'suspended' && c.resume) c.resume().catch(function () {});
    return new Promise(function (resolve, reject) {
      c.decodeAudioData(bytes, function (buffer) {
        var src = c.createBufferSource(), meter = meterFor(src);
        src.buffer = buffer;
        (meter ? meter.node : src).connect(c.destination);
        src.onended = function () { if (playing && playing.src === src) playing = null; resolve(); };
        playing = { src: src, stop: function () { try { src.stop(); } catch (e) { resolve(); } } };
        src.start(0);
        onStart(meter ? meter.read : null);
      }, function () { reject(new Error('could not decode')); });
    });
  }
  // The phone's own voice, for an agent with no ElevenLabs voice.
  function speakText(text, onStart) {
    if (!window.speechSynthesis) return Promise.reject(new Error('no speech'));
    return new Promise(function (resolve) {
      var u = new SpeechSynthesisUtterance(text);
      u.onend = u.onerror = function () { if (playing && playing.u === u) playing = null; resolve(); };
      if (speechSynthesis.speaking) speechSynthesis.cancel();
      playing = { u: u, stop: function () { speechSynthesis.cancel(); resolve(); } };
      speechSynthesis.speak(u);
      onStart(null);
    });
  }
  function stopPlaying() { var p = playing; playing = null; if (p) p.stop(); }

  return { canRecord: canRecord, mimeType: mimeType, unlock: unlock, record: record, playAudio: playAudio, speakText: speakText, stop: stopPlaying };
})();
`
