import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from "fs"
import { resolve, relative, dirname, join, extname, basename } from "path"

// --- Scoped file operations for the admin panel ---
//
// Lets the dashboard read/write identity files (CLAUDE.md / SOUL.md /
// IDENTITY.md) and skill files (.claude/skills/<slug>/SKILL.md) WITHIN an
// agent's workspace without ever touching the rest of the filesystem.
// Every public function resolves the requested path against the agent's
// workspace and refuses anything that would escape via .. symlinks, etc.

const MAX_FILE_BYTES = 200 * 1024      // 200 KB — plenty for CLAUDE.md / skills.
const ALLOWED_EXTENSIONS = new Set([".md", ".markdown", ".txt"])
const IDENTITY_FILENAMES = new Set([
  "CLAUDE.md", "SOUL.md", "IDENTITY.md", "PERSONA.md", "AGENT.md", "BOOTSTRAP.md",
])

export interface FileOverview {
  identity: Array<{
    path: string            // relative to workspace, e.g. "CLAUDE.md"
    title: string
    size: number
    exists: boolean         // canonical files can be listed as templates even if missing
  }>
  skills: Array<{
    slug: string            // dir name under .claude/skills/
    title: string           // first # heading in SKILL.md or fallback to slug
    size: number
    path: string            // relative to workspace, e.g. ".claude/skills/foo/SKILL.md"
  }>
  workspace: string         // absolute, for display only
}

/**
 * Resolve a user-supplied path to an absolute path strictly within `workspace`.
 * Throws if the result would escape. Returns the normalised absolute path.
 */
function resolveInWorkspace(workspace: string, relPath: string): string {
  if (!workspace) throw new Error("Agent workspace is not configured.")
  const wsAbs = resolve(workspace)
  if (!existsSync(wsAbs)) {
    // Create the workspace lazily — a fresh agent scaffolded via the wizard
    // may have an empty directory created but not yet with file structure.
    mkdirSync(wsAbs, { recursive: true })
  }
  // Reject absolute-path attempts outright.
  if (!relPath || relPath.startsWith("/") || relPath.match(/^[a-zA-Z]:/)) {
    throw new Error(`Path must be relative to the workspace: ${relPath}`)
  }
  const target = resolve(wsAbs, relPath)
  const rel = relative(wsAbs, target)
  // rel === "" means target IS the workspace dir — fine for list ops.
  // rel starts with ".." iff target is outside the workspace.
  if (rel.startsWith("..")) {
    throw new Error(`Path escapes the workspace: ${relPath}`)
  }
  return target
}

