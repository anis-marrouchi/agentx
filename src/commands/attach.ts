import { Command } from "commander"
import chalk from "chalk"
import {
  installAttachHooks,
  uninstallAttachHooks,
  attachHooksInstalled,
  userSettingsPath,
  configuredDaemonPort,
} from "@/attach/install"
import { DELIVERY_MODES, isDeliveryMode, type AttachSession, type DeliveryMode } from "@/attach"

// --- agentx attach ---
//
// Wear an agentx identity in the Claude Code session you already have open.
//
// Normally the daemon spawns a `claude` subprocess per task. Attach inverts
// that: this session registers as the agent, and channel messages addressed
// to it are queued here instead of spawning anything. agentx keeps doing what
// it is actually good at — identity, routing, memory, guard, channels — and
// the loop is the one you are already typing into.
//
// Binding is a runtime operation against the daemon. The hooks (installed
// once, at user scope) are dumb pipes that ask the daemon on every event, so
// attach/detach takes effect immediately with no file edits and no restart.

export const attach = new Command()
  .name("attach")
  .description("wear an agentx agent identity in this Claude Code session")

const DEFAULT_URL =
  process.env.AGENTX_DAEMON_URL || `http://127.0.0.1:${configuredDaemonPort()}`

/** Claude Code exports its session id into the shell of every Bash tool call.
 *  That is what lets `agentx attach` bind the exact session it is running
 *  inside rather than guessing from cwd. It is undocumented, so `--session`
 *  stays available and the error text explains the fallback. */
function currentSessionId(explicit?: string): string | undefined {
  return explicit || process.env.CLAUDE_CODE_SESSION_ID || undefined
}

async function api(url: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${url}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) throw new Error(json?.error || text || `HTTP ${res.status}`)
  return json
}

function daemonHint(e: unknown): string {
  const msg = (e as any)?.message ?? String(e)
  if (/ECONNREFUSED|fetch failed/i.test(msg)) {
    return `daemon not reachable — start it with ${chalk.cyan("agentx daemon start")}`
  }
  return msg
}

function modeColor(m: DeliveryMode): (s: string) => string {
  if (m === "auto") return chalk.yellow
  if (m === "manual") return chalk.gray
  return chalk.green
}

function printSession(s: AttachSession & { pending?: number }, mark = false): void {
  const who = s.agentIds.length ? s.agentIds.join(", ") : chalk.gray("(not bound)")
  const pending = s.pending ? chalk.yellow(`${s.pending} pending`) : chalk.gray("empty")
  const here = mark ? chalk.cyan(" ← this session") : ""
  console.log(
    `  ${chalk.bold(who)}  ${modeColor(s.mode)(s.mode)}  ${pending}  ${chalk.gray(s.sessionId)}${here}`,
  )
  if (s.cwd) console.log(`    ${chalk.gray(s.cwd)}`)
}

// ---------------------------------------------------------------------------
// agentx attach <agent>   — bind this session
// ---------------------------------------------------------------------------
attach
  .command("as <agent>", { isDefault: true })
  .description("bind this Claude Code session to an agent identity")
  .option("-m, --mode <mode>", `delivery mode: ${DELIVERY_MODES.join(" | ")}`, "notify")
  .option("--session <id>", "Claude Code session id (defaults to $CLAUDE_CODE_SESSION_ID)")
  .option("--url <url>", "daemon base url", DEFAULT_URL)
  .action(async (agent: string, opts) => {
    const sessionId = currentSessionId(opts.session)
    if (!sessionId) {
      console.error(chalk.red("Could not determine the Claude Code session id."))
      console.error(
        `Run this inside a Claude Code session, or pass ${chalk.cyan("--session <id>")} ` +
          `(list them with ${chalk.cyan("agentx attach list")}).`,
      )
      process.exit(1)
    }
    if (!isDeliveryMode(opts.mode)) {
      console.error(chalk.red(`Invalid mode "${opts.mode}". Expected one of: ${DELIVERY_MODES.join(", ")}`))
      process.exit(1)
    }

    if (!attachHooksInstalled()) {
      console.error(chalk.yellow("Attach hooks are not installed yet."))
      console.error(`Run ${chalk.cyan("agentx attach install")} once, then try again.`)
      process.exit(1)
    }

    try {
      const r = await api(opts.url, "/attach/bind", {
        sessionId,
        agentId: agent,
        mode: opts.mode,
        cwd: process.cwd(),
      })
      console.log(
        `${chalk.green("✓")} This session is now wearing ${chalk.bold(agent)} ` +
          `(${modeColor(opts.mode)(opts.mode)}).`,
      )
      const pending = Number(r?.pending ?? 0)
      if (pending > 0) {
        console.log(chalk.yellow(`  ${pending} message(s) already queued for it.`))
      }
      console.log(
        chalk.gray(
          opts.mode === "auto"
            ? "  Queued messages will be answered automatically at the end of each turn."
            : opts.mode === "notify"
              ? "  You'll be told when messages arrive; run /inbox to answer them."
              : "  Nothing will interrupt you; run /inbox to check for messages.",
        ),
      )
    } catch (e) {
      console.error(chalk.red(`Bind failed: ${daemonHint(e)}`))
      process.exit(1)
    }
  })

