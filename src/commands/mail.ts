import { Command } from "commander"
import chalk from "chalk"
import { z } from "zod"
import { loadDaemonConfig } from "@/daemon/config"
import { sendSystemMail, senderSummary, testMail } from "@/mail/sender"

// --- agentx mail: the mail AgentX sends itself (#1478) ---
//
//   test <address>   send one test mail through mail.sender

export const mail = new Command("mail")
  .description("the mail AgentX sends itself, such as sign-in links")

mail
  .command("test <address>")
  .description("send one test mail through mail.sender, to check the setup")
  .option("-c, --config <path>", "config path")
  .action(async (address: string, opts: { config?: string }) => {
    if (!z.string().email().safeParse(address).success) {
      console.error(chalk.red(`"${address}" is not an email address.`))
      process.exit(1)
    }
    const sender = loadDaemonConfig(opts.config).mail.sender
    if (!sender) {
      console.error(chalk.red("No mail.sender in agentx.json. See docs/reference/config-operations.md#mail-sender."))
      process.exit(1)
    }
    console.log(`Sending a test mail to ${address} as ${senderSummary(sender)}…`)
    try {
      const id = await sendSystemMail(sender, testMail(address, sender))
      console.log(chalk.green(`✓ Sent (${id}). Check that inbox, and the spam folder.`))
    } catch (e) {
      console.error(chalk.red(`✗ Not sent: ${e instanceof Error ? e.message : String(e)}`))
      process.exit(1)
    }
  })
