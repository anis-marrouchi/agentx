import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { WikiStore } from "./store"
import type { WikiArticle } from "./types"

// --- Lightweight Markdown → HTML (no deps) ---

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function md(text: string, wikiArticles: Map<string, string>): string {
  let html = escapeHtml(text)

  // Code blocks (fenced)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) =>
    `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`)

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Tables
  html = html.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)*)/gm, (_m, header, _sep, body) => {
    const ths = header.split("|").filter((c: string) => c.trim()).map((c: string) => `<th>${c.trim()}</th>`).join("")
    const rows = body.trim().split("\n").map((row: string) => {
      const tds = row.split("|").filter((c: string) => c.trim()).map((c: string) => `<td>${c.trim()}</td>`).join("")
      return `<tr>${tds}</tr>`
    }).join("")
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`
  })

  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Wikilinks → clickable links
  html = html.replace(/\[\[([^\]]+)\]\]/g, (_m, title) => {
    const path = wikiArticles.get(title)
    if (path) {
      return `<a href="/article/${encodeURIComponent(path)}" class="wikilink">${title}</a>`
    }
    return `<a href="/search?q=${encodeURIComponent(title)}" class="wikilink broken">${title}</a>`
  })

  // External links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>')

  // Paragraphs (double newlines)
  html = html.replace(/\n\n+/g, '</p><p>')
  html = `<p>${html}</p>`

  // Clean up empty paragraphs around block elements
  html = html.replace(/<p>(<(?:h[1-4]|pre|table|ul|hr|div))/g, '$1')
  html = html.replace(/(<\/(?:h[1-4]|pre|table|ul|hr|div)>)<\/p>/g, '$1')
  html = html.replace(/<p>\s*<\/p>/g, '')

  return html
}

// --- CSS Theme (Wikipedia-inspired) ---

const CSS = `
:root {
  --bg: #f8f9fa;
  --card: #ffffff;
  --border: #a2a9b1;
  --link: #0645ad;
  --link-visited: #0b0080;
  --link-broken: #ba0000;
  --heading-border: #a2a9b1;
  --text: #202122;
  --text-dim: #54595d;
  --accent: #eaecf0;
  --sidebar-bg: #f8f9fa;
  --tag: #eaf3ff;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, 'Segoe UI', Roboto, 'Liberation Sans', sans-serif;
  color: var(--text);
  background: var(--bg);
  line-height: 1.6;
}

.layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  min-height: 100vh;
}

.sidebar {
  background: var(--card);
  border-right: 1px solid var(--border);
  padding: 20px 16px;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}

.sidebar h2 {
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  margin: 20px 0 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--accent);
}

.sidebar h2:first-child { margin-top: 0; }

.sidebar a {
  display: block;
  padding: 4px 8px;
  color: var(--link);
  text-decoration: none;
  font-size: 14px;
  border-radius: 3px;
}

.sidebar a:hover { background: var(--accent); }
.sidebar a.active { background: var(--tag); font-weight: 600; }

.sidebar .logo {
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
  text-decoration: none;
  display: block;
  margin-bottom: 16px;
  padding: 4px 8px;
}

.sidebar .search-box {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 14px;
  margin-bottom: 12px;
}

.main {
  padding: 32px 48px;
  max-width: 960px;
}

.main h1 {
  font-size: 28px;
  font-weight: 400;
  border-bottom: 1px solid var(--heading-border);
  padding-bottom: 8px;
  margin-bottom: 16px;
}

.main h2 {
  font-size: 22px;
  font-weight: 400;
  border-bottom: 1px solid var(--accent);
  padding-bottom: 4px;
  margin: 24px 0 12px;
}

.main h3 { font-size: 18px; margin: 20px 0 8px; }
.main h4 { font-size: 16px; margin: 16px 0 8px; }
.main p { margin: 8px 0; }
.main ul { margin: 8px 0 8px 24px; }
.main li { margin: 2px 0; }

.main a { color: var(--link); }
.main a:visited { color: var(--link-visited); }
.main a.wikilink.broken { color: var(--link-broken); }

.meta {
  background: var(--accent);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 12px 16px;
  margin-bottom: 20px;
  font-size: 13px;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 16px;
}

.meta dt { font-weight: 600; color: var(--text-dim); }
.meta dd { color: var(--text); }

.tag {
  display: inline-block;
  background: var(--tag);
  border-radius: 3px;
  padding: 1px 8px;
  font-size: 12px;
  margin: 1px 2px;
}

table {
  border-collapse: collapse;
  margin: 12px 0;
  width: 100%;
}

th, td {
  border: 1px solid var(--border);
  padding: 6px 12px;
  text-align: left;
  font-size: 14px;
}

th { background: var(--accent); font-weight: 600; }
tr:hover td { background: #f0f4ff; }

pre {
  background: #f5f5f5;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 12px;
  overflow-x: auto;
  font-size: 13px;
  margin: 12px 0;
}

code { font-family: 'SF Mono', Menlo, monospace; font-size: 13px; }
p code { background: #f5f5f5; padding: 1px 4px; border-radius: 2px; }

.entry-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 12px 16px;
  margin: 8px 0;
}

.entry-card .meta-line {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 4px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin: 16px 0;
}

.stat-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  text-align: center;
}

