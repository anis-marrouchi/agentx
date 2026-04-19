import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { WikiStore } from "./store"
import { WikiHub } from "./hub"
import { MeshWikiClient } from "./mesh"
import type { AgentWikiSummary } from "./hub"

// --- Lightweight Markdown → HTML (no deps) ---

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/**
 * Strip legacy section-tag comments from the article body. The old absorb
 * prompt told the LLM to add `<!-- tags: runbook, staging -->` inside
 * sections; in the Farzapedia-aligned design, these are no longer
 * load-bearing and leak through as visible literal text once escaped.
 */
function stripSectionTags(text: string): string {
  return text.replace(/<!--\s*tags?:[^>]*-->\s*\n?/gi, "")
}

/** Render a single tag as a clickable link to the tag-filter route. */
function tagLink(tag: string, agentId?: string): string {
  const href = agentId
    ? `/agent/${encodeURIComponent(agentId)}/tag/${encodeURIComponent(tag)}`
    : `/tag/${encodeURIComponent(tag)}`
  return `<a href="${href}" class="tag">${escapeHtml(tag)}</a>`
}

/** Render an array of tags as clickable links, space-separated. */
function tagLinks(tags: string[] | undefined, agentId?: string): string {
  return (tags || []).map(t => tagLink(t, agentId)).join(" ")
}

function md(text: string, wikiArticles: Map<string, string>, agentPrefix: string = ""): string {
  // Strip section-tag HTML comments before escaping so they don't render
  // as literal "<!-- tags: ... -->" in the output.
  let html = escapeHtml(stripSectionTags(text))

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

  // Wikilinks
  html = html.replace(/\[\[([^\]]+)\]\]/g, (_m, title) => {
    const path = wikiArticles.get(title)
    if (path) {
      return `<a href="${agentPrefix}/article/${encodeURIComponent(path)}" class="wikilink">${title}</a>`
    }
    return `<a href="${agentPrefix}/search?q=${encodeURIComponent(title)}" class="wikilink broken">${title}</a>`
  })

  // External links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')

  // Blockquotes (consecutive `> ` lines → one <blockquote>)
  html = html.replace(/^(>\s?.*(?:\n>\s?.*)*)/gm, (block: string) => {
    const inner = block.split("\n").map(l => l.replace(/^>\s?/, "")).join("<br>")
    return `<blockquote>${inner}</blockquote>`
  })

  // Task-list items (render as plain text with unicode checkbox)
  html = html.replace(/^[-*] \[( |x|X)\] (.+)$/gm, (_m, chk, rest) =>
    `<li class="task">${chk.toLowerCase() === "x" ? "☑" : "☐"} ${rest}</li>`)

  // Unordered lists
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>')

  // Ordered lists — match lines like "1. foo" (number, dot, space)
  html = html.replace(/^\d+\. (.+)$/gm, '<li data-ordered="1">$1</li>')

  // Wrap consecutive <li>s in <ul> / <ol> respectively
  html = html.replace(/(<li data-ordered="1">.*?<\/li>(?:\n?<li data-ordered="1">.*?<\/li>)*)/g,
    (match) => `<ol>${match.replace(/ data-ordered="1"/g, "")}</ol>`)
  html = html.replace(/((?:<li(?! data-ordered)[^>]*>.*?<\/li>\n?)+)/g, '<ul>$1</ul>')

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>')

  // Paragraphs — only wrap non-block lines. A paragraph is a run of
  // text that isn't already wrapped in a block-level tag.
  html = html.replace(/\n\n+/g, '</p><p>')
  html = `<p>${html}</p>`
  // Unwrap <p>...</p> that now contain block-level elements.
  html = html.replace(/<p>\s*(<(?:h[1-6]|ul|ol|blockquote|table|pre|hr)\b[^>]*>[\s\S]*?<\/(?:h[1-6]|ul|ol|blockquote|table|pre)>)\s*<\/p>/g, "$1")
  html = html.replace(/<p>\s*<hr>\s*<\/p>/g, "<hr>")
  // Drop empty paragraphs that remain.
  html = html.replace(/<p>\s*<\/p>/g, "")

  html = html.replace(/<p>(<(?:h[1-4]|pre|table|ul|hr|div))/g, '$1')
  html = html.replace(/(<\/(?:h[1-4]|pre|table|ul|hr|div)>)<\/p>/g, '$1')
  html = html.replace(/<p>\s*<\/p>/g, '')

  return html
}

// --- CSS ---

