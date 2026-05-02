import { Command } from "commander"
import chalk from "chalk"
import prompts from "prompts"
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync } from "fs"
import { resolve, join } from "path"
import { loadDaemonConfig, validateWorkspaces } from "@/daemon/config"
import { applyConfigMutation } from "@/daemon/config-mutator"

// --- agentx agent/channel/cron/mesh/skill/hook management commands ---

function loadConfig(): any {
  const p = resolve(process.cwd(), "agentx.json")
  if (!existsSync(p)) throw new Error("No agentx.json found. Run: agentx init")
  return JSON.parse(readFileSync(p, "utf-8"))
}

/**
 * Persist a mutated config. Goes through applyConfigMutation so every caller
 * gets pre-save Zod validation and an automatic daemon hot-reload when one is
 * running. Returns a promise; callers inside async .action handlers should
 * await it so the reload signal lands before the CLI process exits.
 */
function saveConfig(config: any): Promise<void> {
  return applyConfigMutation((current) => {
    for (const k of Object.keys(current)) delete current[k]
    Object.assign(current, config)
  }).then((result) => {
    if (!result.success) {
      console.error(chalk.red(`  Config save failed: ${result.error}`))
      return
    }
    if (result.reloaded) {
      console.error(chalk.dim("  (daemon hot-reloaded)"))
    } else if (result.reloadSkipped && !/ECONNREFUSED|unreachable|fetch failed/i.test(result.reloadSkipped)) {
      console.error(chalk.dim(`  (daemon reload skipped: ${result.reloadSkipped})`))
    }
  })
}

// ==================== agentx agent ====================

export const agent = new Command()
  .name("agent")
  .description("manage agents — add, list, remove")

agent
  .command("list")
  .alias("ls")
  .description("list configured agents")
  .action(() => {
    const config = loadConfig()
    console.log()
    for (const [id, a] of Object.entries(config.agents || {}) as any) {
      const mentions = a.mentions?.join(", ") || ""
      console.log(`  ${chalk.cyan(id)} — ${a.name} (${a.tier})`)
      console.log(chalk.dim(`    workspace: ${a.workspace}`))
      if (mentions) console.log(chalk.dim(`    mentions: ${mentions}`))
    }
    console.log()
  })

agent
  .command("add")
  .description("add a new agent interactively")
  .action(async () => {
    const config = loadConfig()

    const answers = await prompts([
      { type: "text", name: "id", message: "Agent ID (kebab-case)", validate: (v: string) => /^[a-z0-9-]+$/.test(v) || "Use lowercase, numbers, hyphens" },
      { type: "text", name: "name", message: "Display name" },
      { type: "text", name: "workspace", message: "Workspace path", initial: resolve(process.cwd(), "agents/") },
      { type: "select", name: "tier", message: "Execution tier", choices: [
        { title: "claude-code (subscription, full features)", value: "claude-code" },
        { title: "sdk (API key, programmatic)", value: "sdk" },
        { title: "orchestrator (any provider)", value: "orchestrator" },
      ]},
      { type: "text", name: "model", message: "Model", initial: "claude-sonnet-4-6" },
      { type: "list", name: "mentions", message: "Mention patterns (comma-separated)", separator: "," },
      { type: "number", name: "maxConcurrent", message: "Max concurrent tasks", initial: 2 },
      { type: "text", name: "systemPrompt", message: "System prompt" },
    ])

    if (!answers.id) return

    // Create workspace + .claude dir
    const ws = answers.workspace.endsWith(answers.id) ? answers.workspace : join(answers.workspace, answers.id)
    mkdirSync(resolve(ws, ".claude/skills"), { recursive: true })

    const agentDef = {
      name: answers.name,
      workspace: ws,
      tier: answers.tier,
      model: answers.model,
      mentions: answers.mentions?.map((m: string) => m.trim()).filter(Boolean) || [],
      maxConcurrent: answers.maxConcurrent,
      systemPrompt: answers.systemPrompt,
      permissionMode: "default",
    }

    // Set up workspace with Claude Code best practices
    // (CLAUDE.md, AGENTS.md, .claude/settings.json, .claude/rules/)
    const { setupWorkspace } = await import("@/agents/workspace-setup")
    const setup = setupWorkspace(answers.id, agentDef as any, "19900", (...args: unknown[]) => {
      console.log(chalk.dim(`  ${args.join(" ")}`))
    })

    // Install wiki skill
    const wikiSkillSrc = resolve(process.cwd(), "src/wiki/SKILL.md")
    const wikiSkillDist = resolve(__dirname, "../wiki/SKILL.md")
    const skillSrc = existsSync(wikiSkillSrc) ? wikiSkillSrc : wikiSkillDist
    if (existsSync(skillSrc)) {
      mkdirSync(resolve(ws, ".claude/skills/wiki"), { recursive: true })
      cpSync(skillSrc, resolve(ws, ".claude/skills/wiki/SKILL.md"))
    }

    // Add to config
    config.agents = config.agents || {}
    config.agents[answers.id] = agentDef

    await saveConfig(config)
    console.log(chalk.green(`\n  Agent "${answers.id}" added`))
    console.log(chalk.dim(`  Workspace: ${ws}`))
    console.log(chalk.dim(`  Created: ${setup.created.length} files (CLAUDE.md, AGENTS.md, settings, rules)`))
    console.log()
  })

agent
  .command("remove <id>")
  .alias("rm")
  .description("remove an agent from config (keeps workspace)")
  .action(async (id) => {
    const config = loadConfig()
    if (!config.agents?.[id]) {
      console.log(chalk.red(`  Agent "${id}" not found`))
      return
    }
    delete config.agents[id]
    await saveConfig(config)
    console.log(chalk.green(`  Agent "${id}" removed from config (workspace preserved)`))
  })

