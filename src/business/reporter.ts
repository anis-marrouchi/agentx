import type { MessageRouter } from "@/channels/router"
import type { BusinessConfig } from "./config"
import type { Organization } from "./organization"

// --- Reporter: posts to main channel + escalates blockers up the org chart ---

export class Reporter {
  constructor(
    private router: MessageRouter,
    private org: Organization,
    private config: BusinessConfig,
    private log: (...args: unknown[]) => void,
  ) {}

  async postToMain(text: string, agentId?: string): Promise<void> {
    const dest = this.config.mainChannel
    try {
      await this.router.sendOutbound({
        channel: dest.channel,
        chatId: dest.chatId,
        text,
        agentId,
        accountId: dest.accountId,
      })
    } catch (e: any) {
      this.log(`[business] postToMain failed: ${e.message}`)
    }
  }

  /** Post an escalation message up the chain of command. */
  async escalate(fromAgent: string, subject: string, detail: string): Promise<void> {
    const chain = this.org.chainOfCommand(fromAgent).slice(1)  // drop self
    const targets = chain.length ? chain.slice(0, 1) : []      // first direct manager
    const body = `⚠️ **Escalation from ${fromAgent}** — ${subject}\n\n${detail}`

    if (!targets.length) {
      // No manager → fall back to main channel
      await this.postToMain(body, fromAgent)
      return
    }

    // Post to main channel tagging the manager (they watch the main channel).
    await this.postToMain(`${body}\n\ncc: ${targets.map((t) => `@${t}`).join(" ")}`, fromAgent)
  }
}
