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

/**
 * Resolve the body of a `[[...]]` wikilink to a relative article path.
 *
 * Authors write wikilinks three ways: by title, by path (without `.md`), or
 * by full path (with `.md`). wikiArticles is a title→path map, so we build
 * a path-set on first call and try several normalisations:
 *
 *   1. Exact title lookup                      (handles [[My Article]])
 *   2. Exact path lookup                       (handles [[people/anis.md]])
 *   3. Path + ".md" suffix                     (handles [[people/anis]])
 *   4. Case-insensitive title scan             (forgives minor casing drift)
 *
 * Return the path if any matches, else undefined so the caller can render
 * a broken-link marker.
 */
function resolveWikilink(target: string, wikiArticles: Map<string, string>): string | undefined {
  if (!target) return undefined
  // (1) exact title
  const byTitle = wikiArticles.get(target)
  if (byTitle) return byTitle

  // (2) + (3) path lookups
  const pathSet = new Set(wikiArticles.values())
  if (pathSet.has(target)) return target
  const withExt = target.endsWith('.md') ? target : `${target}.md`
  if (pathSet.has(withExt)) return withExt

  // (4) case-insensitive title fallback — common when the user writes
  // "Anis Marrouchi" but the canonical title is "anis marrouchi".
  const targetLower = target.toLowerCase()
  for (const [title, path] of wikiArticles) {
    if (title.toLowerCase() === targetLower) return path
  }
  return undefined
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

  // Wikilinks — support three forms for the [[...]] body:
  //   [[Title]]                        exact article title
  //   [[path/to/article]]              path without .md (e.g. "people/anis")
  //   [[path/to/article.md]]           full relative path
  //   [[Title|custom display text]]    optional display override (Obsidian-style)
  html = html.replace(/\[\[([^\]]+)\]\]/g, (_m, body: string) => {
    const [rawTarget, rawDisplay] = body.split("|", 2)
    const target = rawTarget.trim().replace(/^\//, "")
    const display = (rawDisplay || rawTarget).trim()
    const path = resolveWikilink(target, wikiArticles)
    if (path) {
      return `<a href="${agentPrefix}/article/${encodeURIComponent(path)}" class="wikilink">${display}</a>`
    }
    return `<a href="${agentPrefix}/search?q=${encodeURIComponent(target)}" class="wikilink broken" title="Not found — click to search">${display}</a>`
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

  // Wrap consecutive ordered <li>s into <ol>. Keep the data-ordered marker
  // on each <li> inside the <ol> so the subsequent <ul> regex below can
  // correctly skip them via negative lookahead. Marker is stripped once all
  // list-wrapping is done.
  html = html.replace(/(<li data-ordered="1">.*?<\/li>(?:\n?<li data-ordered="1">.*?<\/li>)*)/g, '<ol>$1</ol>')

  // Wrap consecutive unordered <li>s — the negative lookahead `(?! data-ordered)`
  // ensures ordered <li>s inside the <ol> above are NOT re-wrapped in <ul>.
  html = html.replace(/((?:<li(?! data-ordered)[^>]*>.*?<\/li>\n?)+)/g, '<ul>$1</ul>')

  // Clean up the ordered marker now that wrapping is settled.
  html = html.replace(/ data-ordered="1"/g, "")

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

const HEAD_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300..600;1,6..72,300..600&family=Inter+Tight:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`

// Paper/ink editorial palette — warm neutrals, Newsreader display font,
// Inter Tight for UI, JetBrains Mono for code/meta. Ported from the
// /Users/macbookpro/Downloads/wiki mockup.
const CSS = `
:root {
  --bg: #FAF8F3;
  --bg-raised: #FFFFFF;
  --bg-sunk: #F2EFE7;
  --bg-hover: #EFEBE0;
  --ink: #1A1915;
  --ink-2: #3D3A32;
  --muted: #6B6860;
  --muted-2: #96918A;
  --line: #E4DED0;
  --line-2: #D1CAB8;
  --accent: oklch(55% 0.14 45);
  --accent-soft: oklch(55% 0.14 45 / 0.10);
  --accent-hover: oklch(48% 0.14 45);
  --cool: oklch(55% 0.08 230);
  --cool-soft: oklch(55% 0.08 230 / 0.10);
  --ok: oklch(55% 0.10 145);
  --warn: oklch(60% 0.14 75);
  --err: oklch(55% 0.16 20);
  --font-display: 'Newsreader', Georgia, serif;
  --font-ui: 'Inter Tight', -apple-system, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  --sidebar-w: 260px;
  --topbar-h: 52px;
  --radius: 6px;
  --radius-sm: 4px;
  --radius-lg: 10px;
  --shadow-sm: 0 1px 2px rgba(26,25,21,0.04), 0 1px 1px rgba(26,25,21,0.03);
  --shadow-md: 0 4px 12px rgba(26,25,21,0.06), 0 2px 4px rgba(26,25,21,0.04);
  --shadow-lg: 0 12px 40px rgba(26,25,21,0.12), 0 4px 12px rgba(26,25,21,0.06);
}
[data-theme="dark"] {
  --bg: #0F0E0C;
  --bg-raised: #1A1815;
  --bg-sunk: #07060A;
  --bg-hover: #22201C;
  --ink: #EBE7DD;
  --ink-2: #C9C4B7;
  --muted: #8B867B;
  --muted-2: #5E5A52;
  --line: #2A2822;
  --line-2: #3A3830;
  --accent: oklch(70% 0.16 45);
  --accent-soft: oklch(70% 0.16 45 / 0.14);
  --accent-hover: oklch(78% 0.16 45);
  --cool: oklch(70% 0.10 230);
  --cool-soft: oklch(70% 0.10 230 / 0.14);
  --ok: oklch(70% 0.14 145);
  --warn: oklch(75% 0.16 75);
  --err: oklch(68% 0.18 20);
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.5);
  --shadow-lg: 0 12px 40px rgba(0,0,0,0.7);
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  background: var(--bg); color: var(--ink);
  font-family: var(--font-ui); font-size: 14px; line-height: 1.55;
  font-feature-settings: 'ss01','cv11';
  -webkit-font-smoothing: antialiased; min-height: 100vh;
}
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); }
button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
input, textarea, select { font: inherit; color: inherit; }
code, pre, .mono { font-family: var(--font-mono); font-size: 0.92em; }
.display { font-family: var(--font-display); font-weight: 400; letter-spacing: -0.01em; }