const CSS = `
:root {
  --bg: #f8f9fa; --card: #ffffff; --border: #a2a9b1;
  --link: #0645ad; --link-visited: #0b0080; --link-broken: #ba0000;
  --heading-border: #a2a9b1; --text: #202122; --text-dim: #54595d;
  --accent: #eaecf0; --tag: #eaf3ff;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: var(--text); background: var(--bg); line-height: 1.6; }
.layout { display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }
.sidebar { background: var(--card); border-right: 1px solid var(--border); padding: 20px 16px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.sidebar h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin: 20px 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--accent); }
.sidebar h2:first-child { margin-top: 0; }
.sidebar a { display: block; padding: 3px 8px; color: var(--link); text-decoration: none; font-size: 14px; border-radius: 3px; }
.sidebar a:hover { background: var(--accent); }
.sidebar a.active { background: var(--tag); font-weight: 600; }
.sidebar .logo { font-size: 20px; font-weight: 700; color: var(--text); text-decoration: none; display: block; margin-bottom: 12px; padding: 4px 8px; }
.sidebar .search-box { width: 100%; padding: 6px 10px; border: 1px solid var(--border); border-radius: 4px; font-size: 14px; margin-bottom: 12px; }
.sidebar .agent-badge { display: inline-block; background: #dcedc8; color: #33691e; border-radius: 3px; padding: 1px 6px; font-size: 11px; font-weight: 600; margin-left: 4px; }
.main { padding: 32px 48px; max-width: 960px; }
.main h1 { font-size: 28px; font-weight: 400; border-bottom: 1px solid var(--heading-border); padding-bottom: 8px; margin-bottom: 16px; }
.main h2 { font-size: 22px; font-weight: 400; border-bottom: 1px solid var(--accent); padding-bottom: 4px; margin: 24px 0 12px; }
.main h3 { font-size: 18px; margin: 20px 0 8px; }
.main h4 { font-size: 16px; margin: 16px 0 8px; }
.main p { margin: 8px 0; }
.main ul { margin: 8px 0 8px 24px; }
.main li { margin: 2px 0; }
.main a { color: var(--link); }
.main a:visited { color: var(--link-visited); }
.main a.wikilink.broken { color: var(--link-broken); }
.meta { background: var(--accent); border: 1px solid var(--border); border-radius: 4px; padding: 12px 16px; margin-bottom: 20px; font-size: 13px; display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; }
.meta dt { font-weight: 600; color: var(--text-dim); }
.tag { display: inline-block; background: var(--tag); border-radius: 3px; padding: 1px 8px; font-size: 12px; margin: 1px 2px; color: inherit; text-decoration: none; }
a.tag:hover { background: var(--border); cursor: pointer; }
.article-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 2px 0; }
.article-row .article-title { margin-left: 4px; }
.article-list { display: flex; flex-direction: column; }
table { border-collapse: collapse; margin: 12px 0; width: 100%; }
th, td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; font-size: 14px; }
th { background: var(--accent); font-weight: 600; }
tr:hover td { background: #f0f4ff; }
pre { background: #f5f5f5; border: 1px solid var(--border); border-radius: 4px; padding: 12px; overflow-x: auto; font-size: 13px; margin: 12px 0; }
code { font-family: 'SF Mono', Menlo, monospace; font-size: 13px; }
p code { background: #f5f5f5; padding: 1px 4px; border-radius: 2px; }
.entry-card { background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 12px 16px; margin: 8px 0; }
.entry-card .meta-line { font-size: 12px; color: var(--text-dim); margin-bottom: 4px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 16px 0; }
.stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 16px; text-align: center; }
.stat-card .number { font-size: 32px; font-weight: 700; color: var(--link); }
.stat-card .label { font-size: 13px; color: var(--text-dim); margin-top: 4px; }
.agent-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin: 12px 0; transition: box-shadow 0.15s; }
.agent-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
.agent-card h3 { margin: 0 0 8px; }
.agent-card h3 a { text-decoration: none; font-size: 20px; }
.agent-card .agent-stats { display: flex; gap: 16px; font-size: 14px; color: var(--text-dim); }
.agent-card .agent-stats strong { color: var(--text); }
.agent-card .article-list { margin-top: 8px; font-size: 13px; }
.agent-card .article-list a { margin-right: 8px; }
.backlinks { background: #fffbe6; border: 1px solid #e6d98c; border-radius: 4px; padding: 12px 16px; margin-top: 24px; font-size: 13px; }
.backlinks h4 { margin-bottom: 4px; }
.breadcrumb { font-size: 13px; color: var(--text-dim); margin-bottom: 12px; }
.breadcrumb a { color: var(--link); text-decoration: none; }
@media (max-width: 768px) { .layout { grid-template-columns: 1fr; } .sidebar { position: static; height: auto; } .main { padding: 20px; } }
`

