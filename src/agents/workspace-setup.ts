import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { resolve } from "path"
import { createHash } from "crypto"
import type { AgentDef } from "@/daemon/config"
import { generateAgentsMd } from "./bootstrap"

// Marker stamped into auto-generated CLAUDE.md so we can tell agentx-managed
// files apart from user-edited ones. On daemon start, files with the marker
// are silently regenerated when the systemPrompt hash changes; files without
// the marker are treated as user-owned and never touched.
const MANAGED_MARKER_PREFIX = "<!-- agentx-managed: hash="
const MANAGED_MARKER_SUFFIX = " -->"

function systemPromptHash(systemPrompt: string | undefined): string {
  return createHash("sha256")
    .update(systemPrompt ?? "")
    .digest("hex")
    .slice(0, 16)
}

function buildManagedMarker(systemPrompt: string | undefined): string {
  return `${MANAGED_MARKER_PREFIX}${systemPromptHash(systemPrompt)}${MANAGED_MARKER_SUFFIX}`
}

/**
 * Read the managed marker from an existing file's first line, if present.
 * Returns the hash (truncated sha256 hex) when found, null otherwise.
 * Files without the marker are user-managed and untouchable.
 */
export function readManagedHash(content: string): string | null {
  const firstLine = content.split("\n", 1)[0] ?? ""
  if (!firstLine.startsWith(MANAGED_MARKER_PREFIX)) return null
  if (!firstLine.endsWith(MANAGED_MARKER_SUFFIX)) return null
  return firstLine.slice(MANAGED_MARKER_PREFIX.length, firstLine.length - MANAGED_MARKER_SUFFIX.length)
}

// --- Workspace Setup: align agent workspaces with Claude Code best practices ---
//
// Generates on daemon start (if missing):
//   CLAUDE.md          — project conventions, under 200 lines, @AGENTS.md import
//   AGENTS.md          — agents.md spec for cross-tool compatibility
//   .claude/settings.json — hooks, permissions, auto memory
//   .claude/rules/     — path-specific rules based on agent role

/** Detect agent role from systemPrompt or agent ID */
function detectRole(agentId: string, def: AgentDef): "coding" | "pm" | "devops" | "qa" | "general" {
  const text = `${agentId} ${def.systemPrompt || ""} ${def.name}`.toLowerCase()
  if (/cod(e|ing|er)|develop|engineer|program/.test(text)) return "coding"
  if (/pm|project.?manag|product|scrum/.test(text)) return "pm"
  if (/devops|deploy|infra|ops|sre|ci.?cd/.test(text)) return "devops"
  if (/qa|test|quality|forensic/.test(text)) return "qa"
  return "general"
}

/** Generate CLAUDE.md for an agent workspace */
export function generateClaudeMd(agentId: string, def: AgentDef, daemonPort: string): string {
  const role = detectRole(agentId, def)
  const lines: string[] = []

  // Managed-marker on line 1 — used by setupWorkspace to detect stale
  // auto-generated files and regenerate them when systemPrompt changes.
  // User-edited files (no marker) are left alone forever.
  lines.push(buildManagedMarker(def.systemPrompt))
  lines.push(`# ${def.name}`)
  lines.push("")
  lines.push("@AGENTS.md")
  lines.push("")

  // Agent identity from systemPrompt — emitted verbatim. Truncating here would
  // silently drop instructions (e.g. multi-paragraph protocols), so we trade
  // a few extra tokens in CLAUDE.md for fidelity. The runtime path already
  // forwards the full systemPrompt via --append-system-prompt; this section
  // mirrors it for tools that read CLAUDE.md as workspace context.
  if (def.systemPrompt && def.systemPrompt.trim().length > 0) {
    lines.push("## Role")
    lines.push("")
    lines.push(def.systemPrompt.trimEnd())
    lines.push("")
  }

  // Build/test commands
  lines.push("## Commands")
  lines.push("")
  if (existsSync(resolve(def.workspace, "package.json"))) {
    lines.push("```bash")
    lines.push("npm install    # install dependencies")
    lines.push("npm test       # run tests")
    lines.push("npm run build  # build project")
    lines.push("```")
  } else if (existsSync(resolve(def.workspace, "requirements.txt"))) {
    lines.push("```bash")
    lines.push("pip install -r requirements.txt")
    lines.push("pytest")
    lines.push("```")
  }
  lines.push("")

  // Role-specific conventions
  lines.push("## Conventions")
  lines.push("")
  switch (role) {
    case "coding":
      lines.push("- Write tests for new code before committing")
      lines.push("- Keep functions small and focused")
      lines.push("- Follow existing patterns in the codebase")
      lines.push("- Run tests before pushing")
      break
    case "pm":
      lines.push("- Keep responses concise (3-5 lines main message)")
      lines.push("- Reference issues with #IID and MRs with !IID")
      lines.push("- Update issue labels and milestones when relevant")
      lines.push("- Summarize decisions, don't narrate process")
      break
    case "devops":
      lines.push("- Always check service status before making changes")
      lines.push("- Never run destructive commands without confirmation")
      lines.push("- Log all deployment actions")
      lines.push("- Verify changes in staging before production")
      break
    case "qa":
      lines.push("- Document reproduction steps for every bug")
      lines.push("- Include expected vs actual behavior")
      lines.push("- Check both happy path and edge cases")
      lines.push("- Attach screenshots when reporting UI issues")
      break
    default:
      lines.push("- Be concise — lead with the answer, skip preamble")
      lines.push("- Follow existing patterns in the codebase")
  }
  lines.push("")

  // Cross-channel messaging capability
  lines.push("## Cross-Channel Messaging")
  lines.push("")
  lines.push("You can send messages to any channel proactively:")
  lines.push("```bash")
  lines.push(`curl -X POST http://localhost:${daemonPort}/send \\`)
  lines.push(`  -H "Content-Type: application/json" \\`)
  lines.push(`  -d '{"channel":"telegram","chatId":"<id>","text":"<message>","agentId":"${agentId}"}'`)
  lines.push("```")
  lines.push('Channels: telegram, whatsapp, gitlab, discord')
  lines.push("")

  return lines.join("\n")
}