/* ——— App shell ——— */
.app {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  grid-template-rows: var(--topbar-h) 1fr;
  min-height: 100vh;
}
.topbar {
  grid-column: 1 / -1;
  display: flex; align-items: center; gap: 16px; padding: 0 20px;
  background: var(--bg); border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: 20; backdrop-filter: blur(8px);
}
.topbar-logo {
  display: flex; align-items: center; gap: 10px;
  font-family: var(--font-display); font-size: 18px; color: var(--ink);
  width: calc(var(--sidebar-w) - 20px); padding-right: 12px;
  border-right: 1px solid var(--line); height: 100%;
  text-decoration: none;
}
.topbar-logo .mark {
  width: 22px; height: 22px; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--accent); color: var(--bg-raised);
  border-radius: 5px; font-family: var(--font-mono);
  font-size: 11px; font-weight: 700;
}
.topbar-search {
  flex: 1; max-width: 520px;
  display: flex; align-items: center; gap: 8px; padding: 6px 12px;
  background: var(--bg-raised); border: 1px solid var(--line);
  border-radius: var(--radius); color: var(--muted);
  transition: border-color 0.15s, background 0.15s;
}
.topbar-search:focus-within { border-color: var(--line-2); background: var(--bg-hover); }
.topbar-search input {
  flex: 1; border: 0; outline: 0; background: transparent;
  color: var(--ink); font: inherit;
}
.topbar-search input::placeholder { color: var(--muted); }
.topbar-search kbd {
  font-family: var(--font-mono); font-size: 11px;
  padding: 2px 6px; border: 1px solid var(--line); border-radius: 3px;
  background: var(--bg); color: var(--muted);
}
.topbar-tools { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.icon-btn {
  width: 32px; height: 32px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--radius-sm); color: var(--muted);
  transition: background 0.15s, color 0.15s;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--ink); }
.icon-btn.active { color: var(--accent); background: var(--accent-soft); }
.icon-btn svg { width: 16px; height: 16px; }

