// --- AgentX TV page (#1471, experimental) ---
//
// The TV button on the Wall opens this page: today's line-up, played back
// to back, full screen, in any browser a TV has. A day picker replays an
// earlier day. The show settings are shown read-only: they are code
// (src/tv/shows.ts) until the owner has watched the prototype.
//
// An episode with a rendered video plays as video. One without (no render
// server yet, or a failed render) is read live: the same screens, drawn
// in the page, with the browser's own voice. Either way the script runs
// as captions.
//
// The HTML is a skeleton; TV_PAGE_SCRIPT paints it from /api/admin/tv.

import { renderWallDocument } from "./wall-space"
import { TV_PAGE_CSS, TV_PAGE_SCRIPT } from "./wall-tv.client"
import { TV_STAGE_CSS } from "@/tv/screens"
import { LOOKS, SEGMENT_LABEL, SHOWS, type Show } from "@/tv/shows"

export interface TvPageOpts {
  localToken?: string
}

const TONE_LABEL = { funny: "Funny", serious: "Serious", sports: "Sports commentary" }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string))

/** One show and its settings, read-only. */
export function showCardHtml(show: Show): string {
  const s = show.settings
  const state = show.onAir ? '<span class="ax-badge ax-badge--live">On air</span>' : '<span class="ax-badge">Not made yet</span>'
  const internal = show.internalOnly ? ' <span class="ax-badge ax-badge--warn">Internal only</span>' : ""
  return `<details class="tv__show"${show.onAir ? " open" : ""}>
  <summary><b>${esc(show.name)}</b> ${state}${internal}</summary>
  <p>${esc(show.about)}</p>
  <dl>
    <dt>Tone</dt><dd>${TONE_LABEL[s.tone]}</dd>
    <dt>Look</dt><dd>${esc(LOOKS[s.look]?.label ?? s.look)}</dd>
    <dt>Presenter</dt><dd>${esc(s.presenter.name)} <small>(voice-over, no avatar yet)</small></dd>
    <dt>Length</dt><dd>about ${Math.round(s.lengthSec / 60 * 10) / 10} min</dd>
    <dt>Segments</dt><dd>${s.segments.map((k) => SEGMENT_LABEL[k]).join(" → ")}</dd>
  </dl>
</details>`
}

export function renderWallTvPage(opts: TvPageOpts = {}): string {
  const token = opts.localToken ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(opts.localToken)};</script>` : ""
  const body = `<div class="tv">
  <header class="tv__bar">
    <a class="tv__back" href="/wall">← Wall</a>
    <h1>AgentX TV <span class="ax-badge ax-badge--warn">Experimental</span></h1>
    <label class="tv__day">Day <select id="tv-day" aria-label="Day to watch"><option>Today</option></select></label>
    <button type="button" class="ax-btn ax-btn--ghost" id="wall-theme" aria-label="Switch light or dark">Light / dark</button>
  </header>
  <main class="tv__main">
    <section class="tv__player" aria-label="Player">
      <div class="tv__frame" id="tv-frame" tabindex="-1">
        <video id="tv-video" playsinline preload="metadata" hidden></video>
        <div class="tv__stagewrap" id="tv-stagewrap" hidden><div class="tv-stage" id="tv-stage"><div id="tv-screen"></div><div id="tv-chrome"></div></div></div>
        <p class="tv__cc" id="tv-cc" hidden></p>
        <div class="tv__overlay" id="tv-overlay"><p class="tv__slate">Loading…</p></div>
        <div class="tv__controls" id="tv-controls" hidden>
          <button type="button" id="tv-prev" aria-label="Previous episode (P)">⏮</button>
          <button type="button" id="tv-toggle" aria-label="Pause (Space)">⏸</button>
          <button type="button" id="tv-next" aria-label="Next episode (N)">⏭</button>
          <span class="tv__time" id="tv-time" aria-live="off"></span>
          <button type="button" id="tv-cc-btn" aria-pressed="true" aria-label="Captions (C)">CC</button>
          <button type="button" id="tv-full" aria-label="Full screen (F)">⛶</button>
        </div>
      </div>
      <p class="tv__now" id="tv-now" aria-live="polite"></p>
      <p class="tv__keys">Keys: <kbd>Space</kbd> play or pause · <kbd>N</kbd> / <kbd>P</kbd> next or previous episode · <kbd>F</kbd> full screen · <kbd>C</kbd> captions</p>
    </section>
    <aside class="tv__side">
      <h2 id="tv-lineup-h">Today's line-up</h2>
      <ol class="tv__lineup" id="tv-lineup" aria-labelledby="tv-lineup-h"></ol>
      <h2>Shows</h2>
      <p class="tv__note">Settings are read-only in this prototype.</p>
      ${SHOWS.map(showCardHtml).join("\n      ")}
    </aside>
  </main>
</div>`
  return renderWallDocument({
    title: "AgentX TV",
    body,
    css: TV_STAGE_CSS + TV_PAGE_CSS,
    scripts: token + `<script>${TV_PAGE_SCRIPT}</script>`,
  })
}
