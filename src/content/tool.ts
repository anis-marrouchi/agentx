import { resolveScheduleCaller } from "@/crons/schedule-tool"
import { PLATFORM_LABEL, type ContentDraft } from "./drafts"

// --- Agent-facing `agentx_content` tool ---
//
// Lets a content agent find the owner's past posts closest to a topic,
// read its calendar, raise a draft for approval and check what happened
// to it. It talks to the daemon's /content endpoints, which never publish:
// there is no action here that posts anything.

export type ContentToolAction = "voice" | "calendar" | "draft" | "status"

export interface ContentToolDeps {
  daemonUrl: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

/** Returns the text the agent sees. Every refusal is text, never a throw. */
export async function runContentTool(args: Record<string, unknown>, deps: ContentToolDeps): Promise<string> {
  const doFetch = deps.fetch ?? fetch
  const base = deps.daemonUrl.replace(/\/$/, "")
  const action = (str(args.action) || "draft").toLowerCase() as ContentToolAction
  const caller = resolveScheduleCaller(args, deps.env ?? process.env)
  if (!caller) return "Error: couldn't tell which agent you are. Pass callerAgentId."
  const agent = encodeURIComponent(caller.agentId)

  const call = async (path: string, init?: RequestInit): Promise<{ ok: boolean; data: any }> => {
    const res = await doFetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(10_000) })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, data: res.ok ? data : { error: (data as any)?.error || `HTTP ${res.status}` } }
  }

  try {
    if (action === "voice") {
      const topic = encodeURIComponent(str(args.topic))
      const { ok, data } = await call(`/content/voice?agent=${agent}&topic=${topic}&n=${Number(args.n) || 3}`)
      if (!ok) return `Error: ${data.error}`
      if (!data.total) return "There are no past posts in voice/ yet. Ask the owner to add a few (one post per .md or .txt file) before you draft."
      return [
        `${data.total} past post(s) in voice/. Closest to the topic:`,
        ...data.samples.map((s: any) => `- ${s.file}: ${s.excerpt}`),
        "Read the whole files before you write, follow their length, tone and habits, and name them in `samples` when you raise the draft.",
      ].join("\n")
    }

    if (action === "calendar") {
      const { ok, data } = await call(`/content/calendar?agent=${agent}`)
      if (!ok) return `Error: ${data.error}`
      if (!data.exists) return "There is no calendar.md yet. Create it from the calendar template in your content skill."
      if (!data.entries.length) return "Nothing is planned in the next 14 days. Add rows to calendar.md."
      return ["Planned in the next 14 days:", ...data.entries.map((e: any) => `- ${e.date} ${e.platform}: ${e.topic} (${e.status})`)].join("\n")
    }

    if (action === "status") {
      const id = str(args.id)
      if (!id) return "Error: `id` is required for status (the draft id you got when you raised it)."
      const { ok, data } = await call(`/content/drafts/${encodeURIComponent(id)}?agent=${agent}`)
      if (!ok) return `Error: ${data.error}`
      const d = data.draft as ContentDraft
      const where = PLATFORM_LABEL[d.platform] ?? d.platform
      switch (d.status) {
        case "pending": return `Draft ${d.id} is still waiting for the owner's approval. Nothing has been published.`
        case "posted": return `Draft ${d.id} was approved and posted on ${where}${d.url ? `: ${d.url}` : ""}.`
        case "ready": return `Draft ${d.id} was approved. No ${where} connector is set, so it was saved ready to paste: ${d.file}.`
        case "rejected": return `Draft ${d.id}: the owner said no. Nothing was published.`
        default: return `Draft ${d.id} was approved but not posted: ${d.error ?? "unknown error"}.`
      }
    }

    if (action !== "draft") return `Error: unknown action "${action}". Use voice, calendar, draft or status.`
    const { ok, data } = await call("/content/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: caller.agentId,
        platform: args.platform,
        text: args.text,
        samples: args.samples,
        topic: args.topic,
        date: args.date,
      }),
    })
    if (!ok) return `Error: ${data.error}`
    const d = data.draft as ContentDraft
    return [
      `Draft ${d.id} is in the owner's Approvals inbox as content:${d.id}. Nothing is published until they say yes.`,
      `It follows: ${d.samples.join(", ")}.`,
      "Don't post it yourself and don't ask again in chat. Check it later with {action:\"status\", id:\"" + d.id + "\"}.",
    ].join(" ")
  } catch (e: any) {
    return `Error: couldn't reach the daemon (${e?.message ?? e}).`
  }
}
