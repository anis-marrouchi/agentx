import type { Command } from "commander"
import chalk from "chalk"
import { readCard } from "@/approvals/cards"
import { decide } from "@/approvals/inbox"
import { showPopup } from "@/approvals/popup"
import { sampleCard } from "@/approvals/sample-card"
import { readApprovalSettings } from "@/approvals/settings"

// --- agentx approvals popup | checkin — the Mac card and check-ins ---

const base = () => (process.env.AGENTX_DAEMON_URL || "http://127.0.0.1:18800").replace(/\/+$/, "")

export function registerCardCommands(approvals: Command): void {
  approvals
    .command("popup")
    .description("show a card on this Mac now and record your answer (macOS)")
    .argument("[key]", "card key from `agentx approvals list`, e.g. card:2026-01-05-new-meeting-date-ab12")
    .option("--sample", "show a sample card; nothing is recorded")
    .option("--pick <n>", "start with option n picked (previews)")
    .option("--theme <system|light|dark>", "override approvals.popup.theme")
    .option("--capture <file.png>", "save a picture of the card window")
    .option("--timeout <seconds>", "override approvals.popup.timeoutSeconds")
    .action(async (key: string | undefined, opts: { sample?: boolean; pick?: string; theme?: string; capture?: string; timeout?: string }) => {
      if (process.platform !== "darwin") { console.error(chalk.red("  the popup needs macOS")); process.exitCode = 1; return }
      const id = key?.startsWith("card:") ? key.slice(5) : key
      const card = opts.sample ? sampleCard() : id ? readCard(process.cwd(), id) : null
      if (!card || card.status !== "pending") {
        console.error(chalk.red(key ? `  no card waiting for "${key}"` : "  give a card key, or --sample")); process.exitCode = 1; return
      }
      const settings = { ...readApprovalSettings().popup! }
      if (opts.theme === "system" || opts.theme === "light" || opts.theme === "dark") settings.theme = opts.theme
      if (opts.timeout) settings.timeoutSeconds = Number(opts.timeout)
      const answer = await showPopup(card, settings, { from: opts.sample ? "Assistant" : undefined, capture: opts.capture, pick: Number(opts.pick) || undefined })
      if (opts.capture) console.log(chalk.dim(`  picture saved to ${opts.capture}`))
      if (opts.sample) { console.log(`  answer (not recorded): ${JSON.stringify(answer)}`); return }
      if (answer.action === "dismiss") { console.log(chalk.dim(`  not answered${answer.why ? ` (${answer.why})` : ""}; the card is still waiting`)); return }
      const r = await decide({ root: process.cwd() }, `card:${card.id}`, answer.action, {
        by: "operator (popup)", ...(answer.action === "yes" ? { choice: answer.choice, text: answer.text } : {}),
      })
      if (!r.ok) { console.error(chalk.red(`  ${r.error}`)); process.exitCode = 1; return }
      console.log(chalk.green(`  ✓ ${r.message}`))
    })

  approvals
    .command("checkin")
    .description("run a check-in now: waiting cards come back, open reminders get cards (daemon, macOS)")
    .option("--daily", "the daily pass: every open reminder, not only those due soon")
    .action(async (opts: { daily?: boolean }) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (process.env.MESH_TOKEN) headers.Authorization = `Bearer ${process.env.MESH_TOKEN}`
      try {
        const res = await fetch(`${base()}/approvals/checkin`, { method: "POST", headers, body: JSON.stringify({ daily: !!opts.daily }) })
        const data: any = await res.json().catch(() => ({}))
        if (!res.ok) { console.error(chalk.red(`  ${data.error ?? res.status}`)); process.exitCode = 1; return }
        console.log(chalk.green(`  ✓ ${data.started} pass started; agents are writing cards. Watch: agentx approvals list`))
      } catch (e: any) {
        console.error(chalk.red(`  couldn't reach the daemon at ${base()}: ${e?.message ?? e}`)); process.exitCode = 1
      }
    })
}
