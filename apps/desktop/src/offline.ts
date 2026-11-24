// The page shown when the dashboard does not answer.

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)
}

export function offlinePage(hub: string): string {
  const url = escapeHtml(hub)
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>AgentX</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; display: grid; place-items: center; height: 100vh; margin: 0; }
  div { max-width: 28rem; padding: 2rem; }
  code { font-size: 13px; }
  a { display: inline-block; margin-top: .5rem; padding: .4rem .9rem; border-radius: 8px; background: #1a1a18; color: #fff; text-decoration: none; }
</style></head><body><div>
<h2>AgentX is not answering</h2>
<p>The app could not reach the dashboard at <code>${url}</code>. Start it in a terminal with <code>agentx daemon start</code>, then try again.</p>
<a href="${url}">Try again</a>
</div></body></html>`
  return "data:text/html;charset=utf-8," + encodeURIComponent(html)
}