// --- HTML Templates ---

function pageLayout(title: string, sidebar: string, content: string): string {
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
    <nav class="sidebar">${sidebar}</nav>
    <main class="main">${content}</main>
  </div>
</body>
</html>`
}

// --- Hub Mode (all agents) ---

function groupByDir(articles: Array<{ title: string; path: string; tags?: string[] }>): Map<string, typeof articles> {
  const byDir = new Map<string, typeof articles>()
  for (const a of articles) {
    const dir = a.path.includes("/") ? a.path.split("/").slice(0, -1).join("/") : "/"
    const list = byDir.get(dir) || []
    list.push(a)
    byDir.set(dir, list)
  }
  return new Map([...byDir].sort((a, b) => a[0].localeCompare(b[0])))
}

function dirLabel(dir: string): string {
  if (dir === "/") return "Root"
  return dir.split("/").pop()!.replace(/-/g, " ")
}

function hubSidebar(agents: AgentWikiSummary[], activePath?: string): string {
  let html = '<a href="/" class="logo">AgentX Wiki</a>'
  html += '<form action="/search" method="get"><input type="text" name="q" class="search-box" placeholder="Search all wikis..."></form>'
  html += '<h2>Hub</h2>'
  html += `<a href="/"${!activePath ? ' class="active"' : ''}>Home</a>`
  html += '<a href="/entries">All Entries</a>'

  for (const agent of agents) {
    const agentPrefix = `/agent/${encodeURIComponent(agent.agentId)}`
    html += `<h2><a href="${agentPrefix}" style="color:inherit;text-decoration:none">${escapeHtml(agent.agentId)}</a> <span class="agent-badge">${agent.totalArticles}</span></h2>`

    // Group articles by type
    const byType = groupByDir(agent.articles)
    for (const [type, articles] of byType) {
      html += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.3px;color:#888;margin:8px 8px 2px;font-weight:600">${dirLabel(type)}</div>`
      for (const a of articles) {
        const fullPath = `${agent.agentId}/${a.path}`
        const isActive = fullPath === activePath
        html += `<a href="${agentPrefix}/article/${encodeURIComponent(a.path)}"${isActive ? ' class="active"' : ''} style="padding-left:16px;font-size:13px">${escapeHtml(a.title)}</a>`
      }
    }
  }

  return html
}

function hubHome(hub: WikiHub, allAgents?: AgentWikiSummary[], remoteAgents?: Array<AgentWikiSummary & { nodeId: string }>): string {
  const agents = allAgents || hub.summary()
  const shared = hub.getSharedStore()
  const totalEntries = shared.listEntries().length
  const totalArticles = agents.reduce((s, a) => s + a.totalArticles, 0)
  const totalUnabsorbed = agents.reduce((s, a) => s + a.unabsorbed, 0)
  const remoteIds = new Set((remoteAgents || []).map(r => r.agentId))

  let content = '<h1>AgentX Wiki Hub</h1>'

  // Stats
  content += '<div class="stats">'
  content += `<div class="stat-card"><div class="number">${agents.length}</div><div class="label">Agents</div></div>`
  content += `<div class="stat-card"><div class="number">${totalArticles}</div><div class="label">Articles</div></div>`
  content += `<div class="stat-card"><div class="number">${totalEntries}</div><div class="label">Raw Entries</div></div>`
  if (remoteAgents && remoteAgents.length > 0) {
    const nodes = new Set(remoteAgents.map(r => r.nodeId))
    content += `<div class="stat-card"><div class="number">${nodes.size}</div><div class="label">Mesh Nodes</div></div>`
  }
  content += '</div>'

  // Agent cards
  content += '<h2>Agent Wikis</h2>'
  for (const agent of agents) {
    const status = agent.unabsorbed > 0
      ? `<span style="color: #e6a700;">${agent.unabsorbed} unabsorbed</span>`
      : '<span style="color: green;">up to date</span>'

    const isRemote = remoteIds.has(agent.agentId) && !hub.listAgents().includes(agent.agentId)
    const remoteBadge = isRemote ? ' <span class="tag" style="background:#fff3cd;color:#856404">remote</span>' : ''

    content += `<div class="agent-card">`
    content += `<h3><a href="/agent/${encodeURIComponent(agent.agentId)}">${escapeHtml(agent.agentId)}</a>${remoteBadge}</h3>`
    content += `<div class="agent-stats">
      <span><strong>${agent.totalArticles}</strong> articles</span>
      <span><strong>${agent.totalEntries}</strong> entries</span>
      <span>${status}</span>
    </div>`

    if (agent.articles.length > 0) {
      content += '<div class="article-list">'
      for (const a of agent.articles) {
        // Tags are individual anchors so each is independently clickable.
        // Article title is its own anchor, so nesting doesn't apply.
        const tagPart = tagLinks((a.tags || []).slice(0, 3), agent.agentId)
        content += `<div class="article-row">${tagPart} <a class="article-title" href="/agent/${encodeURIComponent(agent.agentId)}/article/${encodeURIComponent(a.path)}">${escapeHtml(a.title)}</a></div>`
      }
      content += '</div>'
    }
    content += '</div>'
  }

  return pageLayout("Hub", hubSidebar(agents), content)
}

