import { Command } from "commander"
import chalk from "chalk"
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs"
import { resolve, join } from "path"

// --- agentx init: interactive setup for new installations ---

export const init = new Command()
  .name("init")
  .description("initialize agentx configuration in the current directory")
  .option("--force", "overwrite existing config")
  .action(async (opts) => {
    const cwd = process.cwd()
    const configPath = resolve(cwd, "agentx.json")
    const envPath = resolve(cwd, ".env")
    const sessionsDir = resolve(cwd, ".agentx/sessions")

    console.log()
    console.log(chalk.bold("  agentx init"))
    console.log()

    // Check existing config
    if (existsSync(configPath) && !opts.force) {
      console.log(chalk.yellow(`  agentx.json already exists. Use --force to overwrite.`))
      console.log()
      return
    }

    // Find example config
    const examplePaths = [
      resolve(cwd, "agentx.example.json"),
      resolve(cwd, "node_modules/agentix-cli/agentx.example.json"),
    ]

    let example: string | undefined
    for (const p of examplePaths) {
      if (existsSync(p)) {
        example = readFileSync(p, "utf-8")
        break
      }
    }

    if (!example) {
      // Generate minimal config
      example = JSON.stringify({
        node: {
          id: require("os").hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
          name: require("os").hostname(),
          bind: "127.0.0.1:18800",
        },
        providers: {
          claude: { apiKey: "${ANTHROPIC_API_KEY}" },
        },
        agents: {
          assistant: {
            name: "Assistant",
            workspace: cwd,
            tier: "claude-code",
            model: "claude-sonnet-4-6",
            mentions: ["@assistant", "assistant"],
            maxConcurrent: 2,
            systemPrompt: "You are a helpful assistant.",
            permissionMode: "default",
          },
        },
        channels: {
          telegram: {
            enabled: false,
            accounts: {},
            policy: { dm: "pair", group: "mention-required" },
          },
          whatsapp: { enabled: false },
        },
        crons: {},
        mesh: {
          enabled: false,
          peers: [],
          discovery: "static",
          healthCheck: { interval: 60, timeout: 10 },
        },
      }, null, 2)
    }

    // Write config
    writeFileSync(configPath, example)
    console.log(chalk.green(`  ✓ Created agentx.json`))

    // Create .env template
    if (!existsSync(envPath)) {
      writeFileSync(envPath, [
        "# AgentX environment variables",
        "# ANTHROPIC_API_KEY=sk-ant-...",
        "# TG_BOT_TOKEN=123456:ABC...",
        "# MESH_TOKEN=your-mesh-secret",
        "",
      ].join("\n"))
      console.log(chalk.green(`  ✓ Created .env template`))
    }

    // Create session dir
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true })
      console.log(chalk.green(`  ✓ Created .agentx/sessions/`))
    }

    // Create workspace .claude dir
    const claudeDir = resolve(cwd, ".claude")
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true })
      console.log(chalk.green(`  ✓ Created .claude/`))
    }

    console.log()
    console.log(chalk.bold("  Next steps:"))
    console.log(`    1. Edit ${chalk.cyan("agentx.json")} — configure agents, channels, crons`)
    console.log(`    2. Edit ${chalk.cyan(".env")} — add API keys and bot tokens`)
    console.log(`    3. Run  ${chalk.cyan("agentx daemon start")} — start the daemon`)
    console.log(`    4. Run  ${chalk.cyan("agentx daemon status")} — verify everything`)
    console.log()
  })
