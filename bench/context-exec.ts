// Shared by the Level 0 benchmarks: a fake `claude` and one `agentx exec`
// run through the real registry against it. No model is ever called.

import { execFileSync } from "node:child_process"
import { chmodSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** A `claude` stand-in: records argv, answers like `--output-format json`.
 *  It returns no session id, so the next run on the same chat starts a
 *  fresh session that carries the chat's history, as a rotated one does. */
export function writeFakeClaude(binDir: string, dump: string): void {
  const file = join(binDir, "claude")
  writeFileSync(file, `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write(JSON.stringify({ type: "result", result: "ok", num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }))
`)
  chmodSync(file, 0o755)
}

export interface ExecRun {
  state: string
  bin: string
  configPath: string
  agentId: string
  task: string
  channel?: string
  chatId?: string
  profile?: string
}

/** One `agentx exec` run through the real registry against the fake claude. */
export function runExec(opts: ExecRun): void {
  const args = ["--tsconfig", join(REPO, "tsconfig.json"), join(REPO, "src/cli.ts"),
    "exec", "-a", opts.agentId, "-c", opts.configPath, "--setup-workspace", "--json"]
  if (opts.channel) args.push("--channel", opts.channel)
  if (opts.chatId) args.push("--chat-id", opts.chatId)
  if (opts.profile) args.push("--profile", opts.profile)
  execFileSync(join(REPO, "node_modules/.bin/tsx"), args,
    { cwd: opts.state, input: opts.task, env: { ...process.env, PATH: `${opts.bin}:${process.env.PATH}` }, stdio: ["pipe", "pipe", "pipe"] })
}

/** The clean bench config: two agents on one node, so the landscape has a
 *  team to list, no channels, no memory. */
export function benchConfig(workspace: string): object {
  return {
    node: { id: "bench", name: "Bench", bind: "127.0.0.1:18899" },
    agents: {
      bench: { name: "Bench", workspace, tier: "claude-code", permissionMode: "bypassPermissions", systemPrompt: "You fix failing tests. Keep answers short." },
      helper: { name: "Helper", workspace: workspace + "-helper", tier: "claude-code", mentions: ["@helper_bot"], systemPrompt: "You review pull requests." },
    },
  }
}