// agentx agent capability — set intents / maxDelegationDepth / contextReferences /
// contextStrategy without hand-editing agentx.json. These are the Phase 5/8 fields
// the second-pass parity audit flagged as CLI-only-via-JSON.
agent
  .command("capability <id>")
  .alias("caps")
  .description("set agent capability flags (intents, maxDelegationDepth, contextReferences, contextStrategy)")
  .option("--intents <csv>", "comma-separated intent allow-list (set to '-' to clear)")
  .option("--max-delegation-depth <n>", "max distinct upstream agents on the same subject before refusal (0 disables)")
  .option("--context-references <bool>", "render the deterministic [Verified References] block (true|false)")
  .option("--context-strategy <name>", "per-agent override: layered | planner")
  .option("--max-execution-minutes <n>", "wall-clock cap on a single Claude Code call (1–240)")
  .option("--show", "just print the current capability fields")
  .action(async (id: string, opts) => {
    const config = loadConfig()
    const a = config.agents?.[id]
    if (!a) { console.log(chalk.red(`  Agent "${id}" not found`)); process.exit(1) }
    if (opts.show) {
      console.log()
      console.log(chalk.bold(`  ${id}`))
      console.log(`    intents             ${(a.intents && a.intents.length) ? (a.intents as string[]).join(", ") : chalk.dim("(any)")}`)
      console.log(`    maxDelegationDepth  ${a.maxDelegationDepth ?? 5}`)
      console.log(`    contextReferences   ${a.contextReferences ? "on" : chalk.dim("off")}`)
      console.log(`    contextStrategy     ${a.contextStrategy || chalk.dim("(global default)")}`)
      console.log(`    maxExecutionMinutes ${a.maxExecutionMinutes ?? 20}`)
      console.log()
      return
    }
    const changes: string[] = []
    if (opts.intents !== undefined) {
      if (opts.intents === "-" || opts.intents === "") {
        a.intents = []
        changes.push("intents cleared (permissive)")
      } else {
        a.intents = String(opts.intents).split(",").map((s) => s.trim()).filter(Boolean)
        changes.push(`intents=[${a.intents.join(", ")}]`)
      }
    }
    if (opts.maxDelegationDepth !== undefined) {
      const n = parseInt(opts.maxDelegationDepth, 10)
      if (!Number.isFinite(n) || n < 0 || n > 50) { console.log(chalk.red("  --max-delegation-depth must be 0..50")); process.exit(1) }
      a.maxDelegationDepth = n
      changes.push(`maxDelegationDepth=${n}`)
    }
    if (opts.contextReferences !== undefined) {
      const v = String(opts.contextReferences).toLowerCase()
      if (!["true", "false", "on", "off", "1", "0"].includes(v)) { console.log(chalk.red("  --context-references must be true|false")); process.exit(1) }
      a.contextReferences = v === "true" || v === "on" || v === "1"
      changes.push(`contextReferences=${a.contextReferences}`)
    }
    if (opts.contextStrategy !== undefined) {
      if (!["layered", "planner"].includes(opts.contextStrategy)) { console.log(chalk.red("  --context-strategy must be layered|planner")); process.exit(1) }
      a.contextStrategy = opts.contextStrategy
      changes.push(`contextStrategy=${opts.contextStrategy}`)
    }
    if (opts.maxExecutionMinutes !== undefined) {
      const n = parseInt(opts.maxExecutionMinutes, 10)
      if (!Number.isFinite(n) || n < 1 || n > 240) { console.log(chalk.red("  --max-execution-minutes must be 1..240")); process.exit(1) }
      a.maxExecutionMinutes = n
      changes.push(`maxExecutionMinutes=${n}`)
    }
    if (changes.length === 0) { console.log(chalk.yellow("  no changes — pass at least one flag, or use --show")); process.exit(1) }
    await saveConfig(config)
    console.log(chalk.green(`  ✓ ${id}: ${changes.join(", ")}`))
    console.log(chalk.dim(`  Restart the daemon (or POST /reload) for the change to take effect.`))
  })

// ==================== agentx channel ====================

export const channel = new Command()
  .name("channel")
  .description("manage channels — add telegram/whatsapp/discord, list")

channel
  .command("list")
  .alias("ls")
  .description("list configured channels and bindings")
  .action(() => {
    const config = loadConfig()
    console.log()

    // Telegram
    const tg = config.channels?.telegram
    if (tg?.enabled) {
      console.log(chalk.bold("  Telegram:"))
      for (const [name, acc] of Object.entries(tg.accounts || {}) as any) {
        console.log(`    ${chalk.cyan(name)} -> agent: ${acc.agentBinding}`)
      }
    } else {
      console.log(chalk.dim("  Telegram: disabled"))
    }

    // WhatsApp
    const wa = config.channels?.whatsapp
    if (wa?.enabled) {
      console.log(chalk.bold("  WhatsApp:"))
      console.log(`    default agent: ${wa.defaultAgent || "(none)"}`)
      console.log(`    session: ${wa.sessionDir || ".agentx/whatsapp-sessions"}`)
      for (const route of wa.routes || []) {
        const target = route.contact ? `contact ${route.contact}` : `group "${route.group}"`
        console.log(`    ${target} -> agent: ${route.agent}`)
      }
    } else {
      console.log(chalk.dim("  WhatsApp: disabled"))
    }

    // Discord
    const dc = config.channels?.discord
    if (dc?.enabled) {
      console.log(chalk.bold("  Discord:"))
      console.log(`    agent: ${dc.agentBinding || "(none)"}`)
    } else {
      console.log(chalk.dim("  Discord: disabled"))
    }

    // GitLab
    const gl = config.channels?.gitlab
    if (gl?.enabled) {
      console.log(chalk.bold("  GitLab:"))
      console.log(`    host: ${gl.host}`)
      console.log(`    webhook: :${gl.webhookPort}`)
      for (const route of gl.routes || []) {
        console.log(`    ${route.project} -> agent: ${route.agent}`)
      }
    } else {
      console.log(chalk.dim("  GitLab: disabled"))
    }

    console.log()
  })

