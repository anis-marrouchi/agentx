import { Command } from "commander"
import chalk from "chalk"
import { execFileSync } from "child_process"
import { existsSync } from "fs"
import { TokenStore } from "@/daemon/token-store"
import { CODE_TTL_MS, PairCodeStore, formatCode } from "@/daemon/pair-codes"
import { loadDaemonConfig } from "@/daemon/config"
import { DEFAULT_PUSH_KEYS_FILE, pushKeysPath, readPushKeys, writePushKeys } from "@/channels/push-keys"

// --- agentx app: pair phones with the /app PWA ---
//
// Each paired phone is one token with the single scope `app` in the same
// store as `agentx token`, so revocation, expiry and "last used" come for
// free. These commands only filter that store down to devices.

export const appCmd = new Command()
  .name("app")
  .description("pair phones with the AgentX phone app and manage paired devices")

appCmd
  .command("pair")
  .description("pair a phone — prints a QR code to scan and a one-time code to type in the installed app")
  .option("--name <name>", "name for this phone (shown in `agentx app devices`)", "Phone")
  .option("--url <origin>", "address the phone opens, e.g. https://my-mac.tailnet-name.ts.net (default: this machine's Tailscale name)")
  .action(async (opts) => {
    try {
      const exposed = exposedDashboardMounts(tailscaleServeStatus(), dashboardPort())
      if (exposed.length > 0) {
        throw new Error([
          `tailscale serve publishes the whole dashboard, not only the phone app: ${exposed.join(", ")}`,
          `  Anyone on your tailnet can open it without a key. Serve only the app paths instead:`,
          `    tailscale serve reset   (removes every served path; add the /member lines back if you use them)`,
          `    tailscale serve --bg --set-path /app http://127.0.0.1:${dashboardPort()}/app`,
          `    tailscale serve --bg --set-path /api/app http://127.0.0.1:${dashboardPort()}/api/app`,
        ].join("\n"))
      }
      const origin = (opts.url ? String(opts.url) : tailscaleOrigin()).replace(/\/+$/, "")
      if (!/^https?:\/\/[^/]+$/.test(origin)) throw new Error(`--url must be an origin like https://host.example.ts.net, got: ${origin}`)
      const { token: secret, record } = new TokenStore().create({ name: String(opts.name), scopes: ["app"] })
      // The code redeems this same device token, so the QR link (browser)
      // and the code (installed app) end up as one device.
      const { code } = new PairCodeStore().create({ token: secret, tokenId: record.id, name: record.name })
      const link = `${origin}/app/pair#token=${secret}`
      // @ts-ignore - no type declarations for qrcode-terminal
      const { default: qrcode } = await import("qrcode-terminal") as any
      console.log()
      qrcode.generate(link, { small: true }, (qr: string) => console.log(qr))
      for (const line of pairingLines({ code, origin, deviceId: record.id, deviceName: record.name })) console.log(line)
      if (!existsSync("agentx.json") && !existsSync(".agentx/config.json")) {
        console.log(chalk.yellow(`  ⚠ No agentx.json here. The dashboard only accepts phones paired from the folder that holds agentx.json.`))
      }
      console.log()
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

appCmd
  .command("devices")
  .description("list paired phones")
  .action(() => {
    const devices = new TokenStore().list().filter((r) => r.scopes.includes("app"))
    if (devices.length === 0) {
      console.log(chalk.dim("\n  No paired phones. Run `agentx app pair`.\n"))
      return
    }
    console.log()
    for (const d of devices) {
      const status = d.revokedAt ? chalk.red("revoked") : chalk.green("active")
      console.log(`  ${chalk.cyan(d.id)}  ${status}  ${d.name}`)
      console.log(chalk.dim(`    paired: ${d.createdAt}${d.lastUsedAt ? `  last used: ${d.lastUsedAt}` : ""}`))
    }
    console.log()
  })

appCmd
  .command("revoke <id>")
  .description("unpair a phone immediately")
  .action((id: string) => {
    const store = new TokenStore()
    const device = store.list().find((r) => r.id === id && r.scopes.includes("app"))
    if (!device) {
      console.log(chalk.red(`  No paired phone with id ${id}. See \`agentx app devices\`.`))
      process.exit(1)
    }
    store.revoke(id)
    console.log(chalk.green(`\n  ✓ Unpaired ${id} (${device.name})\n`))
  })

appCmd
  .command("push-keys")
  .description("create the key pair that lets this computer send notifications to paired phones")
  .option("--force", "replace existing keys (every phone must turn notifications on again)")
  .action(async (opts) => {
    let file = DEFAULT_PUSH_KEYS_FILE
    try { file = loadDaemonConfig().channels.push.keysFile } catch { /* defaults */ }
    const path = pushKeysPath(file)
    const existing = readPushKeys(path)
    if (existing && !opts.force) {
      console.log(chalk.green(`\n  ✓ Keys already exist in ${path} (created ${existing.createdAt}).`))
      console.log(chalk.dim(`  Replacing them cuts off every phone; pass --force if you really mean to.\n`))
      return
    }
    const { default: webpush } = await import("web-push")
    writePushKeys(path, webpush.generateVAPIDKeys())
    console.log(chalk.green(`\n  ✓ Saved new push keys to ${path}`))
    console.log(chalk.dim(`  Keep this file private. It is readable only by you, and agentx.json never contains it.`))
    if (existing) console.log(chalk.yellow(`  ⚠ Old keys replaced: open Alerts on each phone and turn notifications on again.`))
    console.log(chalk.dim(`  Restart the daemon so it picks up the keys.\n`))
  })

/** What `agentx app pair` prints under the QR code. */
export function pairingLines(p: { code: string; origin: string; deviceId: string; deviceName: string }): string[] {
  const minutes = Math.round(CODE_TTL_MS / 60000)
  const lines = [
    `  Pairing code: ${chalk.bold.cyan(formatCode(p.code))}`,
    chalk.dim(`  Open the app from the phone's home screen and type this code. It works once, for ${minutes} minutes.`),
    `  Or scan the QR code with the phone's camera and open the link.`,
    `  Device ${chalk.cyan(p.deviceId)} (${p.deviceName}) paired to ${p.origin}.`,
    chalk.yellow(`  ⚠ Anyone who scans the QR code or types the code can use the app. Clear the terminal when done.`),
  ]
  if (!p.origin.startsWith("https://")) {
    lines.push(chalk.yellow(`  ⚠ ${p.origin} is not HTTPS: the phone can't install the app or keep the session from there.`))
  }
  return lines
}

/** https://<this machine's MagicDNS name>, the address `tailscale serve` uses. */
export function tailscaleOrigin(): string {
  let status: any
  try {
    status = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf-8", timeout: 5000 }))
  } catch {
    throw new Error("Could not read this machine's Tailscale name. Is Tailscale running? Or pass --url https://<address>.")
  }
  const name = String(status?.Self?.DNSName || "").replace(/\.$/, "")
  if (!name) throw new Error("Tailscale has no MagicDNS name for this machine. Pass --url https://<address>.")
  return `https://${name}`
}

/** Mount paths the phone and a teammate's work page need; both check a
 *  machine's own key on every request. Everything else stays off the tailnet. */
const APP_MOUNTS = new Set(["/app", "/api/app", "/member", "/api/member"])

/** Public files the guides publish on their own path. Allowed only when the
 *  mount proxies to that same file, never to "/" or another dashboard path. */
const PUBLIC_FILE_MOUNTS = new Set(["/.well-known/assetlinks.json"])

/**
 * Lists `tailscale serve` mounts (host + path) that proxy to the dashboard
 * port outside the app and member paths. `tailscale serve 4202` mounts "/", which
 * publishes every dashboard page and API to the tailnet, and serve proxies
 * from 127.0.0.1, so the dashboard's loopback trust lets those requests in.
 */
export function exposedDashboardMounts(status: any, port: number): string[] {
  const configs = [status, ...Object.values(status?.Foreground ?? {})]
  const found: string[] = []
  for (const cfg of configs) {
    for (const [host, web] of Object.entries<any>(cfg?.Web ?? {})) {
      for (const [mount, h] of Object.entries<any>(web?.Handlers ?? {})) {
        const target = String(h?.Proxy ?? "").match(/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)([/?#].*)?$/)
        if (!target || Number(target[1]) !== port) continue
        const clean = mount.replace(/\/+$/, "") || "/"
        const targetPath = (target[2] ?? "").replace(/\/+$/, "")
        if (APP_MOUNTS.has(clean) || (PUBLIC_FILE_MOUNTS.has(clean) && targetPath === clean)) continue
        found.push(`${host}${mount}`)
      }
    }
  }
  return found
}

/** `tailscale serve status --json`, or null when Tailscale isn't available. */
export function tailscaleServeStatus(): any {
  try {
    return JSON.parse(execFileSync("tailscale", ["serve", "status", "--json"], { encoding: "utf-8", timeout: 5000 }) || "{}")
  } catch {
    return null
  }
}

export function dashboardPort(): number {
  try {
    return loadDaemonConfig().dashboard.port || 4202
  } catch {
    return 4202
  }
}
