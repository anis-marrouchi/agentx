import { activeProviderHolds, getClaudeCodeUsage, liftProviderHolds, planWindowUse } from "@/agents/claude-code-quota"
import { planUsageReader } from "@/agents/claude-plan-usage"
import { RUN_PRIORITIES, getPlanPriority, planPriorityHold } from "@/agents/plan-priority"
import type { CodexPlanUsage } from "@/agents/codex-plan-usage"
import type { Reply } from "./restart-api"

// --- HTTP surface for the Claude plan dispatch gate (operator-only; the
// daemon gates it with checkMeshAuth, like /daemon/restart) ---
//
//   GET  /usage/plan       the plan windows as Claude Code last reported
//                          them, the cold-dispatch counters and local caps,
//                          the windows that hold cold dispatches now, the
//                          usage reader's last reading (#2161), which run
//                          classes it holds, and Codex's last plan reading
//                          from its session files (#2101 R28b), when the
//                          daemon passes one
//   POST /usage/plan/lift  drop the active holds; the next cold dispatch
//                          asks Claude again
//
// Pure request → reply mapping over the in-memory gate state.

export const PLAN_USAGE_API_PATHS = new Set(["/usage/plan", "/usage/plan/lift"])

export function handlePlanUsageApi(method: string, path: string, now: number = Date.now(), extra: { codex?: CodexPlanUsage | null } = {}): Reply {
  const m = method.toUpperCase()
  if (path === "/usage/plan" && m === "GET") {
    const windows = planWindowUse(now)
    const config = getPlanPriority()
    return {
      status: 200,
      body: {
        now,
        ...getClaudeCodeUsage(now),
        holds: activeProviderHolds(now),
        reader: planUsageReader.getState(),
        ...(extra.codex !== undefined && { codex: extra.codex }),
        priority: {
          config,
          windows,
          held: RUN_PRIORITIES.flatMap((p) => {
            const hold = planPriorityHold(p, windows, undefined, config)
            return hold ? [hold] : []
          }),
        },
      },
    }
  }
  if (path === "/usage/plan/lift" && m === "POST") {
    return { status: 200, body: { lifted: liftProviderHolds(now) } }
  }
  return { status: 405, body: { error: "method not allowed" } }
}
