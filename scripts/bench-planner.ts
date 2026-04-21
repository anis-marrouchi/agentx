// Ad-hoc harness for driving the context planner against scenarios drawn
// from real past sessions. Runs the planner only (no main-agent spawn),
// prints what it picks, and shows the controllable context bytes it would
// ship vs what the layered path would ship — so we can compare before
// committing to end-to-end runs against the live daemon.
//
// Run with: pnpm tsx scripts/bench-planner.ts

import { resolve } from "path"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { SessionStore, type SessionMessage } from "../src/agents/sessions"
import { MemoryStore } from "../src/agents/memory-store"
import { planContext } from "../src/agents/context-planner"

// --- Scenarios drawn from devops-agent:telegram:1816212449 on 2026-04-20 ---
const scenarios: Array<{ label: string; priorTail: SessionMessage[]; message: string; why: string }> = [
  {
    label: "A. Cold new-topic question (no prior turns)",
    priorTail: [],
    message: "what's the current deploy status?",
    why: "Layered would still ship cross-chat + memory blobs. Planner should return ~nothing.",
  },
  {
    label: "B. Short acknowledgment (needs recent turns, nothing else)",
    priorTail: [
      user("We just added a new agent — Coder. Do you want me to restart the daemon so it picks up the telegram bot?"),
      agent("I'll restart. Confirming first — restart daemond?"),
    ],
    message: "reload daemond",
    why: "Typical 'ok do it' — layered dumps the full day's 12K blob. Planner should keep ~2 turns and skip memory.",
  },
  {
    label: "C. Follow-up clarification referencing prior answer",
    priorTail: [
      user("Yes add one on our local let it use karpathy skill"),
      agent("The coder agent is live and registered. Daemon hot-loaded via /reload without a full restart."),
    ],
    message: "Do we have to restart, can't decouple this from restarting?",
    why: "References 'restart' from prior agent message. Needs recent turns; no memory or crosschat.",
  },
  {
    label: "D. Cross-agent / cross-chat reference",
    priorTail: [
      user("give the coder my gitlab and github skills"),
      agent("Done. Coder agent now has GITLAB_TOKEN + gh permission."),
    ],
    message: "Can you explain to Noqta coder what he needs to do to run the commands",
    why: "Mentions peer agent (Noqta coder). Planner should set crossChat=true; recent turns still needed.",
  },
  {
    label: "E. Memory-weighted question about a named entity",
    priorTail: [],
    message: "what did we decide last week about the Hexabot skill setup?",
    why: "Temporal ('last week') + named entity ('Hexabot'). Planner should pull memory; zero session tail.",
  },
  {
    label: "F. Typical mid-conversation technical ask (the expensive case)",
    priorTail: [
      user("here is his telegram token: 8670746012:AAEtxxx"),
      agent("Bot account @noqta_coder_bot likely needs a daemon restart to start polling."),
      user("restart daemond"),
      agent("Done — daemon restarted, all 6 agents up."),
      user("give the coder my gitlab and github skills let him use my tokens"),
      agent("Done. Coder agent now has GITLAB_TOKEN + gh permission."),
    ],
    message: "I want to allow both of you terminal-level approval what switches/options are available",
    why: "Mid-depth new subtopic after a lot of prior chat. Planner should trim — not dump 12K.",
  },
  {
    label: "G. Late-session callback to early topic",
    priorTail: [
      agent("Coder agent is fully operational — responded in 11 seconds with 22+ skills loaded."),
      user("coder telegram session does not show as active on our dashboard"),
      agent("Fixed. Coder successfully wrote both skill files."),
    ],
    message: "what about the wiki pages",
    why: "Vague short follow-up. Needs recent turns. 'wiki' keyword may tempt planner to pull memory unnecessarily.",
  },
  {
    label: "H. Completely-off-topic interrupt",
    priorTail: [
      user("the coder agent is stuck waiting for bash"),
      agent("Checking the permission mode now."),
    ],
    message: "how much did we spend on Claude yesterday?",
    why: "Topic switch. Planner should drop recent turns aggressively; maybe pull memory for 'spend'/budgets.",
  },
  {
    label: "I. Arabic acknowledgment (team's actual language pattern)",
    priorTail: [
      user("شوف النتيجة متاع التيست"),
      agent("Tests passed — 16/16. Build clean."),
    ],
    message: "طيب تسلم امش",
    why: "'ok good, go ahead' in Tunisian Arabic. Needs recent turns. Planner shouldn't route this to memory.",
  },
]

