// Pure checks behind the Hub name check (scripts/hub-name-check.mjs, #1485).
// The dashboard's home was called the Wall; it is the Hub now, and its name
// lives in one constant (src/daemon/ui/hub-name.ts). This finds the old name
// where a person reads it: text in the code (strings, page markup) and the
// docs. Comments, code blocks, identifiers such as renderWallPage, paths
// such as wall.ts and words such as "wall-clock" are allowed.
// Unit-tested in test/hub-name-check.test.ts.

/** Names the Hub had before. A future rename adds the current one here. */
export const OLD_NAMES = ["Wall"]

/** The old name as a word of its own, not a part of a longer word. */
const nameRe = (name) => new RegExp(`(?<![\\w-])${name}(?![\\w]|-clock| clock| time\\b)`, "g")

/**
 * Code with its comments blanked: line comments (`//` at the start or after
 * a space, so "https://" stays) and block comments (`/*` at the start or
 * after a space, so a glob like "/api/*" stays). Line breaks are kept, so
 * line numbers still match. Strings are not parsed: the page scripts are
 * strings themselves, and their comments are comments too.
 */
export function stripCodeComments(text) {
  let out = ""
  let block = false
  for (const line of text.split("\n")) {
    let kept = ""
    let i = 0
    while (i < line.length) {
      if (block) {
        const end = line.indexOf("*/", i)
        if (end < 0) { i = line.length; break }
        block = false
        i = end + 2
        continue
      }
      const rest = line.slice(i)
      const m = rest.match(/(^|\s)(\/\/|\/\*)/)
      if (!m) { kept += rest; break }
      const at = i + m.index + m[1].length
      kept += line.slice(i, at)
      if (m[2] === "//") break
      block = true
      i = at + 2
    }
    out += kept + "\n"
  }
  return out.slice(0, -1)
}

/** Markdown with its fenced code, inline code and HTML comments blanked. */
export function stripMarkdownCode(text) {
  const noComments = text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "))
  let fence = false
  return noComments.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return "" }
    if (fence) return ""
    return line.replace(/(`+)[^`]*?\1/g, "")
  }).join("\n")
}

/** Each line of `text` that shows an old name: { line, name, text }. */
export function findOldNames(text, kind) {
  const visible = kind === "markdown" ? stripMarkdownCode(text) : stripCodeComments(text)
  const lines = visible.split("\n")
  const original = text.split("\n")
  const hits = []
  lines.forEach((l, i) => {
    for (const name of OLD_NAMES) {
      if (nameRe(name).test(l)) hits.push({ line: i + 1, name, text: original[i].trim().slice(0, 160) })
    }
  })
  return hits
}

/** Which kind of file a path is for the check, or null to skip it. */
export function kindOf(path) {
  if (/(^|\/)(test|tests|__tests__)\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path)) return null
  if (path.endsWith(".md")) return "markdown"
  if (/\.([cm]?[jt]sx?|css|html|vue)$/.test(path)) return "code"
  return null
}
