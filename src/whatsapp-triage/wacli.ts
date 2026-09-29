import { run } from "@/wiki/facts/exec"
import type { WacliSettings } from "./config"

// --- The two wacli commands triage uses ---
//
// execFile, never a shell: the reply text and the ids come from chat
// messages. While `wacli sync --follow` holds the store, `send text` is
// handed to that process, and `--read-only media download` takes no lock.

export type Runner = typeof run

function base(settings: WacliSettings): string[] {
  return [
    ...(settings.account ? ["--account", settings.account] : []),
    ...(settings.store ? ["--store", settings.store] : []),
  ]
}

const firstLine = (s: string): string => s.trim().split("\n").pop()?.slice(0, 300) || "no output"

export async function sendText(
  settings: WacliSettings,
  to: string,
  text: string,
  exec: Runner = run,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await exec(settings.bin, [...base(settings), "send", "text", "--to", to, "--message", text, "--no-preview"], { timeoutMs: 60_000 })
  return r.code === 0 ? { ok: true } : { ok: false, error: `wacli send failed: ${firstLine(r.stderr || r.stdout)}` }
}

/** Downloads one message's media to `output`. False when wacli couldn't. */
export async function downloadMedia(
  settings: WacliSettings,
  chat: string,
  id: string,
  output: string,
  exec: Runner = run,
): Promise<boolean> {
  const r = await exec(settings.bin, [...base(settings), "--read-only", "media", "download", "--chat", chat, "--id", id, "--output", output], { timeoutMs: 120_000 })
  return r.code === 0
}