function hubAgentOverview(hub: WikiHub, agentId: string, allAgents?: AgentWikiSummary[]): string {
  const agents = allAgents || hub.summary()
  const agentSummary = agents.find(a => a.agentId === agentId)
  if (!agentSummary) return pageLayout("Not Found", hubSidebar(agents), "<h1>Agent not found</h1>")

  // Use summary articles (may come from remote peer if it has more)
  const isRemote = (agentSummary as any).peerUrl !== undefined
  const entries = hub.getAgentEntries(agentId)
  const articles = agentSummary.articles || []

  let content = `<div class="breadcrumb"><a href="/">Hub</a> / ${escapeHtml(agentId)}</div>`
  content += `<h1>${escapeHtml(agentId)}</h1>`
  if (isRemote) {
    content += `<p><span class="tag" style="background:#fff3cd;color:#856404">remote @ ${escapeHtml((agentSummary as any).nodeId)}</span></p>`
  }

  // Stats
  content += '<div class="stats">'
  content += `<div class="stat-card"><div class="number">${agentSummary.totalArticles}</div><div class="label">Articles</div></div>`
  content += `<div class="stat-card"><div class="number">${agentSummary.totalEntries}</div><div class="label">Entries</div></div>`
  content += `<div class="stat-card"><div class="number">${agentSummary.unabsorbed}</div><div class="label">Unabsorbed</div></div>`
  content += '</div>'

  // Articles table
  if (articles.length > 0) {
    content += '<h2>Articles</h2><table>'
    content += '<tr><th>Title</th><th>Tags</th></tr>'
    for (const a of articles) {
      content += `<tr>
        <td><a href="/agent/${encodeURIComponent(agentId)}/article/${encodeURIComponent(a.path)}">${escapeHtml(a.title)}</a></td>
        <td>${tagLinks(((a.tags || []) as string[]).slice(0, 4), agentId)}</td>
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
        <div class="meta-line">${e.date} via ${e.source} &middot; <code>${e.id}</code></div>
        <p>${escapeHtml(e.content.slice(0, 300))}${e.content.length > 300 ? "..." : ""}</p>
      </div>`
    }
  }

  // Lint
  const agentStore = hub.getAgentWiki(agentId)
  const issues = agentStore.lint()
  if (issues.length > 0) {
    content += `<h2>Health Issues (${issues.length})</h2><table>`
    content += '<tr><th>Type</th><th>Article</th><th>Issue</th></tr>'
    for (const issue of issues) {
      content += `<tr><td><span class="tag">${issue.type}</span></td><td>${escapeHtml(issue.article)}</td><td>${escapeHtml(issue.message)}</td></tr>`
    }
    content += '</table>'
  }

  return pageLayout(agentId, hubSidebar(agents, agentId), content)
}

