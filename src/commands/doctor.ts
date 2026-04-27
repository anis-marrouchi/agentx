import { Command } from "commander"
import chalk from "chalk"
import { execFileSync } from "child_process"
import { existsSync, readFileSync, statSync } from "fs"
import { resolve } from "path"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx doctor ---
//
// Pre-flight health check. Catches the common "why isn't it working" reasons
// before the operator hits them at runtime:
//   - wrong Node version
//   - invalid / missing agentx.json
//   - agents with claude-code tier but no claude CLI installed
//   - ${FOO} references in agentx.json that have no matching env var
//   - agent workspace dirs that don't exist
//   - daemon reachable? (when --check-running, default true)
//
// Exit code: 0 if clean, 1 if any error, 0 if only warnings (so CI won't block
// on advisory checks).

type Severity = "ok" | "warn" | "fail"

interface Check {
  severity: Severity
  group: string
  title: string
  detail?: string
  fix?: string
}

export const doctor = new Command()
  .name("doctor")
  .description("pre-flight health check: Node, config, credentials, daemon")
  .option("--no-running", "skip the live daemon probe")
  .option("--json", "emit machine-readable JSON (stable shape for CI)")
  .action(async (opts) => {
    const checks: Check[] = []
    await runEnvChecks(checks)
    const cfg = runConfigChecks(checks)
    if (cfg) runReferenceChecks(checks, cfg)
    if (cfg) runWorkspaceChecks(checks, cfg)
    if (cfg) runWorkspaceSettingsChecks(checks, cfg)
    if (cfg) runRoutingChecks(checks, cfg)
    if (opts.running !== false && cfg) await runRuntimeChecks(checks, cfg)

    if (opts.json) {
      process.stdout.write(JSON.stringify({ checks, summary: summarize(checks) }, null, 2) + "\n")
    } else {
      printHumanReport(checks)
    }

    const { errors } = summarize(checks)
    process.exit(errors > 0 ? 1 : 0)
  })

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function runEnvChecks(checks: Check[]): Promise<void> {
  const nodeMajor = Number(process.versions.node.split(".")[0])
  checks.push({
    severity: nodeMajor >= 20 ? "ok" : "fail",
    group: "Environment",
    title: `Node.js ${process.versions.node}`,
    detail: nodeMajor >= 20 ? undefined : "AgentX needs Node 20 or newer.",
    fix: nodeMajor >= 20 ? undefined : "Install a newer Node (nvm install 20 && nvm use 20)",
  })

  const which = (bin: string): string | null => {
    try { return execFileSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf-8" }).trim().split("\n")[0] }
    catch { return null }
  }
  const npmPath = which("npm")
  checks.push({
    severity: npmPath ? "ok" : "fail",
    group: "Environment",
    title: npmPath ? "npm on PATH" : "npm not found",
    detail: npmPath || undefined,
  })

  // Claude CLI is only required if the config references claude-code agents;
  // we report it advisory here and promote to fail in the config step below.
  const claudePath = which("claude")
  if (claudePath) {
    let ver: string | undefined
    try { ver = execFileSync("claude", ["--version"], { encoding: "utf-8", timeout: 3000 }).trim() } catch { /* */ }
    checks.push({ severity: "ok", group: "Environment", title: `claude CLI ${ver || "installed"}`, detail: claudePath })
  } else {
    checks.push({
      severity: "warn",
      group: "Environment",
      title: "claude CLI not on PATH",
      detail: "Only required for agents on the claude-code tier.",
      fix: "See https://docs.anthropic.com/en/docs/claude-code",
    })
  }
}

function runConfigChecks(checks: Check[]): any {
  const cfgPath = resolve(process.cwd(), "agentx.json")
  if (!existsSync(cfgPath)) {
    checks.push({
      severity: "fail",
      group: "Config",
      title: "agentx.json not found",
      detail: `Looked in ${cfgPath}`,
      fix: "Run `agentx setup` to create one via the web wizard.",
    })
    return null
  }
  let cfg: any
  try { cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) }
  catch (e: any) {
    checks.push({ severity: "fail", group: "Config", title: "agentx.json is not valid JSON", detail: e.message })
    return null
  }
  try {
    // Full schema validation — catches missing required fields.
    loadDaemonConfig(cfgPath)
    checks.push({ severity: "ok", group: "Config", title: `agentx.json valid (${Object.keys(cfg.agents || {}).length} agents, ${Object.keys(cfg.crons || {}).length} schedules)` })
  } catch (e: any) {
    checks.push({
      severity: "fail",
      group: "Config",
      title: "agentx.json failed schema validation",
      detail: e.message,
      fix: "Open /admin → Advanced tab to edit and re-save.",
    })
  }
  const claudeCodeAgents = Object.entries(cfg.agents || {}).filter(([, a]: [string, any]) => a.tier === "claude-code")
  if (claudeCodeAgents.length > 0) {
    const hasClaude = (() => {
      try { execFileSync(process.platform === "win32" ? "where" : "which", ["claude"], { stdio: "ignore" }); return true } catch { return false }
    })()
    if (!hasClaude) {
      checks.push({
        severity: "fail",
        group: "Config",
        title: `${claudeCodeAgents.length} agent(s) use claude-code tier but claude CLI is missing`,
        detail: claudeCodeAgents.map(([id]) => id).join(", "),
        fix: "Install Claude Code (https://docs.anthropic.com/en/docs/claude-code) or switch these agents to tier=sdk.",
      })
    }
  }
  return cfg
}

