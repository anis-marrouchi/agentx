import { run } from "@/wiki/facts/exec"
import type { CardAction } from "@/approvals/cards"

// --- Calling wacli ---
//
// execFile with argv, never a shell: message text comes from an agent that
// read a stranger's message. `send text` goes through a running
// `wacli sync --follow` when there is one, so the store lock isn't a
// problem (openclaw/wacli docs/send.md).

export interface WacliCliOptions {
  binary?: string
  account?: string
}

function base(opts: WacliCliOptions): { cmd: string; args: string[] } {
  return { cmd: opts.binary || "wacli", args: opts.account ? ["--account", opts.account] : [] }
}

function failure(what: string, r: { stdout: string; stderr: string; code: number }): Error {
  const why = (r.stderr || r.stdout).trim().split("\n").pop()?.slice(0, 300) || `exit ${r.code}`
  return new Error(`wacli ${what} failed: ${why}`)
}

/** argv for `wacli send text`; exported for tests. */
export function sendArgs(action: CardAction, opts: WacliCliOptions = {}): string[] {
  const args = [...base(opts).args, "--json", "send", "text", "--to", action.to, "--message", action.message]
  if (action.replyTo) args.push("--reply-to", action.replyTo)
  return args
}

export async function wacliSend(action: CardAction, opts: WacliCliOptions = {}): Promise<void> {
  const r = await run(base(opts).cmd, sendArgs(action, opts), { timeoutMs: 60_000 })
  if (r.code !== 0) throw failure("send", r)
}

/** Save one message's media to `output` without taking the store lock. */
export async function wacliDownloadMedia(chat: string, id: string, output: string, opts: WacliCliOptions = {}): Promise<void> {
  const b = base(opts)
  const r = await run(b.cmd, [...b.args, "--read-only", "media", "download", "--chat", chat, "--id", id, "--output", output], { timeoutMs: 60_000 })
  if (r.code !== 0) throw failure("media download", r)
}