/* ——— Sidebar ——— */
.sidebar {
  grid-column: 1; grid-row: 2;
  background: var(--bg); border-right: 1px solid var(--line);
  padding: 16px 12px 40px; overflow-y: auto;
  position: sticky; top: var(--topbar-h);
  height: calc(100vh - var(--topbar-h));
}
.nav-section { margin-bottom: 20px; }
.nav-section-title {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 10px; font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--muted); margin-bottom: 2px;
}
.nav-item {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 10px; color: var(--ink-2);
  font-size: 13px; border-radius: var(--radius-sm);
  line-height: 1.35; cursor: pointer;
  transition: background 0.1s;
  text-decoration: none;
}
.nav-item:hover { background: var(--bg-hover); color: var(--ink); }
.nav-item.active {
  background: var(--accent-soft); color: var(--accent); font-weight: 500;
}
.nav-item .count {
  margin-left: auto; font-family: var(--font-mono);
  font-size: 11px; color: var(--muted);
}
.nav-item.active .count { color: var(--accent); }
.nav-agent-header {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; font-size: 13px; color: var(--ink);
  cursor: pointer; border-radius: var(--radius-sm);
  text-decoration: none;
}
.nav-agent-header:hover { color: var(--accent); background: var(--bg-hover); }
.nav-agent-header .name { font-weight: 500; }
.nav-agent-header .badge {
  margin-left: auto; font-family: var(--font-mono);
  font-size: 10.5px; color: var(--muted);
}
.nav-agent-type-label {
  padding: 6px 8px 2px; font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted-2); font-weight: 600;
}
.nav-agent-children {
  padding-left: 14px; display: flex; flex-direction: column; gap: 1px;
  margin-top: 2px; border-left: 1px dashed var(--line); margin-left: 10px;
}

/* ——— Main ——— */
.main {
  grid-column: 2; grid-row: 2;
  padding: 32px 48px 80px;
  max-width: 1180px; width: 100%;
}
.main.article { max-width: 1100px; }

/* ——— Breadcrumb ——— */
.breadcrumb {
  display: flex; align-items: center; gap: 6px;
  font-size: 12.5px; color: var(--muted);
  margin-bottom: 14px; font-family: var(--font-ui);
}
.breadcrumb a { color: var(--muted); }
.breadcrumb a:hover { color: var(--accent); }
.breadcrumb .sep { color: var(--muted-2); }
.breadcrumb .current { color: var(--ink-2); }

/* ——— Display heading ——— */
.page-head {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: 24px; padding-bottom: 16px;
  border-bottom: 1px solid var(--line); margin-bottom: 28px;
}
.page-head h1 {
  font-family: var(--font-display); font-size: 38px;
  font-weight: 400; letter-spacing: -0.015em; line-height: 1.1;
}
.page-head .page-sub {
  font-size: 13.5px; color: var(--muted);
  margin-top: 6px; max-width: 60ch; line-height: 1.5;
}
.page-head .page-actions { display: flex; gap: 8px; flex: 0 0 auto; }

/* ——— Buttons ——— */
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; font-size: 13px;
  color: var(--ink-2); background: var(--bg-raised);
  border: 1px solid var(--line); border-radius: var(--radius-sm);
  transition: all 0.1s; text-decoration: none;
}
.btn:hover { background: var(--bg-hover); border-color: var(--line-2); color: var(--ink); }
.btn.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.btn.primary:hover { background: var(--ink-2); color: var(--bg); }
.btn.ghost { background: transparent; border-color: transparent; }
.btn.ghost:hover { background: var(--bg-hover); }
.btn svg { width: 14px; height: 14px; }

/* ——— Stat strip ——— */
.stats, .stat-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0;
  background: var(--bg-raised); border: 1px solid var(--line);
  border-radius: var(--radius); overflow: hidden;
  margin-bottom: 28px;
}
.stat-card, .stat-cell {
  padding: 16px 20px;
  border-right: 1px solid var(--line);
  display: flex; flex-direction: column; gap: 4px;
  background: transparent; text-align: left;
}
.stat-card:last-child, .stat-cell:last-child { border-right: none; }
.stat-card .label, .stat-cell .label {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted); font-weight: 600;
}
.stat-card .number, .stat-cell .number {
  font-family: var(--font-display); font-size: 32px; font-weight: 400;
  line-height: 1; color: var(--ink);
}

/* ——— Section heading ——— */
.section-head, h2.section {
  display: flex; align-items: baseline; justify-content: space-between;
  margin: 40px 0 14px;
}
.section-head h2 {
  font-family: var(--font-display); font-size: 22px;
  font-weight: 400; letter-spacing: -0.01em; color: var(--ink);
  border: none; padding: 0;
}

