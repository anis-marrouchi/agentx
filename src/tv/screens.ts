// --- What a screen looks like, for the video and for the TV page ---
//
// One drawing for both: the HyperFrames composition (composition.ts) puts
// these into a 1920×1080 stage and animates them with GSAP; the TV page
// injects the same functions (injectFns) and animates them with CSS. So the
// functions are self-contained: no imports, no outer names.
//
// Elements with class tv-in enter one after another; --i is their order.

/** One screen's content. */
export function tvScreenHtml(sc: { layout: string; kicker: string; heading: string; sub?: string; stats?: Array<[string, string]>; items?: string[] }): string {
  // No named inner functions: a dev build would wrap them in a helper the
  // page does not have.
  const ent: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }
  const re = /[&<>"]/g
  let i = 0
  let out = `<div class="tv-screen tv-screen--${String(sc.layout).replace(re, (c) => ent[c])}">` +
    `<div class="tv-in" style="--i:${i++}"><span class="tv-kicker">${String(sc.kicker ?? "").replace(re, (c) => ent[c])}</span></div>` +
    `<h1 class="tv-in" style="--i:${i++}">${String(sc.heading ?? "").replace(re, (c) => ent[c])}</h1>`
  if (sc.sub) out += `<p class="tv-in" style="--i:${i++}">${String(sc.sub).replace(re, (c) => ent[c])}</p>`
  if (sc.stats && sc.stats.length) {
    out += `<div class="tv-stats">`
    for (const [label, value] of sc.stats) {
      out += `<div class="tv-in" style="--i:${i++}"><b>${String(value).replace(re, (c) => ent[c])}</b><span>${String(label).replace(re, (c) => ent[c])}</span></div>`
    }
    out += `</div>`
  }
  if (sc.items && sc.items.length) {
    out += `<ol class="tv-items">`
    for (const t of sc.items) out += `<li class="tv-in" style="--i:${i++}">${String(t).replace(re, (c) => ent[c])}</li>`
    out += `</ol>`
  }
  return out + `</div>`
}

/** What stays on screen for the whole episode: the channel bug, the
 *  presenter's lower third and the ticker. */
export function tvChromeHtml(ep: { showName: string; presenter: string; ticker: string[] }): string {
  const ent: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }
  const re = /[&<>"]/g
  const line = ep.ticker.map((t) => String(t).replace(re, (c) => ent[c])).join('<i aria-hidden="true">◆</i>')
  return `<div class="tv-bug"><b>AgentX</b> TV</div>` +
    `<div class="tv-third"><b>${String(ep.presenter).replace(re, (c) => ent[c])}</b><span>${String(ep.showName).replace(re, (c) => ent[c])}</span></div>` +
    `<div class="tv-ticker"><span class="tv-ticker__tag">THE WIRE</span><div class="tv-ticker__run"><span>${line}</span><span aria-hidden="true">${line}</span></div></div>`
}

/** The stage's CSS, at 1920×1080. Colours come from the look's custom
 *  properties set on .tv-stage. */
export const TV_STAGE_CSS = `
.tv-stage { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: var(--tv-bg);
  background-image: radial-gradient(1200px 700px at 78% 18%, color-mix(in srgb, var(--tv-accent) 14%, transparent), transparent 70%),
    linear-gradient(180deg, transparent 60%, color-mix(in srgb, #000 35%, transparent));
  color: var(--tv-ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.tv-screen { position: absolute; left: 140px; right: 140px; top: 130px; bottom: 250px; display: flex; flex-direction: column; justify-content: center; }
.tv-screen > * { flex: none; }
.tv-kicker { display: inline-block; background: var(--tv-accent); color: var(--tv-bg); font-weight: 800; font-size: 34px; letter-spacing: .14em; padding: 8px 22px; border-radius: 6px; }
.tv-screen h1 { font-size: 104px; line-height: 1.04; font-weight: 800; letter-spacing: -.02em; margin: 28px 0 0; max-width: 1640px;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.tv-screen p { font-size: 44px; color: var(--tv-muted); margin: 22px 0 0; }
.tv-screen--open h1, .tv-screen--signoff h1 { font-size: 190px; }
.tv-screen--story h1 { font-size: 84px; }
.tv-screen--list h1 { font-size: 78px; }
.tv-stats { display: flex; gap: 28px; margin-top: 48px; }
.tv-stats > div { background: var(--tv-panel); border-radius: 18px; padding: 26px 40px; min-width: 300px; border-top: 6px solid var(--tv-accent); }
.tv-stats b { display: block; font-size: 112px; line-height: 1; font-variant-numeric: tabular-nums; }
.tv-stats span { display: block; font-size: 34px; color: var(--tv-muted); margin-top: 10px; }
.tv-items { list-style: none; margin: 40px 0 0; padding: 0; display: grid; gap: 14px; }
.tv-items li { font-size: 42px; background: var(--tv-panel); border-left: 8px solid var(--tv-accent); padding: 14px 26px; border-radius: 8px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 1640px; }
.tv-screen--headlines h1 { font-size: 72px; }
.tv-screen--headlines .tv-stats { margin-top: 32px; }
.tv-screen--headlines .tv-stats > div { padding: 18px 36px; }
.tv-screen--headlines .tv-stats b { font-size: 88px; }
.tv-screen--headlines .tv-items { margin-top: 28px; gap: 10px; }
.tv-screen--headlines .tv-items li { font-size: 34px; padding: 10px 24px; }
.tv-bug { position: absolute; top: 48px; right: 64px; font-size: 34px; letter-spacing: .06em; color: var(--tv-ink); opacity: .92;
  background: color-mix(in srgb, var(--tv-panel) 80%, transparent); padding: 8px 20px; border-radius: 8px; }
.tv-bug b { color: var(--tv-accent); }
.tv-third { position: absolute; left: 140px; bottom: 132px; display: flex; align-items: stretch; font-size: 36px; }
.tv-third b { background: var(--tv-ink); color: var(--tv-bg); padding: 10px 26px; font-weight: 800; }
.tv-third span { background: var(--tv-panel); color: var(--tv-ink); padding: 10px 26px; }
.tv-ticker { position: absolute; left: 0; right: 0; bottom: 0; height: 84px; display: flex; align-items: center; background: var(--tv-ticker); color: #fff; font-size: 36px; font-weight: 600; overflow: hidden; }
.tv-ticker__tag { flex: none; height: 100%; display: flex; align-items: center; padding: 0 30px; background: var(--tv-accent); color: var(--tv-bg); font-weight: 800; letter-spacing: .1em; z-index: 1; }
.tv-ticker__run { display: flex; white-space: nowrap; will-change: transform; }
.tv-ticker__run > span { padding-right: 80px; }
.tv-ticker i { font-style: normal; margin: 0 28px; opacity: .7; }
`

/** The custom properties for a look, as an inline style. */
export function lookStyle(look: { bg: string; panel: string; ink: string; muted: string; accent: string; ticker: string }): string {
  return `--tv-bg:${look.bg};--tv-panel:${look.panel};--tv-ink:${look.ink};--tv-muted:${look.muted};--tv-accent:${look.accent};--tv-ticker:${look.ticker}`
}