channel
  .command("add")
  .description("add a channel (telegram, whatsapp, or discord)")
  .action(async () => {
    const config = loadConfig()
    const agentIds = Object.keys(config.agents || {})
    if (!agentIds.length) {
      console.log(chalk.red("  No agents configured. Run: agentx agent add"))
      return
    }

    const agentChoices = agentIds.map(id => ({ title: `${id} (${config.agents[id].name})`, value: id }))

    const { channelType } = await prompts({
      type: "select",
      name: "channelType",
      message: "Channel type",
      choices: [
        { title: "Telegram — bot via BotFather token", value: "telegram" },
        { title: "WhatsApp — link via QR code (self-chat or contacts)", value: "whatsapp" },
        { title: "Discord — bot via Discord developer portal", value: "discord" },
        { title: "GitLab — webhook for issues, MRs, comments, pipelines", value: "gitlab" },
      ],
    })

    if (!channelType) return

    config.channels = config.channels || {}

    // --- Telegram ---
    if (channelType === "telegram") {
      const answers = await prompts([
        { type: "text", name: "accountName", message: "Account name (e.g. 'default', 'devops')" },
        { type: "text", name: "token", message: "Bot token (from @BotFather)" },
        { type: "select", name: "agentBinding", message: "Bind to agent", choices: agentChoices },
      ])

      if (!answers.accountName || !answers.token) return

      try {
        const res = await fetch(`https://api.telegram.org/bot${answers.token}/getMe`)
        const data = await res.json() as any
        if (!data.ok) throw new Error(data.description)
        console.log(chalk.green(`  Bot verified: @${data.result.username}`))

        const botHandle = `@${data.result.username}`
        const agentMentions = config.agents[answers.agentBinding].mentions || []
        if (!agentMentions.includes(botHandle)) {
          agentMentions.push(botHandle, data.result.username)
          config.agents[answers.agentBinding].mentions = agentMentions
        }
      } catch (e: any) {
        console.log(chalk.red(`  Invalid token: ${e.message}`))
        return
      }

      config.channels.telegram = config.channels.telegram || { enabled: false, accounts: {}, policy: { dm: "pair", group: "mention-required" } }
      config.channels.telegram.enabled = true
      config.channels.telegram.accounts[answers.accountName] = {
        token: answers.token,
        agentBinding: answers.agentBinding,
      }

      await saveConfig(config)
      console.log(chalk.green(`  Telegram "${answers.accountName}" added -> ${answers.agentBinding}`))
    }

    // --- WhatsApp ---
    if (channelType === "whatsapp") {
      const answers = await prompts([
        { type: "select", name: "defaultAgent", message: "Default agent for WhatsApp messages", choices: agentChoices },
        { type: "text", name: "sessionDir", message: "Session directory", initial: ".agentx/whatsapp-sessions" },
        { type: "confirm", name: "addRoute", message: "Add a contact/group route?", initial: true },
      ])

      if (!answers.defaultAgent) return

      const routes: any[] = []
      let addMore = answers.addRoute

      while (addMore) {
        const route = await prompts([
          { type: "select", name: "type", message: "Route type", choices: [
            { title: "Contact (phone number)", value: "contact" },
            { title: "Group (name match)", value: "group" },
          ]},
          { type: "text", name: "value", message: (prev: string) => prev === "contact" ? "Phone number (e.g. +21624309128)" : "Group name (partial match)" },
          { type: "select", name: "agent", message: "Route to agent", choices: agentChoices },
          { type: "confirm", name: "more", message: "Add another route?", initial: false },
        ])

        if (route.value && route.agent) {
          routes.push({
            [route.type]: route.value,
            agent: route.agent,
          })
        }
        addMore = route.more
      }

      config.channels.whatsapp = {
        enabled: true,
        sessionDir: answers.sessionDir,
        defaultAgent: answers.defaultAgent,
        routes,
      }

      await saveConfig(config)
      mkdirSync(resolve(process.cwd(), answers.sessionDir), { recursive: true })
      console.log(chalk.green(`  WhatsApp enabled (${routes.length} routes, default: ${answers.defaultAgent})`))
      console.log(chalk.dim("  Start daemon to scan QR code: agentx daemon start"))
    }

    // --- Discord ---
    if (channelType === "discord") {
      const answers = await prompts([
        { type: "text", name: "token", message: "Discord bot token (from developer portal)" },
        { type: "select", name: "agentBinding", message: "Bind to agent", choices: agentChoices },
      ])

      if (!answers.token) return

      config.channels.discord = {
        enabled: true,
        token: answers.token,
        agentBinding: answers.agentBinding,
      }

      await saveConfig(config)
      console.log(chalk.green(`  Discord added -> ${answers.agentBinding}`))
    }

    // --- GitLab ---
    if (channelType === "gitlab") {
      const answers = await prompts([
        { type: "text", name: "host", message: "GitLab instance URL", initial: "https://gitlab.example.com" },
        { type: "text", name: "token", message: "GitLab API token (PRIVATE-TOKEN)" },
        { type: "number", name: "webhookPort", message: "Webhook listen port", initial: 18810 },
        { type: "text", name: "webhookSecret", message: "Webhook secret (X-Gitlab-Token, optional)" },
        { type: "confirm", name: "addRoute", message: "Add a project route?", initial: true },
      ])

      if (!answers.token) return

      const routes: any[] = []
      let addMore = answers.addRoute

      while (addMore) {
        const route = await prompts([
          { type: "text", name: "project", message: "GitLab project path (e.g. group/project, or * for default)" },
          { type: "select", name: "agent", message: "Route to agent", choices: agentChoices },
          { type: "confirm", name: "more", message: "Add another route?", initial: false },
        ])

        if (route.project && route.agent) {
          routes.push({ project: route.project, agent: route.agent })
        }
        addMore = route.more
      }

      config.channels.gitlab = {
        enabled: true,
        host: answers.host,
        token: answers.token,
        webhookPort: answers.webhookPort,
        webhookSecret: answers.webhookSecret || undefined,
        routes,
      }

      await saveConfig(config)
      console.log(chalk.green(`  GitLab enabled (${routes.length} routes, webhook :${answers.webhookPort})`))
      console.log(chalk.dim(`  Add webhook in GitLab: ${answers.host}/<project>/-/hooks`))
      console.log(chalk.dim(`  URL: http://your-server:${answers.webhookPort}/`))
      if (answers.webhookSecret) {
        console.log(chalk.dim(`  Secret token: ${answers.webhookSecret}`))
      }
      console.log(chalk.dim("  Events: Comments, Issues, Merge requests, Pipeline"))
    }

    console.log(chalk.dim("  Restart daemon to apply: agentx daemon stop && agentx daemon start"))
    console.log()
  })

// ==================== agentx cron ====================

export const cron = new Command()
  .name("cron")
  .description("manage cron jobs — add, list, enable, disable")

cron
  .command("list")
  .alias("ls")
  .description("list cron jobs")
  .action(() => {
    const config = loadConfig()
    console.log()
    for (const [id, c] of Object.entries(config.crons || {}) as any) {
      const icon = c.enabled ? chalk.green("●") : chalk.dim("○")
      console.log(`  ${icon} ${chalk.cyan(id)} — ${c.schedule} (${c.timezone})`)
      console.log(chalk.dim(`    agent: ${c.agent} | timeout: ${c.timeout}s`))
    }
    if (!Object.keys(config.crons || {}).length) {
      console.log(chalk.dim("  No cron jobs configured"))
    }
    console.log()
  })

cron
  .command("add")
  .description("add a cron job")
  .action(async () => {
    const config = loadConfig()
    const agentIds = Object.keys(config.agents || {})

    const answers = await prompts([
      { type: "text", name: "id", message: "Job ID (kebab-case)" },
      { type: "text", name: "schedule", message: "Cron expression (e.g. '0 9 * * *')" },
      { type: "text", name: "timezone", message: "Timezone", initial: "UTC" },
      { type: "select", name: "agent", message: "Agent", choices: agentIds.map(id => ({ title: id, value: id })) },
      { type: "text", name: "prompt", message: "Task prompt" },
      { type: "number", name: "timeout", message: "Timeout (seconds)", initial: 600 },
      { type: "confirm", name: "enabled", message: "Enable now?", initial: false },
    ])

    if (!answers.id || !answers.schedule) return

    config.crons = config.crons || {}
    config.crons[answers.id] = {
      enabled: answers.enabled,
      schedule: answers.schedule,
      timezone: answers.timezone,
      agent: answers.agent,
      prompt: answers.prompt,
      timeout: answers.timeout,
      onError: ["log"],
    }

    await saveConfig(config)
    console.log(chalk.green(`  Cron "${answers.id}" added (${answers.enabled ? "enabled" : "disabled"})`))
    console.log()
  })

cron
  .command("enable <id>")
  .description("enable a cron job")
  .action(async (id) => {
    const config = loadConfig()
    if (!config.crons?.[id]) { console.log(chalk.red(`  Cron "${id}" not found`)); return }
    config.crons[id].enabled = true
    await saveConfig(config)
    console.log(chalk.green(`  Cron "${id}" enabled`))
  })

cron
  .command("disable <id>")
  .description("disable a cron job")
  .action(async (id) => {
    const config = loadConfig()
    if (!config.crons?.[id]) { console.log(chalk.red(`  Cron "${id}" not found`)); return }
    config.crons[id].enabled = false
    await saveConfig(config)
    console.log(chalk.green(`  Cron "${id}" disabled`))
  })

// ==================== agentx mesh ====================

export const mesh = new Command()
  .name("mesh")
  .description("manage mesh peers — add, list, remove")

mesh
  .command("list")
  .alias("ls")
  .description("list mesh peers")
  .action(async () => {
    const config = loadConfig()
    console.log()
    if (!config.mesh?.enabled) {
      console.log(chalk.dim("  Mesh: disabled"))
    } else {
      console.log(chalk.bold("  Mesh peers:"))
      for (const peer of config.mesh.peers || []) {
        // Try health check
        let status = chalk.red("unreachable")
        try {
          const res = await fetch(`${peer.url}/health`, { signal: AbortSignal.timeout(3000) })
          const data = await res.json() as any
          status = chalk.green(`healthy — ${data.agents?.length || 0} agents`)
        } catch {}
        console.log(`    ${chalk.cyan(peer.name)} ${chalk.dim(peer.url)} ${status}`)
      }
    }
    console.log()
  })