.stat-card .number {
  font-size: 32px;
  font-weight: 700;
  color: var(--link);
}

.stat-card .label {
  font-size: 13px;
  color: var(--text-dim);
  margin-top: 4px;
}

.backlinks {
  background: #fffbe6;
  border: 1px solid #e6d98c;
  border-radius: 4px;
  padding: 12px 16px;
  margin-top: 24px;
  font-size: 13px;
}

.backlinks h4 { margin-bottom: 4px; }

@media (max-width: 768px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
  .main { padding: 20px; }
}
`

// --- HTML Templates ---

function layout(title: string, sidebar: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — AgentX Wiki</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="layout">
    <nav class="sidebar">
      <a href="/" class="logo">AgentX Wiki</a>
      <form action="/search" method="get">
        <input type="text" name="q" class="search-box" placeholder="Search wiki...">
      </form>
      ${sidebar}
    </nav>
    <main class="main">
      ${content}
    </main>
  </div>
</body>
</html>`
}

function buildSidebar(store: WikiStore, activePath?: string): string {
  const index = store.rebuildIndex()
  const byType = new Map<string, typeof index.articles>()

  for (const article of index.articles) {
    const list = byType.get(article.type) || []
    list.push(article)
    byType.set(article.type, list)
  }

  const typeLabels: Record<string, string> = {
    project: "Projects",
    concept: "Concepts",
    process: "Processes",
    decision: "Decisions",
    person: "People",
    pattern: "Patterns",
    incident: "Incidents",
    report: "Reports",
  }

  let html = '<h2>Navigation</h2>'
  html += `<a href="/"${!activePath ? ' class="active"' : ''}>Home</a>`
  html += `<a href="/entries">Raw Entries</a>`
  html += `<a href="/lint">Health Check</a>`

  for (const [type, articles] of byType) {
    html += `<h2>${typeLabels[type] || type}</h2>`
    for (const a of articles) {
      const isActive = a.path === activePath
      html += `<a href="/article/${encodeURIComponent(a.path)}"${isActive ? ' class="active"' : ''}>${escapeHtml(a.title)}</a>`
    }
  }

  return html
}

// --- Route Handlers ---

function handleHome(store: WikiStore): string {
  const index = store.rebuildIndex()
  const entries = store.listEntries()
  const unabsorbed = store.getUnabsorbedEntries()

  let content = '<h1>AgentX Wiki</h1>'

  // Stats
  content += '<div class="stats">'
  content += `<div class="stat-card"><div class="number">${index.articles.length}</div><div class="label">Articles</div></div>`
  content += `<div class="stat-card"><div class="number">${entries.length}</div><div class="label">Raw Entries</div></div>`
  content += `<div class="stat-card"><div class="number">${unabsorbed.length}</div><div class="label">Unabsorbed</div></div>`

  const types = new Set(index.articles.map(a => a.type))
  content += `<div class="stat-card"><div class="number">${types.size}</div><div class="label">Categories</div></div>`
  content += '</div>'

  // Article list
  if (index.articles.length > 0) {
    content += '<h2>All Articles</h2><table>'
    content += '<tr><th>Title</th><th>Type</th><th>Owner</th><th>Updated</th><th>Sources</th></tr>'
    for (const a of index.articles) {
      content += `<tr>
        <td><a href="/article/${encodeURIComponent(a.path)}">${escapeHtml(a.title)}</a></td>
        <td><span class="tag">${a.type}</span></td>
        <td>${escapeHtml(a.owner || "")}</td>
        <td>${a.lastUpdated || ""}</td>
        <td>${a.sources?.length || 0}</td>
      </tr>`
    }
    content += '</table>'
  }

  // Recent entries
  const recent = entries.slice(-5).reverse()
  if (recent.length > 0) {
    content += '<h2>Recent Entries</h2>'
    for (const e of recent) {
      content += `<div class="entry-card">
        <div class="meta-line">${e.date} &middot; <strong>${escapeHtml(e.agentId)}</strong> via ${e.source}</div>
        <p>${escapeHtml(e.content.slice(0, 200))}${e.content.length > 200 ? "..." : ""}</p>
      </div>`
    }
  }

  return layout("Home", buildSidebar(store), content)
}

