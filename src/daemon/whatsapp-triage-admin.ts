import { mutateAgentxConfig } from "./config-mutate"
import { whatsappTriageSchema } from "@/whatsapp-triage/config"

// --- Dashboard: Webhooks tab → WhatsApp triage (#328) ---
//
// Mirrors `agentx whatsapp triage`. Every write validates the whole
// section before agentx.json changes.

/** What the dashboard shows. Never the secret, only whether it is set. */
export function whatsappTriageSettings(cfg: any): object {
  const parsed = whatsappTriageSchema.safeParse(cfg?.whatsappTriage ?? {})
  const t = parsed.success ? parsed.data : whatsappTriageSchema.parse({})
  return {
    enabled: t.enabled,
    secretEnv: t.secretEnv,
    secretSet: !!process.env[t.secretEnv],
    batchSeconds: t.batchSeconds,
    allowAutoAck: t.allowAutoAck,
    rules: t.rules,
    ...(parsed.success ? {} : { error: parsed.error.issues[0]?.message ?? "invalid whatsappTriage section" }),
  }
}

function mutateTriage(change: (t: any, cfg: any) => string): { summary: string } {
  return mutateAgentxConfig((cfg) => {
    const t = cfg.whatsappTriage && typeof cfg.whatsappTriage === "object" ? cfg.whatsappTriage : {}
    t.rules = Array.isArray(t.rules) ? t.rules : []
    const summary = change(t, cfg)
    const check = whatsappTriageSchema.safeParse(t)
    if (!check.success) {
      const issue = check.error.issues[0]
      throw new Error(`${issue?.path.join(".") || "whatsappTriage"}: ${issue?.message ?? "invalid"}`)
    }
    cfg.whatsappTriage = t
    return summary
  })
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[,\n]/)).map((s) => String(s).trim()).filter(Boolean)

export function updateWhatsappTriage(body: any): { summary: string } {
  return mutateTriage((t) => {
    if (typeof body?.enabled === "boolean") t.enabled = body.enabled
    if (typeof body?.allowAutoAck === "boolean") t.allowAutoAck = body.allowAutoAck
    if (body?.batchSeconds !== undefined) t.batchSeconds = Number(body.batchSeconds)
    return `WhatsApp triage ${t.enabled ? "on" : "off"}`
  })
}

export function addWatchRule(body: any): { summary: string } {
  const id = String(body?.id ?? "").trim()
  const agent = String(body?.agent ?? "").trim()
  return mutateTriage((t, cfg) => {
    if (!cfg.agents?.[agent]) throw new Error(`Unknown agent "${agent}".`)
    if (t.rules.some((r: any) => r.id === id)) throw new Error(`Watch rule "${id}" already exists.`)
    const rule: any = { id, agent, chats: list(body?.chats), senders: list(body?.senders) }
    const prompt = String(body?.prompt ?? "").trim()
    if (prompt) rule.prompt = prompt
    if (body?.quietStart && body?.quietEnd) rule.quietHours = { start: String(body.quietStart), end: String(body.quietEnd) }
    if (body?.autoAck === true) rule.autoAck = true
    t.rules.push(rule)
    return `added watch rule "${id}" → ${agent}`
  })
}

export function editWatchRule(body: any): { summary: string } {
  const id = String(body?.id ?? "")
  return mutateTriage((t) => {
    const rule = t.rules.find((r: any) => r.id === id)
    if (!rule) throw new Error(`Watch rule "${id}" not found.`)
    if (typeof body?.patch?.enabled === "boolean") rule.enabled = body.patch.enabled
    if (typeof body?.patch?.autoAck === "boolean") rule.autoAck = body.patch.autoAck
    return `updated watch rule "${id}"`
  })
}

export function deleteWatchRule(body: any): { summary: string } {
  const id = String(body?.id ?? "")
  return mutateTriage((t) => {
    if (!t.rules.some((r: any) => r.id === id)) throw new Error(`Watch rule "${id}" not found.`)
    t.rules = t.rules.filter((r: any) => r.id !== id)
    return `removed watch rule "${id}"`
  })
}
