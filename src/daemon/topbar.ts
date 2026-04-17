// --- Shared top-chrome for every dashboard surface ---
//
// Four pages render in different files (live + kanban + glossary in
// board-dashboard.ts, settings in admin-panel.ts) but must share: design
// tokens, fonts, theme switcher, brand, primary tab nav, and a mesh-node
// selector. This module exports the CSS + HTML snippets so each page
// composes exactly the same chrome and we never drift them again.
//
// Nothing here is page-specific — callers pass in { activeTab, subtitle,
// subheader? } and compose their own <main> below.

export type TopbarTab = "live" | "boards" | "admin" | "glossary"

export interface TopbarPeer {
  /** Stable id: primary node id, or URL for configured daemons */
  id: string
  name: string
  /** Absolute URL of the peer's dashboard (http://host:port) — selector
   *  navigates to <url>/admin when switched. */
  dashboardUrl: string
  /** True for the node hosting this dashboard (locks the default). */
  primary?: boolean
  /** Optional; shown in the dropdown as "managing via token" hint. */
  tokenScope?: string
}

export interface TopbarOpts {
  activeTab: TopbarTab
  /** Text after the brand, e.g. "Live" / "Settings" / "Boards". */
  subtitle: string
  /** Optional HTML inserted as a second row under the topbar. */
  subheader?: string
  /** Peers to list in the mesh selector. */
  peers?: TopbarPeer[]
  /** id of the peer currently being managed — defaults to the primary. */
  currentPeerId?: string
  /** Optional right-side HTML added before the theme switcher (clocks,
   *  connection dots, etc.). */
  rightExtras?: string
}

/**
 * Font link tags + tiny inline bootstrap script. Callers drop this in <head>.
 */
export const TOPBAR_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<script>(function(){try{var t=localStorage.getItem('ax-theme')||'dark';document.documentElement.setAttribute('data-theme',t)}catch(e){}})();</script>`

/**
 * CSS for topbar + subheader + theme switch + mesh selector. No token
 * definitions — those are per-page because each page's CSS block owns its
 * own :root overrides.
 */
export const TOPBAR_CSS = `
.ax-topbar{display:flex;align-items:center;justify-content:space-between;
  padding:8px 18px;border-bottom:1px solid var(--ax-border);
  background:var(--ax-bg-elev);position:sticky;top:0;z-index:20;gap:10px;flex-wrap:nowrap}
.ax-topbar__left{display:flex;align-items:center;gap:18px;min-width:0}
.ax-brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:-0.01em;flex-shrink:0}
.ax-brand__mark{font-family:var(--ax-mono);font-size:12px;padding:2px 8px;
  border:1px solid var(--ax-border-2);color:var(--ax-accent);border-radius:4px}
.ax-brand__name{font-size:14px}
.ax-brand__subtitle{font-size:11px;color:var(--ax-muted);
  border-left:1px solid var(--ax-border);padding-left:12px;margin-left:4px}
.ax-topbar__tabs{display:flex;gap:2px;min-width:0;overflow-x:auto}
.ax-topbar__tab{background:transparent;border:none;color:var(--ax-text-2);
  padding:8px 14px;font:inherit;cursor:pointer;font-size:12px;text-decoration:none;
  border-bottom:2px solid transparent;letter-spacing:-0.005em;white-space:nowrap}
.ax-topbar__tab:hover{color:var(--ax-text)}
.ax-topbar__tab.is-active{color:var(--ax-text);border-bottom-color:var(--ax-accent)}
.ax-topbar__right{display:flex;align-items:center;gap:10px;font-size:11px;
  color:var(--ax-muted);flex-shrink:0}
.ax-topbar__right .ax-mono{color:var(--ax-text-2)}

/* Mesh selector */
.ax-mesh-sel{position:relative;display:inline-flex;align-items:center;gap:6px;
  padding:4px 10px;border:1px solid var(--ax-border-2);border-radius:4px;
  background:var(--ax-surface);cursor:pointer;font:inherit;font-size:11px;
  color:var(--ax-text-2);white-space:nowrap}
.ax-mesh-sel:hover{border-color:var(--ax-accent);color:var(--ax-text)}
.ax-mesh-sel .lbl{font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:var(--ax-muted);margin-right:2px}
.ax-mesh-sel .name{font-weight:500;color:var(--ax-text)}
.ax-mesh-sel .chev{font-size:9px;opacity:0.6;margin-left:2px}
.ax-mesh-menu{position:absolute;top:calc(100% + 4px);right:0;min-width:240px;
  background:var(--ax-surface);border:1px solid var(--ax-border-2);
  border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.4);padding:4px;z-index:30;display:none}
.ax-mesh-sel.is-open .ax-mesh-menu{display:block}
.ax-mesh-menu a{display:block;padding:7px 10px;border-radius:4px;text-decoration:none;
  color:var(--ax-text-2);font-size:12px}
.ax-mesh-menu a:hover{background:var(--ax-surface-2);color:var(--ax-text)}
.ax-mesh-menu a.is-current{background:color-mix(in oklch,var(--ax-accent) 12%,var(--ax-surface));
  color:var(--ax-accent);border:1px solid color-mix(in oklch,var(--ax-accent) 30%,var(--ax-border-2))}
.ax-mesh-menu a .row{display:flex;align-items:center;gap:8px}
.ax-mesh-menu a .row .dot{width:6px;height:6px;border-radius:50%;background:var(--ax-accent)}
.ax-mesh-menu a.is-offline .row .dot{background:var(--ax-border-2)}
.ax-mesh-menu a .url{font-family:var(--ax-mono);font-size:10px;color:var(--ax-muted);margin-top:2px}

