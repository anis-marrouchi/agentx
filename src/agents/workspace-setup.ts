import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { resolve } from "path"
import { createHash } from "crypto"
import type { AgentDef } from "@/daemon/config"
import { generateAgentsMd } from "./bootstrap"
import { CODEGRAPH_TOOLS, codegraphClaudeMdSection } from "./codegraph-bootstrap"

// Marker stamped into auto-generated CLAUDE.md so we can tell agentx-managed
// files apart from user-edited ones. On daemon start, files with the marker
// are silently regenerated when the systemPrompt hash changes; files without
// the marker are treated as user-owned and never touched.
const MANAGED_MARKER_PREFIX = "<!-- agentx-managed: hash="
const MANAGED_MARKER_SUFFIX = " -->"

/** Hash inputs that drive the managed-CLAUDE.md content. Anything that
 *  affects what `generateClaudeMd` emits should feed into this so flipping
 *  the input also refreshes the file on next boot. Currently:
 *  systemPrompt + codegraph flag (the codegraph instruction block is
 *  conditional on it). */
function managedHashInputs(def: Pick<AgentDef, "systemPrompt" | "codegraph">): string {
  return createHash("sha256")
    .update(def.systemPrompt ?? "")
    .update("\0")
    .update(def.codegraph ? "cg:1" : "cg:0")
    .digest("hex")
    .slice(0, 16)
}

function buildManagedMarker(def: Pick<AgentDef, "systemPrompt" | "codegraph">): string {
  return `${MANAGED_MARKER_PREFIX}${managedHashInputs(def)}${MANAGED_MARKER_SUFFIX}`
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
  lines.push(buildManagedMarker(def))
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

  // Typed actions catalog — prefer these over free-form Bash/Read/Write/curl
  // when applicable. Each action's call lands in /traces as a structured
  // step (action: <name>, input: …, output: …) which is how observability
  // works in this codebase. Free-form Bash gets recorded as opaque shell
  // text, which is harder to debug and harder to compose into workflows.
  lines.push("## Typed actions — prefer these over free-form Bash")
  lines.push("")
  lines.push("Daemon-shipped typed actions cover the common needs. Each call appears in `/traces` as a structured step (input + output schema), unlike opaque `Bash`/`curl`/`Read` calls.")
  lines.push("")
  lines.push("```bash")
  lines.push("# List available actions + their schemas")
  lines.push(`agentx actions builtin                 # → catalog`)
  lines.push(`agentx actions builtin <name> --schema # → input/output schema`)
  lines.push("")
  lines.push("# Invoke an action with typed JSON input")
  lines.push(`agentx actions builtin http.fetch        --input '{"url":"https://example.com/data"}'`)
  lines.push(`agentx actions builtin http.post         --input '{"url":"https://x.tld/hook","body":{"k":"v"}}'`)
  lines.push(`agentx actions builtin file.read_lines   --input '{"path":"data/prices.json"}'`)
  lines.push(`agentx actions builtin file.write_jsonl  --input '{"path":"leads.jsonl","record":{"name":"…","email":"…"}}'`)
  lines.push(`agentx actions builtin extract.structured --input '{"prompt":"<text>","schema":{"type":"object",…}}'`)
  lines.push(`agentx actions builtin rag.lexical       --input '{"agentId":"${agentId}","query":"…","limit":5}'`)
  lines.push(`agentx actions builtin agent.call        --input '{"agentId":"<local-agent>","message":"…"}'`)
  lines.push(`agentx actions builtin mesh.delegate     --input '{"peer":"<peer-name>","agent":"<peer-agent>","message":"…"}'`)
  lines.push("```")
  lines.push("")
  lines.push("Rule of thumb:")
  lines.push("- HTTP fetch/POST → `http.fetch` / `http.post` (not `Bash curl`)")
  lines.push("- Reading a file you'll parse → `file.read_lines` (not `Bash cat`)")
  lines.push("- Appending a structured record → `file.write_jsonl` (not `Bash echo >>` or `Write` with model-formatted JSON)")
  lines.push("- Extracting fields from text into a typed object → `extract.structured` (not asking the model to format JSON in its reply)")
  lines.push("- Searching a doc corpus → `rag.lexical` (not `Read` over every file)")
  lines.push("- Calling another agent on this daemon → `agent.call` (fresh session by default; not composing `Bash curl` to /task)")
  lines.push("- Calling an agent on a peer mesh node → `mesh.delegate` (cross-machine; same fresh-session default)")
  lines.push("")

  // CodeGraph instruction block — only when the agent opted in. See
  // src/agents/codegraph-bootstrap.ts for the section content; sourcing it
  // from one place keeps the wording consistent if upstream changes.
  if (def.codegraph) {
    lines.push(codegraphClaudeMdSection())
  }

  return lines.join("\n")
}