/* ——— Agent grid (hub home) ——— */
.agent-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}
.agent-card {
  background: var(--bg-raised); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 18px 20px;
  display: flex; flex-direction: column; gap: 12px;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.agent-card:hover {
  border-color: var(--line-2); box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
.agent-card h3 {
  font-family: var(--font-display); font-size: 20px; font-weight: 400;
  color: var(--ink); margin: 0;
}
.agent-card h3 a { color: inherit; text-decoration: none; }
.agent-card h3 a:hover { color: var(--accent); }
.agent-card .agent-stats {
  display: flex; gap: 20px; font-size: 13px; color: var(--muted);
}
.agent-card .agent-stats strong {
  color: var(--ink); font-weight: 600; font-family: var(--font-mono);
}
.agent-card .article-list {
  display: flex; flex-direction: column; gap: 4px; margin-top: 4px; font-size: 13px;
}
.agent-card .article-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
  padding: 2px 0;
}
.agent-card .article-row .article-title {
  color: var(--ink-2); text-decoration: none; margin-left: 4px; flex: 1;
}
.agent-card .article-row .article-title:hover { color: var(--accent); }

/* ——— Tags ——— */
.tag {
  display: inline-flex; align-items: center;
  font-family: var(--font-mono); font-size: 11.5px;
  padding: 1px 7px 2px; background: var(--bg-sunk);
  color: var(--ink-2); border-radius: 3px;
  line-height: 1.4; cursor: pointer;
  transition: background 0.1s, color 0.1s;
  text-decoration: none;
}
.tag:hover { background: var(--accent-soft); color: var(--accent); }
.tag.lg { font-size: 12.5px; padding: 3px 10px; }

/* ——— Article meta — inline dl below h1 ——— */
.meta {
  background: var(--bg-raised); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 14px 18px;
  margin-bottom: 24px; font-size: 13px;
  display: grid; grid-template-columns: auto 1fr;
  gap: 6px 18px;
}
.meta dt {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted); font-weight: 600;
  align-self: center;
}
.meta dd { color: var(--ink-2); font-family: var(--font-mono); font-size: 12.5px; }

/* ——— Prose body ——— */
.prose {
  font-size: 15.5px; line-height: 1.65; color: var(--ink-2);
  max-width: 68ch;
}
.main h1, .prose h1 {
  font-family: var(--font-display); font-size: 40px;
  font-weight: 400; letter-spacing: -0.015em; line-height: 1.1;
  color: var(--ink); margin-bottom: 16px;
  border: none; padding: 0;
}
.main h2, .prose h2 {
  font-family: var(--font-display); font-size: 26px;
  font-weight: 400; letter-spacing: -0.01em;
  margin: 36px 0 12px; color: var(--ink);
  padding-bottom: 4px; border-bottom: 1px solid var(--line);
}
.main h3, .prose h3 {
  font-family: var(--font-display); font-size: 20px; font-weight: 500;
  margin: 28px 0 8px; color: var(--ink);
}
.main h4, .prose h4 {
  font-size: 15px; font-weight: 600; margin: 20px 0 6px; color: var(--ink);
}
.main p, .prose p { margin: 10px 0; }
.main ul, .prose ul, .main ol, .prose ol { margin: 10px 0 10px 22px; }
.main li, .prose li { margin: 4px 0; }
.main code, .prose code {
  background: var(--bg-sunk); padding: 1px 5px; border-radius: 3px;
  font-family: var(--font-mono);
}
.main pre, .prose pre {
  background: var(--bg-sunk); border: 1px solid var(--line);
  border-radius: var(--radius-sm); padding: 14px 16px;
  overflow-x: auto; margin: 14px 0; font-size: 13px;
}
.main pre code, .prose pre code { background: none; padding: 0; }
.main blockquote, .prose blockquote {
  border-left: 3px solid var(--accent);
  padding: 4px 0 4px 14px; color: var(--muted);
  font-style: italic; margin: 14px 0;
}

/* Wikilinks in prose */
.prose a.wikilink, .main a.wikilink {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-color: var(--accent-soft);
  text-underline-offset: 3px;
  text-decoration-thickness: 1.5px;
}
.prose a.wikilink:hover, .main a.wikilink:hover { text-decoration-color: var(--accent); }
.prose a.wikilink.broken, .main a.wikilink.broken {
  color: var(--err); text-decoration-color: var(--err);
  text-decoration-style: dashed;
}

/* ——— Tables ——— */
table {
  width: 100%; border-collapse: collapse;
  margin: 14px 0; font-size: 14px;
}
th, td {
  border-bottom: 1px solid var(--line);
  padding: 8px 12px; text-align: left;
}
th {
  background: var(--bg-sunk); font-weight: 600;
  color: var(--ink); font-size: 12.5px;
  text-transform: uppercase; letter-spacing: 0.04em;
}
tr:hover td { background: var(--bg-hover); }