mesh
  .command("add")
  .description("add a mesh peer (another agentx server)")
  .action(async () => {
    const config = loadConfig()

    const answers = await prompts([
      { type: "text", name: "name", message: "Peer name (e.g. 'server-2')" },
      { type: "text", name: "url", message: "Peer URL (e.g. 'http://100.67.108.119:18800')" },
      { type: "text", name: "token", message: "Auth token (optional, press enter to skip)" },
    ])

    if (!answers.name || !answers.url) return

    // Verify connectivity
    try {
      const res = await fetch(`${answers.url}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(5000) })
      const card = await res.json() as any
      console.log(chalk.green(`  Connected: ${card.name} (${card.skills?.length || 0} agents)`))
    } catch {
      console.log(chalk.yellow("  Could not reach peer (adding anyway)"))
    }

    config.mesh = config.mesh || { enabled: false, peers: [], discovery: "static", healthCheck: { interval: 60, timeout: 10 } }
    config.mesh.enabled = true
    config.mesh.peers = config.mesh.peers || []
    config.mesh.peers.push({
      url: answers.url,
      name: answers.name,
      ...(answers.token ? { token: answers.token } : {}),
    })

    await saveConfig(config)
    console.log(chalk.green(`  Peer "${answers.name}" added`))
    console.log()
  })

mesh
  .command("remove <name>")
  .alias("rm")
  .description("remove a mesh peer")
  .action(async (name) => {
    const config = loadConfig()
    if (!config.mesh?.peers) return
    config.mesh.peers = config.mesh.peers.filter((p: any) => p.name !== name)
    if (config.mesh.peers.length === 0) config.mesh.enabled = false
    await saveConfig(config)
    console.log(chalk.green(`  Peer "${name}" removed`))
  })

// ==================== agentx skill ====================

export const skillCmd = new Command()
  .name("skill")
  .description("manage skills — add to agent(s), list")

skillCmd
  .command("add <skillPath>")
  .description("add a skill to agent(s)")
  .option("-a, --agent <agents...>", "target agent ID(s)")
  .option("--all", "add to all agents")
  .action(async (skillPath, opts) => {
    const config = loadConfig()
    const srcPath = resolve(skillPath)

    if (!existsSync(srcPath)) {
      console.log(chalk.red(`  Skill not found: ${srcPath}`))
      return
    }

    // Determine skill name
    const skillName = existsSync(join(srcPath, "SKILL.md"))
      ? srcPath.split("/").pop()!
      : srcPath.replace(/\/SKILL\.md$/, "").split("/").pop()!

    // Determine target agents
    let targets: string[]
    if (opts.all) {
      targets = Object.keys(config.agents || {})
    } else if (opts.agent) {
      targets = opts.agent
    } else {
      const agentIds = Object.keys(config.agents || {})
      const answer = await prompts({
        type: "multiselect",
        name: "agents",
        message: "Install to which agents?",
        choices: agentIds.map(id => ({ title: `${id} (${config.agents[id].name})`, value: id })),
      })
      targets = answer.agents || []
    }

    for (const agentId of targets) {
      const agent = config.agents[agentId]
      if (!agent) { console.log(chalk.yellow(`  Agent "${agentId}" not found, skipping`)); continue }

      const destDir = resolve(agent.workspace, ".claude/skills", skillName)
      mkdirSync(destDir, { recursive: true })

      if (existsSync(join(srcPath, "SKILL.md"))) {
        // Copy entire skill directory
        cpSync(srcPath, destDir, { recursive: true })
      } else if (srcPath.endsWith(".md")) {
        // Single SKILL.md file
        cpSync(srcPath, join(destDir, "SKILL.md"))
      }

      console.log(chalk.green(`  ${skillName} -> ${agentId} (${agent.workspace})`))
    }
    console.log()
  })

skillCmd
  .command("list")
  .alias("ls")
  .description("list skills per agent")
  .action(() => {
    const config = loadConfig()
    console.log()
    for (const [id, a] of Object.entries(config.agents || {}) as any) {
      const skillsDir = resolve(a.workspace, ".claude/skills")
      const skills = existsSync(skillsDir)
        ? readdirSync(skillsDir).filter((f: string) => !f.startsWith("."))
        : []
      console.log(`  ${chalk.cyan(id)}: ${skills.length ? skills.join(", ") : chalk.dim("(none)")}`)
    }
    console.log()
  })

// --- skill sync ---
// Redeploy a skill's SKILL.md from the source location to every agent
// workspace in agentx.json. Prevents stale skill copies after the source
// is updated — e.g. the wiki skill bumped from v3.0.0 → v3.1.0 in Phase 4
// but deployed copies in 25 workspaces stayed on v3.0.0 until a manual
// redeploy. Complements `skill add` (which copies one skill to selected
// workspaces) with `skill sync` (which re-copies a skill to ALL workspaces
// that already have it, or everyone if --all-workspaces).
skillCmd
  .command("sync <name>")
  .description("redeploy a skill's SKILL.md from source to agent workspaces (by default, only those that already have it)")
  .option("--source <path>", "explicit source path (defaults to src/<name>/SKILL.md or skills/<name>/SKILL.md)")
  .option("--agent <id>", "restrict to a single agent's workspace")
  .option("--all-workspaces", "also seed into workspaces that don't have the skill yet")
  .option("--dry-run", "report what would change, don't write")
  .action(async (name, opts) => {
    const { createHash } = await import("node:crypto")

    // Resolve source
    const cwd = process.cwd()
    const candidates = opts.source
      ? [opts.source]
      : [
          resolve(cwd, "src", name, "SKILL.md"),
          resolve(cwd, "skills", name, "SKILL.md"),
        ]
    const src = candidates.find(p => existsSync(p))
    if (!src) {
      console.log(chalk.red(`  No SKILL.md found for "${name}". Searched:`))
      for (const c of candidates) console.log(chalk.dim(`    ${c}`))
      return
    }
    const srcContent = readFileSync(src, "utf-8")
    const srcHash = createHash("sha256").update(srcContent).digest("hex").slice(0, 12)
    const srcVersion = (srcContent.match(/^version:\s*(.+)$/m)?.[1] || "?").trim()

    let config
    try { config = loadDaemonConfig() } catch (e: any) {
      console.log(chalk.red(`  Can't load agentx.json: ${e.message}`))
      return
    }

    const entries = Object.entries(config.agents || {}) as Array<[string, any]>
    const targets = opts.agent ? entries.filter(([id]) => id === opts.agent) : entries
    if (targets.length === 0) {
      console.log(chalk.yellow(opts.agent ? `  Agent "${opts.agent}" not in config.` : "  No agents in config."))
      return
    }

    console.log()
    console.log(chalk.bold(`  Skill sync — ${name}`))
    console.log(chalk.dim(`  Source:  ${src}`))
    console.log(chalk.dim(`  Version: ${srcVersion}  ·  hash ${srcHash}`))
    console.log(chalk.dim(`  Mode:    ${opts.dryRun ? "dry-run" : "commit"}${opts.allWorkspaces ? " · seed missing" : " · only-existing"}`))
    console.log()

    let newN = 0, updatedN = 0, unchangedN = 0, skippedN = 0
    for (const [agentId, def] of targets) {
      const ws = def.workspace as string
      if (!ws || !existsSync(ws)) {
        console.log(`  ${chalk.yellow("✗")} ${agentId.padEnd(22)} ${chalk.dim("(workspace missing: " + (ws || "undefined") + ")")}`)
        skippedN++
        continue
      }
      const dstDir = resolve(ws, ".claude/skills", name)
      const dst = resolve(dstDir, "SKILL.md")

      if (!existsSync(dst)) {
        if (!opts.allWorkspaces) {
          console.log(`  ${chalk.dim("·")} ${agentId.padEnd(22)} ${chalk.dim("(skipped — no existing copy; use --all-workspaces to seed)")}`)
          skippedN++
          continue
        }
        if (!opts.dryRun) {
          mkdirSync(dstDir, { recursive: true })
          writeFileSync(dst, srcContent)
        }
        console.log(`  ${chalk.green("+")} ${agentId.padEnd(22)} ${chalk.dim("→ seeded v" + srcVersion)}`)
        newN++
        continue
      }

      const dstContent = readFileSync(dst, "utf-8")
      const dstHash = createHash("sha256").update(dstContent).digest("hex").slice(0, 12)
      if (dstHash === srcHash) {
        console.log(`  ${chalk.dim("=")} ${agentId.padEnd(22)} ${chalk.dim("up to date (v" + srcVersion + ")")}`)
        unchangedN++
        continue
      }

      const dstVersion = (dstContent.match(/^version:\s*(.+)$/m)?.[1] || "?").trim()
      if (!opts.dryRun) writeFileSync(dst, srcContent)
      console.log(`  ${chalk.yellow("↻")} ${agentId.padEnd(22)} ${chalk.dim(`v${dstVersion} → v${srcVersion}`)}`)
      updatedN++
    }

    console.log()
    const verb = opts.dryRun ? "would" : "did"
    console.log(chalk.dim(`  Summary: ${verb} seed ${newN}, ${verb} update ${updatedN}, ${unchangedN} already current, ${skippedN} skipped.`))
    if (opts.dryRun && (newN > 0 || updatedN > 0)) {
      console.log(chalk.dim("  Dry-run — rerun without --dry-run to write."))
    }
    console.log()
  })

// --- skill audit ---
// Lint every skill against the references registry: unresolved IDs, missing
// delegate skills, raw infrastructure facts that should be cited from
// references. Exits non-zero on any FAILING — wire it into CI.
skillCmd
  .command("audit")
  .description("lint installed skills against the references registry; exits non-zero on FAILING")
  .option("--cwd <cwd>", "where to load skills from", process.cwd())
  .option(
    "--references-cwd <cwd>",
    "where to load references and recipes from (defaults to --cwd; useful when references live in the agentx repo and skills live under ~/.claude)",
  )
  .option("--json", "emit JSON instead of a human report")
  .option("--workspace <id>", "audit a single agent workspace by id (skills + references; overrides --cwd)")
  .option(
    "--all-workspaces",
    "audit every agent workspace in agentx.json; references default to the current cwd",
  )
  .action(async (opts) => {
    const { loadLocalSkills } = await import("@/agent/skills/loader")
    const { auditAll } = await import("@/agent/skills/audit")
    const { loadReferences } = await import("@/agents/references/loader")
    const { loadRecipes } = await import("@/agents/references/recipes")

    const skillsRoots: string[] = []
    if (opts.workspace) {
      const config = loadConfig()
      const agent = config.agents?.[opts.workspace]
      if (!agent) {
        console.log(chalk.red(`  Agent "${opts.workspace}" not found in agentx.json`))
        process.exit(1)
      }
      skillsRoots.push(resolve(agent.workspace))
    } else if (opts.allWorkspaces) {
      const config = loadConfig()
      for (const agent of Object.values(config.agents || {}) as any[]) {
        if (agent?.workspace) skillsRoots.push(resolve(agent.workspace))
      }
    } else {
      skillsRoots.push(resolve(opts.cwd))
    }
    const refsRoot = resolve(opts.referencesCwd || opts.cwd)

    const skillBatches = await Promise.all(skillsRoots.map(r => loadLocalSkills(r)))
    const skills = skillBatches.flat()
    const [references, recipes] = await Promise.all([
      loadReferences(refsRoot),
      loadRecipes(refsRoot),
    ])
    const results = auditAll({ skills, references, recipes })

    if (opts.json) {
      console.log(
        JSON.stringify(
          results.map(r => ({
            name: r.name,
            verdict: r.verdict,
            reasons: r.reasons,
            path: r.skill?.path,
          })),
          null,
          2,
        ),
      )
    } else {
      const summary = { PASS: 0, REVIEW: 0, FAILING: 0 }
      for (const r of results) summary[r.verdict]++
      console.log()
      for (const r of results) {
        const tag =
          r.verdict === "PASS"
            ? chalk.green("PASS   ")
            : r.verdict === "REVIEW"
              ? chalk.yellow("REVIEW ")
              : chalk.red("FAILING")
        console.log(`  ${tag} ${chalk.bold(r.name)}${r.skill?.path ? chalk.dim(` (${r.skill.path})`) : ""}`)
        for (const reason of r.reasons) console.log(`           ${chalk.dim("·")} ${reason}`)
      }
      console.log()
      console.log(
        `  ${chalk.green(`${summary.PASS} PASS`)}  ${chalk.yellow(`${summary.REVIEW} REVIEW`)}  ${chalk.red(`${summary.FAILING} FAILING`)}`,
      )
      console.log()
    }

    process.exit(results.some(r => r.verdict === "FAILING") ? 1 : 0)
  })

// ==================== agentx references ====================
//
// Operator-private fact registry. Generic to any project — Noqta runs KSI in
// .agentx/references/ksi/, the next operator runs their own clients the same
// way. The engine ships only the schema + a generic example template.

export const references = new Command()
  .name("references")
  .alias("refs")
  .description("manage the deterministic references registry — facts cited by skills and resolved into agent context")

references
  .command("init <namespace>")
  .description("scaffold .agentx/references/<namespace>/ from the example template (operator-private)")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--force", "overwrite existing files")
  .action((namespace: string, opts) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(namespace)) {
      console.log(chalk.red(`  Invalid namespace "${namespace}". Use lowercase letters, digits, and hyphens.`))
      process.exit(1)
    }
    const cwd = resolve(opts.cwd)
    const exampleRoot = resolve(cwd, "references/example")
    const exampleRecipe = resolve(cwd, "references/recipes/example.yaml")
    if (!existsSync(exampleRoot)) {
      console.log(chalk.red(`  Example template not found at ${exampleRoot}. Are you running this from the agentx repo root?`))
      process.exit(1)
    }
    const targetRoot = resolve(cwd, ".agentx/references", namespace)
    const targetRecipes = resolve(cwd, ".agentx/references/recipes")
    mkdirSync(targetRoot, { recursive: true })
    mkdirSync(targetRecipes, { recursive: true })

    const exampleFiles = readdirSync(exampleRoot).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
    let copied = 0
    let skipped = 0
    for (const file of exampleFiles) {
      const dest = join(targetRoot, file)
      if (existsSync(dest) && !opts.force) {
        console.log(chalk.dim(`  skip   ${dest} (exists; --force to overwrite)`))
        skipped++
        continue
      }
      // Re-namespace: replace `namespace: example.<x>` with `namespace: <ns>.<x>`
      const src = readFileSync(join(exampleRoot, file), "utf-8")
      const rewritten = src.replace(/^namespace:\s*example\./m, `namespace: ${namespace}.`)
      writeFileSync(dest, rewritten)
      console.log(chalk.green(`  +      ${dest}`))
      copied++
    }
    const recipeDest = join(targetRecipes, `${namespace}.yaml`)
    if (existsSync(recipeDest) && !opts.force) {
      console.log(chalk.dim(`  skip   ${recipeDest} (exists; --force to overwrite)`))
      skipped++
    } else if (existsSync(exampleRecipe)) {
      const src = readFileSync(exampleRecipe, "utf-8").replaceAll("example.", `${namespace}.`)
      writeFileSync(recipeDest, src)
      console.log(chalk.green(`  +      ${recipeDest}`))
      copied++
    }
    console.log()
    console.log(chalk.dim(`  ${copied} written, ${skipped} skipped. Edit the placeholders, then:`))
    console.log(chalk.dim(`    1. set contextReferences: true on the relevant agents in agentx.json`))
    console.log(chalk.dim(`    2. agentx skill audit  # verify references resolve`))
    console.log(chalk.dim(`    3. systemctl restart agentx  # pick up the new registry`))
    console.log()
  })

