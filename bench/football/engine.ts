// Minimal football engine for the Harmonious Agents test bench (#2567).
//
// A grid pitch, one ball, two teams of 3-5 players. Turn based: every
// player makes one decision per tick, then the tick resolves at once.
// All chance (passes, shots, tackles, loose-ball contests) is drawn from a
// random stream fixed by (seed, tick), so the same actions on the same seed
// always give the same match. That is what lets a recorded match be
// replayed and a fix be scored before and after on the same seed.

export type TeamId = "A" | "B"
export interface Cell { x: number; y: number }
export interface Player extends Cell { id: string; team: TeamId }
export interface Ball extends Cell { owner: string | null }

export type Action =
  | { type: "stay" }
  | { type: "move"; dx: number; dy: number }
  | { type: "pass"; to: string }
  | { type: "shoot" }

export interface PitchConfig { width: number; height: number; playersPerTeam: number }
export const DEFAULT_PITCH: PitchConfig = { width: 12, height: 8, playersPerTeam: 4 }

export interface MatchState {
  tick: number
  players: Player[]
  ball: Ball
  score: Record<TeamId, number>
}

/** What happened in a tick, for the referee's record and the measures. */
export type MatchEvent =
  | { kind: "pass"; from: string; to: string; ok: boolean; gotBy: string | null }
  | { kind: "shot"; by: string; goal: boolean }
  | { kind: "tackle"; by: string; on: string; ok: boolean }
  | { kind: "pickup"; by: string; contested: string[] }
  | { kind: "possession"; from: TeamId | null; to: TeamId }
  | { kind: "kickoff"; team: TeamId }
  | { kind: "invalid"; by: string; action: Action["type"] }

export const other = (t: TeamId): TeamId => (t === "A" ? "B" : "A")
export const dist = (a: Cell, b: Cell) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))

/** The goal a team attacks: A attacks the right edge, B the left. */
export function goalCell(team: TeamId, cfg: PitchConfig): Cell {
  return { x: team === "A" ? cfg.width - 1 : 0, y: Math.floor(cfg.height / 2) }
}

/** mulberry32 seeded by (seed, tick): the stream does not depend on what the players did before. */
export function tickRng(seed: number, tick: number): () => number {
  let a = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(tick + 1, 0x85ebca6b)) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function teamOf(state: MatchState, id: string | null): TeamId | null {
  return id ? state.players.find((p) => p.id === id)?.team ?? null : null
}

/** Players line up in their own half; the kicking-off team gets the ball. */
export function kickoff(cfg: PitchConfig, team: TeamId, prev?: MatchState): MatchState {
  const players: Player[] = []
  for (const t of ["A", "B"] as TeamId[]) {
    for (let i = 0; i < cfg.playersPerTeam; i++) {
      const depth = i === 0 ? 1 : 2 + (i % 2) * 2
      const x = t === "A" ? depth : cfg.width - 1 - depth
      const y = Math.round(((i + 1) * (cfg.height - 1)) / (cfg.playersPerTeam + 1))
      players.push({ id: `${t}${i + 1}`, team: t, x, y })
    }
  }
  const striker = players.filter((p) => p.team === team).at(-1)!
  striker.x = team === "A" ? Math.floor(cfg.width / 2) - 1 : Math.ceil(cfg.width / 2)
  striker.y = Math.floor(cfg.height / 2)
  return {
    tick: prev?.tick ?? 0,
    players,
    ball: { x: striker.x, y: striker.y, owner: striker.id },
    score: prev ? { ...prev.score } : { A: 0, B: 0 },
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const step = (v: number) => clamp(Math.round(v), -1, 1)

/** Resolve one tick. Pure: returns the next state and what happened. */
export function resolveTick(
  state: MatchState,
  actions: Record<string, Action>,
  seed: number,
  cfg: PitchConfig = DEFAULT_PITCH,
): { state: MatchState; events: MatchEvent[] } {
  const rng = tickRng(seed, state.tick)
  const s: MatchState = structuredClone(state)
  const events: MatchEvent[] = []
  const byId = new Map(s.players.map((p) => [p.id, p]))
  const startTeam = teamOf(s, s.ball.owner)
  let scored: TeamId | null = null
  let goalKickFor: TeamId | null = null

  // 1. The carrier's pass or shot goes first.
  for (const p of s.players) {
    const a = actions[p.id] ?? { type: "stay" }
    if ((a.type === "pass" || a.type === "shoot") && s.ball.owner !== p.id) {
      events.push({ kind: "invalid", by: p.id, action: a.type })
      continue
    }
    if (a.type === "pass") {
      const to = byId.get(a.to)
      if (!to || to.team !== p.team || to.id === p.id) { events.push({ kind: "invalid", by: p.id, action: "pass" }); continue }
      const markers = s.players.filter((q) => q.team !== p.team && dist(q, to) <= 1)
      const chance = clamp(0.95 - 0.05 * dist(p, to) - 0.25 * markers.length, 0.1, 0.95)
      const ok = rng() < chance
      const gotBy = ok ? to.id : markers.length ? markers[Math.floor(rng() * markers.length)].id : null
      s.ball = { x: to.x, y: to.y, owner: gotBy }
      if (gotBy) { const g = byId.get(gotBy)!; s.ball.x = g.x; s.ball.y = g.y }
      events.push({ kind: "pass", from: p.id, to: to.id, ok, gotBy })
    } else if (a.type === "shoot") {
      const d = dist(p, goalCell(p.team, cfg))
      const goal = rng() < Math.max(0.03, 0.65 - 0.1 * d)
      events.push({ kind: "shot", by: p.id, goal })
      if (goal) scored = p.team
      else goalKickFor = other(p.team)
    }
  }

  if (scored) {
    s.score[scored]++
    const next = kickoff(cfg, other(scored), s)
    next.tick = s.tick + 1
    events.push({ kind: "kickoff", team: other(scored) })
    events.push({ kind: "possession", from: startTeam, to: other(scored) })
    return { state: next, events }
  }
  if (goalKickFor) {
    const keeper = s.players.find((q) => q.id === `${goalKickFor}1`)!
    s.ball = { x: keeper.x, y: keeper.y, owner: keeper.id }
  }

  // 2. Everyone who moved moves at once; the carrier takes the ball along.
  for (const p of s.players) {
    const a = actions[p.id]
    if (a?.type !== "move") continue
    p.x = clamp(p.x + step(a.dx), 0, cfg.width - 1)
    p.y = clamp(p.y + step(a.dy), 0, cfg.height - 1)
    if (s.ball.owner === p.id) { s.ball.x = p.x; s.ball.y = p.y }
  }

  // 3. A loose ball goes to whoever stands on it; a carrier can be tackled.
  const onBall = s.players.filter((p) => p.x === s.ball.x && p.y === s.ball.y)
  if (!s.ball.owner && onBall.length) {
    const winner = onBall[Math.floor(rng() * onBall.length)]
    s.ball.owner = winner.id
    events.push({ kind: "pickup", by: winner.id, contested: onBall.map((p) => p.id) })
  } else if (s.ball.owner) {
    const carrier = byId.get(s.ball.owner)!
    for (const q of onBall) {
      if (q.team === carrier.team) continue
      const ok = rng() < 0.4
      events.push({ kind: "tackle", by: q.id, on: carrier.id, ok })
      if (ok) { s.ball.owner = q.id; break }
    }
  }

  const endTeam = teamOf(s, s.ball.owner)
  if (endTeam && endTeam !== startTeam) events.push({ kind: "possession", from: startTeam, to: endTeam })
  s.tick++
  return { state: s, events }
}
