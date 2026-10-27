// --- An episode as a HyperFrames composition ---
//
// HyperFrames (an open-source HTML-to-video renderer) turns one HTML page
// into an MP4: elements carry data-start and data-duration in seconds, and
// a paused GSAP timeline registered on window.__timelines moves them. The
// renderer seeks that timeline frame by frame in headless Chrome.
//
// GSAP is loaded from a file next to the page, never from a CDN: the
// render server's Chrome may have no way out, and a missing timeline
// blocks the render (render.ts fetches the file once per episode).

import type { Episode } from "./episode"
import { LOOKS } from "./shows"
import { lookStyle, tvChromeHtml, tvScreenHtml, TV_STAGE_CSS } from "./screens"

/** The ticker's speed, in pixels a second. */
const TICKER_PX_PER_SEC = 140

export function compositionHtml(ep: Episode): string {
  const look = LOOKS[ep.look] ?? LOOKS.newsroom
  const total = ep.durationSec
  const screens = ep.screens.map((sc) =>
    `<section id="${sc.id}" class="clip" data-start="${sc.start}" data-duration="${sc.duration}" data-track-index="0">${tvScreenHtml(sc)}</section>`).join("\n  ")
  const audio = ep.screens.filter((sc) => sc.audio).map((sc) =>
    `<audio id="vo-${sc.id}" data-start="${sc.start + 0.3}" data-duration="${Math.max(0.1, sc.duration - 0.3)}" data-track-index="2" src="${sc.audio}"></audio>`).join("\n  ")
  const steps = ep.screens.map((sc) =>
    `tl.from("#${sc.id} .tv-in", { opacity: 0, y: 40, duration: 0.5, stagger: 0.12, ease: "power2.out" }, ${sc.start + 0.1});\n` +
    `  tl.to("#${sc.id} .tv-screen", { opacity: 0, duration: 0.3 }, ${Math.max(sc.start, sc.start + sc.duration - 0.3)});`).join("\n  ")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(ep.title)}</title>
<style>
html, body { margin: 0; background: #000; }
.clip { position: absolute; inset: 0; }
#chrome { z-index: 2; }
${TV_STAGE_CSS}
</style>
</head>
<body>
<div id="root" class="tv-stage" style="${lookStyle(look)}" data-composition-id="root" data-start="0" data-duration="${total}" data-width="1920" data-height="1080">
  ${screens}
  <div id="chrome" class="clip" data-start="0" data-duration="${total}" data-track-index="1">${tvChromeHtml(ep)}</div>
  ${audio}
</div>
<script src="gsap.min.js"></script>
<script>
  const tl = gsap.timeline({ paused: true });
  ${steps}
  tl.from(".tv-third", { x: -80, opacity: 0, duration: 0.6, ease: "power2.out" }, 0.6);
  const run = document.querySelector(".tv-ticker__run");
  const lap = run.firstElementChild.offsetWidth;
  const secs = Math.max(1, lap / ${TICKER_PX_PER_SEC});
  tl.fromTo(run, { x: 0 }, { x: -lap, duration: secs, ease: "none", repeat: Math.ceil(${total} / secs) }, 0);
  window.__timelines = window.__timelines || {};
  window.__timelines["root"] = tl;
</script>
</body>
</html>
`
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
