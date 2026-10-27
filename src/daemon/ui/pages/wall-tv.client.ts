// --- AgentX TV page, browser side (#1471) ---
//
// Plays a day's line-up back to back. An episode with a video plays it;
// one without is read live: its screens drawn with the same tvScreenHtml()
// the video was made from, scaled from 1920×1080 to the frame, each one
// spoken with the browser's voice and held for its length.
//
// Browsers only start sound after a press, so nothing plays until Play is
// pressed; that press also takes the frame full screen.

import { injectFns } from "../inject"
import { tvChromeHtml, tvScreenHtml } from "@/tv/screens"
import { LOOKS } from "@/tv/shows"

export const TV_PAGE_SCRIPT = String.raw`
(function () {
  'use strict';
  ${injectFns({ tvScreenHtml, tvChromeHtml })}
  var LOOKS = ${JSON.stringify(LOOKS)};
  var CC_KEY = 'ax-tv-cc';
  var T = { day: '', today: '', days: [], eps: [], i: 0, sc: 0, mode: '', playing: false, timer: null, force: null, timeUp: false, spoken: true, screenAt: 0, idle: null, cc: true };
  try { T.cc = localStorage.getItem(CC_KEY) !== 'off'; } catch (e) {}
  var $ = function (id) { return document.getElementById(id); };
  var video = $('tv-video'), frame = $('tv-frame');

  function headers() {
    var h = { 'X-Requested-With': 'agentx-board' };
    if (window.AX_LOCAL_TOKEN) h.Authorization = 'Bearer ' + window.AX_LOCAL_TOKEN;
    return h;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clock(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function lineupSec() { return T.eps.reduce(function (n, e) { return n + (e.durationSec || 0); }, 0); }
  function dayLabel(d) { return d === T.today ? 'Today' : d; }

  async function load(day) {
    stop();
    $('tv-overlay').hidden = false;
    $('tv-overlay').innerHTML = '<p class="tv__slate">Loading…</p>';
    try {
      var r = await fetch('/api/admin/tv' + (day ? '?day=' + encodeURIComponent(day) : ''), { headers: headers() });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var d = await r.json();
      T.day = d.day; T.today = d.today; T.days = d.days || []; T.eps = d.episodes || []; T.i = 0;
    } catch (e) {
      T.eps = [];
      $('tv-overlay').innerHTML = '<div class="tv__slate"><b>Off air</b><p>Could not load the line-up: ' + esc(e.message) + '.</p><button type="button" class="ax-btn" id="tv-retry">Try again</button></div>';
      $('tv-retry').onclick = function () { load(day); };
      return;
    }
    try { history.replaceState(null, '', T.day === T.today ? location.pathname : '?day=' + T.day); } catch (e) {}
    paintDays();
    paintLineup();
    idleSlate();
  }

  function paintDays() {
    var days = T.days.slice();
    if (days.indexOf(T.today) < 0) days.unshift(T.today);
    if (days.indexOf(T.day) < 0) days.push(T.day);
    $('tv-day').innerHTML = days.map(function (d) {
      return '<option value="' + esc(d) + '"' + (d === T.day ? ' selected' : '') + '>' + esc(dayLabel(d)) + '</option>';
    }).join('');
  }

  function paintLineup() {
    $('tv-lineup-h').textContent = (T.day === T.today ? "Today's" : T.day) + ' line-up';
    $('tv-lineup').innerHTML = T.eps.length ? T.eps.map(function (e, k) {
      var on = T.mode && k === T.i;
      return '<li><button type="button" data-ep="' + k + '"' + (on ? ' aria-current="true"' : '') + '>' +
        '<span class="tv__ep-time">' + esc(new Date(e.madeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</span>' +
        '<b>' + esc(e.showName) + '</b><span>' + clock(e.durationSec) + ' · ' + (e.videoUrl ? 'video' : 'read live') + '</span></button></li>';
    }).join('') : '<li class="tv__none">Nothing made this day.</li>';
  }

  function idleSlate() {
    var o = $('tv-overlay');
    o.hidden = false;
    $('tv-controls').hidden = true;
    if (T.eps.length) {
      var n = T.eps.length;
      o.innerHTML = '<div class="tv__slate"><b>AgentX TV</b><p>' + esc(dayLabel(T.day)) + ': ' + n + ' episode' + (n === 1 ? '' : 's') + ', ' + clock(lineupSec()) + '</p>' +
        '<button type="button" class="tv__play" id="tv-play">▶ Play ' + (T.day === T.today ? "today's" : 'the') + ' line-up</button></div>';
      $('tv-play').onclick = function () { start(0); };
      $('tv-play').focus();
      return;
    }
    var other = T.days.filter(function (d) { return d !== T.day; })[0];
    o.innerHTML = '<div class="tv__slate tv__slate--off"><b>Nothing on air yet</b>' +
      '<p>No episode was made ' + (T.day === T.today ? 'today' : 'on ' + esc(T.day)) + '. One is made with <code>agentx tv make</code>.</p>' +
      (other ? '<button type="button" class="ax-btn" id="tv-other">Watch ' + esc(dayLabel(other)) + '</button>' : '') + '</div>';
    if (other) $('tv-other').onclick = function () { load(other); };
  }

  // Playing
  function start(i) {
    if (frame.requestFullscreen && !document.fullscreenElement) frame.requestFullscreen().catch(function () {});
    else if (frame.webkitRequestFullscreen && !document.webkitFullscreenElement) frame.webkitRequestFullscreen();
    play(i);
  }
  function play(i) {
    stop();
    if (i >= T.eps.length) { endSlate(); return; }
    T.i = Math.max(0, i);
    var ep = T.eps[T.i];
    $('tv-overlay').hidden = true;
    $('tv-controls').hidden = false;
    T.playing = true;
    if (ep.videoUrl) {
      T.mode = 'video';
      $('tv-stagewrap').hidden = true;
      video.hidden = false;
      video.src = ep.videoUrl;
      video.play().catch(function () { liveRead(ep); });
    } else liveRead(ep);
    paintLineup();
    paintToggle();
    paintNow();
    nudge();
  }
  function liveRead(ep) {
    T.mode = 'live';
    video.hidden = true;
    video.removeAttribute('src');
    var look = LOOKS[ep.look] || LOOKS.newsroom;
    var stage = $('tv-stage');
    ['bg', 'panel', 'ink', 'muted', 'accent', 'ticker'].forEach(function (k) { stage.style.setProperty('--tv-' + k, look[k]); });
    $('tv-chrome').innerHTML = tvChromeHtml(ep);
    $('tv-stagewrap').hidden = false;
    fit();
    var run = stage.querySelector('.tv-ticker__run');
    if (run) run.style.animationDuration = Math.max(10, run.firstElementChild.offsetWidth / 140) + 's';
    screen(0);
  }
  function screen(k) {
    clearTimeout(T.timer); clearTimeout(T.force);
    var ep = T.eps[T.i];
    var sc = ep && ep.screens[k];
    if (!sc) { play(T.i + 1); return; }
    T.sc = k; T.timeUp = false; T.screenAt = Date.now();
    $('tv-screen').innerHTML = tvScreenHtml(sc);
    caption(sc.say);
    speak(sc.say, ep);
    T.timer = setTimeout(function () {
      T.timeUp = true;
      advance();
      // A voice that never says it finished does not hold the show.
      T.force = setTimeout(function () { T.spoken = true; advance(); }, 8000);
    }, sc.duration * 1000);
  }
  function advance() { if (T.mode === 'live' && T.playing && T.timeUp && T.spoken) screen(T.sc + 1); }
  function speak(text, ep) {
    T.spoken = true;
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    var en = speechSynthesis.getVoices().filter(function (v) { return /^en/i.test(v.lang); });
    if (en.length) u.voice = en[0];
    u.lang = 'en';
    u.onend = u.onerror = function () { T.spoken = true; advance(); };
    T.spoken = false;
    speechSynthesis.speak(u);
  }
  function caption(text) {
    $('tv-cc').textContent = text || '';
    $('tv-cc').hidden = !T.cc || !text;
  }
  function stop() {
    T.playing = false;
    clearTimeout(T.timer); clearTimeout(T.force);
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (!video.paused) video.pause();
  }
  function toggle() {
    if (!T.mode) { if (T.eps.length) start(0); return; }
    if (T.playing) {
      stop();
    } else {
      T.playing = true;
      if (T.mode === 'video') video.play().catch(function () {});
      else screen(T.sc);   // a live read starts its screen again
    }
    paintToggle();
    paintNow();
  }
  function paintToggle() {
    $('tv-toggle').textContent = T.playing ? '⏸' : '▶';
    $('tv-toggle').setAttribute('aria-label', T.playing ? 'Pause (Space)' : 'Play (Space)');
  }
  function endSlate() {
    T.mode = '';
    $('tv-stagewrap').hidden = true; video.hidden = true; caption('');
    $('tv-controls').hidden = true;
    $('tv-overlay').hidden = false;
    $('tv-overlay').innerHTML = '<div class="tv__slate"><b>That was ' + (T.day === T.today ? "today's" : 'the') + ' line-up</b><p>Thanks for watching.</p><button type="button" class="tv__play" id="tv-again">↻ Play it again</button></div>';
    $('tv-again').onclick = function () { play(0); };
    $('tv-again').focus();
    paintLineup();
    paintNow();
  }

  function elapsed() {
    var ep = T.eps[T.i];
    if (!ep) return 0;
    if (T.mode === 'video') return video.currentTime || 0;
    var sc = ep.screens[T.sc];
    return sc ? sc.start + Math.min(sc.duration, T.playing ? (Date.now() - T.screenAt) / 1000 : 0) : 0;
  }
  function paintNow() {
    var ep = T.mode && T.eps[T.i];
    $('tv-now').textContent = ep ? (T.playing ? 'Now playing: ' : 'Paused: ') + ep.title + ' (' + (T.i + 1) + ' of ' + T.eps.length + ', ' + (T.mode === 'video' ? 'video' : 'read live') + ')' : '';
  }
  setInterval(function () {
    var ep = T.mode && T.eps[T.i];
    if (ep) $('tv-time').textContent = (T.i + 1) + '/' + T.eps.length + ' · ' + clock(elapsed()) + ' / ' + clock(ep.durationSec);
  }, 500);

  // Video: captions follow the screen the video is on; at its end, the next episode.
  video.addEventListener('timeupdate', function () {
    var ep = T.eps[T.i], t = video.currentTime, cur = null;
    if (!ep) return;
    ep.screens.forEach(function (s) { if (s.start <= t) cur = s; });
    caption(cur ? cur.say : '');
  });
  video.addEventListener('ended', function () { if (T.mode === 'video') play(T.i + 1); });
  video.addEventListener('error', function () { if (T.mode === 'video' && video.getAttribute('src')) liveRead(T.eps[T.i]); });

  // The stage is drawn at 1920×1080 and scaled to the frame; a video is
  // letterboxed the same way. Captions sit on the picture, above the
  // presenter's name; when the band under the picture is tall enough (a
  // phone held upright), they go there instead and cover nothing.
  function fit() {
    var w = frame.clientWidth, h = frame.clientHeight;
    var s = Math.min(w / 1920, h / 1080);
    var top = Math.round((h - 1080 * s) / 2);
    var band = h - top - 1080 * s;
    var stage = $('tv-stage');
    stage.style.transform = 'scale(' + s + ')';
    stage.style.left = Math.round((w - 1920 * s) / 2) + 'px';
    stage.style.top = top + 'px';
    frame.style.setProperty('--tv-cs', String(Math.max(s, 0.45)));
    frame.style.setProperty('--tv-cb', (band >= 140 ? Math.max(70, band - 140) : band + 200 * s) + 'px');
  }
  window.addEventListener('resize', fit);
  document.addEventListener('fullscreenchange', fit);
  document.addEventListener('webkitfullscreenchange', fit);

  // Controls fade while it plays and nothing moves.
  function nudge() {
    frame.classList.remove('is-idle');
    clearTimeout(T.idle);
    T.idle = setTimeout(function () { if (T.playing) frame.classList.add('is-idle'); }, 3000);
  }
  frame.addEventListener('mousemove', nudge);
  frame.addEventListener('touchstart', nudge, { passive: true });

  function setCc(on) {
    T.cc = on;
    try { localStorage.setItem(CC_KEY, on ? 'on' : 'off'); } catch (e) {}
    $('tv-cc-btn').setAttribute('aria-pressed', String(on));
    $('tv-cc').hidden = !on || !$('tv-cc').textContent;
  }
  function full() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (frame.requestFullscreen) frame.requestFullscreen().catch(function () {});
    else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
  }
  $('tv-toggle').onclick = toggle;
  $('tv-next').onclick = function () { play(T.i + 1); };
  $('tv-prev').onclick = function () { play(T.i - 1); };
  $('tv-full').onclick = full;
  $('tv-cc-btn').onclick = function () { setCc(!T.cc); };
  $('tv-day').onchange = function () { load(this.value); };
  $('tv-lineup').onclick = function (e) {
    var b = e.target.closest('[data-ep]');
    if (b) start(Number(b.getAttribute('data-ep')));
  };
  document.addEventListener('keydown', function (e) {
    nudge();
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'select' || tag === 'input' || e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === ' ' && tag !== 'button') { e.preventDefault(); toggle(); }
    else if (k === 'n' && T.mode) play(T.i + 1);
    else if (k === 'p' && T.mode) play(T.i - 1);
    else if (k === 'f') full();
    else if (k === 'c') setCc(!T.cc);
  });

  setCc(T.cc);
  fit();
  var want = new URLSearchParams(location.search).get('day');
  load(want && /^\d{4}-\d{2}-\d{2}$/.test(want) ? want : '');
})();
`