/* ——— Entry cards ——— */
.entry-card {
  background: var(--bg-raised); border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px 18px; margin: 10px 0;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.entry-card:hover { border-color: var(--line-2); box-shadow: var(--shadow-sm); }
.entry-card .meta-line {
  font-size: 11.5px; color: var(--muted);
  margin-bottom: 6px; font-family: var(--font-mono);
}
.entry-card h3 {
  font-family: var(--font-display); font-size: 19px; font-weight: 400;
  color: var(--ink); margin: 4px 0 6px;
  border: none; padding: 0;
}
.entry-card h3 a { color: inherit; }
.entry-card h3 a:hover { color: var(--accent); }
.entry-card p {
  color: var(--ink-2); font-size: 13.5px;
  line-height: 1.55; margin: 4px 0;
}

/* ——— Backlinks ——— */
.backlinks {
  margin-top: 40px; padding: 16px 18px;
  background: var(--bg-raised); border: 1px solid var(--line);
  border-radius: var(--radius);
}
.backlinks h4 {
  font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--muted);
  font-weight: 600; margin-bottom: 8px;
}
.backlinks ul { list-style: none; padding: 0; margin: 0; }
.backlinks li { padding: 4px 0; font-size: 13.5px; }

/* ——— Health issues list ——— */
.health-list { display: flex; flex-direction: column; gap: 6px; }
.health-row {
  display: grid; grid-template-columns: 96px 1fr 2fr;
  gap: 14px; align-items: center;
  padding: 10px 14px; background: var(--bg-raised);
  border: 1px solid var(--line); border-radius: var(--radius-sm);
  font-size: 13px;
}
.health-row .kind {
  font-family: var(--font-mono); font-size: 10.5px;
  text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--muted);
}
.health-row .article { color: var(--ink); font-weight: 500; }
.health-row .msg { color: var(--ink-2); }

