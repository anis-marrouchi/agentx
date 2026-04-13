import chalk from "chalk"
import prompts from "prompts"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs"
import { resolve } from "path"
import { applyConfigMutation, setAtPath } from "@/daemon/config-mutator"

// --- agentx connect whatsapp ---
//
// Runs a pairing-only Baileys session inside the CLI, prints the QR, waits
// for the scan, and persists the session files. After that the daemon picks
// the session up automatically on start. This removes the "run daemon, find
// the QR in logs, scan" two-step from the legacy channel add flow.

const DEFAULT_SESSION_DIR = ".agentx/whatsapp-sessions"

function daemonRunning(): boolean {
  const pidFile = resolve(process.cwd(), ".agentx/daemon.pid")
  if (!existsSync(pidFile)) return false
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10)
    if (!pid) return false
    // process.kill with signal 0 only probes existence, doesn't actually signal.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sessionExists(dir: string): boolean {
  if (!existsSync(dir)) return false
  try { return readdirSync(dir).some((f) => f.includes("creds") || f.endsWith(".json")) } catch { return false }
}

export interface ConnectWhatsAppOpts {
  agent?: string
  sessionDir?: string
  configPath?: string
  skipPair?: boolean
}

async function pairSession(sessionDir: string, log: (s: string) => void): Promise<boolean> {
  let baileys: any
  try {
    // @ts-ignore optional dep
    baileys = await import("@whiskeysockets/baileys")
  } catch {
    log(chalk.red("  WhatsApp pairing needs @whiskeysockets/baileys."))
    log(chalk.red("  Install with: pnpm add @whiskeysockets/baileys  (or npm install)"))
    return false
  }

  const { makeWASocket, useMultiFileAuthState } = baileys.default || baileys
  mkdirSync(sessionDir, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)

  let version: [number, number, number] | undefined
  try { version = (await baileys.fetchLatestBaileysVersion()).version } catch { /* fallback */ }

  const silentLogger = {
    level: "silent",
    trace: () => {}, debug: () => {}, info: () => {},
    warn: () => {}, fatal: () => {}, error: () => {},
    child: () => silentLogger,
  } as any

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: baileys.makeCacheableSignalKeyStore
        ? baileys.makeCacheableSignalKeyStore(state.keys, silentLogger)
        : state.keys,
    },
    ...(version ? { version } : {}),
    logger: silentLogger,
    printQRInTerminal: false,
    browser: ["agentx-connect", "pairing", "1.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  })

  sock.ev.on("creds.update", saveCreds)

  return await new Promise<boolean>((resolveP) => {
    const timeoutMs = 120_000
    const deadline = setTimeout(() => {
      log(chalk.yellow("  Timed out waiting for scan (2min)."))
      try { sock.end(undefined) } catch { /* ignore */ }
      resolveP(false)
    }, timeoutMs)

    sock.ev.on("connection.update", async (u: any) => {
      if (u.qr) {
        log(chalk.dim("  Scan this QR with WhatsApp → Linked devices → Link a device:"))
        log("")
        try {
          const { default: qrcode } = await import("qrcode-terminal") as any
          qrcode.generate(u.qr, { small: true })
        } catch {
          log(`  QR: ${u.qr}`)
        }
        log("")
      }
      if (u.connection === "open") {
        clearTimeout(deadline)
        log(chalk.green("  ✓ Paired"))
        try { sock.end(undefined) } catch { /* ignore */ }
        resolveP(true)
      }
      if (u.connection === "close" && !u.qr) {
        // If we haven't opened yet and close is final, abort.
        const reason = u.lastDisconnect?.error?.output?.statusCode
        // 401 = "Unauthorized" / kicked. 515 = reset. Otherwise just let it retry via new QR.
        if (reason === 401) {
          clearTimeout(deadline)
          log(chalk.red("  ✗ Authorization failed — rescan required"))
          resolveP(false)
        }
      }
    })
  })
}

export async function connectWhatsApp(opts: ConnectWhatsAppOpts = {}): Promise<void> {
  console.log()
  console.log(chalk.bold("  Connect WhatsApp"))
  console.log()

  if (daemonRunning()) {
    console.log(chalk.yellow("  ⚠ The daemon is running. Stop it first so pairing can open a fresh Baileys session:"))
    console.log(chalk.dim("    agentx daemon stop"))
    console.log()
    const { cont } = await prompts({ type: "confirm", name: "cont", message: "Continue anyway? (expect errors)", initial: false })
    if (!cont) { console.log(chalk.red("  Aborted")); process.exit(1) }
  }

  const cfgPath = opts.configPath || resolve(process.cwd(), "agentx.json")
  if (!existsSync(cfgPath)) {
    console.log(chalk.red(`  No agentx.json at ${cfgPath}. Run: agentx init`))
    process.exit(1)
  }
  const raw = JSON.parse(readFileSync(cfgPath, "utf-8"))

  const sessionDir = opts.sessionDir || raw.channels?.whatsapp?.sessionDir || DEFAULT_SESSION_DIR
  const absSession = resolve(process.cwd(), sessionDir)

  // --- Agent binding ---
  const agents = Object.keys(raw.agents || {})
  if (agents.length === 0) {
    console.log(chalk.red("  No agents configured. Run: agentx agent add"))
    process.exit(1)
  }

  let agent = opts.agent
  if (!agent) {
    const r = await prompts({
      type: "select",
      name: "agent",
      message: "Default agent for incoming messages:",
      choices: agents.map((id) => ({ title: id, value: id })),
      initial: 0,
    })
    agent = r.agent
  }
  if (!agent) { console.log(chalk.red("  Aborted")); process.exit(1) }

  // --- Decide whether to re-pair ---
  let shouldPair = !opts.skipPair
  if (sessionExists(absSession) && shouldPair) {
    const { keep } = await prompts({
      type: "confirm",
      name: "keep",
      message: `An existing session was found at ${sessionDir}. Keep it (recommended), or pair again?`,
      initial: true,
    })
    shouldPair = !keep
    if (keep) console.log(chalk.dim("  Keeping existing session — skipping QR pair."))
  }

  // --- Pair ---
  if (shouldPair) {
    const ok = await pairSession(absSession, (s) => console.log(s))
    if (!ok) {
      console.log(chalk.red("  Pairing failed. You can retry with `agentx connect whatsapp`."))
      process.exit(1)
    }
  }

  // --- Persist config ---
  const result = await applyConfigMutation((cfg) => {
    setAtPath(cfg, "channels.whatsapp.enabled", true)
    setAtPath(cfg, "channels.whatsapp.sessionDir", sessionDir)
    setAtPath(cfg, "channels.whatsapp.defaultAgent", agent)
  }, { configPath: opts.configPath })

  if (!result.success) {
    console.log(chalk.red(`  ✗ ${result.error}`))
    process.exit(1)
  }

  console.log()
  console.log(chalk.green(`  ✓ WhatsApp bound to agent "${agent}"`))
  console.log(chalk.dim(`    Session: ${sessionDir}`))
  console.log(chalk.dim("    Start the daemon to begin receiving:"))
  console.log(chalk.dim("      agentx daemon start"))
  console.log(chalk.dim("    Add routes later with:"))
  console.log(chalk.dim(`      agentx config set channels.whatsapp.routes '[{"contact":"+1234567890","agent":"${agent}"}]'`))
  console.log()
}