/** Generate .claude/settings.json with hooks and permissions */
function generateSettings(agentId: string, def: AgentDef): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    autoMemoryEnabled: true,
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    },
  }

  // Permission mode
  if (def.permissionMode === "bypassPermissions") {
    // No deny rules — full access
  } else if (def.permissionMode === "plan") {
    settings["permissions"] = {
      deny: ["Bash(rm -rf *)", "Bash(drop *)", "Bash(DELETE *)"],
    }
  } else {
    // Default: deny destructive operations
    settings["permissions"] = {
      deny: [
        "Bash(rm -rf /)",
        "Bash(> /dev/sda*)",
        "Bash(mkfs*)",
      ],
    }
  }

  // Hooks
  const hooks: Record<string, unknown[]> = {}

  // Notification hook — log when agent needs input
  hooks["Notification"] = [{
    matcher: "",
    hooks: [{
      type: "command",
      command: `echo "[${agentId}] notification: $(jq -r '.type // \"unknown\"')" >> /tmp/agentx-${agentId}.log`,
    }],
  }]

  // PostToolUse — log tool activity
  hooks["PostToolUse"] = [{
    matcher: "Bash",
    hooks: [{
      type: "command",
      command: `jq -r '.tool_input.command // empty' >> /tmp/agentx-${agentId}-commands.log`,
    }],
  }]

  // SessionStart after compaction — re-inject key context
  hooks["SessionStart"] = [{
    matcher: "compact",
    hooks: [{
      type: "command",
      command: `echo "Reminder: You are ${def.name} (${agentId}). Follow the conventions in CLAUDE.md."`,
    }],
  }]

  settings["hooks"] = hooks
  return settings
}

/** Generate .claude/rules/ files based on agent role */
function generateRules(agentId: string, def: AgentDef): Array<{ name: string; content: string }> {
  const role = detectRole(agentId, def)
  const rules: Array<{ name: string; content: string }> = []

  switch (role) {
    case "coding":
      rules.push({
        name: "testing.md",
        content: `---
paths:
  - "**/*.test.{ts,tsx,js,jsx}"
  - "**/*.spec.{ts,tsx,js,jsx}"
  - "test/**/*"
---

# Testing Rules

- Every new function should have a corresponding test
- Test both happy path and error cases
- Use descriptive test names that explain what's being tested
- Mock external dependencies, not internal modules
`,
      })
      rules.push({
        name: "code-quality.md",
        content: `# Code Quality

- No console.log in production code (use a logger)
- Handle errors explicitly — no empty catch blocks
- Keep files under 300 lines
- Extract repeated logic into shared utilities
`,
      })
      break

    case "devops":
      rules.push({
        name: "deployment-safety.md",
        content: `# Deployment Safety

- Always verify staging before production
- Check disk space and memory before deploying
- Never expose secrets in logs or commits
- Use rollback-safe deployment strategies
`,
      })
      break

    case "pm":
      rules.push({
        name: "communication.md",
        content: `# Communication Rules

- Keep GitLab comments under 5 lines for the main message
- Use <details> for verbose output (logs, commands, steps)
- Reference issues with #IID, merge requests with !IID
- Never mention Telegram handles on GitLab
`,
      })
      break

    case "qa":
      rules.push({
        name: "bug-reports.md",
        content: `# Bug Report Format

Always include:
1. Steps to reproduce
2. Expected behavior
3. Actual behavior
4. Environment (browser, OS, version)
5. Screenshots if applicable
`,
      })
      break
  }

  return rules
}

/**
 * Set up an agent workspace with CLI-agent best practices.
 * Only creates files that don't already exist (non-destructive).
 */