function assertEditable(absPath: string): void {
  const ext = extname(absPath).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Only text files (.md, .markdown, .txt) can be edited from the admin panel (got ${ext}).`)
  }
}

function extractTitle(markdown: string, fallback: string): string {
  const line = markdown.split(/\r?\n/).find((l) => l.trim().startsWith("#"))
  if (!line) return fallback
  return line.replace(/^#+\s*/, "").trim().slice(0, 120) || fallback
}

/**
 * List the identity files + skills for an agent. Identity "canonical" names
 * that don't exist are still reported (exists: false) so the UI can offer to
 * create them with a sensible default.
 */
export function listAgentFiles(workspace: string): FileOverview {
  const wsAbs = resolveInWorkspace(workspace, ".")
  const identity: FileOverview["identity"] = []
  const seen = new Set<string>()

  // Every .md in the workspace root is identity material; canonical names
  // sort first.
  let rootEntries: string[] = []
  try { rootEntries = readdirSync(wsAbs) } catch { /* empty */ }
  for (const name of IDENTITY_FILENAMES) {
    const abs = join(wsAbs, name)
    if (existsSync(abs) && statSync(abs).isFile()) {
      const size = statSync(abs).size
      const content = size > 0 && size < MAX_FILE_BYTES ? safeRead(abs) : ""
      identity.push({ path: name, title: extractTitle(content, name), size, exists: true })
      seen.add(name)
    } else {
      identity.push({ path: name, title: name, size: 0, exists: false })
      seen.add(name)
    }
  }
  for (const name of rootEntries) {
    if (seen.has(name)) continue
    const abs = join(wsAbs, name)
    try {
      const st = statSync(abs)
      if (!st.isFile()) continue
      if (!ALLOWED_EXTENSIONS.has(extname(name).toLowerCase())) continue
      const content = st.size > 0 && st.size < MAX_FILE_BYTES ? safeRead(abs) : ""
      identity.push({ path: name, title: extractTitle(content, name), size: st.size, exists: true })
    } catch { /* skip unreadable */ }
  }

  // Skills live under .claude/skills/<slug>/SKILL.md
  const skills: FileOverview["skills"] = []
  const skillsRoot = join(wsAbs, ".claude", "skills")
  if (existsSync(skillsRoot)) {
    try {
      for (const slug of readdirSync(skillsRoot)) {
        const dir = join(skillsRoot, slug)
        let st
        try { st = statSync(dir) } catch { continue }
        if (!st.isDirectory()) continue
        const file = join(dir, "SKILL.md")
        if (!existsSync(file)) continue
        const stf = statSync(file)
        const content = stf.size < MAX_FILE_BYTES ? safeRead(file) : ""
        skills.push({
          slug,
          title: extractTitle(content, slug),
          size: stf.size,
          path: `.claude/skills/${slug}/SKILL.md`,
        })
      }
    } catch { /* */ }
  }
  skills.sort((a, b) => a.slug.localeCompare(b.slug))

  return { identity, skills, workspace: wsAbs }
}

function safeRead(abs: string): string {
  try { return readFileSync(abs, "utf-8") } catch { return "" }
}

/**
 * Read a single file within the workspace. Throws if the path is outside the
 * workspace, has a disallowed extension, or doesn't exist.
 */
export function readAgentFile(workspace: string, relPath: string): { path: string; content: string } {
  const abs = resolveInWorkspace(workspace, relPath)
  assertEditable(abs)
  if (!existsSync(abs)) return { path: relPath, content: "" }
  if (statSync(abs).size > MAX_FILE_BYTES) {
    throw new Error(`File is too large to edit in the admin panel (> ${MAX_FILE_BYTES / 1024} KB).`)
  }
  return { path: relPath, content: readFileSync(abs, "utf-8") }
}

/**
 * Write a file. Creates parent dirs as needed. Rejects extensions / size
 * outside the allow-list the same way readAgentFile does.
 */
export function writeAgentFile(workspace: string, relPath: string, content: string): { path: string; bytes: number } {
  const abs = resolveInWorkspace(workspace, relPath)
  assertEditable(abs)
  const buf = Buffer.from(content, "utf-8")
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`File too large (${buf.length} > ${MAX_FILE_BYTES} bytes).`)
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, buf)
  return { path: relPath, bytes: buf.length }
}

/**
 * Create a new skill scaffold at .claude/skills/<slug>/SKILL.md.
 */
export function createAgentSkill(
  workspace: string,
  slug: string,
  opts: { title?: string; content?: string } = {},
): { slug: string; path: string } {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw new Error("Skill slug must be lowercase (letters, digits, -, _) and start with a letter or digit.")
  }
  const relPath = `.claude/skills/${slug}/SKILL.md`
  const abs = resolveInWorkspace(workspace, relPath)
  if (existsSync(abs)) throw new Error(`Skill "${slug}" already exists.`)
  mkdirSync(dirname(abs), { recursive: true })
  const body = opts.content?.trim()
    ? opts.content
    : defaultSkillTemplate(slug, opts.title)
  writeFileSync(abs, body)
  return { slug, path: relPath }
}

/**
 * Remove a skill directory (.claude/skills/<slug>). Scoped to the workspace
 * so we can never touch anything else.
 */
export function deleteAgentSkill(workspace: string, slug: string): { slug: string } {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error(`Invalid skill slug: ${slug}`)
  const abs = resolveInWorkspace(workspace, `.claude/skills/${slug}`)
  if (!existsSync(abs)) throw new Error(`Skill "${slug}" not found.`)
  const st = statSync(abs)
  if (!st.isDirectory()) throw new Error(`Skill path is not a directory: ${slug}`)
  rmSync(abs, { recursive: true, force: true })
  return { slug }
}

function defaultSkillTemplate(slug: string, title?: string): string {
  const displayTitle = title?.trim() || slug
  return `# ${displayTitle}

Describe what this skill does and when the agent should use it. Keep it under ~5 lines — the agent reads this to decide whether to invoke the skill.

## When to use
- Trigger condition 1
- Trigger condition 2

## How to use
Document the arguments, commands, or files the skill expects. Example:

\`\`\`bash
# Example invocation
claude-code ${basename(slug)} --arg value
\`\`\`
`
}