references
  .command("discover <namespace>")
  .description("scan installed skills and write detected facts to .agentx/references/<namespace>/")
  .option("--cwd <cwd>", "where to scan for skills", process.cwd())
  .option("--references-cwd <cwd>", "where to WRITE the YAML files (defaults to --cwd; useful when skills live under ~/.claude and references live in the agentx repo)")
  .option("--from <skills>", "comma-separated skill name/tag substrings to filter by (default: namespace itself)")
  .option("--gitlab-host <url>", "validate project URLs against this host (e.g. https://gitlab.noqta.tn)")
  .option("--write", "write the YAML files (default: dry-run preview)")
  .option("--force", "overwrite existing files when --write is set")
  .action(async (namespace: string, opts) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(namespace)) {
      console.log(chalk.red(`  Invalid namespace "${namespace}". Use lowercase letters, digits, and hyphens.`))
      process.exit(1)
    }
    const { loadLocalSkills } = await import("@/agent/skills/loader")
    const { discoverFromSkills, renderDiscovery } = await import("@/agents/references/discover")
    const cwd = resolve(opts.cwd)
    const filter = (opts.from
      ? String(opts.from)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : [namespace])
    const skills = await loadLocalSkills(cwd)
    const result = discoverFromSkills(skills, {
      namespace,
      filter,
      gitlabHost: opts.gitlabHost,
    })

    console.log()
    if (result.scannedSkills.length === 0) {
      console.log(chalk.yellow(`  No skills matched filter [${filter.join(", ")}] under ${cwd}`))
      console.log(chalk.dim("  Tip: pass --from <skill-name>,<other> to widen the filter."))
      console.log()
      return
    }
    console.log(chalk.dim(`  Scanned skills: ${result.scannedSkills.join(", ")}`))
    const counts = Object.fromEntries(
      Object.entries(result.byKind).map(([k, v]) => [k, v.length]),
    )
    console.log(`  Discovered:  ssh=${counts.ssh}  gitlab=${counts.gitlab}  paths=${counts.path}  contacts=${counts.contact}`)

    const files = renderDiscovery(result, namespace)
    const writeRoot = resolve(opts.referencesCwd || opts.cwd)
    const targetDir = resolve(writeRoot, ".agentx/references", namespace)

    if (!opts.write) {
      console.log()
      console.log(chalk.dim(`  Dry-run — would write to ${targetDir}/`))
      for (const [name, content] of Object.entries(files)) {
        console.log(chalk.cyan(`\n  --- ${name} ---`))
        console.log(content.split("\n").slice(0, 30).map(l => `    ${l}`).join("\n"))
        if (content.split("\n").length > 30) console.log(chalk.dim(`    … (${content.split("\n").length - 30} more lines truncated in preview)`))
      }
      console.log()
      console.log(chalk.dim(`  Re-run with --write to commit these to ${targetDir}/`))
      console.log()
      return
    }

    mkdirSync(targetDir, { recursive: true })
    let written = 0
    let skipped = 0
    for (const [name, content] of Object.entries(files)) {
      const dest = join(targetDir, name)
      if (existsSync(dest) && !opts.force) {
        console.log(chalk.dim(`  skip   ${dest} (exists; --force to overwrite)`))
        skipped++
        continue
      }
      writeFileSync(dest, content)
      console.log(chalk.green(`  +      ${dest}`))
      written++
    }
    console.log()
    console.log(chalk.dim(`  ${written} written, ${skipped} skipped. Review every card — flagged ones (tags include "needs-review") are best-effort guesses.`))
    console.log(chalk.dim(`  Then: agentx skill audit  →  set contextReferences: true on the relevant agents  →  systemctl restart agentx`))
    console.log()
  })

