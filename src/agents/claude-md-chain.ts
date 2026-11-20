// Instruction files a daemon-started Claude Code session reads (#2000).
//
// Claude Code loads CLAUDE.md files, their @imports, .claude/rules and the
// auto-memory MEMORY.md into the first user message, before its only
// message cache mark, which sits after our task text. That text changes on
// every start, so the ~45k characters of instructions are written to the
// cache on every start and never read back. A daemon start turns Claude
// Code's own loading off (CLAUDE_MDS_OFF_ENV) and gets the same files here:
// the stable ones in the cached system prompt, MEMORY.md (rewritten many
// times a day) in the task text. Interactive sessions are not affected.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, parse, resolve } from "node:path"

/** Claude Code 2.1.329: when set, no CLAUDE.md, rule, import or MEMORY.md
 *  is loaded. Setting sources (hooks, permissions) are untouched. */
export const CLAUDE_MDS_OFF_ENV = "CLAUDE_CODE_DISABLE_CLAUDE_MDS"

/** Turn Claude Code's own loading off for a process whose prompt already
 *  carries the files. Unset `own` leaves the env as it is. */
export function withOwnClaudeMd(env: NodeJS.ProcessEnv, own: boolean | undefined): NodeJS.ProcessEnv {
  if (own) env[CLAUDE_MDS_OFF_ENV] = "1"
  return env
}

export type SettingSource = "user" | "project" | "local"

const HEADER = "<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n"
const FOOTER = "\n</system-reminder>"
const INSTRUCTIONS = "project instructions, checked into the codebase"
const AUTO_MEMORY = "user's auto-memory, persists across conversations"
const MAX_IMPORT_DEPTH = 5

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return null
  }
}

/** `@path` imports written on a line of their own, relative to the file. */
function importsOf(content: string, fromDir: string, home: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const line of content.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence
    const m = !inFence && /^@(\S+)\s*$/.exec(line.trim())
    if (!m) continue
    const target = m[1].startsWith("~/") ? join(home, m[1].slice(2)) : resolve(fromDir, m[1])
    out.push(target)
  }
  return out
}

/** A rule with `paths:` front matter only applies when a matching file is
 *  read, so Claude Code does not load it at start. */
function isConditionalRule(content: string): boolean {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content)
  return Boolean(fm && /^paths\s*:/m.test(fm[1]))
}

function rulesIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => join(dir, f))
}

function addWithImports(path: string, home: string, seen: Set<string>, out: Array<[string, string]>, depth = 0): void {
  if (seen.has(path) || depth > MAX_IMPORT_DEPTH) return
  const content = readText(path)
  if (content === null) return
  seen.add(path)
  out.push([path, content])
  for (const target of importsOf(content, dirname(path), home)) addWithImports(target, home, seen, out, depth + 1)
}

/** The instruction files in the order Claude Code loads them for `cwd`:
 *  user CLAUDE.md, then for each directory from the root down to `cwd` its
 *  CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md, then the project's
 *  unconditional rules. Each file is followed by its imports. */
export function claudeMdFiles(cwd: string, sources: SettingSource[], home = homedir()): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const seen = new Set<string>()
  if (sources.includes("user")) addWithImports(join(home, ".claude", "CLAUDE.md"), home, seen, out)
  const dirs: string[] = []
  for (let d = resolve(cwd); ; d = dirname(d)) {
    dirs.unshift(d)
    if (d === parse(d).root) break
  }
  for (const d of dirs) {
    if (sources.includes("project")) {
      addWithImports(join(d, "CLAUDE.md"), home, seen, out)
      addWithImports(join(d, ".claude", "CLAUDE.md"), home, seen, out)
    }
    if (sources.includes("local")) addWithImports(join(d, "CLAUDE.local.md"), home, seen, out)
  }
  if (sources.includes("project")) {
    for (const rule of rulesIn(join(resolve(cwd), ".claude", "rules"))) {
      const content = readText(rule)
      if (content !== null && !isConditionalRule(content) && !seen.has(rule)) {
        seen.add(rule)
        out.push([rule, content])
      }
    }
  }
  return out
}

function section(path: string, label: string, content: string): string {
  return `\nContents of ${path} (${label}):\n\n${content}`
}

/** The instruction files as Claude Code renders them in message 1, for the
 *  cached system prompt. Empty when there are none. */
export function claudeMdBlock(cwd: string, sources: SettingSource[], home = homedir()): string {
  const files = claudeMdFiles(cwd, sources, home)
  if (files.length === 0) return ""
  return HEADER + files.map(([p, c]) => section(p, INSTRUCTIONS, c)).join("") + FOOTER
}

/** Claude Code's auto-memory directory for a working directory. */
export function autoMemoryPath(cwd: string, home = homedir()): string {
  return join(home, ".claude", "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"), "memory", "MEMORY.md")
}

/** MEMORY.md as Claude Code renders it, for the task text. Empty when the
 *  file does not exist. */
export function autoMemoryBlock(cwd: string, home = homedir()): string {
  const path = autoMemoryPath(cwd, home)
  const content = readText(path)
  if (content === null) return ""
  // Claude Code drops the file's final newline before closing the block.
  return `<system-reminder>${section(path, AUTO_MEMORY, content.trimEnd())}${FOOTER}`
}