@media (max-width: 900px) {
  .app { grid-template-columns: 1fr; }
  .topbar-logo { width: auto; border-right: none; }
  .sidebar { display: none; }
  .main { padding: 20px; grid-column: 1; }
}
`

// --- HTML Templates ---

function pageLayout(title: string, sidebar: string, content: string, searchQuery: string = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — AgentX Wiki</title>
  ${HEAD_FONTS}
  <style>${CSS}</style>
  <script>(function(){try{var t=localStorage.getItem('wiki-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}})();</script>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <a href="/" class="topbar-logo">
        <span class="mark">W</span>
        <span class="display">AgentX Wiki</span>
      </a>
      <form class="topbar-search" action="/search" method="get">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="search" name="q" placeholder="Search every wiki…" value="${escapeHtml(searchQuery)}" autocomplete="off" />
        <kbd>⌘K</kbd>
      </form>
      <div class="topbar-tools">
        <button class="icon-btn" id="wiki-theme-toggle" title="Toggle theme" aria-label="Toggle theme">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
      </div>
    </header>
    <nav class="sidebar">${sidebar}</nav>
    <main class="main">${content}</main>
  </div>
  <script>
    (function(){
      var btn = document.getElementById('wiki-theme-toggle');
      if (!btn) return;
      btn.addEventListener('click', function(){
        var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? '' : 'dark';
        if (cur) document.documentElement.setAttribute('data-theme', 'dark');
        else document.documentElement.removeAttribute('data-theme');
        try { localStorage.setItem('wiki-theme', cur); } catch(e){}
      });
      // Cmd/Ctrl-K focuses search
      document.addEventListener('keydown', function(e){
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          var inp = document.querySelector('.topbar-search input');
          if (inp) inp.focus();
        }
      });
    })();
  </script>
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
  let html = '<div class="nav-section">'
  html += `<a class="nav-item${!activePath ? ' active' : ''}" href="/">Home</a>`
  html += `<a class="nav-item" href="/entries">All entries</a>`
  html += '</div>'

  for (const agent of agents) {
    const agentPrefix = `/agent/${encodeURIComponent(agent.agentId)}`
    html += '<div class="nav-section">'
    html += `<a class="nav-agent-header" href="${agentPrefix}">`
    html += `<span class="name">${escapeHtml(agent.agentId)}</span>`
    html += `<span class="badge">${agent.totalArticles}</span>`
    html += `</a>`
    html += '<div class="nav-agent-children">'

    const byType = groupByDir(agent.articles)
    for (const [type, articles] of byType) {
      html += `<div class="nav-agent-type-label">${dirLabel(type)}</div>`
      for (const a of articles) {
        const fullPath = `${agent.agentId}/${a.path}`
        const isActive = fullPath === activePath
        html += `<a class="nav-item${isActive ? ' active' : ''}" href="${agentPrefix}/article/${encodeURIComponent(a.path)}">${escapeHtml(a.title)}</a>`
      }
    }
    html += '</div>'
    html += '</div>'
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

  let content = `<div class="page-head">
    <div>
      <h1>AgentX Wiki</h1>
      <p class="page-sub">Agent-owned institutional knowledge, typed and cross-referenced. Everything here compiles from raw conversation entries through the nightly absorb pass.</p>
    </div>
  </div>`

  // Stat strip
  content += '<div class="stat-strip">'
  content += `<div class="stat-cell"><div class="label">Agents</div><div class="number">${agents.length}</div></div>`
  content += `<div class="stat-cell"><div class="label">Articles</div><div class="number">${totalArticles}</div></div>`
  content += `<div class="stat-cell"><div class="label">Raw entries</div><div class="number">${totalEntries}</div></div>`
  if (totalUnabsorbed > 0) {
    content += `<div class="stat-cell"><div class="label">Unabsorbed</div><div class="number">${totalUnabsorbed}</div></div>`
  }
  if (remoteAgents && remoteAgents.length > 0) {
    const nodes = new Set(remoteAgents.map(r => r.nodeId))
    content += `<div class="stat-cell"><div class="label">Mesh nodes</div><div class="number">${nodes.size}</div></div>`
  }
  content += '</div>'

  // Agent cards grid
  content += '<div class="section-head"><h2>Agent wikis</h2></div>'
  content += '<div class="agent-grid">'
  for (const agent of agents) {
    const statusChip = agent.unabsorbed > 0
      ? `<span class="tag" style="color:var(--warn);background:color-mix(in oklch, var(--warn) 12%, transparent)">${agent.unabsorbed} unabsorbed</span>`
      : `<span class="tag" style="color:var(--ok);background:color-mix(in oklch, var(--ok) 12%, transparent)">up to date</span>`

    const isRemote = remoteIds.has(agent.agentId) && !hub.listAgents().includes(agent.agentId)
    const remoteBadge = isRemote
      ? ` <span class="tag" style="color:var(--cool);background:var(--cool-soft)">remote</span>`
      : ''

    content += `<div class="agent-card">`
    content += `<h3><a href="/agent/${encodeURIComponent(agent.agentId)}">${escapeHtml(agent.agentId)}</a>${remoteBadge}</h3>`
    content += `<div class="agent-stats">
      <span><strong>${agent.totalArticles}</strong> articles</span>
      <span><strong>${agent.totalEntries}</strong> entries</span>
      ${statusChip}
    </div>`

    if (agent.articles.length > 0) {
      content += '<div class="article-list">'
      for (const a of agent.articles.slice(0, 6)) {
        const tagPart = tagLinks((a.tags || []).slice(0, 2), agent.agentId)
        content += `<div class="article-row">${tagPart} <a class="article-title" href="/agent/${encodeURIComponent(agent.agentId)}/article/${encodeURIComponent(a.path)}">${escapeHtml(a.title)}</a></div>`
      }
      if (agent.articles.length > 6) {
        content += `<div class="article-row"><a class="article-title" style="color:var(--muted)" href="/agent/${encodeURIComponent(agent.agentId)}">+ ${agent.articles.length - 6} more →</a></div>`
      }
      content += '</div>'
    }
    content += '</div>'
  }
  content += '</div>'

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

  let content = `<nav class="breadcrumb"><a href="/">Hub</a> <span class="sep">/</span> <span class="current">${escapeHtml(agentId)}</span></nav>`
  content += `<div class="page-head"><div><h1>${escapeHtml(agentId)}</h1>`
  if (isRemote) {
    content += `<p class="page-sub"><span class="tag" style="color:var(--cool);background:var(--cool-soft)">remote @ ${escapeHtml((agentSummary as any).nodeId)}</span></p>`
  }
  content += `</div></div>`

  // Stats
  content += '<div class="stat-strip">'
  content += `<div class="stat-cell"><div class="label">Articles</div><div class="number">${agentSummary.totalArticles}</div></div>`
  content += `<div class="stat-cell"><div class="label">Entries</div><div class="number">${agentSummary.totalEntries}</div></div>`
  content += `<div class="stat-cell"><div class="label">Unabsorbed</div><div class="number">${agentSummary.unabsorbed}</div></div>`
  content += '</div>'

  // Articles grouped by type
  if (articles.length > 0) {
    content += '<div class="section-head"><h2>Articles</h2><span class="mono" style="font-size:12px;color:var(--muted)">' + articles.length + ' total</span></div>'
    const byType = groupByDir(articles as Array<{ title: string; path: string; tags?: string[] }>)
    for (const [type, list] of byType) {
      content += `<h3 class="display" style="font-size:17px;color:var(--muted);font-weight:500;margin:20px 0 8px">${dirLabel(type)}</h3>`
      content += '<div class="agent-card" style="padding:4px 14px"><div class="article-list">'
      for (const a of list) {
        content += `<div class="article-row">${tagLinks(((a.tags || []) as string[]).slice(0, 3), agentId)} <a class="article-title" href="/agent/${encodeURIComponent(agentId)}/article/${encodeURIComponent(a.path)}">${escapeHtml(a.title)}</a></div>`
      }
      content += '</div></div>'
    }
  }

  // Recent entries
  const recent = entries.slice(-5).reverse()
  if (recent.length > 0) {
    content += '<div class="section-head"><h2>Recent entries</h2><a class="btn ghost" href="/entries">See all →</a></div>'
    for (const e of recent) {
      content += `<div class="entry-card">
        <div class="meta-line">${e.date} · via ${escapeHtml(e.source)} · <code>${escapeHtml(e.id)}</code></div>
        <p>${escapeHtml(e.content.slice(0, 300))}${e.content.length > 300 ? "…" : ""}</p>
      </div>`
    }
  }

  // Lint
  const agentStore = hub.getAgentWiki(agentId)
  const issues = agentStore.lint()
  if (issues.length > 0) {
    content += `<div class="section-head"><h2>Health issues</h2><span class="mono" style="font-size:12px;color:var(--warn)">${issues.length}</span></div>`
    content += '<div class="health-list">'
    for (const issue of issues) {
      content += `<div class="health-row">
        <span class="kind">${escapeHtml(issue.type)}</span>
        <span class="article">${escapeHtml(issue.article)}</span>
        <span class="msg">${escapeHtml(issue.message)}</span>
      </div>`
    }
    content += '</div>'
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

  let content = `<nav class="breadcrumb"><a href="/">Hub</a> <span class="sep">/</span> <a href="${prefix}">${escapeHtml(agentId)}</a> <span class="sep">/</span> <span class="current">${escapeHtml(article.meta.title)}</span></nav>`
  content += `<article class="prose"><h1>${escapeHtml(article.meta.title)}</h1>`

  // Meta box
  content += '<dl class="meta">'
  if (article.meta.type) {
    content += `<dt>Type</dt><dd>${tagLink(article.meta.type, agentId)}</dd>`
  }
  if (article.meta.tags?.length) {
    content += `<dt>Tags</dt><dd>${tagLinks(article.meta.tags, agentId)}</dd>`
  }
  if (article.meta.owner) content += `<dt>Owner</dt><dd>${escapeHtml(article.meta.owner)}</dd>`
  content += `<dt>Created</dt><dd>${escapeHtml(article.meta.created || '—')}</dd>`
  content += `<dt>Updated</dt><dd>${escapeHtml(article.meta.lastUpdated || '—')}</dd>`
  if (article.meta.sources?.length) {
    content += `<dt>Sources</dt><dd>${article.meta.sources.length} entries</dd>`
  }
  content += '</dl>'

  content += md(article.content, titleToPath, prefix)

  if (inbound.length > 0) {
    content += '<div class="backlinks"><h4>Pages that link here</h4><ul>'
    for (const link of inbound) {
      const linked = store.readArticle(link)
      content += `<li><a href="${prefix}/article/${encodeURIComponent(link)}">${escapeHtml(linked?.meta.title || link)}</a></li>`
    }
    content += '</ul></div>'
  }
  content += `</article>`

  return pageLayout(article.meta.title, hubSidebar(agents, `${agentId}/${articlePath}`), content)
}

function hubEntries(hub: WikiHub, allAgents?: AgentWikiSummary[]): string {
  const agents = allAgents || hub.summary()
  const shared = hub.getSharedStore()
  const entries = shared.listEntries()

  let content = '<nav class="breadcrumb"><a href="/">Hub</a> <span class="sep">/</span> <span class="current">Entries</span></nav>'
  content += `<div class="page-head"><div><h1>All raw entries</h1><p class="page-sub">Every conversation line that the ingest pipeline captured. Absorb compiles these into typed articles nightly.</p></div></div>`

  const byDate = new Map<string, typeof entries>()
  for (const e of entries) {
    const list = byDate.get(e.date) || []
    list.push(e)
    byDate.set(e.date, list)
  }

  for (const [date, dateEntries] of [...byDate].reverse()) {
    content += `<div class="section-head"><h2>${date}</h2><span class="mono" style="font-size:12px;color:var(--muted)">${dateEntries.length} entries</span></div>`
    for (const e of dateEntries) {
      content += `<div class="entry-card">
        <div class="meta-line">
          <a href="/agent/${encodeURIComponent(e.agentId)}">${escapeHtml(e.agentId)}</a>
          · via ${escapeHtml(e.source)} · <code>${escapeHtml(e.id)}</code>
        </div>
        <p>${escapeHtml(e.content.slice(0, 400))}${e.content.length > 400 ? "…" : ""}</p>
      </div>`
    }
  }

  return pageLayout("All Entries", hubSidebar(agents), content)
}

function hubSearch(hub: WikiHub, query: string, allAgents?: AgentWikiSummary[]): string {
  const agents = allAgents || hub.summary()
  let content = `<nav class="breadcrumb"><a href="/">Hub</a> <span class="sep">/</span> <span class="current">Search</span></nav>`
  content += `<div class="page-head"><div><h1>“${escapeHtml(query)}”</h1><p class="page-sub">Full-text search across every agent's wiki.</p></div></div>`

  let totalResults = 0
  const blocks: string[] = []

  for (const agentSummary of agents) {
    const store = hub.getAgentWiki(agentSummary.agentId)
    const results = store.findRelevant(query, undefined, 10)

    if (results.length > 0) {
      blocks.push(`<div class="section-head"><h2>${escapeHtml(agentSummary.agentId)}</h2><span class="mono" style="font-size:12px;color:var(--muted)">${results.length} match${results.length === 1 ? '' : 'es'}</span></div>`)
      for (const r of results) {
        const prefix = `/agent/${encodeURIComponent(agentSummary.agentId)}`
        blocks.push(`<div class="entry-card">
          <div class="meta-line">${tagLinks((r.meta.tags || []).slice(0, 3), agentSummary.agentId)}</div>
          <h3><a href="${prefix}/article/${encodeURIComponent(r.path)}">${escapeHtml(r.meta.title)}</a></h3>
          <p>${escapeHtml(r.content.slice(0, 240))}…</p>
        </div>`)
      }
      totalResults += results.length
    }
  }
  content += blocks.join('')

  if (totalResults === 0) content += '<p style="color:var(--muted);margin-top:24px">No matching articles found.</p>'

  return pageLayout(`Search: ${query}`, hubSidebar(agents), content, query)
}