// Phase 0 stop-gap deny list for the destructive-action guardrails. Claude
// Code deny globs are coarse (single trailing wildcard), so this is a blunt
// backstop for the clearly-always-destructive prisma/dropdb classes that
// caused the 2026-07-21 prod-wipe incident. The env-var-resolved, nuanced
// matching (diff --shadow-database-url pointed at prod, pg_restore --clean,
// migrate deploy) is done by the `agentx guard` PreToolUse hook, which runs
// even under bypassPermissions (where deny rules may be skipped).
const GUARDRAIL_DENY = [
  "Bash(npx prisma migrate reset*)",
  "Bash(prisma migrate reset*)",
  "Bash(npx prisma db push*)",
  "Bash(prisma db push*)",
  "Bash(dropdb*)",
]

/**
 * The command the PreToolUse hook runs. This fires on EVERY Bash/Write/Edit
 * call, so it must be cheap: spawning `node dist/cli.js guard check` cost
 * ~300ms of interpreter + bundle boot per tool call. Instead we POST the
 * payload to the already-running daemon over loopback (~1ms) and pipe its
 * response straight back to Claude Code. `/guard/check` is loopback-only.
 *
 * The trailing `|| true` is load-bearing: a PreToolUse hook exiting 2 BLOCKS
 * the tool call, and curl uses exit 2 for its own init failures. Forcing
 * exit 0 means a curl/daemon problem can never masquerade as a policy deny.
 * If the daemon is unreachable we fail open — acceptable because the daemon
 * is what spawns the agents in the first place, so "daemon down" means there
 * are no agent tool calls to guard.
 */
function guardHookCommand(agentId: string, daemonPort: string): string {
  const url = `http://127.0.0.1:${daemonPort}/guard/check?agent=${encodeURIComponent(agentId)}`
  return `curl -s --max-time 3 -H 'Content-Type: application/json' --data-binary @- '${url}' 2>/dev/null || true`
}

/** PreToolUse hook entries wiring the guard onto Bash + Write/Edit. */
function guardPreToolUseHooks(agentId: string, daemonPort: string): unknown[] {
  const command = guardHookCommand(agentId, daemonPort)
  return [
    { matcher: "Bash", hooks: [{ type: "command", command, timeout: 10 }] },
    { matcher: "Write|Edit", hooks: [{ type: "command", command, timeout: 10 }] },
  ]
}

/** Is this hook entry one of ours? Matches both the current curl form and
 *  the earlier `guard check` CLI form, so stale entries get replaced rather
 *  than duplicated. */
function isGuardEntry(entry: any): boolean {
  return (
    Array.isArray(entry?.hooks) &&
    entry.hooks.some(
      (h: any) =>
        typeof h?.command === "string" && (h.command.includes("/guard/check") || h.command.includes("guard check")),
    )
  )
}

