import { Command } from "commander"
import chalk from "chalk"
import prompts from "prompts"
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync } from "fs"
import { resolve, join } from "path"
import { loadDaemonConfig, validateWorkspaces } from "@/daemon/config"

// --- agentx agent/channel/cron/mesh/skill/hook management commands ---

function loadConfig(): any {
  const p = resolve(process.cwd(), "agentx.json")
  if (!existsSync(p)) throw new Error("No agentx.json found. Run: agentx init")
  return JSON.parse(readFileSync(p, "utf-8"))
}

function saveConfig(config: any): void {
  writeFileSync(resolve(process.cwd(), "agentx.json"), JSON.stringify(config, null, 2))
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

    saveConfig(config)
    console.log(chalk.green(`\n  Agent "${answers.id}" added`))
    console.log(chalk.dim(`  Workspace: ${ws}`))
    console.log(chalk.dim(`  Created: ${setup.created.length} files (CLAUDE.md, AGENTS.md, settings, rules)`))
    console.log()
  })

agent
  .command("remove <id>")
  .alias("rm")
  .description("remove an agent from config (keeps workspace)")
  .action((id) => {
    const config = loadConfig()
    if (!config.agents?.[id]) {
      console.log(chalk.red(`  Agent "${id}" not found`))
      return
    }
    delete config.agents[id]
    saveConfig(config)
    console.log(chalk.green(`  Agent "${id}" removed from config (workspace preserved)`))
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

      saveConfig(config)
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

      saveConfig(config)
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

      saveConfig(config)
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

      saveConfig(config)
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

    saveConfig(config)
    console.log(chalk.green(`  Cron "${answers.id}" added (${answers.enabled ? "enabled" : "disabled"})`))
    console.log()
  })

cron
  .command("enable <id>")
  .description("enable a cron job")
  .action((id) => {
    const config = loadConfig()
    if (!config.crons?.[id]) { console.log(chalk.red(`  Cron "${id}" not found`)); return }
    config.crons[id].enabled = true
    saveConfig(config)
    console.log(chalk.green(`  Cron "${id}" enabled`))
  })

cron
  .command("disable <id>")
  .description("disable a cron job")
  .action((id) => {
    const config = loadConfig()
    if (!config.crons?.[id]) { console.log(chalk.red(`  Cron "${id}" not found`)); return }
    config.crons[id].enabled = false
    saveConfig(config)
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

    saveConfig(config)
    console.log(chalk.green(`  Peer "${answers.name}" added`))
    console.log()
  })

mesh
  .command("remove <name>")
  .alias("rm")
  .description("remove a mesh peer")
  .action((name) => {
    const config = loadConfig()
    if (!config.mesh?.peers) return
    config.mesh.peers = config.mesh.peers.filter((p: any) => p.name !== name)
    if (config.mesh.peers.length === 0) config.mesh.enabled = false
    saveConfig(config)
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
      saveConfig(config)
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
