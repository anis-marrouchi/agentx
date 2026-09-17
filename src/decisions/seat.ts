import { getDecisionBackend } from "./backend"
import { DecisionStore, type SeatMode } from "./store"
import type { AnswersFor, Questions, StateValue } from "./types"

// askSeat — the only entry point a call site should use.
//
// Three properties it must have, in priority order:
//
//   1. It never throws. A seat is an addition to a call site that already
//      works; a decision backend having a bad day must not take down the
//      dispatch path it was bolted onto. Every failure returns null and the
//      caller keeps its existing behaviour.
//
//   2. Every failure is still a row. A seat that records only its successes
//      flatters itself exactly where it matters — a backend that times out
//      on the hard half of the traffic would otherwise show beautiful
//      calibration on the easy half.
//
//   3. Default off. A seat does nothing until an operator names it in
//      config or the environment, and `shadow` never changes behaviour —
//      it only records, so the incumbent stays authoritative through the
//      whole soak.

export interface SeatSettings {
  mode: SeatMode
  backend?: string
  model?: string
  timeoutMs?: number
  /** Post-hoc temperature from a fit on this seat's own labeled rows.
   *  1 means "not calibrated yet", which is where every seat starts. */
  temperature?: number
  /** Stop persisting state once this many rows exist for the seat. */
  keepStateRows?: number
  redactState?: boolean
}

export interface DecisionsRuntime {
  enabled: boolean
  defaultBackend: string
  seats: Record<string, SeatSettings>
  store: DecisionStore | null
}

const DEFAULT_RUNTIME: DecisionsRuntime = {
  enabled: false,
  defaultBackend: "local",
  seats: {},
  store: null,
}

let runtime: DecisionsRuntime = { ...DEFAULT_RUNTIME }

/** Called once by the daemon after config load. Until it is, every seat is
 *  off and askSeat is a null-returning no-op. */
export function configureDecisions(next: Partial<DecisionsRuntime>): void {
  runtime = { ...DEFAULT_RUNTIME, ...runtime, ...next }
}

export function resetDecisionsRuntime(): void {
  runtime = { ...DEFAULT_RUNTIME, seats: {} }
}

export function decisionsRuntime(): DecisionsRuntime {
  return runtime
}

const VALID_MODES: readonly SeatMode[] = ["off", "shadow", "active"]

export function parseSeatMode(value: unknown): SeatMode | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return (VALID_MODES as readonly string[]).includes(normalized)
    ? (normalized as SeatMode)
    : null
}

/** `monitor-prefilter` -> AGENTX_DECISION_SEAT_MONITOR_PREFILTER */
export function seatEnvVar(seat: string): string {
  return `AGENTX_DECISION_SEAT_${seat.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
}

/**
 * Resolve a seat's mode. Order: per-seat env var, then config, then "off".
 *
 * An invalid value at any level falls through to the next rather than
 * failing loudly — same trade as src/intent/mode.ts. The cost is silence on
 * a typo; the cost of the alternative is a seat accidentally promoted to
 * `active` because someone wrote "Active " with a trailing space.
 *
 * Read every call, never cached, so an operator can flip a seat off without
 * restarting the daemon.
 */
export function getSeatMode(seat: string, env: NodeJS.ProcessEnv = process.env): SeatMode {
  const fromEnv = parseSeatMode(env[seatEnvVar(seat)])
  if (fromEnv) return fromEnv
  if (!runtime.enabled) return "off"
  return parseSeatMode(runtime.seats[seat]?.mode) ?? "off"
}

export interface AskSeatOptions<Q extends Questions> {
  /** What the code would do without the seat. Recorded alongside, which is
   *  what makes agreement and the eventual promotion decision measurable. */
  incumbent?: Partial<Record<keyof Q & string, string | number>>
  links?: Array<{ kind: string; id: string }>
  signal?: AbortSignal
  timeoutMs?: number
  backend?: string
  model?: string
}

export interface SeatResult<Q extends Questions> {
  answers: AnswersFor<Q>
  callId: string | null
  mode: SeatMode
}

let lastWarnAt = 0

export async function askSeat<Q extends Questions>(
  seat: string,
  state: StateValue,
  questions: Q,
  opts: AskSeatOptions<Q> = {},
): Promise<SeatResult<Q> | null> {
  const mode = getSeatMode(seat)
  if (mode === "off") return null

  const settings = runtime.seats[seat] ?? { mode }
  const backendName = opts.backend ?? settings.backend ?? runtime.defaultBackend
  const started = Date.now()

  try {
    const backend = getDecisionBackend(backendName)
    const response = await backend.decide({
      state,
      questions,
      model: opts.model ?? settings.model,
      abortSignal: opts.signal,
      timeoutMs: opts.timeoutMs ?? settings.timeoutMs,
    })

    const callId = record(seat, mode, state, questions, response, opts, settings)
    return { answers: response.answers, callId, mode }
  } catch (err: any) {
    recordFailure(seat, mode, state, questions, backendName, opts, settings, started, err)
    warnThrottled(seat, backendName, err)
    return null
  }
}

function record<Q extends Questions>(
  seat: string,
  mode: SeatMode,
  state: StateValue,
  questions: Q,
  response: Awaited<ReturnType<ReturnType<typeof getDecisionBackend>["decide"]>>,
  opts: AskSeatOptions<Q>,
  settings: SeatSettings,
): string | null {
  if (!runtime.store) return null
  try {
    return runtime.store.recordCall({
      seat,
      mode,
      backend: response.meta.backend,
      model: response.model,
      meta: response.meta,
      state,
      questions,
      answers: response.answers as Record<string, any>,
      usage: response.usage,
      incumbent: toIncumbent(opts.incumbent),
      links: opts.links,
      keepState: !settings.redactState,
    })
  } catch {
    // Recording is observability. It never breaks the call it observes.
    return null
  }
}

function recordFailure<Q extends Questions>(
  seat: string,
  mode: SeatMode,
  state: StateValue,
  questions: Q,
  backend: string,
  opts: AskSeatOptions<Q>,
  settings: SeatSettings,
  started: number,
  err: any,
): void {
  if (!runtime.store) return
  try {
    runtime.store.recordCall({
      seat,
      mode,
      backend,
      model: opts.model ?? settings.model ?? "unknown",
      meta: {
        structureMode: "text",
        answerMode: "probabilities",
        retries: 0,
        stateTruncated: false,
        latencyMs: Date.now() - started,
      },
      state,
      questions,
      answers: {},
      incumbent: toIncumbent(opts.incumbent),
      links: opts.links,
      error: String(err?.message ?? err).slice(0, 500),
      keepState: !settings.redactState,
    })
  } catch {
    /* observability never breaks the caller */
  }
}

function toIncumbent(
  incumbent: Record<string, string | number | undefined> | undefined,
): Record<string, { value: string | number }> | undefined {
  if (!incumbent) return undefined
  const out: Record<string, { value: string | number }> = {}
  for (const [question, value] of Object.entries(incumbent)) {
    if (value !== undefined) out[question] = { value }
  }
  return out
}

/** At most one line a minute. A backend that is down fails on every call,
 *  and a log line per call would bury the thing that actually broke. */
function warnThrottled(seat: string, backend: string, err: any): void {
  const now = Date.now()
  if (now - lastWarnAt < 60_000) return
  lastWarnAt = now
  console.warn(
    `[decisions] seat "${seat}" on backend "${backend}" failed: ${err?.message ?? err}`,
  )
}