export const TV_PAGE_CSS = `
.tv [hidden] { display: none !important; }
.tv { max-width: 1400px; margin: 0 auto; padding: 0 16px 32px; }
.tv__bar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 14px 0; border-bottom: 1px solid var(--ax-border); }
.tv__bar h1 { font-size: 22px; font-weight: 800; margin: 0; flex: 1; display: flex; align-items: center; gap: 10px; }
.tv__back { color: var(--ax-text); text-decoration: none; font-weight: 700; }
.tv__day { display: flex; align-items: center; gap: 8px; color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.tv__day select { font: inherit; color: var(--ax-text); background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius); padding: 6px 10px; }
.tv__main { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 24px; padding-top: 20px; align-items: start; }
.tv__frame { position: relative; aspect-ratio: 16 / 9; background: #000; border-radius: var(--ax-radius-lg); overflow: hidden; outline: none; }
.tv__frame:fullscreen { border-radius: 0; aspect-ratio: auto; width: 100vw; height: 100vh; }
.tv__frame video { position: absolute; inset: 0; width: 100%; height: 100%; background: #000; }
.tv__stagewrap { position: absolute; inset: 0; }
.tv__stagewrap .tv-stage { position: absolute; transform-origin: 0 0; }
#tv-screen .tv-in { animation: tv-in .5s cubic-bezier(.2,.7,.2,1) both; animation-delay: calc(var(--i) * .12s + .1s); }
.tv-ticker__run { animation: tv-tick 60s linear infinite; }
.tv-third { animation: tv-in .6s .6s both; }
@keyframes tv-in { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: none; } }
@keyframes tv-tick { to { transform: translateX(-50%); } }
@media (prefers-reduced-motion: reduce) { #tv-screen .tv-in, .tv-third { animation: none; } .tv-ticker__run { animation-duration: 600s !important; } }
.tv__frame { --tv-cs: .5; --tv-cb: 100px; }
.tv__cc { position: absolute; left: 0; right: 0; bottom: var(--tv-cb); width: fit-content; max-width: min(92%, calc(1500px * var(--tv-cs))); margin: 0 auto;
  padding: .3em .6em; border-radius: 6px; text-align: center; font-size: max(12px, calc(36px * var(--tv-cs))); line-height: 1.35; color: #fff; background: rgb(0 0 0 / 72%); }
.tv__overlay { position: absolute; inset: 0; display: grid; place-items: center; background: radial-gradient(circle at 50% 40%, #12305f, #050b18 70%); color: #fff; text-align: center; padding: 16px; }
.tv__slate b { display: block; font-size: clamp(22px, 4vw, 56px); font-weight: 800; letter-spacing: -.01em; }
.tv__slate p { color: #c4d0e6; font-size: clamp(14px, 1.6vw, 22px); margin: 10px 0 20px; }
.tv__slate code { background: rgb(255 255 255 / 12%); padding: 2px 8px; border-radius: 4px; }
.tv__slate--off { background-image: repeating-linear-gradient(90deg, #c0c0c0 0 14%, #c0c000 14% 28%, #00c0c0 28% 42%, #00c000 42% 57%, #c000c0 57% 71%, #c00000 71% 85%, #0000c0 85% 100%);
  background-size: 100% 10px; background-repeat: no-repeat; padding-top: 28px; }
.tv__play { font: inherit; font-size: clamp(16px, 2vw, 28px); font-weight: 800; color: #07152e; background: #ffcc00; border: 0; border-radius: var(--ax-radius-pill); padding: .6em 1.4em; cursor: pointer; }
.tv__play:focus-visible, .tv__controls button:focus-visible, .tv__lineup button:focus-visible { outline: 4px solid #ffcc00; outline-offset: 3px; }
.tv__controls { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: var(--ax-radius-pill); background: rgb(0 0 0 / 65%); color: #fff; transition: opacity .3s; }
.tv__frame.is-idle .tv__controls { opacity: 0; }
.tv__frame.is-idle { cursor: none; }
.tv__controls button { font: inherit; font-size: 18px; color: #fff; background: none; border: 0; border-radius: var(--ax-radius-pill); min-width: 40px; height: 40px; cursor: pointer; }
.tv__controls button:hover { background: rgb(255 255 255 / 15%); }
.tv__controls button[aria-pressed="false"] { opacity: .5; }
.tv__time { flex: 1; font-variant-numeric: tabular-nums; font-size: var(--ax-fs-sm); padding: 0 8px; }
.tv__now { color: var(--ax-muted); font-size: var(--ax-fs-sm); margin: 10px 2px 0; min-height: 1.4em; }
.tv__keys { color: var(--ax-muted); font-size: var(--ax-fs-xs); margin: 4px 2px 0; }
.tv__keys kbd { font: inherit; border: 1px solid var(--ax-border-2); border-radius: 4px; padding: 0 5px; }
.tv__side h2 { font-size: 20px; font-weight: 800; margin: 0 0 10px; }
.tv__side h2 + .tv__note { margin-top: -6px; }
.tv__lineup { list-style: none; margin: 0 0 24px; padding: 0; display: grid; gap: 8px; }
.tv__lineup button { width: 100%; text-align: left; font: inherit; color: var(--ax-text); background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 10px 12px; cursor: pointer;
  display: grid; grid-template-columns: auto 1fr; column-gap: 10px; }
.tv__lineup button[aria-current="true"] { border-color: var(--ax-accent); box-shadow: inset 4px 0 0 var(--ax-accent); }
.tv__lineup button > span:last-child { grid-column: 2; color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.tv__ep-time { grid-row: span 2; color: var(--ax-muted); font-variant-numeric: tabular-nums; }
.tv__none, .tv__note { color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.tv__show { background: var(--ax-surface); border-radius: var(--ax-radius); padding: 10px 12px; margin-bottom: 8px; }
.tv__show summary { cursor: pointer; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.tv__show p { color: var(--ax-muted); font-size: var(--ax-fs-sm); margin: 8px 0; }
.tv__show dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; font-size: var(--ax-fs-sm); }
.tv__show dt { color: var(--ax-muted); }
.tv__show dd { margin: 0; }
.tv__show small { color: var(--ax-muted); }
@media (max-width: 900px) {
  .tv__main { grid-template-columns: minmax(0, 1fr); }
  .tv__keys { display: none; }
  .tv__frame { border-radius: var(--ax-radius); }
}
`