function hubArticlePage(hub: WikiHub, agentId: string, articlePath: string, allAgents?: AgentWikiSummary[]): string | null {
  const store = hub.getAgentWiki(agentId)
  const article = store.readArticle(articlePath)
  if (!article) return null

  const agents = allAgents || hub.summary()
  const index = store.rebuildIndex()
  const titleToPath = new Map<string, string>()
  for (const a of index.articles) titleToPath.set(a.title, a.path)

  const prefix = `/agent/${encodeURIComponent(agentId)}`
  const backlinks = store.buildBacklinks()
  const inbound = backlinks[article.meta.title] || []

  let content = `<div class="breadcrumb"><a href="/">Hub</a> / <a href="${prefix}">${escapeHtml(agentId)}</a> / ${escapeHtml(article.meta.title)}</div>`
  content += `<h1>${escapeHtml(article.meta.title)}</h1>`

  // Meta box
  content += '<dl class="meta">'
  if (article.meta.type) {
    content += `<dt>Type</dt><dd>${tagLink(article.meta.type, agentId)}</dd>`
  }
  content += `<dt>Tags</dt><dd>${tagLinks(article.meta.tags, agentId)}</dd>`
  content += `<dt>Owner</dt><dd>${escapeHtml(article.meta.owner)}</dd>`
  content += `<dt>Created</dt><dd>${article.meta.created}</dd>`
  content += `<dt>Updated</dt><dd>${article.meta.lastUpdated}</dd>`
  if (article.meta.sources?.length) {
    content += `<dt>Sources</dt><dd>${article.meta.sources.length} entries</dd>`
  }
  content += '</dl>'

  content += md(article.content, titleToPath, prefix)

  if (inbound.length > 0) {
    content += '<div class="backlinks"><h4>Pages that link here:</h4><ul>'
    for (const link of inbound) {
      const linked = store.readArticle(link)
      content += `<li><a href="${prefix}/article/${encodeURIComponent(link)}">${escapeHtml(linked?.meta.title || link)}</a></li>`
    }
    content += '</ul></div>'
  }

  return pageLayout(article.meta.title, hubSidebar(agents, `${agentId}/${articlePath}`), content)
}

function hubEntries(hub: WikiHub, allAgents?: AgentWikiSummary[]): string {
  const agents = allAgents || hub.summary()
  const shared = hub.getSharedStore()
  const entries = shared.listEntries()

  let content = '<div class="breadcrumb"><a href="/">Hub</a> / Entries</div>'
  content += `<h1>All Raw Entries (${entries.length})</h1>`

  const byDate = new Map<string, typeof entries>()
  for (const e of entries) {
    const list = byDate.get(e.date) || []
    list.push(e)
    byDate.set(e.date, list)
  }

  for (const [date, dateEntries] of [...byDate].reverse()) {
    content += `<h2>${date} (${dateEntries.length})</h2>`
    for (const e of dateEntries) {
      content += `<div class="entry-card">
        <div class="meta-line">
          <a href="/agent/${encodeURIComponent(e.agentId)}">${escapeHtml(e.agentId)}</a>
          via ${e.source} &middot; <code>${e.id}</code>
        </div>
        <p>${escapeHtml(e.content.slice(0, 400))}${e.content.length > 400 ? "..." : ""}</p>
      </div>`
    }
  }

  return pageLayout("All Entries", hubSidebar(agents), content)
}

function hubSearch(hub: WikiHub, query: string, allAgents?: AgentWikiSummary[]): string {
  const agents = allAgents || hub.summary()
  let content = `<h1>Search: "${escapeHtml(query)}"</h1>`
  let totalResults = 0

  for (const agentSummary of agents) {
    const store = hub.getAgentWiki(agentSummary.agentId)
    const results = store.findRelevant(query, undefined, 10)

    if (results.length > 0) {
      content += `<h2>${escapeHtml(agentSummary.agentId)} (${results.length})</h2>`
      for (const r of results) {
        const prefix = `/agent/${encodeURIComponent(agentSummary.agentId)}`
        content += `<div class="entry-card">
          <div class="meta-line">${tagLinks((r.meta.tags || []).slice(0, 3), agentSummary.agentId)}</div>
          <h3><a href="${prefix}/article/${encodeURIComponent(r.path)}">${escapeHtml(r.meta.title)}</a></h3>
          <p>${escapeHtml(r.content.slice(0, 200))}...</p>
        </div>`
      }
      totalResults += results.length
    }
  }

  if (totalResults === 0) content += '<p>No matching articles found.</p>'

  return pageLayout(`Search: ${query}`, hubSidebar(agents), content)
}

/**
 * Hub-wide tag filter. Shows every article tagged with `tag` across all
 * local agents, grouped by agent. Exact-tag match (not BM25).
 */
function hubTagPage(hub: WikiHub, tag: string, allAgents?: AgentWikiSummary[]): string {
  const agents = allAgents || hub.summary()
  let content = `<h1>Tag: <span class="tag">${escapeHtml(tag)}</span></h1>`
  let total = 0
  for (const agentSummary of agents) {
    let store
    try { store = hub.getAgentWiki(agentSummary.agentId) } catch { continue }
    const matches = store.findByTags([tag], undefined, 100)
    if (matches.length === 0) continue
    content += `<h2>${escapeHtml(agentSummary.agentId)} (${matches.length})</h2>`
    for (const a of matches) {
      const prefix = `/agent/${encodeURIComponent(agentSummary.agentId)}`
      content += `<div class="entry-card">
        <div class="meta-line">${tagLinks((a.meta.tags || []).slice(0, 6), agentSummary.agentId)}</div>
        <h3><a href="${prefix}/article/${encodeURIComponent(a.path)}">${escapeHtml(a.meta.title)}</a></h3>
      </div>`
    }
    total += matches.length
  }
  if (total === 0) content += `<p>No articles tagged <code>${escapeHtml(tag)}</code>.</p>`
  return pageLayout(`Tag: ${tag}`, hubSidebar(agents), content)
}

