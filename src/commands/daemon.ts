import { Command } from "commander"
import { AgentXDaemon } from "@/daemon"

export const daemon = new Command()
  .name("daemon")
  .description("start the agentx daemon — channels, crons, agents, and mesh")
  .option("-c, --config <path>", "path to agentx.json config file")
  .action(async (opts) => {
    const d = new AgentXDaemon(opts.config)
    await d.start()
  })
