import { readFileSync, existsSync, unlinkSync } from "fs"
import { resolve } from "path"

// --- Bootstrap Identity Files ---
//
// Support for structured workspace identity files (inspired by OpenClaw).
// These files live in the agent's workspace and are auto-loaded into context.
//
// Supported files:
//   SOUL.md      — personality, tone, boundaries (persistent)
//   IDENTITY.md  — name, role, emoji, tagline (persistent)
//   USER.md      — user profile, preferences (persistent)
//   AGENTS.md    — operating rules, standing orders (persistent)
//   BOOTSTRAP.md — one-time first-run ritual (auto-deleted after first load)

export interface BootstrapFiles {
  soul?: string
  identity?: string
  user?: string
  agents?: string
  bootstrap?: string
}

const BOOTSTRAP_FILE_NAMES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "AGENTS.md",
  "BOOTSTRAP.md",
] as const

/**
 * Load bootstrap identity files from an agent's workspace.
 * Returns content keyed by file type. Missing files are omitted.
 */
export function loadBootstrapFiles(workspace: string): BootstrapFiles {
  const result: BootstrapFiles = {}

  const tryLoad = (filename: string): string | undefined => {
    const filePath = resolve(workspace, filename)
    if (!existsSync(filePath)) return undefined
    try {
      const content = readFileSync(filePath, "utf-8").trim()
      return content || undefined
    } catch {
      return undefined
    }
  }

  result.soul = tryLoad("SOUL.md")
  result.identity = tryLoad("IDENTITY.md")
  result.user = tryLoad("USER.md")
  result.agents = tryLoad("AGENTS.md")
  result.bootstrap = tryLoad("BOOTSTRAP.md")

  // BOOTSTRAP.md is one-time: delete after loading
  if (result.bootstrap) {
    try {
      unlinkSync(resolve(workspace, "BOOTSTRAP.md"))
    } catch {
      // Best-effort deletion
    }
  }

  return result
}

/**
 * Build context string from bootstrap files.
 * Returns empty string if no files found.
 */
export function buildBootstrapContext(files: BootstrapFiles): string {
  const sections: string[] = []

  if (files.identity) {
    sections.push(`[Identity]\n${files.identity}`)
  }

  if (files.soul) {
    sections.push(`[Personality & Boundaries]\n${files.soul}`)
  }

  if (files.agents) {
    sections.push(`[Operating Rules]\n${files.agents}`)
  }

  if (files.user) {
    sections.push(`[User Profile]\n${files.user}`)
  }

  if (files.bootstrap) {
    sections.push(`[First-Run Instructions — one time only]\n${files.bootstrap}`)
  }

  if (sections.length === 0) return ""

  return sections.join("\n\n")
}

/**
 * Check which bootstrap files exist in a workspace (for status/diagnostics).
 */
export function listBootstrapFiles(workspace: string): string[] {
  return BOOTSTRAP_FILE_NAMES.filter((name) =>
    existsSync(resolve(workspace, name))
  )
}