/** Per-agent tag filter — narrows to one agent's corpus. */
function hubAgentTagPage(hub: WikiHub, agentId: string, tag: string, allAgents?: AgentWikiSummary[]): string {
  const agents = allAgents || hub.summary()
  let store
  try { store = hub.getAgentWiki(agentId) } catch {
    return pageLayout(`Tag: ${tag}`, hubSidebar(agents), `<h1>Agent not found: ${escapeHtml(agentId)}</h1>`)
  }
  const matches = store.findByTags([tag], undefined, 100)
  const prefix = `/agent/${encodeURIComponent(agentId)}`
  let content = `<div class="breadcrumb"><a href="/">Hub</a> / <a href="${prefix}">${escapeHtml(agentId)}</a> / Tag: ${escapeHtml(tag)}</div>`
  content += `<h1>${escapeHtml(agentId)} · Tag: <span class="tag">${escapeHtml(tag)}</span></h1>`
  content += `<p>${matches.length} article${matches.length === 1 ? "" : "s"} tagged <code>${escapeHtml(tag)}</code></p>`
  for (const a of matches) {
    content += `<div class="entry-card">
      <div class="meta-line">${tagLinks((a.meta.tags || []).slice(0, 6), agentId)}</div>
      <h3><a href="${prefix}/article/${encodeURIComponent(a.path)}">${escapeHtml(a.meta.title)}</a></h3>
    </div>`
  }
  return pageLayout(`${agentId} · ${tag}`, hubSidebar(agents), content)
}

// --- Single Agent Mode ---

function agentSidebar(store: WikiStore, agentId: string, activePath?: string): string {
  const index = store.rebuildIndex()
  const byType = groupByDir(index.articles.map(a => ({ title: a.title, path: a.path, tags: a.tags })))

  let html = `<a href="/" class="logo">${escapeHtml(agentId)}</a>`
  html += '<form action="/search" method="get"><input type="text" name="q" class="search-box" placeholder="Search..."></form>'
  html += '<h2>Navigation</h2>'
  html += `<a href="/"${!activePath ? ' class="active"' : ''}>Home</a>`
  html += '<a href="/lint">Health Check</a>'

  for (const [type, articles] of byType) {
    html += `<h2>${dirLabel(type)}</h2>`
    for (const a of articles) {
      const isActive = a.path === activePath
      html += `<a href="/article/${encodeURIComponent(a.path)}"${isActive ? ' class="active"' : ''}>${escapeHtml(a.title)}</a>`
    }
  }

  return html
}

// --- Server ---

