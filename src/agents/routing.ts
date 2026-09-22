import { askSeat } from "@/decisions/seat"
import {
  TASK_TIER_SEAT,
  taskTierQuestions,
  taskTierState,
  needsFlagship,
  type TaskTierAnswers,
  type TaskTierInput,
} from "@/decisions/seats/task-tier"

// Picking a cheaper model for work that does not need an expensive one.
//
// The policy, in one line: keep the flagship unless the seat is ACTIVE and
// confidently says the task is mechanical.
//
// Every branch that is not that leads to the flagship — seat off, seat in
// shadow, backend unreachable, answer above the threshold, no cheap model
// configured, a follow-up turn. That is not defensiveness for its own
// sake. Downgrading is invisible in the output: the reply still arrives,
// still reads fluently, and is simply worse in ways nobody checks. An
// outage that silently made the whole fleet dumber would cost far more
// than the tokens it saved, so the failure has to land on the expensive
// side.
//
// Follow-ups are where this gets interesting, and the answer is
// arithmetic rather than caution.
//
// Switching models mid-session is mechanically trivial — the session is a
// transcript and the model is a per-invocation flag, which is exactly what
// Claude Code's /model does. The cost is that the PROMPT CACHE IS PER
// MODEL. Resuming on a different model means that model has no cache for
// the transcript and reads all of it at full price.
//
// Published rates, opus-5 against haiku-4.5:
//
//   opus cached read   $0.50/M        haiku uncached read  $1.00/M
//   opus output       $25.00/M        haiku output          $5.00/M
//
// So the swap costs 2x more on input and saves $20/M on output, and it is
// cheaper only when
//
//   session_tokens < 40 x reply_tokens
//
// A task worth downgrading is by definition one whose answer is short —
// an acknowledgement, a status echo. Ten tokens of reply puts the
// break-even at a 400-token session. On any real conversation the swap
// LOSES, and it loses precisely on the traffic this seat exists to catch.
//
// That reverses once the cache is COLD. After the cache TTL there is no
// cached read to give up: opus pays $5.00/M and haiku $1.00/M, and the
// cheap model wins outright. So a follow-up is routable exactly when the
// session has been idle long enough that nothing is cached any more.

/** Below this P(needs the strongest model), a cheaper one will do.
 *
 *  Low on purpose. This is not the point at which a small model becomes
 *  adequate — it is the point past which being wrong is cheap, and the
 *  asymmetry between "saved a fraction of a cent" and "gave a subtly wrong
 *  answer nobody caught" is not close. */
const DOWNGRADE_BELOW = 0.2

/** How long a cached prefix is assumed to live. Anthropic's default TTL is
 *  five minutes with a one-hour option; an hour is assumed here because it
 *  is the assumption whose error is cheap — see the note above. */
const CACHE_TTL_MS = 60 * 60 * 1000

/** Resolve only models compatible with the agent's CLI engine. An omitted
 *  model leaves the agent on its configured default. */
export function cheapModelForEngine(
  tier: string,
  routing?: { cheapModel?: string; cheapModels?: { "claude-code"?: string; "codex-cli"?: string } },
): string | undefined {
  if (tier === "claude-code") {
    const model = routing?.cheapModels?.[tier] ?? routing?.cheapModel
    return model && /^(claude-|haiku$|sonnet$|opus$)/.test(model) ? model : undefined
  }
  if (tier === "codex-cli") {
    const model = routing?.cheapModels?.[tier]
    return model && /^(gpt-|o\d)/.test(model) ? model : undefined
  }
  return undefined
}

export interface RouteResult {
  /** The model to use, or undefined to leave the agent's own default. */
  model?: string
  /** True when this call moved the task off the flagship. */
  downgraded: boolean
  /** P(needs the strongest model), or null when nothing was asked. */
  needsFlagship: number | null
  reason: string
}

export interface RouteOptions extends TaskTierInput {
  /** The model to drop to. Usually from config; no downgrade without it. */
  cheapModel?: string | null
  threshold?: number
  /** Idle time on the session being resumed, or null when starting fresh.
   *  Only consulted for follow-ups. */
  sessionIdleMs?: number | null
  /** How long a cached prefix is assumed to survive. */
  cacheTtlMs?: number
}

/**
 * Decide whether this task can run on a cheaper model.
 *
 * Never throws and never blocks: a routing decision must not be able to
 * stop a task from running.
 */
export async function routeTaskModel(opts: RouteOptions): Promise<RouteResult> {
  const keep = (reason: string, p: number | null = null): RouteResult => ({
    downgraded: false, needsFlagship: p, reason,
  })

  if (opts.channel === "voice" || opts.channel === "desktop") return keep("desktop requests retain the configured model")

  if (!opts.cheapModel) return keep("no cheaper model configured")

  // A follow-up onto a WARM cache is the losing case above. Idle longer
  // than the TTL and there is nothing left to lose, so it is routable.
  //
  // One hour, not the five-minute default, because the assumption has to
  // be the one that fails safely: over-estimating how long the cache lives
  // means occasionally keeping the flagship when a swap would have been
  // free, while under-estimating means routinely paying double on input.
  if (opts.isFollowUp) {
    const idle = opts.sessionIdleMs ?? 0
    const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS
    if (idle < ttl) {
      return keep(`follow-up on a warm cache (idle ${Math.round(idle / 1000)}s) — swapping would cost more than it saves`)
    }
  }

  let result
  try {
    result = await askSeat(
      TASK_TIER_SEAT,
      taskTierState(opts),
      taskTierQuestions,
      {
        // The incumbent is "always flagship", which is what this has to beat.
        incumbent: { needsFlagship: 1 },
        features: { agent: opts.agent, channel: opts.channel ?? "unknown" },
      },
    )
  } catch {
    return keep("routing seat threw — keeping the flagship")
  }

  if (!result) return keep("routing seat unavailable — keeping the flagship")

  const p = needsFlagship(result.answers as TaskTierAnswers)

  // Shadow records the answer and changes nothing. This is the whole
  // point of a soak: the rows accumulate against real traffic while the
  // incumbent stays authoritative, so promotion is a decision made on
  // evidence rather than on how good the idea sounded.
  if (result.mode !== "active") {
    return keep(`shadow — would ${p < (opts.threshold ?? DOWNGRADE_BELOW) ? "downgrade" : "keep"} (${p.toFixed(2)})`, p)
  }

  const threshold = opts.threshold ?? DOWNGRADE_BELOW
  if (p >= threshold) return keep(`needs the flagship (${p.toFixed(2)})`, p)

  return {
    model: opts.cheapModel,
    downgraded: true,
    needsFlagship: p,
    reason: `mechanical task (${p.toFixed(2)} below ${threshold}) → ${opts.cheapModel}`,
  }
}
