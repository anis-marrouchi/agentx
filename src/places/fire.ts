import type { Place, PlaceRule, Transition } from "./store"
import { OPERATOR_HEADER } from "@/requests/operator"

// --- What happens when a phone crosses a place (#676) ---
//
// Each fired rule ends as one push to the phone that crossed, through the
// existing push channel (the daemon's POST /channel/send, channel "push",
// chatId = that phone's device id). A plain reminder pushes its own text;
// a rule with an agent runs the text as a task first and pushes the answer.
// Delivery runs after the phone's request has been answered, so a slow
// agent never makes the phone's report time out and retry.

export interface FireDeps {
  /** Push one notification to one phone. Throws when it can't. */
  push: (deviceId: string, title: string, body: string) => Promise<void>
  /** Run a task on an agent and return its answer. Throws on failure. */
  task: (agent: string, message: string, ruleId: string) => Promise<string>
  log: (msg: string) => void
}

export function placeTitle(place: Place, on: Transition): string {
  return on === "enter" ? `Arrived at ${place.name}` : `Left ${place.name}`
}

export function taskMessage(place: Place, rule: PlaceRule, at: number): string {
  const when = new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC"
  return [
    `[Place reminder · ${rule.on === "enter" ? "the owner arrived at" : "the owner left"} ${place.name} · ${when}]`,
    rule.text,
    "",
    "Your answer is sent to the owner's phone as a notification. Keep it short.",
  ].join("\n")
}

export async function fireRules(deviceId: string, place: Place, rules: PlaceRule[], at: number, deps: FireDeps): Promise<void> {
  await Promise.all(rules.map(async (rule) => {
    const title = placeTitle(place, rule.on)
    let body = rule.text
    if (rule.agent) {
      try {
        body = (await deps.task(rule.agent, taskMessage(place, rule, at), rule.id)).trim() || `${rule.agent} had nothing to add.`
      } catch (e: any) {
        body = `${rule.text}\n\n(${rule.agent} couldn't run this: ${String(e?.message || e).slice(0, 160)})`
      }
    }
    try {
      await deps.push(deviceId, title, body)
      deps.log(`[places] ${rule.id} on ${place.id}: pushed to ${deviceId}`)
    } catch (e: any) {
      deps.log(`[places] ${rule.id} on ${place.id}: push failed: ${String(e?.message || e).slice(0, 200)}`)
    }
  }))
}

/** FireDeps that reach the daemon over HTTP, the way the dashboard's other
 *  phone features do (see finishAlertDeps in board-dashboard.ts). */
export function daemonFireDeps(
  daemon: { url: string; token?: string; operatorKey?: string },
  log: (msg: string) => void = console.error,
): FireDeps {
  const url = daemon.url.replace(/\/+$/, "")
  const headers = { "Content-Type": "application/json", ...(daemon.token ? { Authorization: `Bearer ${daemon.token}` } : {}) }
  return {
    async push(deviceId, title, body) {
      const r = await fetch(url + "/channel/send", {
        method: "POST",
        headers,
        // First line is the title (splitTitle in channels/ntfy.ts).
        body: JSON.stringify({ channel: "push", chatId: deviceId, text: `${title}\n${body}`, buttons: [{ label: "Open", url: "/app#alerts" }] }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`)
    },
    async task(agent, message, ruleId) {
      const r = await fetch(url + "/task", {
        method: "POST",
        // The owner set this reminder up on their own phone, so the turn is
        // theirs, proven with the operator key like a phone chat turn (#393).
        headers: { ...headers, ...(daemon.operatorKey ? { [OPERATOR_HEADER]: daemon.operatorKey } : {}) },
        // One session per rule: a repeating rule's runs share their context.
        body: JSON.stringify({ agent, message, context: { channel: "app", chatId: `place:${ruleId}`, sender: "places" } }),
        signal: AbortSignal.timeout(10 * 60_000),
      })
      const data = await r.json().catch(() => ({})) as { content?: unknown; error?: unknown }
      if (!r.ok || data.error) throw new Error(String(data.error || `HTTP ${r.status}`))
      return String(data.content ?? "")
    },
    log,
  }
}
