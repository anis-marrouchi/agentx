import { Command } from "commander"
import chalk from "chalk"
import { execFileSync } from "child_process"
import { TokenStore } from "@/daemon/token-store"

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
  .description("pair a phone — prints a QR code to scan with the phone's camera")
  .option("--name <name>", "name for this phone (shown in `agentx app devices`)", "Phone")
  .option("--url <origin>", "address the phone opens, e.g. https://my-mac.tailnet-name.ts.net (default: this machine's Tailscale name)")
  .action(async (opts) => {
    try {
      const origin = (opts.url ? String(opts.url) : tailscaleOrigin()).replace(/\/+$/, "")
      if (!/^https?:\/\/[^/]+$/.test(origin)) throw new Error(`--url must be an origin like https://host.example.ts.net, got: ${origin}`)
      const { token: secret, record } = new TokenStore().create({ name: String(opts.name), scopes: ["app"] })
      const link = `${origin}/app/pair#token=${secret}`
      // @ts-ignore - no type declarations for qrcode-terminal
      const { default: qrcode } = await import("qrcode-terminal") as any
      console.log()
      qrcode.generate(link, { small: true }, (qr: string) => console.log(qr))
      console.log(`  Scan with the phone's camera, then open the link.`)
      console.log(`  Device ${chalk.cyan(record.id)} (${record.name}) paired to ${origin}.`)
      console.log(chalk.yellow(`  ⚠ Anyone who scans this code can use the app. Clear the terminal when done.`))
      if (!origin.startsWith("https://")) {
        console.log(chalk.yellow(`  ⚠ ${origin} is not HTTPS: the phone can't install the app or keep the session from there.`))
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

/** https://<this machine's MagicDNS name>, the address `tailscale serve` uses. */
function tailscaleOrigin(): string {
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
