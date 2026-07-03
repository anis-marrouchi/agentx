import { marked } from "marked"
import { markedTerminal } from "marked-terminal"
import chalk from "chalk"

// Render an agent's markdown reply to ANSI for the terminal — bold/italic,
// headings, lists, blockquotes, and syntax-highlighted fenced code blocks
// (marked-terminal delegates code highlighting to cli-highlight). Kept as a
// pure string→string function so it works in both the plain REPL and inside
// an Ink <Text>. Falls back to the raw markdown on any parser error so a
// malformed reply is never swallowed.

let configuredWidth = -1

/** (Re)configure the marked instance for a given wrap width. marked is a
 *  singleton, so we only re-apply the extension when the width changes. */
function ensureConfigured(width: number): void {
  if (width === configuredWidth) return
  configuredWidth = width
  marked.setOptions({ gfm: true, breaks: false })
  marked.use(
    markedTerminal({
      width,
      reflowText: true,
      // Don't prepend literal "## " to headings — render the text styled only.
      showSectionPrefix: false,
      // Shallower indent for lists/code so replies read as chat, not a man page.
      tab: 2,
      heading: chalk.bold.cyan,
      firstHeading: chalk.bold.cyan,
      code: chalk.gray,
      codespan: chalk.yellow,
      blockquote: chalk.gray.italic,
      link: chalk.blue.underline,
      href: chalk.blue.underline,
    }) as any,
  )
}

/** Render markdown → ANSI string, wrapped to `width` columns. */
export function renderMarkdown(md: string, width = 80): string {
  const w = Math.max(20, Math.min(width, 120))
  try {
    ensureConfigured(w)
    const out = marked.parse(md, { async: false }) as string
    return out.replace(/\n+$/, "")
  } catch {
    return md.trimEnd()
  }
}