function user(content: string): SessionMessage {
  return { role: "user", name: "انيس المروشي", content, timestamp: new Date().toISOString() }
}
function agent(content: string): SessionMessage {
  return { role: "agent", name: "devops-agent", content, timestamp: new Date().toISOString() }
}

async function main() {
  // Build an isolated SessionStore in a throwaway dir so we don't touch
  // the real .agentx/sessions.
  const tmp = resolve(process.cwd(), ".agentx/bench-tmp")
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  const sessions = new SessionStore(tmp)
  const memory = new MemoryStore(tmp)

  const day = new Date().toISOString().slice(0, 10)
  const agentId = "devops-agent"
  const channel = "telegram"
  const chatId = "bench-1816212449"

  console.log()
  console.log("═".repeat(80))
  console.log("  Context-planner scenario drive")
  console.log("  Scenarios drawn from devops-agent:telegram:1816212449:2026-04-20")
  console.log("═".repeat(80))

  for (const scenario of scenarios) {
    // Seed session with this scenario's priorTail.
    const sessionKey = `${agentId}:${channel}:${chatId}:${day}`
    const sessionFile = resolve(tmp, ".agentx/sessions", sessionKey.replace(/[^a-zA-Z0-9_:-]/g, "_") + ".json")
    mkdirSync(resolve(tmp, ".agentx/sessions"), { recursive: true })
    writeFileSync(sessionFile, JSON.stringify({
      id: sessionKey,
      agentId, channel, chatId, day,
      messages: scenario.priorTail,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2))

    // Force a cache reload.
    ;(sessions as any).cache.clear?.()

    console.log()
    console.log(chalk.bold(scenario.label))
    console.log(chalk.dim("  why: " + scenario.why))
    console.log(chalk.dim(`  message: "${scenario.message}"`))
    console.log(chalk.dim(`  prior tail: ${scenario.priorTail.length} message(s)`))

    // What LAYERED would ship (approximation):
    const layeredHistory = sessions.buildHistoryContext(agentId, channel, chatId)
    const layeredBytes = layeredHistory.length
    console.log(chalk.dim(`  LAYERED history bytes: ${layeredBytes}`))

    // Run planner:
    try {
      const plan = await planContext({
        agentId, channel, chatId,
        message: scenario.message,
        sessions, memoryStore: memory,
        timeoutMs: 20_000,
      })
      if (!plan) {
        console.log("  " + chalk.red("planner returned null — would fall back to layered"))
        continue
      }
      const plannerBytes =
        (plan.sessionHistory?.length ?? 0) +
        (plan.memoryContext?.length ?? 0) +
        (plan.crossChatContext?.length ?? 0)
      const delta = plannerBytes - layeredBytes
      const deltaPct = layeredBytes === 0 ? 0 : Math.round((delta / layeredBytes) * 100)
      console.log(`  PLAN: turns=${plan.debug.recentTurns}, mem=${plan.debug.memoryIncluded ? `yes("${plan.debug.memoryQuery}")` : "no"}, xchat=${plan.debug.crossChatIncluded ? "yes" : "no"} (${plan.debug.planLatencyMs}ms)`)
      console.log(`        reasoning: ${plan.debug.reasoning ?? "(none)"}`)
      const deltaLabel = delta <= 0 ? chalk.green(`${delta} (${deltaPct}%)`) : chalk.red(`+${delta} (+${deltaPct}%)`)
      console.log(`  PLANNER bytes: ${plannerBytes}  vs layered ${layeredBytes}  Δ ${deltaLabel}`)
    } catch (err: any) {
      console.log("  " + chalk.red(`planner error: ${err.message}`))
    }
  }

  console.log()
  console.log("═".repeat(80))
  console.log()
  rmSync(tmp, { recursive: true, force: true })
}

// tiny chalk shim so we don't need the dep
const chalk = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