references
  .command("list")
  .alias("ls")
  .description("list every loaded reference (debug)")
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--json", "emit JSON")
  .action(async (opts) => {
    const { loadReferences } = await import("@/agents/references/loader")
    const idx = await loadReferences(resolve(opts.cwd))
    const cards = [...idx.byId.values()].sort((a, b) => a.id.localeCompare(b.id))
    if (opts.json) {
      console.log(JSON.stringify(cards, null, 2))
      return
    }
    console.log()
    if (cards.length === 0) {
      console.log(chalk.dim("  (no references loaded — try `agentx references init <namespace>`)"))
      console.log()
      return
    }
    for (const card of cards) {
      const src = idx.sourceById.get(card.id)
      console.log(`  ${chalk.cyan(card.id)} ${chalk.dim(`(${card.kind})`)}`)
      console.log(`    ${card.summary}`)
      if (src) console.log(chalk.dim(`    ${src}`))
    }
    console.log()
    console.log(chalk.dim(`  ${cards.length} reference(s) loaded.`))
    console.log()
  })

// ==================== agentx hook ====================

export const hook = new Command()
  .name("hook")
  .description("manage hooks — add to agent workspace")

hook
  .command("add <agent>")
  .description("add a hook to an agent's workspace settings")
  .action(async (agentId) => {
    const config = loadConfig()
    const agent = config.agents?.[agentId]
    if (!agent) { console.log(chalk.red(`  Agent "${agentId}" not found`)); return }

    const settingsPath = resolve(agent.workspace, ".claude/settings.json")
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {}

    const answers = await prompts([
      { type: "select", name: "event", message: "Hook event", choices: [
        { title: "PreToolUse — before any tool runs", value: "PreToolUse" },
        { title: "PostToolUse — after any tool runs", value: "PostToolUse" },
        { title: "SessionStart — when session begins", value: "SessionStart" },
        { title: "Notification — on notifications", value: "Notification" },
        { title: "Stop — before session stops", value: "Stop" },
      ]},
      { type: "select", name: "type", message: "Hook type", choices: [
        { title: "command — run a shell command", value: "command" },
        { title: "http — POST to a URL", value: "http" },
      ]},
      { type: "text", name: "value", message: (prev: any) => prev === "command" ? "Shell command" : "URL" },
      { type: "text", name: "matcher", message: "Matcher regex (optional, e.g. 'Bash' to match tool)" },
    ])

    if (!answers.event || !answers.value) return

    settings.hooks = settings.hooks || {}
    settings.hooks[answers.event] = settings.hooks[answers.event] || []

    const hookDef: any = {
      type: answers.type,
      ...(answers.type === "command" ? { command: answers.value } : { url: answers.value }),
    }

    const entry: any = { hooks: [hookDef] }
    if (answers.matcher) entry.matcher = answers.matcher

    settings.hooks[answers.event].push(entry)

    mkdirSync(resolve(agent.workspace, ".claude"), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    console.log(chalk.green(`  Hook added to ${agentId}: ${answers.event} -> ${answers.type}`))
    console.log()
  })

// ==================== agentx migrate ====================

export const migrate = new Command()
  .name("migrate")
  .description("import configuration from OpenClaw or other tools")

migrate
  .command("openclaw [configPath]")
  .description("import agents, channels, and crons from OpenClaw config")
  .option("--dry-run", "show what would be imported without writing")
  .action(async (configPath, opts) => {
    // Find OpenClaw config
    const searchPaths = [
      configPath,
      resolve(process.env.HOME || "", ".openclaw/openclaw.json"),
      resolve(process.env.HOME || "", ".openclaw/clawdbot.json"),
    ].filter(Boolean)

    let ocPath: string | undefined
    for (const p of searchPaths) {
      if (p && existsSync(p)) { ocPath = p; break }
    }

    if (!ocPath) {
      console.log(chalk.red("  OpenClaw config not found. Pass the path: agentx migrate openclaw /path/to/config.json"))
      return
    }

    console.log(chalk.dim(`  Reading: ${ocPath}`))
    const oc = JSON.parse(readFileSync(ocPath, "utf-8"))

    const config = existsSync(resolve(process.cwd(), "agentx.json"))
      ? loadConfig()
      : { node: { id: "imported", name: "Imported", bind: "127.0.0.1:18800" }, providers: {}, agents: {}, channels: { telegram: { enabled: false, accounts: {}, policy: { dm: "pair", group: "mention-required" } }, whatsapp: { enabled: false } }, crons: {}, mesh: { enabled: false, peers: [] } }

    // Import agents
    const agents = oc.agents?.list || []
    const bindings = oc.bindings || []
    const bindMap: Record<string, string> = {}
    for (const b of bindings) {
      if (b.match?.channel === "telegram") {
        bindMap[b.match.accountId] = b.agentId
      }
    }
    // Default account -> main agent
    if (agents.find((a: any) => a.id === "main" || a.default)) {
      bindMap["default"] = "main"
    }

    let agentCount = 0
    for (const a of agents) {
      if (a.workspace?.startsWith("/data")) continue // skip remote devices

      const axId = a.id.replace(/-agent$/, "").replace(/^main$/, "main-agent")
      const mentions = a.groupChat?.mentionPatterns || []
      if (!mentions.some((m: string) => m === axId)) mentions.push(axId)

      config.agents[axId] = {
        name: a.name,
        workspace: a.workspace,
        tier: "claude-code",
        model: "claude-sonnet-4-6",
        mentions,
        maxConcurrent: a.id === "main" ? 2 : 1,
        systemPrompt: `You are ${a.name} on AgentX.`,
        permissionMode: "bypassPermissions",
      }
      agentCount++

      if (!opts.dryRun) {
        mkdirSync(resolve(a.workspace, ".claude/skills"), { recursive: true })
        // Set up workspace with Claude Code best practices
        const { setupWorkspace } = await import("@/agents/workspace-setup")
        setupWorkspace(axId, config.agents[axId] as any)
      }
    }
    console.log(`  ${chalk.green(agentCount)} agents imported (workspaces set up with Claude Code best practices)`)

    // Import Telegram accounts
    const tgAccounts = oc.channels?.telegram?.accounts || {}
    let tgCount = 0
    for (const [name, acc] of Object.entries(tgAccounts) as any) {
      if (!acc.botToken) continue
      const boundAgent = bindMap[name]
      const axAgentId = boundAgent?.replace(/-agent$/, "").replace(/^main$/, "main-agent") || "default"

      config.channels.telegram.accounts[name] = {
        token: acc.botToken,
        agentBinding: axAgentId,
      }
      config.channels.telegram.enabled = true
      tgCount++
    }
    console.log(`  ${chalk.green(tgCount)} Telegram accounts imported`)

    // Import cron jobs (from separate file if exists)
    const cronPath = resolve(ocPath, "../cron/jobs.json")
    if (existsSync(cronPath)) {
      const cronData = JSON.parse(readFileSync(cronPath, "utf-8"))
      let cronCount = 0
      for (const job of cronData.jobs || []) {
        const axId = job.name || job.id
        const agentId = job.agentId?.replace(/-agent$/, "").replace(/^main$/, "main-agent") || "default"
        config.crons[axId] = {
          enabled: job.enabled || false,
          schedule: job.schedule?.expr || "0 9 * * *",
          timezone: job.schedule?.tz || "UTC",
          agent: agentId,
          prompt: job.payload?.message || "",
          timeout: job.payload?.timeoutSeconds || 600,
          onError: ["log"],
        }
        cronCount++
      }
      console.log(`  ${chalk.green(cronCount)} cron jobs imported`)
    }

    if (opts.dryRun) {
      console.log(chalk.yellow("\n  Dry run — nothing written"))
      console.log(JSON.stringify(config, null, 2))
    } else {
      await saveConfig(config)
      console.log(chalk.green("\n  Migration complete! Review agentx.json and run: agentx daemon start"))
    }
    console.log()
  })

// ==================== agentx config ====================

export const configCmd = new Command()
  .name("config")
  .description("validate and inspect configuration")

configCmd
  .command("check")
  .description("validate agentx.json and check all workspaces")
  .option("-c, --config <path>", "path to agentx.json")
  .action(async (opts) => {
    console.log()
    try {
      const config = loadDaemonConfig(opts.config)
      console.log(chalk.green("  ✓ Config valid"))
      console.log(chalk.dim(`    Node: ${config.node.name} (${config.node.id})`))
      console.log(chalk.dim(`    Bind: ${config.node.bind}`))
      console.log(chalk.dim(`    Agents: ${Object.keys(config.agents).length}`))
      console.log(chalk.dim(`    Crons: ${Object.keys(config.crons).length}`))
      console.log(chalk.dim(`    Mesh peers: ${config.mesh.peers.length}`))

      // Channels
      const tgAccounts = Object.keys(config.channels.telegram.accounts).length
      console.log(chalk.dim(`    Telegram: ${config.channels.telegram.enabled ? `${tgAccounts} accounts` : "disabled"}`))
      console.log(chalk.dim(`    WhatsApp: ${config.channels.whatsapp.enabled ? `${config.channels.whatsapp.routes.length} routes` : "disabled"}`))
      console.log(chalk.dim(`    Discord: ${config.channels.discord?.enabled ? "enabled" : "disabled"}`))

      // Warnings
      const warnings = validateWorkspaces(config)
      if (warnings.length) {
        console.log()
        console.log(chalk.yellow("  Warnings:"))
        for (const w of warnings) {
          console.log(chalk.yellow(`    ⚠ ${w}`))
        }
      } else {
        console.log(chalk.green("  ✓ All workspaces valid"))
      }

      // Check agent workspaces
      console.log()
      for (const [id, agent] of Object.entries(config.agents)) {
        const ws = agent.workspace
        const hasClaudeDir = existsSync(resolve(ws, ".claude"))
        const hasClaudeMd = existsSync(resolve(ws, "CLAUDE.md"))
        const hasSettings = existsSync(resolve(ws, ".claude/settings.json"))
        const skillCount = existsSync(resolve(ws, ".claude/skills"))
          ? readdirSync(resolve(ws, ".claude/skills")).filter(f => !f.startsWith(".")).length
          : 0

        const checks = [
          hasClaudeDir ? chalk.green("✓") : chalk.red("✗"),
          ".claude",
          hasClaudeMd ? chalk.green("✓") : chalk.yellow("○"),
          "CLAUDE.md",
          hasSettings ? chalk.green("✓") : chalk.yellow("○"),
          "settings",
          `${skillCount} skills`,
        ]
        console.log(`  ${chalk.cyan(id)}: ${checks.join(" ")}`)
      }
    } catch (e: any) {
      console.log(chalk.red(`  ✗ ${e.message}`))
    }
    console.log()
  })

configCmd
  .command("show")
  .description("print the resolved configuration")
  .option("-c, --config <path>", "path to agentx.json")
  .action((opts) => {
    try {
      const config = loadDaemonConfig(opts.config)
      console.log(JSON.stringify(config, null, 2))
    } catch (e: any) {
      console.log(chalk.red(e.message))
    }
  })

// --- config get/set/unset — dot-path edits with Zod validation + hot-reload ---

function parseValue(raw: string, asString: boolean): unknown {
  if (asString) return raw
  // Try JSON first — handles numbers, booleans, arrays, objects, quoted strings.
  try { return JSON.parse(raw) } catch { /* fall through */ }
  // Treat "a,b,c" as an array of trimmed strings (common shorthand).
  if (raw.includes(",") && !raw.includes(" ")) {
    return raw.split(",").map(s => s.trim()).filter(Boolean)
  }
  return raw
}

function formatValue(v: unknown): string {
  if (v === undefined) return chalk.dim("(unset)")
  if (typeof v === "string") return v
  return JSON.stringify(v, null, 2)
}

configCmd
  .command("get <path>")
  .description("read a config value by dot-path (e.g. agents.devops.model)")
  .option("-c, --config <path>", "path to agentx.json")
  .option("--raw", "show ${VAR} tokens instead of env-expanded values")
  .option("--json", "output as JSON (for scripting)")
  .action(async (path: string, opts) => {
    const { readFileSync, existsSync } = await import("fs")
    const { resolve } = await import("path")
    const { getAtPath } = await import("@/daemon/config-mutator")
    const { expandEnvVars } = await import("@/daemon/config")

    const cfgPath = opts.config || resolve(process.cwd(), "agentx.json")
    if (!existsSync(cfgPath)) {
      console.log(chalk.red(`  No config at ${cfgPath}`))
      process.exit(1)
    }
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8"))
    const source = opts.raw ? raw : expandEnvVars(raw)
    const value = getAtPath(source, path)
    if (opts.json) {
      console.log(JSON.stringify(value))
    } else {
      console.log(formatValue(value))
    }
  })

configCmd
  .command("set <path> <value>")
  .description("write a config value by dot-path; validates against schema and hot-reloads the daemon")
  .option("-c, --config <path>", "path to agentx.json")
  .option("--string", "treat the value as a literal string (skip JSON parsing)")
  .option("--dry-run", "validate and diff without writing")
  .action(async (path: string, value: string, opts) => {
    const { applyConfigMutation, setAtPath, getAtPath } = await import("@/daemon/config-mutator")
    const parsed = parseValue(value, !!opts.string)

    const result = await applyConfigMutation((cfg) => {
      setAtPath(cfg, path, parsed)
    }, { configPath: opts.config, dryRun: !!opts.dryRun })

    if (!result.success) {
      console.log(chalk.red(`  ✗ ${result.error}`))
      process.exit(1)
    }

    const written = getAtPath(result.after, path)
    if (opts.dryRun) {
      console.log(chalk.yellow(`  (dry-run) ${chalk.cyan(path)} would become: ${formatValue(written)}`))
    } else {
      console.log(chalk.green(`  ✓ ${chalk.cyan(path)} = ${formatValue(written)}`))
      if (result.reloaded) {
        console.log(chalk.dim("    Daemon hot-reloaded."))
      } else if (result.reloadSkipped && !/ECONNREFUSED|unreachable|fetch failed/i.test(result.reloadSkipped)) {
        console.log(chalk.dim(`    (daemon reload skipped: ${result.reloadSkipped})`))
      }
    }
  })

configCmd
  .command("unset <path>")
  .description("remove a config value by dot-path (validates + hot-reloads)")
  .option("-c, --config <path>", "path to agentx.json")
  .option("--dry-run", "validate without writing")
  .action(async (path: string, opts) => {
    const { applyConfigMutation, getAtPath, unsetAtPath } = await import("@/daemon/config-mutator")

    const result = await applyConfigMutation((cfg) => {
      if (getAtPath(cfg, path) === undefined) {
        // No-op — still succeeds, writes nothing meaningful, but keeps the
        // caller's flow consistent.
        return
      }
      unsetAtPath(cfg, path)
    }, { configPath: opts.config, dryRun: !!opts.dryRun })

    if (!result.success) {
      console.log(chalk.red(`  ✗ ${result.error}`))
      process.exit(1)
    }

    const stillThere = getAtPath(result.after, path)
    if (stillThere !== undefined) {
      console.log(chalk.dim(`  (no-op) ${chalk.cyan(path)} was not set`))
      return
    }

    if (opts.dryRun) {
      console.log(chalk.yellow(`  (dry-run) ${chalk.cyan(path)} would be removed`))
    } else {
      console.log(chalk.green(`  ✓ ${chalk.cyan(path)} removed`))
      if (result.reloaded) {
        console.log(chalk.dim("    Daemon hot-reloaded."))
      }
    }
  })

// --- agentx config governance ---
//
// Read-only view of the governance flags that admit dispatches into the
// ledger pipeline. v1 is read-only because every flag is read once at
// daemon startup; flipping in place would require restart anyway. The
// view answers the question operators ask first when something doesn't
// dispatch: "is governance even enabled, and at what level?"

configCmd
  .command("governance")
  .description("show resolved governance flags (read-only; flags read once at startup)")
  .option("-c, --config <path>", "path to agentx.json")
  .option("--json", "emit JSON")
  .action((opts) => {
    let businessEnabled = false
    let projectsCount = 0
    let configError: string | undefined
    try {
      const cfg = loadDaemonConfig(opts.config)
      businessEnabled = !!(cfg as any).business?.enabled
      projectsCount = ((cfg as any).business?.projects ?? []).length
    } catch (e: any) {
      configError = e?.message ?? String(e)
    }

    const ledgerMode = (process.env.INTENT_LEDGER_MODE || "off").toLowerCase()
    const pmGateRaw = (process.env.INTENT_PM_GATE_ENABLED || "").toLowerCase()
    const pmGate = pmGateRaw === "true" || pmGateRaw === "1" || pmGateRaw === "yes"
    const pmGateActive = pmGate && businessEnabled
    const ledgerValid = ["off", "shadow", "authoritative"].includes(ledgerMode)

    if (opts.json) {
      console.log(JSON.stringify({
        ledger: { mode: ledgerMode, valid: ledgerValid },
        pmGate: {
          envSet: pmGate,
          businessEnabled,
          active: pmGateActive,
          projects: projectsCount,
        },
        configError,
      }, null, 2))
      return
    }

    console.log()
    console.log(chalk.bold("  Governance flags"))
    console.log()
    if (configError) {
      console.log(chalk.yellow(`  Note: agentx.json couldn't be loaded — ${configError}`))
      console.log()
    }

    const modeColor = ledgerMode === "authoritative" ? chalk.green
      : ledgerMode === "shadow" ? chalk.cyan
      : ledgerMode === "off" ? chalk.dim
      : chalk.red
    console.log(`  INTENT_LEDGER_MODE        ${modeColor(ledgerMode)}${ledgerValid ? "" : chalk.red(" (invalid — must be off|shadow|authoritative)")}`)

    const pmStatus = pmGateActive
      ? chalk.green("active")
      : pmGate
        ? chalk.yellow("env=true but business.enabled=false → inactive")
        : chalk.dim("disabled")
    console.log(`  INTENT_PM_GATE_ENABLED    ${pmStatus}`)
    console.log(chalk.dim(`    business.enabled        ${businessEnabled ? chalk.green("true") : chalk.dim("false")}`))
    console.log(chalk.dim(`    business.projects[]     ${projectsCount}`))

    console.log()
    console.log(chalk.dim("  These flags are read once at daemon startup. Flipping requires a restart."))
    console.log(chalk.dim("  See: https://github.com/anis-marrouchi/agentx/blob/master/docs/architecture/research-rescue-plan.md"))
    console.log()
  })
