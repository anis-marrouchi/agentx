import type { InboxContext } from "@/approvals/inbox"
import { readApprovalSettings } from "@/approvals/settings"
import { deskAct, parseDeskAct, type DeskActResult } from "@/desk/act"
import { readDeskSource } from "@/desk/read"
import { OPERATOR_HEADER } from "@/requests/operator"

// --- Dashboard side of the desk, for this machine (#959) ---
//
// Under the Approvals admin prefix, so it sits behind the same checks: the
// dashboard token when one is configured, and X-Requested-With on writes.
// The phone app's /api/app/desk reads this machine directly and another
// machine through these routes on that machine's dashboard, the way it
// reads approvals today.
//
//   GET  /api/admin/approvals/desk       this machine's desk sources, bounded
//   POST /api/admin/approvals/desk/act   { key, action, option?, text?, agent?, by? }

export const DESK_PANEL_PREFIX = "/api/admin/approvals/desk"

export interface DeskPanelDeps {
  /** Ring the owner from this agent: this machine's daemon /calls/owner. */
  callAgent?: (agentId: string, reason: string) => Promise<DeskActResult>
}

export async function handleDeskPanel(
  method: string,
  path: string,
  body: Record<string, unknown>,
  ctx: InboxContext,
  deps: DeskPanelDeps = {},
): Promise<{ status: number; body: unknown }> {
  if (method === "GET" && path === DESK_PANEL_PREFIX) return { status: 200, body: readDeskSource(ctx) }
  if (method === "POST" && path === `${DESK_PANEL_PREFIX}/act`) {
    const input = parseDeskAct(body)
    if (typeof input === "string") return { status: 400, body: { error: input } }
    // The phone app names itself when it acts through another machine.
    const by = typeof body.by === "string" && /^operator \([^)]{1,80}\)$/.test(body.by) ? body.by : "operator (dashboard)"
    const r = await deskAct(ctx, input, { by, laterHours: readApprovalSettings(ctx.configPath).laterHours, callAgent: deps.callAgent })
    return r.ok ? { status: 200, body: { ok: true, message: r.message } } : { status: r.status, body: { error: r.error } }
  }
  return { status: 404, body: { error: "Not found" } }
}

/** POST /calls/owner on a daemon, with its token and the operator key. */
export function daemonCallAgent(
  daemon: { url: string; token?: string; operatorKey?: string | null },
  fetcher: typeof fetch = fetch,
): (agentId: string, reason: string) => Promise<DeskActResult> {
  return async (agentId, reason) => {
    if (!daemon.operatorKey) return { ok: false, status: 503, error: "no operator key on this computer: start the daemon once to create it" }
    try {
      const r = await fetcher(`${daemon.url.replace(/\/+$/, "")}/calls/owner`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [OPERATOR_HEADER]: daemon.operatorKey,
          ...(daemon.token ? { Authorization: `Bearer ${daemon.token}` } : {}),
        },
        body: JSON.stringify({ agentId, reason }),
        signal: AbortSignal.timeout(10_000),
      })
      const b = await r.json().catch(() => ({})) as { error?: string; again?: boolean; rang?: string | false; call?: { note?: string | null } }
      if (!r.ok) return { ok: false, status: r.status, error: b.error ?? `daemon ${r.status}` }
      return { ok: true, message: callMessage(agentId, b) }
    } catch (e: any) {
      return { ok: false, status: 502, error: `daemon not reachable: ${e?.message ?? e}` }
    }
  }
}

/** What happened to the call, in words the owner can act on. */
export function callMessage(agentId: string, b: { again?: boolean; rang?: string | false; call?: { note?: string | null } }): string {
  if (b.again) return `${agentId} is already calling you about this`
  if (b.rang === "widget") return `${agentId} is calling you on AgentX Voice`
  if (b.rang === "notify") return `${agentId} is calling: you get a notice to answer in AgentX Voice`
  return `${agentId} will call you: ${b.call?.note || "Focus is on"}, so it waits as a missed call`
}
