// --- Convert standard Markdown to Telegram HTML ---
//
// Uses parse_mode: "HTML" (not MarkdownV2) — much simpler and more reliable.
// Based on OpenClaw's approach: markdown → HTML tags.
//
// Supported Telegram HTML tags:
//   <b>bold</b>, <i>italic</i>, <s>strikethrough</s>,
//   <code>inline code</code>, <pre><code>code block</code></pre>,
//   <a href="url">link</a>, <blockquote>quote</blockquote>,
//   <tg-spoiler>spoiler</tg-spoiler>
//
// Tables are converted to bullet-point format (Telegram has no table support).
// File extensions that look like TLDs are wrapped in <code> to prevent
// Telegram generating spurious link previews.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/**
 * Convert standard Markdown (Claude output) to Telegram HTML.
 */
export function markdownToTelegramHtml(md: string): string {
  // Strip MarkdownV2 escape backslashes that Claude Code sometimes outputs
  // e.g., \_ → _, \# → #, \| → |, \. → ., \! → !, \- → -, \( → (, \) → )
  const cleaned = md.replace(/\\([_*\[\]()~`>#+=|{}.!\\-])/g, "$1")
  const lines = cleaned.split("\n")
  const result: string[] = []
  let inCodeBlock = false
  let codeBlockLang = ""
  let codeBlockLines: string[] = []
  let inBlockquote = false
  let tableHeaders: string[] = []
  let inTable = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Code block toggle
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeBlockLang = line.trimStart().slice(3).trim()
        codeBlockLines = []
        continue
      } else {
        inCodeBlock = false
        const code = escapeHtml(codeBlockLines.join("\n"))
        // Language hint as comment for context
        const langHint = codeBlockLang ? `// ${codeBlockLang}\n` : ""
        result.push(`<pre><code>${langHint}${code}</code></pre>`)
        codeBlockLang = ""
        continue
      }
    }

    if (inCodeBlock) {
      codeBlockLines.push(line)
      continue
    }

    // Close blockquote if we left it
    if (inBlockquote && !line.trimStart().startsWith(">")) {
      result.push("</blockquote>")
      inBlockquote = false
    }

    // Close table if we left it
    if (inTable && !line.trim().startsWith("|")) {
      inTable = false
      tableHeaders = []
    }

    // Blockquote
    if (line.trimStart().startsWith("> ")) {
      const content = line.replace(/^>\s*/, "")
      if (!inBlockquote) {
        result.push("<blockquote>")
        inBlockquote = true
      }
      result.push(convertInline(content))
      continue
    }

    // Headers → bold with blank line before
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headerMatch) {
      result.push("")
      result.push(`<b>${convertInline(headerMatch[2])}</b>`)
      continue
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      result.push("———")
      continue
    }

    // Table handling — convert to readable bullet format
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const cells = line.split("|").slice(1, -1).map(c => c.trim())

      // Skip separator rows (|---|---|)
      if (/^\|[\s\-:|]+\|$/.test(line.trim())) {
        inTable = true
        continue
      }

      if (!inTable) {
        // This is the header row
        tableHeaders = cells
        inTable = true
        continue
      }

      // Data row — render as bullet with header labels
      if (tableHeaders.length > 0 && cells.length > 0) {
        if (cells.length >= 2) {
          // First cell as bold label, rest as key: value pairs
          const parts: string[] = []
          for (let c = 0; c < cells.length; c++) {
            if (c === 0) {
              parts.push(`<b>${convertInline(cells[c])}</b>`)
            } else {
              const header = tableHeaders[c] ? `${convertInline(tableHeaders[c])}: ` : ""
              parts.push(`${header}${convertInline(cells[c])}`)
            }
          }
          result.push(`• ${parts.join(" — ")}`)
        } else {
          result.push(`• ${convertInline(cells[0])}`)
        }
      }
      continue
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/)
    if (ulMatch) {
      const indent = ulMatch[1].length > 0 ? "  " : ""
      result.push(`${indent}• ${convertInline(ulMatch[2])}`)
      continue
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+[.)]\s+(.+)$/)
    if (olMatch) {
      const indent = olMatch[1].length > 0 ? "  " : ""
      const num = line.match(/^(\s*)(\d+)/)?.[2] || "1"
      result.push(`${indent}${num}. ${convertInline(olMatch[2])}`)
      continue
    }

    // Empty line
    if (!line.trim()) {
      result.push("")
      continue
    }

    // Normal text
    result.push(convertInline(line))
  }

  // Close unclosed blocks
  if (inCodeBlock) {
    result.push(`<pre><code>${escapeHtml(codeBlockLines.join("\n"))}</code></pre>`)
  }
  if (inBlockquote) {
    result.push("</blockquote>")
  }

  let html = result.join("\n").trim()

  // Wrap file extensions that look like TLDs to prevent Telegram link previews
  // e.g., "config.ts" would get wrapped as "config<code>.ts</code>"
  html = wrapFileRefsInCode(html)

  return html
}

/**
 * Convert inline markdown to HTML tags.
 */
function convertInline(text: string): string {
  let result = escapeHtml(text)

  // Inline code (first, to protect content from further processing)
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>")

  // Links: [text](url) — must come before bold/italic to preserve URLs
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label, url) => `<a href="${escapeHtml(url)}">${label}</a>`,
  )

  // Bold+italic: ***text***
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>")

  // Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")

  // Italic: *text* or _text_ (not inside other tags)
  result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "<i>$1</i>")

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>")

  // Spoiler: ||text||
  result = result.replace(/\|\|(.+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>")

  return result
}

/**
 * Wrap file extensions that share TLDs in <code> to prevent Telegram
 * from generating spurious link previews (e.g., config.ts, main.py).
 * Skips content already inside <code>, <pre>, or <a> tags.
 */
const FILE_EXT_TLDS = /(?<=\w)\.(ts|js|py|rs|go|rb|cs|sh|md|yml|yaml|toml|json|env|css|html|xml|sql|tf|hcl)(?=[\s,;:)\]}<]|$)/gi

function wrapFileRefsInCode(html: string): string {
  // Split on existing tags to avoid modifying content inside them
  const parts = html.split(/(<\/?(?:code|pre|a)[^>]*>)/gi)
  let insideTag = false

  return parts.map((part) => {
    if (/<(?:code|pre|a)\b/i.test(part)) {
      insideTag = true
      return part
    }
    if (/<\/(?:code|pre|a)>/i.test(part)) {
      insideTag = false
      return part
    }
    if (insideTag) return part

    return part.replace(FILE_EXT_TLDS, "<code>.$1</code>")
  }).join("")
}
