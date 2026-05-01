import { renderShell, type TopbarPeer } from ".."

// --- /admin/wiki — embed the running wiki server ---
//
// `agentx wiki serve` (default port 4200) is a 1k-line dedicated HTTP
// surface with full markdown + wikilink + tag rendering. Re-implementing
// it inside the dashboard would be a multi-day rewrite for a feature
// nobody is asking for; the tradeoff worth taking is to embed it via
// iframe so operators get one-stop nav without forking the renderer.
//
// AGENTX_WIKI_URL overrides the wiki host (e.g. when wiki serves on a
// peer or behind a different reverse proxy). The __HOST__ sentinel is
// rewritten client-side to location.hostname so the same HTML works on
// localhost and Tailscale.

export interface WikiPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderWikiPage(opts: WikiPageOpts = {}): string {
  const wikiUrl = process.env.AGENTX_WIKI_URL || `http://__HOST__:4200`

  const body = `<div class="ax-wiki">
  <div class="ax-wiki__hint" id="wiki-hint">
    <span>Wiki served from <code id="wiki-url">${wikiUrl}</code></span>
    <span class="ax-wiki__hint-sep">·</span>
    <a id="wiki-open" href="${wikiUrl}" target="_blank" rel="noopener">open in new tab ↗</a>
  </div>
  <iframe id="wiki-frame" class="ax-wiki__frame" src="${wikiUrl}" title="AgentX Wiki" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>
  <div class="ax-wiki__fallback" id="wiki-fallback" hidden>
    <h2>Wiki server isn’t running</h2>
    <p>The wiki UI runs as a separate process so it can stay up while the dashboard restarts. Start it with:</p>
    <pre>agentx wiki serve --port 4200</pre>
    <p>Or override the URL by setting <code>AGENTX_WIKI_URL</code> in the environment.</p>
  </div>
</div>`

  const css = `
    .ax-wiki{display:flex;flex-direction:column;height:calc(100vh - 48px)}
    .ax-wiki__hint{display:flex;align-items:center;gap:8px;padding:6px 14px;font-size:11px;color:var(--ax-muted);background:var(--ax-bg-elev);border-bottom:1px solid var(--ax-border)}
    .ax-wiki__hint code{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--ax-fg)}
    .ax-wiki__hint-sep{opacity:0.5}
    .ax-wiki__hint a{color:var(--ax-accent,#3a7bd5);text-decoration:none}
    .ax-wiki__hint a:hover{text-decoration:underline}
    .ax-wiki__frame{flex:1;width:100%;border:0;background:var(--ax-bg)}
    .ax-wiki__fallback{padding:48px 32px;max-width:640px;margin:0 auto}
    .ax-wiki__fallback h2{font-family:'IBM Plex Sans',sans-serif;font-weight:600;font-size:18px;margin:0 0 12px}
    .ax-wiki__fallback p{color:var(--ax-muted);font-size:13px;line-height:1.6}
    .ax-wiki__fallback pre{background:var(--ax-bg-elev);border:1px solid var(--ax-border);border-radius:6px;padding:10px 12px;font-family:'IBM Plex Mono',monospace;font-size:12px;display:inline-block}
    .ax-wiki__fallback code{font-family:'IBM Plex Mono',monospace;font-size:12px;background:var(--ax-bg-elev);padding:1px 5px;border-radius:3px}
  `

  // Replace __HOST__ at render-time on the client (matches existing topbar
  // pattern), and detect an unreachable wiki via the iframe load timeout.
  const script = `
  (function(){
    var host = location.hostname || 'localhost';
    var urlEl = document.getElementById('wiki-url');
    var openEl = document.getElementById('wiki-open');
    var frame = document.getElementById('wiki-frame');
    var fallback = document.getElementById('wiki-fallback');
    var hint = document.getElementById('wiki-hint');
    var resolved = (urlEl.textContent || '').replace(/__HOST__/g, host);
    urlEl.textContent = resolved;
    openEl.href = resolved;
    frame.src = resolved;

    var loaded = false;
    frame.addEventListener('load', function(){ loaded = true; });
    setTimeout(function(){
      if (loaded) return;
      // Best-effort: ping the URL with a HEAD; if it errors, swap in fallback.
      fetch(resolved, { method: 'HEAD', mode: 'no-cors' })
        .catch(function(){
          frame.style.display = 'none';
          hint.style.display = 'none';
          fallback.hidden = false;
        });
    }, 4000);
  })();
  `

  return renderShell({
    title: "AgentX · Wiki",
    activeTab: "wiki",
    subtitle: "Wiki",
    body,
    css,
    scripts: `<script>${script}</script>`,
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    noMain: true,
  })
}
