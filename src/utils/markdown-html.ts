// --- Markdown to HTML, shared -------------------------------------------
//
// One renderer for the wiki, the dashboard's ask-an-agent drawer and the task
// conversation view. It escapes first and only then adds markup, because
// everything it renders — wiki articles, agent replies — is written by
// someone or something other than the person reading it.
//
// Deliberately small: headings, bold/italic, code, links, lists, tables,
// blockquotes and rules. Anything it does not know stays as text.

export interface MarkdownOptions {
  /** Resolve [[wikilinks]]. Omitted, they render as their display text. */
  wikilink?: (target: string, display: string) => string
}

export function markdownToHtml(text: string, opts: MarkdownOptions = {}): string {
  // Strip section-tag HTML comments before escaping so they don't render
  // as literal "<!-- tags: ... -->" in the output.
  // Inlined rather than a module-scope helper: this function is stringified
  // and shipped to the browser, where the minifier renames such a helper and
  // module scope does not travel with the source.
  let html = String(text ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")

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
  html = html.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const [rawTarget, rawDisplay] = inner.split("|", 2)
    const target = rawTarget.trim().replace(/^\//, "")
    const display = (rawDisplay || rawTarget).trim()
    // Without a resolver a wikilink is just words — better than a dead link.
    return opts.wikilink ? opts.wikilink(target, display) : display
  })

  // External links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

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