export function setupWorkspace(
  agentId: string,
  def: AgentDef,
  daemonPort: string = "19900",
  log: (...args: unknown[]) => void = console.error,
): { created: string[]; skipped: string[] } {
  const created: string[] = []
  const skipped: string[] = []
  const workspace = def.workspace

  if (!existsSync(workspace)) {
    log(`Workspace not found: ${workspace}`)
    return { created, skipped }
  }

  // Only set up CLI-backed tier agents.
  if (def.tier !== "claude-code" && def.tier !== "codex-cli") {
    return { created, skipped }
  }

  const writeIfMissing = (path: string, content: string) => {
    if (existsSync(path)) {
      skipped.push(path)
    } else {
      mkdirSync(resolve(path, ".."), { recursive: true })
      writeFileSync(path, content)
      created.push(path)
    }
  }

  /**
   * Write a managed file with the agentx-managed marker. If the file already
   * exists and starts with our marker, regenerate when the embedded hash
   * doesn't match the current expected hash. Files without the marker are
   * treated as user-owned and left alone.
   */
  const writeManaged = (path: string, content: string, expectedHash: string) => {
    if (!existsSync(path)) {
      mkdirSync(resolve(path, ".."), { recursive: true })
      writeFileSync(path, content)
      created.push(path)
      return
    }
    let existing: string
    try {
      existing = readFileSync(path, "utf8")
    } catch {
      skipped.push(path)
      return
    }
    const existingHash = readManagedHash(existing)
    if (existingHash === null) {
      // User-edited (no marker) — never overwrite.
      skipped.push(path)
      return
    }
    if (existingHash === expectedHash) {
      skipped.push(path)
      return
    }
    writeFileSync(path, content)
    created.push(`${path} (refreshed)`)
  }

  // AGENTS.md (agents.md spec) — first-line of systemPrompt only, currently
  // not managed-marker'd. Left as writeIfMissing for now.
  writeIfMissing(
    resolve(workspace, "AGENTS.md"),
    generateAgentsMd({ name: def.name, id: agentId, role: def.systemPrompt?.split("\n")[0], workspace, tier: def.tier }),
  )

  if (def.tier === "codex-cli") {
    if (created.length > 0) {
      log(`[${agentId}] workspace setup: created ${created.length} file(s)`)
    }
    return { created, skipped }
  }

  // CLAUDE.md — managed: silently refreshed when systemPrompt changes.
  writeManaged(
    resolve(workspace, "CLAUDE.md"),
    generateClaudeMd(agentId, def, daemonPort),
    systemPromptHash(def.systemPrompt),
  )

  // .claude/settings.json
  const settingsPath = resolve(workspace, ".claude/settings.json")
  writeIfMissing(settingsPath, JSON.stringify(generateSettings(agentId, def), null, 2))

  // .claude/rules/
  const rules = generateRules(agentId, def)
  for (const rule of rules) {
    writeIfMissing(resolve(workspace, ".claude/rules", rule.name), rule.content)
  }

  if (created.length > 0) {
    log(`[${agentId}] workspace setup: created ${created.length} file(s)`)
  }

  return { created, skipped }
}

/**
 * Patch existing .claude/settings.json to add missing keys (non-destructive).
 * Used to enable new features (like agent teams) on workspaces that already have settings.
 */
function patchSettings(workspace: string, patches: Record<string, unknown>): boolean {
  const settingsPath = resolve(workspace, ".claude/settings.json")
  if (!existsSync(settingsPath)) return false

  try {
    const existing = JSON.parse(readFileSync(settingsPath, "utf-8"))
    let changed = false

    for (const [key, value] of Object.entries(patches)) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        // Merge objects (e.g. env: { KEY: "value" })
        if (!existing[key]) existing[key] = {}
        for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
          if (existing[key][subKey] === undefined) {
            existing[key][subKey] = subValue
            changed = true
          }
        }
      } else if (existing[key] === undefined) {
        existing[key] = value
        changed = true
      }
    }

    if (changed) {
      writeFileSync(settingsPath, JSON.stringify(existing, null, 2))
    }
    return changed
  } catch {
    return false
  }
}

/**
 * Set up all agent workspaces on daemon start.
 */
export function setupAllWorkspaces(
  agents: Record<string, AgentDef>,
  daemonPort: string = "19900",
  log: (...args: unknown[]) => void = console.error,
): void {
  let totalCreated = 0
  let totalPatched = 0
  for (const [id, def] of Object.entries(agents)) {
    if (def.tier !== "claude-code" && def.tier !== "codex-cli") continue
    const result = setupWorkspace(id, def, daemonPort, log)
    totalCreated += result.created.length

    // Patch existing settings with new features (agent teams, etc.)
    if (def.tier === "claude-code" && patchSettings(def.workspace, {
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" },
    })) {
      totalPatched++
    }
  }
  if (totalCreated > 0) {
    log(`Workspace setup: ${totalCreated} file(s) created across agent workspaces`)
  }
  if (totalPatched > 0) {
    log(`Workspace patch: ${totalPatched} workspace(s) updated with agent teams support`)
  }
}
