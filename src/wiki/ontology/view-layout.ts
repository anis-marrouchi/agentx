// --- Wiki knowledge-graph view: page frame, sidebar, icons (#811) ---
//
// Server-rendered HTML with no client build, like the rest of the wiki.
// The sidebar is the widest zoom level (Z0): Home, the owner's pins and
// the pillars, nothing deeper.

import { normName, type WikiGraph } from "./graph"
import type { Ontology } from "./types"

export function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

const PATHS: Record<string, string> = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  org: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  device: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  app: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6M12 9v6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  agent: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
  project: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  contract: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h4"/>',
  law: '<path d="M12 3v18M5 21h14M6 7h12M6 7l-3 7a3 3 0 0 0 6 0zM18 7l-3 7a3 3 0 0 0 6 0z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  decision: '<path d="M12 3v18M12 8H6l-2 2 2 2h6M12 12h6l2 2-2 2h-6"/>',
  steps: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  topic: '<path d="M4 7h16M4 12h10M4 17h7"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  merge: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M8 6c6 0 8 2 8 6"/>',
}

export function icon(name: string | undefined): string {
  const d = PATHS[name ?? ""] ?? PATHS.topic
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
}

export function typeIcon(o: Ontology, type: string | undefined): string {
  return icon(o.types.find(t => t.id === type)?.icon)
}

export function typeLabel(o: Ontology, type: string | undefined): string {
  return o.types.find(t => t.id === type)?.label ?? type ?? ""
}

export function entityHref(id: string): string {
  return `/e/${encodeURIComponent(id)}`
}

export interface Crumb { label: string; href?: string }

/** Wiki / Pillar / Kind / Page / Panel, following the zoom. */
export function crumbs(list: Crumb[]): string {
  const parts = [{ label: "Wiki", href: "/" }, ...list].map((c, i, all) =>
    i === all.length - 1 || !c.href ? `<b>${esc(c.label)}</b>` : `<a href="${c.href}">${esc(c.label)}</a>`)
  return `<nav class="ox-crumbs" aria-label="Breadcrumb">${parts.join('<span aria-hidden="true">/</span>')}</nav>`
}

/** The Z0–Z4 indicator. `at` is the current level. */
export function zoomBar(at: 1 | 2 | 3 | 4): string {
  const names = ["", "Pillar", "Overview", "Panel", "Statement"]
  const cells = [1, 2, 3, 4].map(z => `<span class="${z === at ? "on" : ""}">Z${z}${z === at ? ` ${names[z]}` : ""}</span>`)
  return `<div class="ox-zoom" title="Zoom level">${cells.join("")}</div>`
}

export function sidebar(g: WikiGraph, active: { pillar?: string; entity?: string; home?: boolean }): string {
  const o = g.ontology
  let html = `<a class="ox-nav${active.home ? " on" : ""}" href="/">${icon("home")}<span>Home</span></a>`
  const pins = o.sidebar.pins.slice(0, o.sidebar.pins_max)
  if (pins.length) {
    html += `<div class="ox-side-h">Pinned</div>`
    for (const title of pins) {
      const id = g.names.get(normName(title))
      const e = id ? g.entities.get(id) : undefined
      if (!e) continue
      html += `<a class="ox-nav pin${active.entity === e.id ? " on" : ""}" href="${entityHref(e.id)}">${typeIcon(o, e.type)}<span>${esc(e.title)}</span></a>`
    }
  }
  html += `<div class="ox-side-h">Pillars</div>`
  for (const p of o.pillars) {
    if (p.sidebar === false) continue
    html += `<a class="ox-nav${active.pillar === p.id ? " on" : ""}" href="/p/${encodeURIComponent(p.id)}">${icon(p.icon)}<span>${esc(p.label)}</span></a>`
  }
  html += `<div class="ox-side-foot">Types, topics and agent wikis are one level down, on Home and the pillar pages.</div>`
  return html
}

