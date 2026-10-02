import { activeProviderHolds, getClaudeCodeUsage, liftProviderHolds } from "@/agents/claude-code-quota"
import type { Reply } from "./restart-api"

// --- HTTP surface for the Claude plan dispatch gate (operator-only; the
// daemon gates it with checkMeshAuth, like /daemon/restart) ---
//
//   GET  /usage/plan       the plan windows as Claude Code last reported
//                          them, the cold-dispatch counters and local caps,
//                          and the windows that hold cold dispatches now
//   POST /usage/plan/lift  drop the active holds; the next cold dispatch
//                          asks Claude again
//
// Pure request → reply mapping over the in-memory gate state.

export const PLAN_USAGE_API_PATHS = new Set(["/usage/plan", "/usage/plan/lift"])

export function handlePlanUsageApi(method: string, path: string, now: number = Date.now()): Reply {
  const m = method.toUpperCase()
  if (path === "/usage/plan" && m === "GET") {
    return { status: 200, body: { now, ...getClaudeCodeUsage(now), holds: activeProviderHolds(now) } }
  }
  if (path === "/usage/plan/lift" && m === "POST") {
    return { status: 200, body: { lifted: liftProviderHolds(now) } }
  }
  return { status: 405, body: { error: "method not allowed" } }
}
