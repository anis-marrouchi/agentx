// --- Phone app: the voice orb (window.AXOrb) ---
//
// The approved blue phone orb: a radial highlight, a glow that follows the
// microphone, a thinking ring and speech pulses. The shared level/envelope
// helpers retain the Mac voice timing; reduced motion renders a still state.
// The 96-point body sits in a 160-point canvas to leave room for its glow.

export const APP_ORB_SCRIPT = `
window.AXOrb = (function () {
  // Same list, order and hash as presenceLook (src/voice/presence.ts) and
  // OrbMath.colorHex, for an agent whose colour did not come with it.
  var PALETTE = ['#7C3AED', '#DB2777', '#EA580C', '#0D9488', '#2563EB', '#65A30D', '#C026D3', '#0891B2'];
  var HEX = /^#[0-9a-fA-F]{6}$/;
  function colorFor(id, configured) {
    if (configured && HEX.test(configured)) return configured;
    var h = 0;
    Array.from(String(id || '')).forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
    return PALETTE[h % PALETTE.length];
  }
  function hexToHsb(hex) {
    var v = parseInt(hex.slice(1), 16), r = (v >> 16 & 255) / 255, g = (v >> 8 & 255) / 255, b = (v & 255) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d + 6) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: h, s: max ? d / max : 0, b: max };
  }
  function hsb(h, s, b, a) {
    var i = Math.floor(h * 6), f = h * 6 - i, p = b * (1 - s), q = b * (1 - f * s), t = b * (1 - (1 - f) * s), rgb;
    rgb = [[b, t, p], [q, b, p], [p, b, t], [p, q, b], [t, p, b], [b, p, q]][((i % 6) + 6) % 6];
    return 'rgba(' + Math.round(rgb[0] * 255) + ',' + Math.round(rgb[1] * 255) + ',' + Math.round(rgb[2] * 255) + ',' + (a == null ? 1 : a) + ')';
  }
  function clamp(x) { return Math.min(1, Math.max(0, x)); }

  // OrbMath: microphone RMS to 0..1, the speaking envelope, smoothing.
  function levelFromRms(rms) { return !(rms > 0.004) ? 0 : Math.min(1, Math.sqrt(rms - 0.004) * 3.2); }
  function speakingEnvelope(t) {
    var syllable = Math.abs(Math.sin(t * 15.7)), phrase = 0.55 + 0.45 * Math.sin(t * 1.9 + 0.7);
    var jitter = 0.5 + 0.5 * Math.sin(t * 37.3 + Math.sin(t * 3.1));
    return 0.15 + 0.85 * syllable * phrase * (0.7 + 0.3 * jitter);
  }
  function smooth(cur, target) { return target > cur ? cur + (target - cur) * 0.6 : cur + (target - cur) * 0.2; }

  function create(canvas) {
    var ctx = canvas.getContext('2d');
    var reduce = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    var o = { phase: 'idle', tint: PALETTE[3], level: 0, meter: null, raf: 0, last: 0 };
    function still() { return !!(reduce && reduce.matches); }
    function paused() { return still() || o.phase === 'idle' || document.hidden; }

    function energy(t) {
      var s = still();
      if (o.phase === 'listening') return s ? 0.45 : 0.12 + 0.88 * o.level;
      if (o.phase === 'thinking') return s ? 0.2 : 0.22 + 0.08 * Math.sin(t * 2.2);
      if (o.phase === 'speaking') return s ? 0.7 : o.meter ? 0.15 + 0.85 * o.level : speakingEnvelope(t);
      return 0;
    }
    function draw(t) {
      var dpr = window.devicePixelRatio || 1, css = canvas.clientWidth || 150, px = Math.round(css * dpr);
      // Both sides: a canvas starts at 300x150, so at 2x the width alone already matches.
      if (canvas.width !== px || canvas.height !== px) { canvas.width = canvas.height = px; }
      // The 96-point orb in a 160-point frame: room for the widest glow (74).
      var W = canvas.width, k = W / 160;
      ctx.setTransform(k, 0, 0, k, W / 2, W / 2);
      ctx.clearRect(-80, -80, 160, 160);
      var e = energy(t), sc = 1 + 0.08 * e, R = 48 * sc, base = hexToHsb(o.tint);
      var drift = o.phase === 'thinking' && !still() ? Math.sin(t * 0.8) * 0.04 : 0;
      function shade(dh, ds, db, a) { var h = (base.h + dh + drift) % 1; return hsb(h < 0 ? h + 1 : h, clamp(base.s + ds), clamp(base.b + db), a); }
      // Glow: a disc of the tint, blurred 10 + 12e points.
      var blur = 10 + 12 * e, gr = 48 * sc * 1.08, g = ctx.createRadialGradient(0, 0, Math.max(0, gr - blur), 0, 0, gr + blur);
      g.addColorStop(0, shade(0, 0, 0, 0.28 + 0.32 * e)); g.addColorStop(1, shade(0, 0, 0, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, gr + blur, 0, Math.PI * 2); ctx.fill();

      // The body: the approved radial highlight, clipped to the circle.
      ctx.save(); ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = shade(0, 0, 0); ctx.fillRect(-R, -R, 2 * R, 2 * R);
      var body = ctx.createRadialGradient(-16, -21, 0, 0, 0, R * 1.2);
      body.addColorStop(0, '#9cc1ff'); body.addColorStop(0.48, '#2979ff'); body.addColorStop(1, '#1747c2');
      ctx.fillStyle = body; ctx.fillRect(-R, -R, 2 * R, 2 * R);
      ctx.restore();

      if (o.phase === 'thinking') {
        // A slow ring going round.
        var rot = still() ? -Math.PI / 2 : t * 3.1, rr = 48 * sc * 0.86;
        ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(0, 0, rr, rot, rot + 0.28 * Math.PI * 2); ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.3 + 0.25 * e) + ')'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, R - 0.5, 0, Math.PI * 2); ctx.stroke();
      }
    }

    function frame(now) {
      o.raf = 0;
      if (paused()) { draw(0); return; }
      if (now - o.last >= 32) {
        o.last = now;
        if (o.meter) o.level = smooth(o.level, levelFromRms(o.meter()));
        draw(now / 1000);
      }
      o.raf = requestAnimationFrame(frame);
    }
    function kick() { if (!o.raf) o.raf = requestAnimationFrame(frame); }
    if (reduce && reduce.addEventListener) reduce.addEventListener('change', kick);
    document.addEventListener('visibilitychange', kick);
    kick();

    return {
      // phase: idle, listening, thinking or speaking. meter: a function
      // returning the RMS of what is heard or played, or null.
      show: function (phase, meter) {
        if (phase !== o.phase) { o.phase = phase; o.level = 0; }
        o.meter = meter || null;
        kick();
      },
      tint: function (hex) { if (hex && HEX.test(hex) && hex !== o.tint) { o.tint = hex; kick(); } },
      state: function () { return { phase: o.phase, tint: o.tint, still: still(), animating: !!o.raf && !paused() }; },
    };
  }
  return { create: create, colorFor: colorFor, levelFromRms: levelFromRms, speakingEnvelope: speakingEnvelope };
})();
`
