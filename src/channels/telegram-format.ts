// --- Convert standard Markdown (Claude output) to Telegram MarkdownV2 ---
//
// Telegram MarkdownV2 requires escaping 18 special chars outside entities:
//   _ * [ ] ( ) ~ ` > # + - = | { } . !
//
// Supported entities: *bold*, _italic_, __underline__, ~strikethrough~,
//   ||spoiler||, `code`, ```pre```, [link](url)

// Characters that must be escaped in normal text
const SPECIAL = /([_*\[\]()~`>#+=|{}.!\-\\])/g

/**
 * Escape special characters for MarkdownV2 plain text.
 */
function esc(text: string): string {
  return text.replace(SPECIAL, "\\$1")
}

/**
 * Escape only backtick and backslash inside code/pre blocks.
 */
function escCode(text: string): string {
  return text.replace(/([`\\])/g, "\\$1")
}

/**
 * Convert standard Markdown to Telegram MarkdownV2.
 *
 * Handles: headers, bold, italic, inline code, code blocks, links, lists, blockquotes.
 * Designed for Claude's output style.
 */
export function markdownToTelegramV2(md: string): string {
  const lines = md.split("\n")
  const result: string[] = []
  let inCodeBlock = false
  let codeBlockLang = ""
  let codeBlockLines: string[] = []

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
        // Close code block
        inCodeBlock = false
        const code = codeBlockLines.join("\n")
        if (codeBlockLang) {
          result.push("```" + escCode(codeBlockLang))
        } else {
          result.push("```")
        }
        result.push(escCode(code))
        result.push("```")
        continue
      }
    }

    if (inCodeBlock) {
      codeBlockLines.push(line)
      continue
    }

    // Headers → bold text
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headerMatch) {
      result.push("")
      result.push("*" + escInline(headerMatch[2]) + "*")
      continue
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      result.push("———")
      continue
    }

    // Blockquote
    if (line.trimStart().startsWith("> ")) {
      const content = line.replace(/^>\s*/, "")
      result.push(">" + convertInline(content))
      continue
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/)
    if (ulMatch) {
      const indent = ulMatch[1].length > 0 ? "  " : ""
      result.push(indent + "• " + convertInline(ulMatch[2]))
      continue
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+[.)]\s+(.+)$/)
    if (olMatch) {
      const indent = olMatch[1].length > 0 ? "  " : ""
      const num = line.match(/^(\s*)(\d+)/)?.[2] || "1"
      result.push(indent + esc(num) + "\\. " + convertInline(olMatch[2]))
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

  // Handle unclosed code block
  if (inCodeBlock) {
    result.push("```")
    result.push(escCode(codeBlockLines.join("\n")))
    result.push("```")
  }

  return result.join("\n").trim()
}

/**
 * Convert inline markdown elements: bold, italic, code, links.
 */
function convertInline(text: string): string {
  // First, extract and protect inline code spans
  const codeSpans: string[] = []
  let processed = text.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = codeSpans.length
    codeSpans.push("`" + escCode(code) + "`")
    return `\x00CODE${idx}\x00`
  })

  // Extract and protect @mentions (Telegram usernames contain letters, digits, underscores)
  const mentions: string[] = []
  processed = processed.replace(/@(\w{5,})/g, (_match, username) => {
    const idx = mentions.length
    mentions.push("@" + esc(username))
    return `\x00MENTION${idx}\x00`
  })

  // Extract and protect links
  const links: string[] = []
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    const idx = links.length
    links.push("[" + escInline(label) + "](" + url.replace(/([)\\])/g, "\\$1") + ")")
    return `\x00LINK${idx}\x00`
  })

  // Bold+italic: ***text*** or ___text___
  processed = processed.replace(/\*\*\*(.+?)\*\*\*/g, (_m, t) => "*_" + esc(t) + "_*")

  // Bold: **text** → *text*
  processed = processed.replace(/\*\*(.+?)\*\*/g, (_m, t) => "*" + esc(t) + "*")

  // Italic: *text* or _text_ → _text_
  // Be careful not to match already-converted bold markers
  processed = processed.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, (_m, t) => "_" + esc(t) + "_")
  processed = processed.replace(/(?<!_)_([^_]+?)_(?!_)/g, (_m, t) => "_" + esc(t) + "_")

  // Strikethrough: ~~text~~ → ~text~
  processed = processed.replace(/~~(.+?)~~/g, (_m, t) => "~" + esc(t) + "~")

  // Escape remaining plain text (but preserve our placeholders and already-formatted entities)
  processed = escPlainSegments(processed)

  // Restore protected tokens
  processed = processed.replace(/\x00CODE(\d+)\x00/g, (_m, idx) => codeSpans[parseInt(idx)])
  processed = processed.replace(/\x00MENTION(\d+)\x00/g, (_m, idx) => mentions[parseInt(idx)])
  processed = processed.replace(/\x00LINK(\d+)\x00/g, (_m, idx) => links[parseInt(idx)])

  return processed
}

/**
 * Escape text that appears inside a formatting entity (already wrapped in * or _).
 */
function escInline(text: string): string {
  return esc(text)
}

/**
 * Escape special chars in plain text segments only (not inside formatting markers).
 * This is a simplified approach: escape any special char that isn't part of a
 * formatting entity we already placed.
 */
function escPlainSegments(text: string): string {
  // Split on our formatting markers and placeholders (including MENTION)
  const parts = text.split(/(\*[^*]+\*|_[^_]+_|~[^~]+~|\x00\w+\d+\x00)/g)

  return parts
    .map((part) => {
      // Keep formatted entities and placeholders as-is
      if (
        /^\*[^*]+\*$/.test(part) ||
        /^_[^_]+_$/.test(part) ||
        /^~[^~]+~$/.test(part) ||
        /^\x00/.test(part)
      ) {
        return part
      }
      // Escape plain text
      return esc(part)
    })
    .join("")
}