/**
 * Hub-wide tag filter. Shows every article tagged with `tag` across all
 * local agents, grouped by agent. Exact-tag match (not BM25).
 */
function hubTagPage(hub: WikiHub, tag: string, allAgents?: AgentWikiSummary[]): string {
  const agents = allAgents || hub.summary()
  let content = `<nav class="breadcrumb"><a href="/">Hub</a> <span class="sep">/</span> <span class="current">Tag</span></nav>`
  content += `<div class="page-head"><div><h1>${escapeHtml(tag)}</h1><p class="page-sub">All articles tagged <span class="tag">${escapeHtml(tag)}</span>, across every agent.</p></div></div>`
  let total = 0
  for (const agentSummary of agents) {
    let store
    try { store = hub.getAgentWiki(agentSummary.agentId) } catch { continue }
    const matches = store.findByTags([tag], undefined, 100)
    if (matches.length === 0) continue
    content += `<div class="section-head"><h2>${escapeHtml(agentSummary.agentId)}</h2><span class="mono" style="font-size:12px;color:var(--muted)">${matches.length}</span></div>`
    for (const a of matches) {
      const prefix = `/agent/${encodeURIComponent(agentSummary.agentId)}`
      content += `<div class="entry-card">
        <div class="meta-line">${tagLinks((a.meta.tags || []).slice(0, 6), agentSummary.agentId)}</div>
        <h3><a href="${prefix}/article/${encodeURIComponent(a.path)}">${escapeHtml(a.meta.title)}</a></h3>
      </div>`
    }
    total += matches.length
  }
  if (total === 0) content += `<p style="color:var(--muted);margin-top:24px">No articles tagged <code>${escapeHtml(tag)}</code>.</p>`
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
  let content = `<nav class="breadcrumb"><a href="/">Hub</a> <span class="sep">/</span> <a href="${prefix}">${escapeHtml(agentId)}</a> <span class="sep">/</span> <span class="current">${escapeHtml(tag)}</span></nav>`
  content += `<div class="page-head"><div><h1>${escapeHtml(tag)}</h1><p class="page-sub">${matches.length} article${matches.length === 1 ? "" : "s"} tagged <code>${escapeHtml(tag)}</code> in <b>${escapeHtml(agentId)}</b>.</p></div></div>`
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

  let html = '<div class="nav-section">'
  html += `<div class="nav-section-title">${escapeHtml(agentId)}</div>`
  html += `<a class="nav-item${!activePath ? ' active' : ''}" href="/">Home</a>`
  html += `<a class="nav-item" href="/lint">Health check</a>`
  html += '</div>'

  for (const [type, articles] of byType) {
    html += '<div class="nav-section">'
    html += `<div class="nav-section-title">${dirLabel(type)}</div>`
    for (const a of articles) {
      const isActive = a.path === activePath
      html += `<a class="nav-item${isActive ? ' active' : ''}" href="/article/${encodeURIComponent(a.path)}">${escapeHtml(a.title)}</a>`
    }
    html += '</div>'
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