function handleArticle(store: WikiStore, path: string): string | null {
  const article = store.readArticle(path)
  if (!article) return null

  // Build wikilink lookup
  const index = store.rebuildIndex()
  const titleToPath = new Map<string, string>()
  for (const a of index.articles) {
    titleToPath.set(a.title, a.path)
  }

  // Build backlinks
  const backlinks = store.buildBacklinks()
  const inbound = backlinks[article.meta.title] || []

  let content = `<h1>${escapeHtml(article.meta.title)}</h1>`

  // Meta box
  content += '<dl class="meta">'
  content += `<dt>Type</dt><dd><span class="tag">${article.meta.type}</span></dd>`
  content += `<dt>Owner</dt><dd>${escapeHtml(article.meta.owner)}</dd>`
  content += `<dt>Created</dt><dd>${article.meta.created}</dd>`
  content += `<dt>Updated</dt><dd>${article.meta.lastUpdated}</dd>`
  if (article.meta.sources?.length) {
    content += `<dt>Sources</dt><dd>${article.meta.sources.length} entries</dd>`
  }
  content += '</dl>'

  // Rendered content
  content += md(article.content, titleToPath)

  // Backlinks
  if (inbound.length > 0) {
    content += '<div class="backlinks"><h4>Pages that link here:</h4><ul>'
    for (const link of inbound) {
      const linkedArticle = store.readArticle(link)
      const title = linkedArticle?.meta.title || link
      content += `<li><a href="/article/${encodeURIComponent(link)}">${escapeHtml(title)}</a></li>`
    }
    content += '</ul></div>'
  }

  return layout(article.meta.title, buildSidebar(store, path), content)
}

function handleEntries(store: WikiStore): string {
  const entries = store.listEntries()

  let content = '<h1>Raw Entries</h1>'
  content += `<p>${entries.length} entries from agent conversations</p>`

  // Group by date
  const byDate = new Map<string, typeof entries>()
  for (const e of entries) {
    const list = byDate.get(e.date) || []
    list.push(e)
    byDate.set(e.date, list)
  }

  for (const [date, dateEntries] of [...byDate].reverse()) {
    content += `<h2>${date}</h2>`
    for (const e of dateEntries) {
      content += `<div class="entry-card">
        <div class="meta-line">
          <strong>${escapeHtml(e.agentId)}</strong> via ${e.source}
          &middot; <code>${e.id}</code>
        </div>
        <p>${escapeHtml(e.content.slice(0, 500))}${e.content.length > 500 ? "..." : ""}</p>
      </div>`
    }
  }

  return layout("Raw Entries", buildSidebar(store), content)
}

function handleLint(store: WikiStore): string {
  const issues = store.lint()

  let content = '<h1>Wiki Health Check</h1>'

  if (issues.length === 0) {
    content += '<p style="color: green; font-size: 18px;">No issues found. Wiki is healthy.</p>'
  } else {
    content += `<p>${issues.length} issues found:</p><table>`
    content += '<tr><th>Type</th><th>Article</th><th>Issue</th></tr>'
    for (const issue of issues) {
      const color = issue.type === "broken-link" ? "#ba0000"
        : issue.type === "orphan" ? "#e6a700"
        : "#54595d"
      content += `<tr>
        <td><span class="tag" style="background: ${color}; color: white;">${issue.type}</span></td>
        <td><a href="/article/${encodeURIComponent(issue.article)}">${escapeHtml(issue.article)}</a></td>
        <td>${escapeHtml(issue.message)}</td>
      </tr>`
    }
    content += '</table>'
  }

  return layout("Health Check", buildSidebar(store), content)
}

function handleSearch(store: WikiStore, query: string): string {
  const results = store.findRelevant(query, undefined, 20)

  let content = `<h1>Search: "${escapeHtml(query)}"</h1>`

  if (results.length === 0) {
    content += '<p>No articles found.</p>'
  } else {
    content += `<p>${results.length} results</p>`
    for (const r of results) {
      content += `<div class="entry-card">
        <div class="meta-line"><span class="tag">${r.meta.type}</span> &middot; ${r.meta.owner}</div>
        <h3><a href="/article/${encodeURIComponent(r.path)}">${escapeHtml(r.meta.title)}</a></h3>
        <p>${escapeHtml(r.content.slice(0, 200))}...</p>
      </div>`
    }
  }

  return layout(`Search: ${query}`, buildSidebar(store), content)
}

// --- Server ---

export function startWikiServer(wikiDir: string, port: number = 4200): void {
  const store = new WikiStore(wikiDir)

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`)
    const path = decodeURIComponent(url.pathname)

    let html: string | null = null
    let status = 200

    try {
      if (path === "/" || path === "") {
        html = handleHome(store)
      } else if (path.startsWith("/article/")) {
        const articlePath = path.slice("/article/".length)
        html = handleArticle(store, articlePath)
        if (!html) { status = 404; html = layout("Not Found", buildSidebar(store), "<h1>Article not found</h1>") }
      } else if (path === "/entries") {
        html = handleEntries(store)
      } else if (path === "/lint") {
        html = handleLint(store)
      } else if (path === "/search") {
        const q = url.searchParams.get("q") || ""
        html = handleSearch(store, q)
      } else {
        status = 404
        html = layout("Not Found", buildSidebar(store), "<h1>Page not found</h1>")
      }
    } catch (err: any) {
      status = 500
      html = layout("Error", buildSidebar(store), `<h1>Error</h1><pre>${escapeHtml(err.message)}</pre>`)
    }

    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
    res.end(html)
  })

  server.listen(port, () => {
    // caller prints the URL
  })
}