export function startWikiServer(wikiDir: string, port: number = 4200, agentFilter?: string, peerUrls: string[] = [], mode: "flat" | "graph" | "unified" = "graph"): void {
  const hub = new WikiHub(wikiDir, undefined, mode)
  const mesh = peerUrls.length > 0 ? new MeshWikiClient(peerUrls) : null

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`)
    const path = decodeURIComponent(url.pathname)

    let html: string | null = null
    let status = 200

    try {
      // Handle remote article fetch: /remote/:peerIdx/:agentId/article/:path
      if (path.startsWith("/remote/") && mesh) {
        const parts = path.slice("/remote/".length).split("/article/")
        if (parts.length === 2) {
          const [peerAgent, articlePath] = parts
          const slashIdx = peerAgent.indexOf("/")
          const peerUrl = decodeURIComponent(peerAgent.slice(0, slashIdx))
          const agentId = peerAgent.slice(slashIdx + 1)

          const article = await mesh.getRemoteArticle(peerUrl, agentId, articlePath)
          if (article) {
            const remoteAgents = await mesh.getRemoteAgents()
            const allAgents = [...hub.summary(), ...remoteAgents.map(r => ({ ...r, agentId: `${r.agentId} @${r.nodeId}` }))]

            let content = `<div class="breadcrumb"><a href="/">Hub</a> / <span class="tag">remote</span> ${escapeHtml(agentId)} @ ${escapeHtml(peerUrl)}</div>`
            content += `<h1>${escapeHtml(article.meta.title)}</h1>`
            content += '<dl class="meta">'
            content += `<dt>Tags</dt><dd>${(article.meta.tags||[]).map(t => `<span class="tag">${t}</span>`).join(" ")}</dd>`
            content += `<dt>Owner</dt><dd>${escapeHtml(article.meta.owner)}</dd>`
            content += `<dt>Source</dt><dd><span class="tag">remote</span> ${escapeHtml(peerUrl)}</dd>`
            content += `<dt>Updated</dt><dd>${article.meta.lastUpdated}</dd>`
            content += '</dl>'

            const titleToPath = new Map<string, string>()
            content += md(article.content, titleToPath)

            html = pageLayout(article.meta.title, hubSidebar(allAgents), content)
          }
        }
      }

      if (!html && agentFilter) {
        // Single agent mode
        const store = hub.getAgentWiki(agentFilter)

        if (path === "/" || path === "") {
          const index = store.rebuildIndex()
          const entries = hub.getAgentEntries(agentFilter)
          let content = `<h1>${escapeHtml(agentFilter)}</h1>`
          content += '<div class="stats">'
          content += `<div class="stat-card"><div class="number">${index.articles.length}</div><div class="label">Articles</div></div>`
          content += `<div class="stat-card"><div class="number">${entries.length}</div><div class="label">Entries</div></div>`
          content += '</div>'
          if (index.articles.length > 0) {
            content += '<h2>Articles</h2><table><tr><th>Title</th><th>Type</th><th>Updated</th></tr>'
            for (const a of index.articles) {
              content += `<tr><td><a href="/article/${encodeURIComponent(a.path)}">${escapeHtml(a.title)}</a></td><td><span class="tag">${(a.tags||[]).slice(0,3).join(", ")}</span></td><td>${a.lastUpdated || ""}</td></tr>`
            }
            content += '</table>'
          }
          html = pageLayout(agentFilter, agentSidebar(store, agentFilter), content)
        } else if (path.startsWith("/article/")) {
          const articlePath = path.slice("/article/".length)
          const article = store.readArticle(articlePath)
          if (article) {
            const index = store.rebuildIndex()
            const titleToPath = new Map<string, string>()
            for (const a of index.articles) titleToPath.set(a.title, a.path)
            let content = `<h1>${escapeHtml(article.meta.title)}</h1>`
            content += '<dl class="meta">'
            content += `<dt>Tags</dt><dd>${(article.meta.tags||[]).map(t => `<span class="tag">${t}</span>`).join(" ")}</dd>`
            content += `<dt>Updated</dt><dd>${article.meta.lastUpdated}</dd>`
            if (article.meta.sources?.length) content += `<dt>Sources</dt><dd>${article.meta.sources.length} entries</dd>`
            content += '</dl>'
            content += md(article.content, titleToPath)
            html = pageLayout(article.meta.title, agentSidebar(store, agentFilter, articlePath), content)
          }
        } else if (path === "/lint") {
          const issues = store.lint()
          let content = '<h1>Health Check</h1>'
          if (issues.length === 0) { content += '<p style="color:green;">No issues.</p>' }
          else {
            content += `<table><tr><th>Type</th><th>Article</th><th>Issue</th></tr>`
            for (const i of issues) content += `<tr><td><span class="tag">${i.type}</span></td><td>${escapeHtml(i.article)}</td><td>${escapeHtml(i.message)}</td></tr>`
            content += '</table>'
          }
          html = pageLayout("Health Check", agentSidebar(store, agentFilter), content)
        } else if (path === "/search") {
          const q = url.searchParams.get("q") || ""
          const results = store.findRelevant(q, undefined, 20)
          let content = `<h1>Search: "${escapeHtml(q)}"</h1>`
          for (const r of results) {
            content += `<div class="entry-card"><h3><a href="/article/${encodeURIComponent(r.path)}">${escapeHtml(r.meta.title)}</a></h3><p>${escapeHtml(r.content.slice(0, 200))}...</p></div>`
          }
          if (results.length === 0) content += '<p>No results.</p>'
          html = pageLayout(`Search: ${q}`, agentSidebar(store, agentFilter), content)
        } else if (path.startsWith("/tag/")) {
          const tag = decodeURIComponent(path.slice("/tag/".length))
          const matches = store.findByTags([tag], undefined, 100)
          let content = `<h1>Tag: <a class="tag" href="#">${escapeHtml(tag)}</a></h1>`
          content += `<p>${matches.length} article${matches.length === 1 ? "" : "s"} tagged <code>${escapeHtml(tag)}</code></p>`
          for (const a of matches) {
            content += `<div class="entry-card"><h3><a href="/article/${encodeURIComponent(a.path)}">${escapeHtml(a.meta.title)}</a></h3><div class="meta-line">${tagLinks((a.meta.tags || []).slice(0, 6))}</div></div>`
          }
          if (matches.length === 0) content += '<p>No articles with this tag.</p>'
          html = pageLayout(`Tag: ${tag}`, agentSidebar(store, agentFilter), content)
        }
      } else {
        // Hub mode — merge local + remote agents
        const remoteAgents = mesh ? await mesh.getRemoteAgents() : []
        const localAgents = hub.summary()
        // Merge: prefer whichever has more articles (local or remote)
        const localMap = new Map(localAgents.map(a => [a.agentId, a]))
        const allAgents: AgentWikiSummary[] = []
        const seen = new Set<string>()

        for (const local of localAgents) {
          const remote = remoteAgents.find(r => r.agentId === local.agentId)
          if (remote && remote.totalArticles > local.totalArticles) {
            // Remote has more articles — merge: keep remote articles, combine entry counts
            allAgents.push({
              ...remote,
              totalEntries: Math.max(local.totalEntries, remote.totalEntries),
              unabsorbed: Math.max(local.unabsorbed, remote.unabsorbed),
            })
          } else {
            allAgents.push(local)
          }
          seen.add(local.agentId)
        }
        // Add remote-only agents
        for (const remote of remoteAgents) {
          if (!seen.has(remote.agentId)) {
            allAgents.push(remote)
            seen.add(remote.agentId)
          }
        }

        if (path === "/" || path === "") {
          html = hubHome(hub, allAgents, remoteAgents)
        } else if (path === "/entries") {
          html = hubEntries(hub, allAgents)
        } else if (path === "/search") {
          html = hubSearch(hub, url.searchParams.get("q") || "", allAgents)
        } else if (path.startsWith("/tag/")) {
          html = hubTagPage(hub, decodeURIComponent(path.slice("/tag/".length)), allAgents)
        } else if (path.match(/^\/agent\/[^/]+\/tag\/.+/)) {
          const m = path.match(/^\/agent\/([^/]+)\/tag\/(.+)$/)!
          html = hubAgentTagPage(hub, decodeURIComponent(m[1]), decodeURIComponent(m[2]), allAgents)
        } else if (path.startsWith("/agent/")) {
          const rest = path.slice("/agent/".length)
          const slashIdx = rest.indexOf("/article/")
          if (slashIdx === -1) {
            // Agent overview
            html = hubAgentOverview(hub, rest, allAgents)
          } else {
            // Agent article
            const agentId = rest.slice(0, slashIdx)
            const articlePath = rest.slice(slashIdx + "/article/".length)
            html = hubArticlePage(hub, agentId, articlePath, allAgents)

            // If not found locally, try remote peers
            if (!html && mesh) {
              const remote = remoteAgents.find(r => r.agentId === agentId)
              if (remote) {
                const article = await mesh.getRemoteArticle(remote.peerUrl, agentId, articlePath)
                if (article) {
                  let content = `<div class="breadcrumb"><a href="/">Hub</a> / <span class="tag">remote @ ${escapeHtml(remote.nodeId)}</span> / ${escapeHtml(agentId)}</div>`
                  content += `<h1>${escapeHtml(article.meta.title)}</h1>`
                  content += '<dl class="meta">'
                  content += `<dt>Tags</dt><dd>${(article.meta.tags||[]).map(t => `<span class="tag">${t}</span>`).join(" ")}</dd>`
                  content += `<dt>Source</dt><dd><span class="tag">remote</span> ${escapeHtml(remote.nodeId)}</dd>`
                  content += `<dt>Updated</dt><dd>${article.meta.lastUpdated}</dd>`
                  content += '</dl>'
                  content += md(article.content, new Map())
                  html = pageLayout(article.meta.title, hubSidebar(allAgents), content)
                }
              }
            }
          }
        }
      }

      if (!html) {
        status = 404
        const sidebar = agentFilter
          ? agentSidebar(hub.getAgentWiki(agentFilter), agentFilter)
          : hubSidebar(hub.summary())
        html = pageLayout("Not Found", sidebar, "<h1>Page not found</h1>")
      }
    } catch (err: any) {
      status = 500
      html = pageLayout("Error", "", `<h1>Error</h1><pre>${escapeHtml(err.message)}</pre>`)
    }

    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
    res.end(html)
  })

  server.listen(port)
}