function runReferenceChecks(checks: Check[], cfg: any): void {
  // Parse ${VAR} references out of the config (recursively) and verify each
  // one has a matching value in .env or process.env.
  const refs = new Set<string>()
  collectEnvRefs(cfg, refs)
  if (refs.size === 0) {
    checks.push({ severity: "ok", group: "Secrets", title: "No ${VAR} references in agentx.json" })
    return
  }
  const envFile = resolve(process.cwd(), ".env")
  const envFromFile: Record<string, string> = {}
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i)
      if (m) envFromFile[m[1]] = m[2]
    }
  }
  const missing: string[] = []
  const empty: string[] = []
  for (const name of refs) {
    const raw = process.env[name] ?? envFromFile[name]
    if (raw === undefined) missing.push(name)
    else if (!raw.trim() || /^["']?\s*["']?$/.test(raw)) empty.push(name)
  }
  if (missing.length === 0 && empty.length === 0) {
    checks.push({ severity: "ok", group: "Secrets", title: `${refs.size} env reference(s) resolved` })
  } else {
    if (missing.length > 0) {
      checks.push({
        severity: "fail",
        group: "Secrets",
        title: `${missing.length} env var(s) referenced in agentx.json but missing`,
        detail: missing.join(", "),
        fix: `Add to .env — e.g. ${missing[0]}=<value>`,
      })
    }
    if (empty.length > 0) {
      checks.push({
        severity: "warn",
        group: "Secrets",
        title: `${empty.length} env var(s) set but empty`,
        detail: empty.join(", "),
      })
    }
  }
}

function collectEnvRefs(node: unknown, into: Set<string>): void {
  if (typeof node === "string") {
    for (const m of node.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) into.add(m[1])
  } else if (Array.isArray(node)) {
    for (const item of node) collectEnvRefs(item, into)
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectEnvRefs(v, into)
  }
}

function runWorkspaceChecks(checks: Check[], cfg: any): void {
  const missing: string[] = []
  for (const [id, a] of Object.entries(cfg.agents || {}) as [string, any][]) {
    if (!a.workspace) continue
    const abs = a.workspace.startsWith("/") ? a.workspace : resolve(process.cwd(), a.workspace)
    try {
      const st = statSync(abs)
      if (!st.isDirectory()) missing.push(`${id}: ${abs} (exists but not a directory)`)
    } catch { missing.push(`${id}: ${abs}`) }
  }
  if (missing.length === 0) {
    checks.push({ severity: "ok", group: "Workspaces", title: "All agent workspace folders exist" })
  } else {
    checks.push({
      severity: "warn",
      group: "Workspaces",
      title: `${missing.length} agent workspace(s) missing`,
      detail: missing.join("\n    "),
      fix: "The daemon will create missing folders on first task, but you won't see CLAUDE.md / skills until you populate them.",
    })
  }
}

// Audit each agent's .claude/settings.json for known traps:
//   - unexpanded ${VAR} literals in env values (Claude Code does NOT expand them)
//   - env.PATH missing /usr/bin or /bin (basic utils unreachable)
//   - JSON syntax errors
//   - permissions.allow: [] explicitly empty alongside non-empty deny
// Each finding is FAIL severity for the ${VAR} / PATH cases (these break the
// agent's Bash tool entirely), WARN for the lockdown case.
function runWorkspaceSettingsChecks(checks: Check[], cfg: any): void {
  const VAR_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g
  const findings: Array<{ severity: Severity; agent: string; msg: string }> = []

  for (const [agentId, a] of Object.entries(cfg.agents || {}) as [string, any][]) {
    if (!a.workspace) continue
    const wsAbs = a.workspace.startsWith("/") ? a.workspace : resolve(process.cwd(), a.workspace)
    for (const fname of ["settings.json", "settings.local.json"]) {
      const p = resolve(wsAbs, ".claude", fname)
      if (!existsSync(p)) continue
      let data: any
      try {
        data = JSON.parse(readFileSync(p, "utf-8"))
      } catch (e: any) {
        findings.push({ severity: "fail", agent: agentId, msg: `${fname}: JSON parse error — ${e.message}` })
        continue
      }
      const env = (data.env || {}) as Record<string, unknown>
      for (const [k, v] of Object.entries(env)) {
        if (typeof v !== "string") continue
        const unexpanded = v.match(VAR_RE)
        if (unexpanded) {
          findings.push({
            severity: "fail",
            agent: agentId,
            msg: `${fname} env.${k} contains unexpanded ${[...new Set(unexpanded)].join(",")} — Claude Code does NOT expand \${VAR} in settings.json (use a fully-literal value)`,
          })
        }
      }
      const pathVal = env.PATH
      if (typeof pathVal === "string") {
        const parts = pathVal.split(":").filter(Boolean)
        if (!parts.includes("/usr/bin")) {
          findings.push({ severity: "fail", agent: agentId, msg: `${fname} env.PATH missing /usr/bin — cat/head/sh/which will fail` })
        }
        if (!parts.includes("/bin")) {
          findings.push({ severity: "fail", agent: agentId, msg: `${fname} env.PATH missing /bin — ls/cp/mv will fail` })
        }
      }
      const perms = data.permissions
      if (perms && typeof perms === "object" && "allow" in perms) {
        const allow = perms.allow
        const deny = perms.deny
        if (Array.isArray(allow) && allow.length === 0 && Array.isArray(deny) && deny.length > 0) {
          findings.push({
            severity: "warn",
            agent: agentId,
            msg: `${fname} permissions.allow is explicitly [] with ${deny.length} deny rules — agent may be locked out (omit the key to use defaults instead)`,
          })
        }
      }
    }
  }

  if (findings.length === 0) {
    checks.push({ severity: "ok", group: "Workspace settings", title: `All ${Object.keys(cfg.agents || {}).length} agent .claude/settings.json files clean` })
    return
  }
  for (const f of findings) {
    checks.push({
      severity: f.severity,
      group: "Workspace settings",
      title: `${f.agent}: ${f.msg}`,
      fix: f.severity === "fail" ? "Edit .claude/settings.json — replace ${VAR} with the literal value or omit the key to inherit." : "Either remove the empty allow list or populate it.",
    })
  }
}

// Surface routing / dispatch fragilities the recurring-patches plan
// cataloged: webhook entries that route many event-types to a single
// handler (github, gitlab), trigger maps pointing at workflow ids that
// don't exist, mesh `node` fields naming peers that aren't configured,
// gitlab agentMappings referencing unknown agents, and the very common
// "I edited agentx.json but didn't reload" pitfall.
function runRoutingChecks(checks: Check[], cfg: any): void {
  const webhooks = (cfg.webhooks ?? []) as Array<{
    id: string
    source: string
    agentId: string
    enabled: boolean
    node?: string
    secretEnv?: string
    triggers?: Record<string, string>
    defaultWorkflow?: string
  }>
  const findings: Array<{ severity: Severity; title: string; fix?: string }> = []

  // Build the set of known workflow ids. Workflows live as JSON files under
  // `workflows.dir` (default .agentx/workflows/). The id is the filename
  // sans extension; we don't need to parse the contents for this check.
  const workflowDir = resolve(process.cwd(), cfg.workflows?.dir || ".agentx/workflows")
  const knownWorkflows = new Set<string>()
  try {
    const { readdirSync } = require("fs") as typeof import("fs")
    if (existsSync(workflowDir)) {
      for (const f of readdirSync(workflowDir)) {
        if (f.endsWith(".json") && !f.startsWith("_") && !f.endsWith(".disabled.json")) {
          knownWorkflows.add(f.replace(/\.json$/, ""))
        }
      }
    }
  } catch { /* directory not yet populated; checks below tolerate empty set */ }

  // 1. Multi-event-type sources (github, gitlab) without a triggers map.
  //    Without it, every inbound event hits the same agent and the
  //    duplicate-firing class of bug returns. Surface as REVIEW (warn) —
  //    operators may genuinely want a single-handler setup, but they
  //    should opt in by setting `defaultWorkflow` explicitly.
  const multiEventSources = new Set(["github", "gitlab"])
  for (const w of webhooks) {
    if (!w.enabled) continue
    if (!multiEventSources.has(w.source)) continue
    const hasTriggers = w.triggers && Object.keys(w.triggers).length > 0
    if (!hasTriggers && !w.defaultWorkflow) {
      findings.push({
        severity: "warn",
        title: `webhook "${w.id}" (${w.source} -> ${w.agentId}) has no triggers map; every event-type collapses to the bound agent`,
        fix: `Add a triggers map: { "issues.opened": "wf-id", "pull_request.synchronize": "wf-id" } — or set defaultWorkflow.`,
      })
    }
  }

  // 2. Trigger map references workflow ids that don't exist on disk.
  //    Hard-fails the dispatch at runtime (and silently — dispatcher just
  //    logs "workflow not found" and bails). Surface here as FAIL.
  for (const w of webhooks) {
    if (!w.enabled || !w.triggers) continue
    for (const [eventType, workflowId] of Object.entries(w.triggers)) {
      if (knownWorkflows.size > 0 && !knownWorkflows.has(workflowId)) {
        findings.push({
          severity: "fail",
          title: `webhook "${w.id}".triggers["${eventType}"] -> "${workflowId}" — no such workflow under ${cfg.workflows?.dir || ".agentx/workflows"}`,
          fix: `Create the workflow file or fix the id in agentx.json`,
        })
      }
    }
    if (w.defaultWorkflow && knownWorkflows.size > 0 && !knownWorkflows.has(w.defaultWorkflow)) {
      findings.push({
        severity: "fail",
        title: `webhook "${w.id}".defaultWorkflow -> "${w.defaultWorkflow}" — no such workflow`,
        fix: `Create the workflow file or fix the id in agentx.json`,
      })
    }
  }

  // 3. Mesh-routed webhooks naming peers that don't exist.
  const peers = new Set<string>(((cfg.mesh?.peers ?? []) as Array<{ name: string }>).map(p => p.name))
  for (const w of webhooks) {
    if (!w.enabled || !w.node) continue
    if (!peers.has(w.node)) {
      findings.push({
        severity: "fail",
        title: `webhook "${w.id}" routes to mesh peer "${w.node}" which is not in mesh.peers`,
        fix: `Add the peer to mesh.peers or remove the node field on the webhook.`,
      })
    }
  }

  // 4. Two enabled webhook entries collide on (source, agentId): the
  //    Phase 3 dispatcher takes the first match, the second is silently
  //    ignored — operators rarely realize.
  const seen = new Map<string, string>()
  for (const w of webhooks) {
    if (!w.enabled) continue
    const key = `${w.source}:${w.agentId}`
    const prior = seen.get(key)
    if (prior) {
      findings.push({
        severity: "warn",
        title: `webhook entries "${prior}" and "${w.id}" both enabled for ${w.source} -> ${w.agentId}; only the first is dispatched`,
        fix: `Disable one entry, or merge their triggers maps into a single entry.`,
      })
    } else {
      seen.set(key, w.id)
    }
  }

  // 5. GitLab agentMappings referencing agent ids that aren't in agents.
  //    A mapping with `node:` set is a cross-mesh route — the agent lives
  //    on a remote peer, not locally — so missing-from-agents is correct
  //    and not a finding. We still warn when `node` names a peer that
  //    isn't configured (caught by check #3 above for webhooks; same
  //    invariant should hold for agentMappings).
  const agentIds = new Set(Object.keys(cfg.agents ?? {}))
  for (const m of (cfg.channels?.gitlab?.agentMappings ?? [])) {
    if (!m?.agentId) continue
    if (m.node) {
      // Cross-mesh route — verify the named peer exists.
      if (!peers.has(m.node)) {
        findings.push({
          severity: "fail",
          title: `gitlab.agentMappings entry agentId="${m.agentId}" routes to mesh peer "${m.node}" which is not in mesh.peers`,
          fix: `Add the peer to mesh.peers or drop the node field on the mapping.`,
        })
      }
      continue
    }
    if (!agentIds.has(m.agentId)) {
      findings.push({
        severity: "warn",
        title: `gitlab.agentMappings entry agentId="${m.agentId}" — no such agent in agents.* (and no node field, so it's not a cross-mesh route)`,
        fix: `Add the agent to agents.*, set node:"<peer>" if the agent lives remotely, or remove the mapping.`,
      })
    }
  }

  // 6. Telegram accounts without an agentBinding silently drop every DM.
  for (const [acctId, acct] of Object.entries((cfg.channels?.telegram?.accounts ?? {}) as Record<string, { agentBinding?: string }>)) {
    if (!acct.agentBinding) {
      findings.push({
        severity: "fail",
        title: `telegram account "${acctId}" has no agentBinding; every DM to this bot will drop`,
        fix: `Set agentBinding to a valid agent id.`,
      })
    } else if (!agentIds.has(acct.agentBinding)) {
      findings.push({
        severity: "fail",
        title: `telegram account "${acctId}".agentBinding -> "${acct.agentBinding}" — no such agent in agents.*`,
        fix: `Fix the agentBinding or define the agent in agents.*.`,
      })
    }
  }

  // (Removed: the "agentx.json newer than daemon pid" check produced
  //  false positives because the pid file is only rewritten on start,
  //  not on hot-reload. The signal-to-noise was too low. A future check
  //  can query /reload's `lastReload` timestamp via the daemon API
  //  instead of using filesystem mtimes.)

  if (findings.length === 0) {
    checks.push({
      severity: "ok",
      group: "Routing",
      title: `${webhooks.length} webhook(s), ${Object.keys(cfg.channels?.telegram?.accounts ?? {}).length} telegram account(s) — all routing references resolve`,
    })
    return
  }
  for (const f of findings) {
    checks.push({ severity: f.severity, group: "Routing", title: f.title, fix: f.fix })
  }
}

async function runRuntimeChecks(checks: Check[], cfg: any): Promise<void> {
  const url = cfg.dashboard?.daemonUrl?.replace(/\/+$/, "") || "http://127.0.0.1:18800"
  const headers: Record<string, string> = {}
  if (cfg.dashboard?.token) headers["Authorization"] = `Bearer ${cfg.dashboard.token}`
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 2000)
    const r = await fetch(url + "/health", { headers, signal: ac.signal })
    clearTimeout(timer)
    if (!r.ok) {
      checks.push({ severity: "warn", group: "Runtime", title: `Daemon responded ${r.status}`, detail: url })
      return
    }
    const body: any = await r.json()
    checks.push({
      severity: "ok",
      group: "Runtime",
      title: `Daemon healthy — ${body.agents?.length ?? 0} agents live, uptime ${Math.round((body.uptime ?? 0) / 60)}m`,
      detail: url,
    })
  } catch {
    checks.push({
      severity: "warn",
      group: "Runtime",
      title: "Daemon not reachable (not running?)",
      detail: url,
      fix: "Run `agentx daemon start`. Skip this check with `agentx doctor --no-running`.",
    })
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function summarize(checks: Check[]): { errors: number; warnings: number; ok: number } {
  return {
    errors: checks.filter((c) => c.severity === "fail").length,
    warnings: checks.filter((c) => c.severity === "warn").length,
    ok: checks.filter((c) => c.severity === "ok").length,
  }
}

function printHumanReport(checks: Check[]): void {
  console.log()
  console.log(chalk.bold("  agentx doctor"))
  console.log()

  const groups = new Map<string, Check[]>()
  for (const c of checks) {
    if (!groups.has(c.group)) groups.set(c.group, [])
    groups.get(c.group)!.push(c)
  }
  for (const [group, items] of groups) {
    console.log(chalk.bold("  " + group))
    for (const c of items) {
      const marker = c.severity === "ok" ? chalk.green("✓")
        : c.severity === "warn" ? chalk.yellow("!")
        : chalk.red("✗")
      console.log(`    ${marker} ${c.title}`)
      if (c.detail) console.log(chalk.dim("      " + c.detail.replace(/\n/g, "\n      ")))
      if (c.fix) console.log(chalk.dim("      → " + c.fix))
    }
    console.log()
  }

  const s = summarize(checks)
  if (s.errors > 0) {
    console.log(chalk.red.bold(`  ${s.errors} error${s.errors === 1 ? "" : "s"}`) +
      (s.warnings ? chalk.yellow(`, ${s.warnings} warning${s.warnings === 1 ? "" : "s"}`) : "") +
      `. Fix the error${s.errors === 1 ? "" : "s"} and rerun.`)
  } else if (s.warnings > 0) {
    console.log(chalk.yellow.bold(`  ${s.warnings} warning${s.warnings === 1 ? "" : "s"}.`) + chalk.dim(" Review but not blocking."))
  } else {
    console.log(chalk.green.bold(`  All checks passed (${s.ok}).`))
  }
  console.log()
}
