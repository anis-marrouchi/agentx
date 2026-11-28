// Referee for the football bench (#2567): asks every player for its move,
// holds the message budget, applies the rules through the engine and
// records every message and move. A recorded match can be replayed: the
// referee re-applies the recorded moves on the same seed and checks that
// every tick comes out the same.

import { DEFAULT_PITCH, kickoff, resolveTick, type Action, type MatchEvent, type MatchState, type PitchConfig, type Player, type TeamId } from "./engine"

/** A message to teammates. `text` is free talk; `cue` is a typed event, no asking. */
export interface Message { from: string; tick: number; text?: string; cue?: { kind: string; [k: string]: unknown } }

export interface PlayerView {
  self: Player
  state: MatchState
  /** Messages teammates sent last tick that the budget let through. */
  inbox: Message[]
  cfg: PitchConfig
}

export interface Decision { action: Action; say?: Omit<Message, "from" | "tick">[] }

/** One seat on the pitch. A scripted policy, or later an agent behind a mesh. */
export type PlayerPolicy = (view: PlayerView) => Decision | Promise<Decision>
/** A team's policy: one seat per player id. */
export type TeamPolicy = { name: string; seat: (playerId: string) => PlayerPolicy }

export interface MatchOptions {
  seed: number
  ticks: number
  /** Messages a team may send per tick; the rest are dropped and counted. */
  messageBudget: number
  pitch?: PitchConfig
}

export interface TickRecord {
  tick: number
  actions: Record<string, Action>
  /** Messages delivered (within budget). */
  messages: Message[]
  /** Messages over the budget, per team. */
  dropped: Record<TeamId, number>
  events: MatchEvent[]
  /** State before this tick resolved. */
  before: MatchState
}

export interface MatchLog {
  version: 1
  options: Required<MatchOptions>
  teams: Record<TeamId, string>
  ticks: TickRecord[]
  final: MatchState
}

export async function playMatch(home: TeamPolicy, away: TeamPolicy, opts: MatchOptions): Promise<MatchLog> {
  const options: Required<MatchOptions> = { pitch: DEFAULT_PITCH, ...opts }
  const cfg = options.pitch
  const teams: Record<TeamId, TeamPolicy> = { A: home, B: away }
  const seats = new Map<string, PlayerPolicy>()
  let state = kickoff(cfg, "A")
  for (const p of state.players) seats.set(p.id, teams[p.team].seat(p.id))

  let inbox: Record<TeamId, Message[]> = { A: [], B: [] }
  const ticks: TickRecord[] = []
  for (let t = 0; t < options.ticks; t++) {
    const before = state
    const decisions = await Promise.all(
      state.players.map(async (p) => {
        const view: PlayerView = { self: { ...p }, state: structuredClone(state), inbox: inbox[p.team], cfg }
        return [p, await seats.get(p.id)!(view)] as const
      }),
    )
    const actions: Record<string, Action> = {}
    const sent: Record<TeamId, Message[]> = { A: [], B: [] }
    const dropped: Record<TeamId, number> = { A: 0, B: 0 }
    for (const [p, d] of decisions) {
      actions[p.id] = d.action
      for (const m of d.say ?? []) {
        if (sent[p.team].length < options.messageBudget) sent[p.team].push({ ...m, from: p.id, tick: before.tick })
        else dropped[p.team]++
      }
    }
    const r = resolveTick(state, actions, options.seed, cfg)
    ticks.push({ tick: before.tick, actions, messages: [...sent.A, ...sent.B], dropped, events: r.events, before })
    state = r.state
    inbox = sent
  }
  return { version: 1, options, teams: { A: home.name, B: away.name }, ticks, final: state }
}

/** Re-apply the recorded moves on the recorded seed. Returns the first tick that differs, or null. */
export function replayMatch(log: MatchLog): { mismatchAt: number | null; final: MatchState } {
  let state = kickoff(log.options.pitch, "A")
  for (const rec of log.ticks) {
    if (JSON.stringify(state) !== JSON.stringify(rec.before)) return { mismatchAt: rec.tick, final: state }
    const r = resolveTick(state, rec.actions, log.options.seed, log.options.pitch)
    if (JSON.stringify(r.events) !== JSON.stringify(rec.events)) return { mismatchAt: rec.tick, final: r.state }
    state = r.state
  }
  const same = JSON.stringify(state) === JSON.stringify(log.final)
  return { mismatchAt: same ? null : log.ticks.length, final: state }
}
