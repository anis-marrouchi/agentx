import { handleError } from "@/utils/handle-error"
import { logger } from "@/utils/logger"
import { startMcpServer } from "@/mcp"
import chalk from "chalk"
import { Command } from "commander"
import { resolve } from "path"

// --- `agentx serve` — run as MCP server for AI editors ---

export const serve = new Command()
  .name("serve")
  .description("run agentx as an MCP server for AI editors (Claude Code, Cursor, Windsurf, etc.)")
  .option("--stdio", "use stdio transport (default)", true)
  .option(
    "-c, --cwd <cwd>",
    "working directory",
    process.cwd()
  )
  .action(async (opts) => {
    try {
      process.chdir(resolve(opts.cwd))
      if (opts.stdio !== false) {
        // stdio mode — all logging goes to stderr, stdout is JSON-RPC
        await startMcpServer()
      } else {
        logger.error("Only stdio transport is currently supported.")
        logger.info(
          `Usage: ${chalk.green("agentx serve --stdio")} or configure in your MCP client.`
        )
        logger.break()
        logger.info("Add to Claude Code:")
        logger.info(
          chalk.dim(
            '  claude mcp add agentx -- npx agentx serve --stdio'
          )
        )
        logger.break()
        logger.info("Add to Cursor/MCP config:")
        logger.info(
          chalk.dim(
            JSON.stringify(
              {
                mcpServers: {
                  agentx: {
                    command: "npx",
                    args: ["agentx", "serve", "--stdio"],
                  },
                },
              },
              null,
              2
            )
          )
        )
      }
    } catch (error) {
      handleError(error)
    }
  })