// ---------------------------------------------------------------------------
// agentx attach detach
// ---------------------------------------------------------------------------
attach
  .command("detach")
  .description("stop wearing an identity in this session (queued work falls back to spawned agents)")
  .option("--agent <id>", "release only this identity (default: all)")
  .option("--session <id>", "Claude Code session id (defaults to $CLAUDE_CODE_SESSION_ID)")
  .option("--url <url>", "daemon base url", DEFAULT_URL)
  .action(async (opts) => {
    const sessionId = currentSessionId(opts.session)
    if (!sessionId) {
      console.error(chalk.red("Could not determine the Claude Code session id. Pass --session <id>."))
      process.exit(1)
    }
    try {
      await api(opts.url, "/attach/detach", { sessionId, agentId: opts.agent })
      console.log(`${chalk.green("✓")} Detached. New messages will spawn agents the normal way.`)
    } catch (e) {
      console.error(chalk.red(`Detach failed: ${daemonHint(e)}`))
      process.exit(1)
    }
  })

// ---------------------------------------------------------------------------
// agentx attach list / status
// ---------------------------------------------------------------------------
attach
  .command("list")
  .alias("status")
  .description("show every attached session on this machine")
  .option("--url <url>", "daemon base url", DEFAULT_URL)
  .option("--json", "raw JSON output")
  .action(async (opts) => {
    const here = currentSessionId()
    try {
      const r = await api(opts.url, "/attach/sessions")
      const sessions: Array<AttachSession & { pending: number }> = r?.sessions ?? []
      if (opts.json) {
        console.log(JSON.stringify({ hooksInstalled: attachHooksInstalled(), sessions }, null, 2))
        return
      }

      console.log()
      console.log(
        attachHooksInstalled()
          ? `${chalk.green("✓")} Attach hooks installed  ${chalk.gray(userSettingsPath())}`
          : `${chalk.yellow("!")} Attach hooks not installed — run ${chalk.cyan("agentx attach install")}`,
      )
      console.log()

      const bound = sessions.filter((s) => s.agentIds.length > 0)
      if (bound.length === 0) {
        console.log(chalk.gray("  No session is wearing an identity right now."))
      } else {
        for (const s of bound) printSession(s, s.sessionId === here)
      }
      const idle = sessions.length - bound.length
      if (idle > 0) console.log(chalk.gray(`\n  ${idle} registered session(s) with no binding.`))
      console.log()
    } catch (e) {
      console.error(chalk.red(`Could not read attach state: ${daemonHint(e)}`))
      process.exit(1)
    }
  })

// ---------------------------------------------------------------------------
// agentx attach install / uninstall
// ---------------------------------------------------------------------------
attach
  .command("install")
  .description("wire the attach hooks into ~/.claude/settings.json (one time, all sessions)")
  .option("--port <n>", "daemon port the hooks should call (default: node.bind in agentx.json)")
  .option("--path <file>", "settings file to patch (default: ~/.claude/settings.json)")
  .option("--no-guard", "skip the PreToolUse guard hook (not recommended)")
  .action((opts) => {
    try {
      const port = String(opts.port || configuredDaemonPort())
      const r = installAttachHooks(port, { path: opts.path, withGuard: opts.guard })
      console.log(
        r.changed
          ? `${chalk.green("✓")} Installed attach hooks in ${chalk.gray(r.path)}`
          : `${chalk.green("✓")} Attach hooks already up to date in ${chalk.gray(r.path)}`,
      )
      console.log(chalk.gray(`  Events: ${r.events.join(", ")} → 127.0.0.1:${port}`))
      if (r.guardInstalled) {
        console.log(chalk.gray("  PreToolUse guard installed at user scope."))
        console.log(
          chalk.gray(
            "  (An attached session runs under your permissions, not the agent's workspace\n" +
              "   settings — without this an attached production identity would be less\n" +
              "   guarded than a spawned one.)",
          ),
        )
      } else {
        console.log(
          chalk.yellow(
            "  ! Guard hook skipped. An attached production identity will run unguarded.",
          ),
        )
      }
      console.log()
      console.log(`Next: ${chalk.cyan("agentx attach <agent>")} inside a Claude Code session.`)
    } catch (e: any) {
      console.error(chalk.red(`Install failed: ${e?.message ?? e}`))
      process.exit(1)
    }
  })

attach
  .command("uninstall")
  .description("remove the attach hooks from ~/.claude/settings.json")
  .option("--path <file>", "settings file to patch (default: ~/.claude/settings.json)")
  .option("--remove-guard", "also remove the PreToolUse guard hook")
  .action((opts) => {
    try {
      const r = uninstallAttachHooks({ path: opts.path, keepGuard: !opts.removeGuard })
      console.log(
        r.changed
          ? `${chalk.green("✓")} Removed attach hooks from ${chalk.gray(r.path)} (${r.events.join(", ")})`
          : `${chalk.gray("Nothing to remove.")}`,
      )
      if (!opts.removeGuard) {
        console.log(chalk.gray("  PreToolUse guard left in place — pass --remove-guard to drop it too."))
      }
    } catch (e: any) {
      console.error(chalk.red(`Uninstall failed: ${e?.message ?? e}`))
      process.exit(1)
    }
  })
