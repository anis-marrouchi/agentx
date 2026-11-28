// Measures for the football bench (#2567), read from a recorded match.
//
//   passes      handoffs tried and handoffs that landed
//   goals/100   goals per hundred messages the team sent (talk has a cost)
//   collisions  ticks where two or more teammates chased a ball their team
//               does not have, loose or carried (Crowded Room)
//   awareness   after the team loses the ball, mean ticks until each of its
//               players first reacts: steps toward the ball or back toward
//               its own goal (Tuning)

import { dist, goalCell, other, type MatchState, type TeamId } from "./engine"
import type { MatchLog } from "./referee"

export interface TeamMeasures {
  goals: number
  passesTried: number
  passesLanded: number
  messages: number
  dropped: number
  goalsPer100Messages: number | null
  collisions: number
  turnoversLost: number
  /** Mean ticks to react after losing the ball; null when the team never lost it. */
  awarenessTicks: number | null
}

/** Ticks a player gets to react before it counts as not having noticed. */
export const AWARENESS_WINDOW = 10

export function measure(log: MatchLog): Record<TeamId, TeamMeasures> {
  const out = {} as Record<TeamId, TeamMeasures>
  for (const team of ["A", "B"] as TeamId[]) {
    const mine = (id: string) => id.startsWith(team)
    let passesTried = 0, passesLanded = 0, messages = 0, collisions = 0
    for (const rec of log.ticks) {
      for (const e of rec.events) {
        if (e.kind === "pass" && mine(e.from)) { passesTried++; if (e.ok) passesLanded++ }
      }
      messages += rec.messages.filter((m) => mine(m.from)).length
      if (chasers(rec.before, rec.actions, team) >= 2) collisions++
    }
    const dropped = log.ticks.reduce((n, r) => n + r.dropped[team], 0)
    const lags = awareness(log, team)
    const goals = log.final.score[team]
    out[team] = {
      goals,
      passesTried,
      passesLanded,
      messages,
      dropped,
      goalsPer100Messages: messages ? (goals * 100) / messages : null,
      collisions,
      turnoversLost: lags.turnovers,
      awarenessTicks: lags.samples.length ? lags.samples.reduce((a, b) => a + b, 0) / lags.samples.length : null,
    }
  }
  return out
}

/** Teammates moving closer to a ball their team does not have this tick. */
function chasers(before: MatchState, actions: MatchLog["ticks"][number]["actions"], team: TeamId): number {
  if (before.ball.owner?.startsWith(team)) return 0
  let n = 0
  for (const p of before.players) {
    const a = actions[p.id]
    if (p.team !== team || a?.type !== "move") continue
    const next = { x: p.x + Math.sign(a.dx), y: p.y + Math.sign(a.dy) }
    if (dist(next, before.ball) < dist(p, before.ball)) n++
  }
  return n
}

function awareness(log: MatchLog, team: TeamId): { turnovers: number; samples: number[] } {
  const samples: number[] = []
  let turnovers = 0
  log.ticks.forEach((rec, i) => {
    const lost = rec.events.some((e) => e.kind === "possession" && e.from === team && e.to === other(team))
    const goalAgainst = rec.events.some((e) => e.kind === "kickoff")
    if (!lost || goalAgainst) return
    turnovers++
    const own = goalCell(other(team), log.options.pitch)
    for (const p0 of rec.before.players.filter((p) => p.team === team)) {
      let lag = AWARENESS_WINDOW
      for (let j = i + 1; j < Math.min(log.ticks.length, i + 1 + AWARENESS_WINDOW); j++) {
        const r = log.ticks[j]
        const p = r.before.players.find((q) => q.id === p0.id)!
        const a = r.actions[p.id]
        if (a?.type !== "move") continue
        const next = { x: p.x + Math.sign(a.dx), y: p.y + Math.sign(a.dy) }
        if (dist(next, r.before.ball) < dist(p, r.before.ball) || dist(next, own) < dist(p, own)) { lag = j - i; break }
      }
      samples.push(lag)
    }
  })
  return { turnovers, samples }
}