export function layout(title: string, side: string, main: string, rail = "", q = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Wiki</title>
<style>${CSS}</style>
<script>(function(){try{var t=localStorage.getItem('wiki-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}})();</script>
</head>
<body>
<div class="ox-app">
  <header class="ox-top">
    <a class="ox-logo" href="/"><span class="mark"><i></i></span>Wiki</a>
    <form class="ox-search" action="/find" method="get" role="search">${icon("search")}<input type="search" name="q" value="${esc(q)}" placeholder="Jump to any page" aria-label="Search the wiki" autocomplete="off"><kbd>⌘K</kbd></form>
    <span class="ox-spacer"></span>
    <a class="ox-btn" href="/agents">Agent wikis</a>
    <button class="ox-btn" id="ox-theme" type="button" aria-label="Toggle theme">Theme</button>
  </header>
  <div class="ox-layout${rail ? " rail" : ""}">
    <nav class="ox-side" aria-label="Wiki">${side}</nav>
    <main class="ox-main">${main}</main>
    ${rail ? `<aside class="ox-rail">${rail}</aside>` : ""}
  </div>
</div>
<script>
(function(){
  var b=document.getElementById('ox-theme');
  if(b)b.addEventListener('click',function(){var d=document.documentElement.getAttribute('data-theme')==='dark'?'':'dark';if(d)document.documentElement.setAttribute('data-theme','dark');else document.documentElement.removeAttribute('data-theme');try{localStorage.setItem('wiki-theme',d)}catch(e){}});
  document.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();var i=document.querySelector('.ox-search input');if(i)i.focus();}});
})();
</script>
</body>
</html>`
}

const CSS = `
:root{--paper:#fafaf9;--card:#fff;--soft:#f4f4f2;--edge:#e7e7e3;--ink:#121614;--muted:#4f5755;--subtle:#7d8684;
--accent:#1e40af;--accent-soft:#eef3ff;--accent-edge:#c7d6fb;--ok:#0f766e;--ok-soft:#effcf9;--ok-edge:#a7eadf;
--warn:#92400e;--warn-soft:#fffbeb;--warn-edge:#fde68a;--bad:#b91c1c;--bad-soft:#fef2f2;--bad-edge:#fecaca;
--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
[data-theme=dark]{--paper:#111413;--card:#181c1b;--soft:#1f2422;--edge:#2c3331;--ink:#e9eeec;--muted:#b3bcba;--subtle:#87918f;
--accent:#9db7ff;--accent-soft:#1c2540;--accent-edge:#33406a;--ok:#5eead4;--ok-soft:#10302b;--ok-edge:#1d5249;
--warn:#fcd34d;--warn-soft:#33290f;--warn-edge:#5c4a17;--bad:#fca5a5;--bad-soft:#3a1717;--bad-edge:#5e2525}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.45 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.ox-top{display:flex;align-items:center;gap:16px;padding:10px 18px;border-bottom:1px solid var(--edge);background:var(--card);position:sticky;top:0;z-index:5}
body>a[href="/admin"]+.ox-app .ox-top{padding-right:130px}
.ox-logo{display:flex;align-items:center;gap:9px;font-weight:600;color:var(--ink);width:200px}
.ox-logo .mark{width:24px;height:24px;border-radius:7px;background:var(--ink);display:flex;align-items:center;justify-content:center}
.ox-logo .mark i{width:8px;height:8px;border-radius:50%;background:#14b8a6}
.ox-search{flex:0 1 440px;display:flex;align-items:center;gap:8px;border:1px solid var(--edge);border-radius:999px;padding:6px 12px;background:var(--paper)}
.ox-search svg{width:15px;height:15px;color:var(--subtle)}
.ox-search input{flex:1;border:0;background:transparent;color:var(--ink);font:13px var(--sans);outline:none}
.ox-search kbd{font:11px var(--mono);color:var(--subtle)}
.ox-spacer{flex:1}
.ox-btn{font:12.5px var(--sans);border:1px solid var(--edge);background:var(--card);color:var(--ink);border-radius:999px;padding:5px 12px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.ox-layout{display:grid;grid-template-columns:230px minmax(0,1fr)}
.ox-layout.rail{grid-template-columns:230px minmax(0,1fr) 290px}
.ox-side{border-right:1px solid var(--edge);padding:14px 12px;min-height:calc(100vh - 50px)}
.ox-nav{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:10px;color:var(--ink)}
.ox-nav:hover{background:var(--soft);text-decoration:none}
.ox-nav svg{width:16px;height:16px;color:var(--muted);flex:none}
.ox-nav span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ox-nav.on{background:var(--accent-soft);color:var(--accent);font-weight:500}.ox-nav.on svg{color:var(--accent)}
.ox-side-h{font:10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--subtle);padding:16px 10px 6px}
.ox-side-foot{margin-top:18px;border-top:1px solid var(--edge);padding:12px 10px 0;font:10.5px/1.6 var(--mono);color:var(--subtle)}
.ox-main{padding:20px 28px 48px;min-width:0}
.ox-rail{border-left:1px solid var(--edge);padding:20px 18px}
.ox-bar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.ox-crumbs{font:11.5px var(--mono);color:var(--subtle);display:flex;gap:8px;flex-wrap:wrap}
.ox-crumbs b{color:var(--ink);font-weight:500}
.ox-zoom{display:inline-flex;border:1px solid var(--edge);border-radius:999px;padding:3px;background:var(--card);gap:2px}
.ox-zoom span{font:10.5px var(--mono);letter-spacing:.05em;text-transform:uppercase;padding:4px 9px;border-radius:999px;color:var(--subtle)}
.ox-zoom span.on{background:var(--ink);color:var(--paper)}
.ox-head{display:flex;gap:16px;align-items:flex-start;margin:16px 0 18px}
.ox-avatar{width:54px;height:54px;border-radius:14px;background:var(--accent-soft);border:1px solid var(--accent-edge);display:flex;align-items:center;justify-content:center;color:var(--accent);flex:none}
.ox-avatar svg{width:26px;height:26px}
.ox-head h1{font-size:30px;margin:2px 0 8px;letter-spacing:-.02em;font-weight:600;line-height:1.15}
.ox-head p{margin:0;color:var(--muted)}
.ox-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ox-chip{font-size:12px;border:1px solid var(--edge);background:var(--card);border-radius:999px;padding:2px 10px;color:var(--muted);display:inline-flex;gap:6px;align-items:center;white-space:nowrap}
.ox-chip svg{width:12px;height:12px}
.ox-chip.type{background:var(--accent-soft);border-color:var(--accent-edge);color:var(--accent)}
.ox-chip.mono{font:11px var(--mono)}
.ox-st{font:10px var(--mono);letter-spacing:.07em;text-transform:uppercase;border-radius:999px;padding:3px 8px;border:1px solid;white-space:nowrap}
.ox-st.ok,.ox-st.confirmed{color:var(--ok);background:var(--ok-soft);border-color:var(--ok-edge)}
.ox-st.proposed{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-edge)}
.ox-st.warn,.ox-st.due{color:var(--warn);background:var(--warn-soft);border-color:var(--warn-edge)}
.ox-st.bad,.ox-st.late{color:var(--bad);background:var(--bad-soft);border-color:var(--bad-edge)}
.ox-st.major{color:var(--paper);background:var(--ink);border-color:var(--ink)}
.ox-st.normal{color:var(--muted);background:var(--soft);border-color:var(--edge)}
.ox-st.minor{color:var(--subtle);background:var(--card);border-color:var(--edge)}
.ox-card{background:var(--card);border:1px solid var(--edge);border-radius:16px;padding:16px 18px;min-width:0}
.ox-card-h{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}
.ox-card-h h2,.ox-card-h h3{font-size:15px;margin:0;font-weight:600;white-space:nowrap}
.ox-card-h .note{font:11px var(--mono);color:var(--subtle);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.ox-card-h .zin{margin-left:auto;font:11px var(--mono);white-space:nowrap}
.ox-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;margin-top:16px}
.ox-grid2>.wide{grid-column:1/-1}
.ox-grid3{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;margin-top:16px}
.ox-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--edge);font-size:13.5px;min-width:0}
.ox-row:first-of-type{border-top:0}
.ox-row .t{min-width:35%;overflow:hidden;flex:1 1 auto}
.ox-row .t a,.ox-row .t span.l{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ox-row .r{margin-left:auto;display:flex;gap:6px;align-items:center;flex:0 1 auto;min-width:0;flex-wrap:wrap;justify-content:flex-end}
.ox-row .r .ox-chip{max-width:240px;overflow:hidden;text-overflow:ellipsis}
.ox-ic{width:28px;height:28px;border-radius:8px;background:var(--soft);border:1px solid var(--edge);display:flex;align-items:center;justify-content:center;flex:none;color:var(--muted)}
.ox-ic svg{width:14px;height:14px}
.ox-card-h .note svg,.ox-row .l svg{width:12px;height:12px;vertical-align:-2px}
.ox-sub{font:11px var(--mono);color:var(--subtle);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ox-summary{font-size:15px;line-height:1.55;margin:0 0 10px}
.ox-meta{display:flex;gap:16px;flex-wrap:wrap;font:11px var(--mono);color:var(--subtle)}
.ox-lbl{font:10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--subtle);display:block;margin:4px 0 10px}
.ox-annot{border:1px dashed var(--subtle);border-radius:14px;padding:12px 14px;font-size:12.5px;color:var(--muted);line-height:1.5}
.ox-annot ol{margin:6px 0;padding-left:18px}
.ox-annot .ox-sub{white-space:normal;overflow-wrap:anywhere}
.ox-rail .ox-row{font-size:13px}
.ox-tabs{display:flex;gap:4px;border-bottom:1px solid var(--edge);margin:4px 0 0;flex-wrap:wrap}
.ox-tabs a{padding:8px 12px;color:var(--muted);border-bottom:2px solid transparent;font-size:13.5px}
.ox-tabs a.on{color:var(--ink);border-color:var(--ink);font-weight:500}
.ox-tabs a small{font:11px var(--mono);color:var(--subtle);margin-left:4px}
.ox-ev{display:grid;grid-template-columns:86px 70px minmax(0,1fr);gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--edge);font-size:13.5px}
.ox-ev:first-of-type{border-top:0}
.ox-ev .d{font:11px var(--mono);color:var(--subtle)}
.ox-ev a{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.ox-fold{border:1px solid var(--edge);background:var(--soft);border-radius:12px;padding:8px 12px;margin-top:8px;font-size:13px;color:var(--muted)}
.ox-fold summary{cursor:pointer}
.ox-tl-axis,.ox-tl-row{display:grid;grid-template-columns:170px minmax(0,1fr);gap:8px}
.ox-tl-axis{font:10.5px var(--mono);color:var(--subtle);margin-bottom:4px}
.ox-tl-axis .yrs{display:flex;justify-content:space-between}
.ox-tl-row{align-items:center;padding:6px 0;border-top:1px solid var(--edge)}
.ox-tl-row .who{font-size:12.5px;line-height:1.3;min-width:0;overflow:hidden}
.ox-tl-row .who small{display:block;font:10.5px var(--mono);color:var(--subtle)}
.ox-track{position:relative;height:20px;background:var(--soft);border-radius:999px}
.ox-track i{position:absolute;top:2px;height:16px;border-radius:999px;background:var(--accent);color:#fff;font:10px/16px var(--mono);padding:0 7px;white-space:nowrap;overflow:hidden;font-style:normal}
.ox-track i.past{background:var(--subtle)}
.ox-kv{display:grid;grid-template-columns:150px minmax(0,1fr);gap:10px;padding:8px 0;border-top:1px solid var(--edge);font-size:13.5px}
.ox-kv:first-of-type{border-top:0}
.ox-kv .k{color:var(--muted)}
.ox-mask{letter-spacing:.15em;color:var(--muted)}
.ox-prose{line-height:1.6;font-size:14.5px}
.ox-prose h1,.ox-prose h2,.ox-prose h3{font-size:16px;margin:18px 0 6px}
.ox-prose pre{background:var(--soft);padding:10px;border-radius:8px;overflow:auto}
.ox-prose table{border-collapse:collapse}.ox-prose td,.ox-prose th{border:1px solid var(--edge);padding:4px 8px}
.ox-pager{display:flex;gap:10px;margin-top:12px;font:12px var(--mono)}
.ox-empty{color:var(--subtle);font-size:13px;padding:6px 0}
.ox-err{border:1px solid var(--bad-edge);background:var(--bad-soft);color:var(--bad);border-radius:12px;padding:10px 14px;margin:12px 0;font-size:13px}
@media (max-width:1100px){.ox-layout.rail{grid-template-columns:230px minmax(0,1fr)}.ox-rail{grid-column:2;border-left:0;border-top:1px solid var(--edge)}}
@media (max-width:760px){.ox-layout,.ox-layout.rail{grid-template-columns:1fr}.ox-side{min-height:0;border-right:0;border-bottom:1px solid var(--edge)}.ox-rail{grid-column:1}.ox-grid2{grid-template-columns:1fr}.ox-logo{width:auto}.ox-tl-axis,.ox-tl-row{grid-template-columns:110px minmax(0,1fr)}}
`
