import { Command } from "commander"
import chalk from "chalk"
import { TokenStore } from "@/daemon/token-store"

// --- agentx token: mint / list / revoke scoped API tokens ---

export const token = new Command()
  .name("token")
  .description("scoped API tokens for external access (mesh peers, integrations)")

token
  .command("create")
  .description("mint a new token — prints the secret once, store it somewhere safe")
  .requiredOption("--name <name>", "human-readable label (e.g. 'Slack integration')")
  .option("--scope <scopes>", "comma-separated scopes (default: dashboard:read)", "dashboard:read")
  .option("--expires <days>", "expire after N days (default: no expiry)")
  .action((opts) => {
    try {
      const store = new TokenStore()
      const scopes = String(opts.scope).split(",").map((s) => s.trim()).filter(Boolean)
      const days = opts.expires ? parseInt(opts.expires, 10) : undefined
      if (opts.expires && (!days || days < 1)) throw new Error("--expires must be a positive integer (days)")
      const { token: secret, record } = store.create({ name: opts.name, scopes, expiresInDays: days })
      console.log()
      console.log(chalk.bold("  Token created."))
      console.log()
      console.log(`  id:       ${chalk.cyan(record.id)}`)
      console.log(`  name:     ${record.name}`)
      console.log(`  scopes:   ${record.scopes.join(", ")}`)
      console.log(`  expires:  ${record.expiresAt || chalk.dim("never")}`)
      console.log()
      console.log(chalk.yellow("  ⚠ This is the only time the full secret will be shown."))
      console.log()
      console.log(`  ${chalk.green.bold(secret)}`)
      console.log()
      console.log(chalk.dim("  Use it via the Authorization header:"))
      console.log(chalk.dim(`    curl -H "Authorization: Bearer ${secret.slice(0, 16)}..." ...`))
      console.log()
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

token
  .command("list")
  .alias("ls")
  .description("show all issued tokens (secrets not included)")
  .action(() => {
    try {
      const records = new TokenStore().list()
      if (records.length === 0) {
        console.log(chalk.dim("\n  No tokens issued.\n"))
        return
      }
      console.log()
      for (const r of records) {
        const status = r.revokedAt
          ? chalk.red("revoked")
          : r.expiresAt && Date.parse(r.expiresAt) < Date.now()
            ? chalk.red("expired")
            : chalk.green("active")
        console.log(`  ${chalk.cyan(r.id)}  ${status}  ${r.name}`)
        console.log(chalk.dim(`    prefix: ${r.prefix}…  scopes: ${r.scopes.join(", ")}`))
        console.log(chalk.dim(`    created: ${r.createdAt}${r.expiresAt ? `  expires: ${r.expiresAt}` : ""}${r.lastUsedAt ? `  last used: ${r.lastUsedAt}` : ""}`))
      }
      console.log()
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

token
  .command("revoke <id>")
  .description("immediately invalidate a token")
  .action((id: string) => {
    try {
      const rec = new TokenStore().revoke(id)
      if (!rec) {
        console.log(chalk.red(`  Token ${id} not found.`))
        process.exit(1)
      }
      console.log(chalk.green(`\n  ✓ Revoked ${id} (${rec.name})\n`))
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })
