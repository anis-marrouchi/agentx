import { Command } from "commander"
import { randomUUID } from "crypto"
import { readFileSync } from "fs"
import { resolve } from "path"
import { LandscapeBuilder } from "@/agents/landscape"
import { AgentRegistry } from "@/agents/registry"
import { setupWorkspace } from "@/agents/workspace-setup"
import { loadDaemonConfig } from "@/daemon/config"

// --- `agentx exec` — run one task through one agent, then exit ---
//
// The daemon is a long-lived router; benchmarks and scripts need the
// opposite: hand an agent a task, wait for it to finish, get the result
// and its real token usage back, exit. This goes through the same
// AgentRegistry.execute the daemon uses (context layers, tier dispatch,
// session store), minus the channels and HTTP around it.
//
// The task comes from the argument or stdin, so long instructions never
// need shell quoting. Registry state (.agentx/) lands in the working
// directory, so run it from a state directory, not the agent's workspace.
//
// With --json, stdout is exactly one JSON object:
//   { content, error?, errorKind?, usage?, numTurns?, billedModel?, durationMs }
// usage is cumulative across the whole agentic loop, cache split out:
//   { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens }
// Exit code is 1 when the agent returned an error.

export const exec = new Command()
  .name("exec")
  .description("run one task through an agent and exit — for scripts and benchmarks")
  .argument("[message]", "the task (default: read from stdin)")
  .requiredOption("-a, --agent <id>", "agent id from the config")
  .option("-c, --config <path>", "config file (default: ./agentx.json)")
  .option("-m, --model <model>", "override the agent's model for this task")
  .option("--timeout <minutes>", "upper bound on the task's run time")
  .option("--setup-workspace", "write the managed workspace files first, as daemon boot does")
  .option("--json", "print one JSON result object instead of the reply text")
  .option("--channel <name>", "channel name the task runs under, as a channel adapter would set it", "exec")
  .option("--chat-id <id>", "chat id for the session (default: a fresh one), so repeated runs share a history")
  .option("--profile <full|lean>", "session profile for this run's channel, overriding session.profileByChannel")
  .action(async (messageArg: string | undefined, opts) => {
    const message = (messageArg ?? readFileSync(0, "utf8")).trim()
    if (!message) fail("no task given (pass it as an argument or on stdin)")

    const config = loadDaemonConfig(opts.config ? resolve(opts.config) : undefined)
    const agent = config.agents[opts.agent]
    if (!agent) fail(`unknown agent "${opts.agent}" — known: ${Object.keys(config.agents).join(", ")}`)
    if (opts.profile !== undefined && opts.profile !== "full" && opts.profile !== "lean") fail(`--profile must be full or lean, not "${opts.profile}"`)
    if (opts.profile) config.session.profileByChannel = { ...config.session.profileByChannel, [opts.channel]: opts.profile }

    const log = (...args: unknown[]) => console.error("[agentx exec]", ...args)
    if (opts.setupWorkspace) {
      const port = config.node.bind.split(":")[1] || "19900"
      setupWorkspace(opts.agent, agent, port, log)
    }

    const registry = new AgentRegistry(config, log)
    // The daemon gives every agent its landscape (team, channels, rules);
    // a run here gets the same, minus mesh peers, so what it measures is
    // what the daemon sends.
    try {
      const landscape = new LandscapeBuilder(config)
      landscape.build()
      registry.setLandscape(landscape)
    } catch (e: any) {
      log(`no landscape: ${e?.message ?? e}`)
    }
    const started = Date.now()
    const response = await registry.execute({
      agentId: opts.agent,
      message,
      model: opts.model,
      timeoutMinutes: opts.timeout ? Number(opts.timeout) : undefined,
      context: { channel: opts.channel, chatId: opts.chatId || `exec-${randomUUID()}`, sender: "cli" },
    })

    if (opts.json) {
      process.stdout.write(JSON.stringify({
        content: response.content,
        error: response.error,
        errorKind: response.errorKind,
        usage: response.usage,
        numTurns: response.numTurns,
        billedModel: response.billedModel,
        durationMs: Date.now() - started,
      }) + "\n")
    } else if (response.error) {
      console.error(response.error)
    } else {
      process.stdout.write(response.content + "\n")
    }
    // The registry holds timers and pooled CLI processes open; a one-shot
    // command must not wait on them.
    process.exit(response.error ? 1 : 0)
  })

function fail(message: string): never {
  console.error(`agentx exec: ${message}`)
  process.exit(1)
}
