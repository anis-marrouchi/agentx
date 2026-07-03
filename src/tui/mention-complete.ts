import { readdirSync } from "fs"
import { resolve, dirname, basename, join } from "path"

// `@`-mention autocomplete for the chat composer: `@agent` completes to a
// registered agent id, `@path/frag` completes to files/dirs under cwd. The
// parse + agent match are pure (unit-tested); file match touches the fs.

export interface Mention {
  /** The text after `@` being typed (may be empty). */
  token: string
  /** Index of the `@` in the input buffer. */
  start: number
}

/** The trailing `@mention` being typed at the end of the buffer, or null.
 *  Only fires at a word boundary so mid-word emails/handles don't trigger. */
export function parseMention(input: string): Mention | null {
  const m = /(^|\s)@([\w./@-]*)$/.exec(input)
  if (!m) return null
  return { token: m[2], start: m.index + m[1].length }
}

/** Agent ids containing `token`, as `@id`. */
export function matchAgents(token: string, agentIds: string[]): string[] {
  const t = token.toLowerCase()
  return agentIds.filter((id) => id.toLowerCase().includes(t)).map((id) => `@${id}`)
}

/** Files/dirs under cwd whose name starts with the token's basename.
 *  Directories get a trailing slash so completion can continue into them. */
export function matchFiles(token: string, cwd: string): string[] {
  try {
    const dir = token.includes("/") ? dirname(token) : "."
    const base = token.includes("/") ? basename(token) : token
    const abs = resolve(cwd, dir)
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && e.name.toLowerCase().startsWith(base.toLowerCase()))
      .map((e) => {
        const rel = dir === "." ? e.name : join(dir, e.name)
        return e.isDirectory() ? `${rel}/` : rel
      })
  } catch {
    return []
  }
}

export interface MentionSuggestions {
  mention: Mention
  items: string[]
}

/** Combined agent + file suggestions for the trailing mention, capped. */
export function mentionSuggestions(input: string, agentIds: string[], cwd: string, limit = 6): MentionSuggestions | null {
  const mention = parseMention(input)
  if (!mention) return null
  const items = [...matchAgents(mention.token, agentIds), ...matchFiles(mention.token, cwd)].slice(0, limit)
  return items.length ? { mention, items } : null
}

/** Replace the mention token with a completion. Agents and files get a
 *  trailing space; a directory (ends with `/`) stays open to keep typing. */
export function applyMention(input: string, mention: Mention, item: string): string {
  const head = input.slice(0, mention.start)
  const trailing = item.endsWith("/") ? "" : " "
  return head + item + trailing
}