/** Generate .claude/settings.json with hooks and permissions */
function generateSettings(agentId: string, def: AgentDef, daemonPort: string = "19900"): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    autoMemoryEnabled: true,
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    },
  }

  // Permission mode. The guardrail deny list is injected in ALL modes —
  // including bypassPermissions, which previously had none — as a stop-gap
  // backstop beneath the PreToolUse guard hook.
  if (def.permissionMode === "bypassPermissions") {
    settings["permissions"] = { deny: [...GUARDRAIL_DENY] }
  } else if (def.permissionMode === "plan") {
    settings["permissions"] = {
      deny: [...GUARDRAIL_DENY, "Bash(rm -rf *)", "Bash(drop *)", "Bash(DELETE *)"],
    }
  } else {
    // Default: deny destructive operations
    settings["permissions"] = {
      deny: [
        ...GUARDRAIL_DENY,
        "Bash(rm -rf /)",
        "Bash(> /dev/sda*)",
        "Bash(mkfs*)",
      ],
    }
  }

  // Pre-authorize codegraph MCP tools so claude doesn't prompt for each
  // call. Even under bypassPermissions there's no harm — an explicit allow
  // list survives if the agent later switches to a stricter mode.
  if (def.codegraph) {
    const perms = (settings["permissions"] as Record<string, unknown>) || {}
    const existing = Array.isArray(perms["allow"]) ? (perms["allow"] as string[]) : []
    perms["allow"] = [...new Set([...existing, ...CODEGRAPH_TOOLS])]
    settings["permissions"] = perms
  }

  // Hooks
  const hooks: Record<string, unknown[]> = {}

  // PreToolUse — destructive-action guardrails. Runs the guard on every Bash
  // and Write/Edit call; in warn mode it audits without blocking. This is the
  // primary enforcement chokepoint (works even under bypassPermissions).
  hooks["PreToolUse"] = guardPreToolUseHooks(agentId, daemonPort)

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

  // CLAUDE.md — managed: silently refreshed when systemPrompt OR codegraph
  // flag changes (both feed into the marker hash via managedHashInputs).
  writeManaged(
    resolve(workspace, "CLAUDE.md"),
    generateClaudeMd(agentId, def, daemonPort),
    managedHashInputs(def),
  )

  // .claude/settings.json
  const settingsPath = resolve(workspace, ".claude/settings.json")
  writeIfMissing(settingsPath, JSON.stringify(generateSettings(agentId, def, daemonPort), null, 2))

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
 * Backfill the destructive-action guardrails into an EXISTING settings.json:
 * merge the stop-gap deny list into permissions.deny (dedup, no clobber) and
 * add the PreToolUse guard hook if absent. writeIfMissing never touches
 * existing files, so live workspaces need this explicit patch. Idempotent —
 * re-running is a no-op once both are present. Returns true if it changed.
 */
export function patchGuardrails(workspace: string, agentId: string, daemonPort: string = "19900"): boolean {
  const settingsPath = resolve(workspace, ".claude/settings.json")
  if (!existsSync(settingsPath)) return false

  try {
    const existing = JSON.parse(readFileSync(settingsPath, "utf-8"))
    let changed = false

    // 1. deny list
    const perms = (existing.permissions ??= {})
    const deny: string[] = Array.isArray(perms.deny) ? perms.deny : (perms.deny = [])
    for (const rule of GUARDRAIL_DENY) {
      if (!deny.includes(rule)) {
        deny.push(rule)
        changed = true
      }
    }

    // 2. PreToolUse guard hook. Drop any previous guard entries (including
    //    the older node-CLI form) and re-add the current one, so a changed
    //    port or invocation style self-heals instead of duplicating.
    const hooks = (existing.hooks ??= {})
    const others = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.filter((e: any) => !isGuardEntry(e)) : []
    const desired = [...others, ...guardPreToolUseHooks(agentId, daemonPort)]
    if (JSON.stringify(hooks.PreToolUse ?? null) !== JSON.stringify(desired)) {
      hooks.PreToolUse = desired
      changed = true
    }

    if (changed) writeFileSync(settingsPath, JSON.stringify(existing, null, 2))
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
  let totalGuarded = 0
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

    // Backfill destructive-action guardrails (deny list + PreToolUse hook)
    // onto existing workspaces.
    if (def.tier === "claude-code" && patchGuardrails(def.workspace, id, daemonPort)) {
      totalGuarded++
    }
  }
  if (totalCreated > 0) {
    log(`Workspace setup: ${totalCreated} file(s) created across agent workspaces`)
  }
  if (totalPatched > 0) {
    log(`Workspace patch: ${totalPatched} workspace(s) updated with agent teams support`)
  }
  if (totalGuarded > 0) {
    log(`Guardrails: ${totalGuarded} workspace(s) backfilled with deny list + PreToolUse guard hook`)
  }
}
