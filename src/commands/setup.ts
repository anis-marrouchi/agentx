import { Command } from "commander"
import chalk from "chalk"
import { spawn } from "child_process"
import { existsSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import { wizardState } from "@/daemon/setup-wizard"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx setup: launch the web setup wizard ---
//
// The wizard itself is a web form served by the board-dashboard process (on
// port 4202). This command starts that process (if it isn't already running)
// and opens the wizard URL in the user's default browser — zero CLI prompts.

export const setup = new Command()
  .name("setup")
  .description("open the web setup wizard to create or extend your AgentX install")
  .option("--port <n>", "dashboard port (default: from agentx.json, else 4202)")
  .option("--no-open", "don't try to open the browser")
  .action(async (opts) => {
    const state = wizardState()
    const port = opts.port ? parseInt(opts.port, 10) : resolveDashboardPort()
    const url = `http://127.0.0.1:${port}/setup`

    console.log()
    if (state.configExists) {
      console.log(chalk.dim(`  Found agentx.json — the wizard will extend your current install.`))
    } else {
      console.log(chalk.dim(`  No agentx.json yet — the wizard will create one.`))
    }
    console.log(chalk.bold(`  Opening ${url}`))
    console.log()

    // If the board server isn't already listening, start it in the background.
    const alreadyUp = await probe(url).catch(() => false)
    if (!alreadyUp) {
      console.log(chalk.dim(`  Starting dashboard server on port ${port} (Ctrl-C to quit)…`))
      const cli = resolveCliEntry()
      const child = spawn(process.execPath, [cli, "board", "serve", "--port", String(port)], {
        stdio: "inherit",
        detached: false,
      })
      // Give the server a beat to bind before opening the browser.
      await new Promise((ok) => setTimeout(ok, 1200))
      if (opts.open !== false) openBrowser(url)
      // Stay attached so the user sees the server logs.
      await new Promise<void>((ok) => child.on("exit", () => ok()))
    } else {
      console.log(chalk.dim(`  Dashboard is already running.`))
      if (opts.open !== false) openBrowser(url)
    }
  })

function resolveDashboardPort(): number {
  try {
    const cfg = loadDaemonConfig()
    return cfg.dashboard.port || 4202
  } catch {
    return 4202
  }
}

function resolveCliEntry(): string {
  // When installed via npm, this module runs from dist/; cli.js sits beside it.
  // The bundle is ESM, so CommonJS __dirname is not defined.
  // In dev, we fall back to the current script so `tsx` works too.
  const candidate = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js")
  return existsSync(candidate) ? candidate : (process.argv[1] || candidate)
}

async function probe(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "GET" })
    return r.ok || r.status === 302
  } catch { return false }
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open"
  try {
    // spawn() reports a missing binary (ENOENT) via an async "error" event on
    // the child, NOT a synchronous throw — so the try/catch alone wouldn't
    // catch it. Headless Linux servers commonly lack xdg-open; without the
    // listener the unhandled error propagates and kills the wizard process.
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true })
    child.once("error", () => {
      console.log(chalk.dim(`  Couldn't auto-open the browser. Visit ${url} manually.`))
    })
    child.unref()
  } catch {
    console.log(chalk.dim(`  Couldn't auto-open the browser. Visit ${url} manually.`))
  }
}
