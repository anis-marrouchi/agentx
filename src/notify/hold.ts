import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, join } from "path"
import { readFocus, type FocusState } from "./focus"

// --- Hold while the owner is in a call (#394, the call check) ---
//
// Nothing new goes on the screen while the owner is in a call, the same
// rule as Focus: held, never dropped, delivered when the call ends.
//
// The answer is a file, like the widget's Focus hold, so every process
// reads the same thing: the daemon, and `agentx notify` run by an agent.
// The daemon writes it from what it knows (an AgentX call answered, the
// widget busy) and renews it while the call lasts; any other tool that
// knows of a call (a phone bridge) may write it too, with its own source.
// A hold past its `until` is over: a writer that died never holds forever.
//
//   ~/.agentx/call.json  {"active": true, "source": "daemon", "reason": "on a call with Sam", "until": "<ISO>"}
//
// Calls themselves are exempt: they keep their own busy and Focus rule
// (calls/service.ts), which reads readFocus, not this.

export const CALL_HOLD = join(homedir(), ".agentx", "call.json")

export function readCall(path = CALL_HOLD, now = Date.now()): FocusState {
  try {
    const hold = JSON.parse(readFileSync(path, "utf-8"))
    if (hold?.active === true && !(hold.until && Date.parse(hold.until) <= now)) {
      return { active: true, mode: "call", reason: `in a call${hold.reason ? `: ${hold.reason}` : ""}` }
    }
  } catch {
    /* no file, or unreadable: not in a call */
  }
  return { active: false, mode: null, reason: "not in a call" }
}

/** Focus or a call: what notify, the popup and the Focus watcher hold on. */
export function readHold(focus: () => FocusState = readFocus, call: () => FocusState = readCall): FocusState {
  const f = focus()
  return f.active ? f : call()
}

/** The daemon's side: write the hold while `reason` is set, clear its own
 *  hold when it is not. Another source's hold is left alone. */
export function writeCallHold(reason: string | null, ttlMs: number, path = CALL_HOLD, now = Date.now()): void {
  let current: any = null
  try { current = JSON.parse(readFileSync(path, "utf-8")) } catch { /* none */ }
  if (current && current.source && current.source !== "daemon") return
  if (!reason) {
    if (current) rmSync(path, { force: true })
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ active: true, source: "daemon", reason, until: new Date(now + ttlMs).toISOString() }) + "\n")
  renameSync(tmp, path)
}