/* Theme switcher segmented control */
.ax-theme-switch{display:inline-flex;border:1px solid var(--ax-border-2);
  border-radius:4px;overflow:hidden}
.ax-theme-switch button{background:transparent;border:none;color:var(--ax-muted);
  padding:3px 9px;font:inherit;font-size:10px;cursor:pointer;letter-spacing:0.04em;
  text-transform:uppercase;font-family:var(--ax-mono);border-right:1px solid var(--ax-border-2)}
.ax-theme-switch button:last-child{border-right:none}
.ax-theme-switch button:hover{color:var(--ax-text);background:var(--ax-surface-2,var(--ax-surface))}
.ax-theme-switch button.is-active{color:var(--ax-accent);
  background:color-mix(in oklch,var(--ax-accent) 12%,var(--ax-surface))}

/* Subheader — page-specific toolbar below the main topbar. Kanban uses it
 * for the board picker + search + filters; others can use it for context
 * bars if they want. */
.ax-subheader{display:flex;align-items:center;gap:10px;padding:10px 18px;
  background:var(--ax-bg-elev);border-bottom:1px solid var(--ax-border);
  flex-wrap:wrap}
.ax-subheader > * {flex-shrink:0}
.ax-subheader .spacer{flex:1}`

/**
 * Shared click wiring for the theme switcher + mesh selector. Safe to call
 * multiple times — only binds once per element.
 */
export const TOPBAR_SCRIPT = `<script>
(function(){
  function wireTheme(){
    var sw = document.querySelectorAll('[data-theme-opt]');
    if (!sw.length) return;
    var current = document.documentElement.getAttribute('data-theme') || 'dark';
    sw.forEach(function(b){
      if (b.dataset.wired) return; b.dataset.wired = '1';
      if (b.getAttribute('data-theme-opt') === current) b.classList.add('is-active');
      b.addEventListener('click', function(){
        var t = b.getAttribute('data-theme-opt');
        document.documentElement.setAttribute('data-theme', t);
        try { localStorage.setItem('ax-theme', t); } catch (e) {}
        sw.forEach(function(x){ x.classList.toggle('is-active', x === b); });
      });
    });
  }
  function wireMesh(){
    var sel = document.querySelector('.ax-mesh-sel');
    if (!sel || sel.dataset.wired) return; sel.dataset.wired = '1';
    sel.addEventListener('click', function(e){
      if (e.target.closest('.ax-mesh-menu a')) return;
      sel.classList.toggle('is-open');
    });
    document.addEventListener('click', function(e){
      if (!sel.contains(e.target)) sel.classList.remove('is-open');
    });
  }
  function wire(){ wireTheme(); wireMesh(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else { wire(); }
})();
</script>`

/**
 * Render the topbar element. Caller places this at the start of <body>.
 * Emits a matching .ax-subheader row only when `subheader` HTML is provided.
 */
export function renderTopbar(opts: TopbarOpts): string {
  const peers = opts.peers && opts.peers.length > 0 ? opts.peers : [{ id: "local", name: "this daemon", dashboardUrl: "", primary: true }]
  const currentId = opts.currentPeerId || peers.find((p) => p.primary)?.id || peers[0].id
  const current = peers.find((p) => p.id === currentId) || peers[0]

  const meshMenu = peers.map((p) => {
    const isCurrent = p.id === currentId
    const url = p.dashboardUrl ? `${p.dashboardUrl.replace(/\/+$/, "")}/admin` : "#"
    const primaryMark = p.primary ? ' <span style="color:var(--ax-muted);font-size:10px">· primary</span>' : ""
    const tokenNote = p.tokenScope ? `<div class="url">token: ${esc(p.tokenScope)}</div>` : ""
    return `<a href="${esc(url)}" class="${isCurrent ? "is-current" : ""}">
      <div class="row"><span class="dot"></span><span>${esc(p.name)}${primaryMark}</span></div>
      ${p.dashboardUrl ? `<div class="url">${esc(p.dashboardUrl)}</div>` : ""}
      ${tokenNote}
    </a>`
  }).join("")

  const meshSelector = `<div class="ax-mesh-sel" aria-haspopup="menu">
    <span class="lbl">managing</span>
    <span class="name">${esc(current.name)}</span>
    <span class="chev">▾</span>
    <div class="ax-mesh-menu" role="menu">${meshMenu}</div>
  </div>`

  const tabs = [
    { id: "live", label: "Live", href: "/live" },
    { id: "boards", label: "Boards", href: "/" },
    { id: "admin", label: "Settings", href: "/admin" },
    { id: "glossary", label: "Glossary", href: "/glossary" },
  ].map((t) => {
    const cls = t.id === opts.activeTab ? "ax-topbar__tab is-active" : "ax-topbar__tab"
    return `<a href="${t.href}" class="${cls}">${t.label}</a>`
  }).join("")

  const header = `<header class="ax-topbar">
  <div class="ax-topbar__left">
    <div class="ax-brand">
      <span class="ax-brand__mark">AX</span>
      <span class="ax-brand__name">AgentX</span>
      <span class="ax-brand__subtitle">${esc(opts.subtitle)}</span>
    </div>
    <nav class="ax-topbar__tabs">${tabs}</nav>
  </div>
  <div class="ax-topbar__right">
    ${opts.rightExtras || ""}
    ${meshSelector}
    <div class="ax-theme-switch" role="tablist" aria-label="Theme">
      <button data-theme-opt="dark">Dark</button>
      <button data-theme-opt="light">Light</button>
      <button data-theme-opt="crt">CRT</button>
    </div>
  </div>
</header>${opts.subheader ? `<div class="ax-subheader">${opts.subheader}</div>` : ""}`
  return header
}

function esc(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}
