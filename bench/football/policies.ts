// Scripted team policies for the football bench (#2567).
//
// These are baselines that check the bench works end to end, not research
// evidence: the first experiment proper puts agents in the seats. Both
// teams read the whole pitch; they differ only in how they talk.
//
//   free-talk  everyone runs at a ball the team does not have and keeps
//              asking for it in words, every tick
//   cue        no asking: a player sends a typed event only when something
//              changes (it claims a loose ball, or it gets open), and
//              teammates hold their lane while a claim stands

import { dist, goalCell, type Action, type Cell, type Player } from "./engine"
import type { Decision, PlayerView, TeamPolicy } from "./referee"

const toward = (from: Cell, to: Cell): Action => ({ type: "move", dx: Math.sign(to.x - from.x), dy: Math.sign(to.y - from.y) })
const attackDir = (p: Player) => (p.team === "A" ? 1 : -1)

/** Carrier: shoot when close, pass to an open teammate ahead, else dribble on. */
function carry(v: PlayerView, wanted: Set<string>): Action {
  const goal = goalCell(v.self.team, v.cfg)
  if (dist(v.self, goal) <= 3) return { type: "shoot" }
  const mates = v.state.players.filter((p) => p.team === v.self.team && p.id !== v.self.id)
  const open = (p: Player) => !v.state.players.some((q) => q.team !== p.team && dist(q, p) <= 1)
  const ahead = mates
    .filter((p) => wanted.has(p.id) && open(p) && dist(p, goal) < dist(v.self, goal))
    .sort((a, b) => dist(a, goal) - dist(b, goal))
  if (ahead.length) return { type: "pass", to: ahead[0].id }
  return toward(v.self, goal)
}

/** Lane: keeper stays home, the others push up with the ball when the team has it. */
function lane(v: PlayerView, attacking: boolean): Action {
  const n = Number(v.self.id.slice(1))
  const baseX = n === 1 ? (v.self.team === "A" ? 1 : v.cfg.width - 2) : v.state.ball.x + (attacking ? 2 : -2) * attackDir(v.self)
  const y = Math.round((n * (v.cfg.height - 1)) / (v.cfg.playersPerTeam + 1))
  const target = { x: Math.max(0, Math.min(v.cfg.width - 1, baseX)), y }
  return dist(v.self, target) === 0 ? { type: "stay" } : toward(v.self, target)
}

export const freeTalk: TeamPolicy = {
  name: "free-talk",
  seat: () => (v): Decision => {
    const owner = v.state.players.find((p) => p.id === v.state.ball.owner)
    if (owner?.id === v.self.id) {
      const askers = new Set(v.inbox.filter((m) => m.text?.startsWith("pass")).map((m) => m.from))
      return { action: carry(v, askers), say: [{ text: "I have it, who is open?" }] }
    }
    if (owner?.team === v.self.team) return { action: lane(v, true), say: [{ text: `pass to me, ${v.self.id}?` }] }
    return { action: toward(v.self, v.state.ball), say: [{ text: "going for the ball" }] }
  },
}

export const cue: TeamPolicy = {
  name: "cue",
  seat: () => {
    let toldOpen = false
    return (v): Decision => {
      const owner = v.state.players.find((p) => p.id === v.state.ball.owner)
      const mates = v.state.players.filter((p) => p.team === v.self.team)
      if (owner?.id === v.self.id) {
        toldOpen = false
        const open = new Set(v.inbox.filter((m) => m.cue?.kind === "open").map((m) => m.from))
        // Without a fresh cue, anyone ahead counts as open: cues are sent once.
        for (const p of mates) if (p.id !== v.self.id) open.add(p.id)
        return { action: carry(v, open) }
      }
      if (owner?.team === v.self.team) {
        const marked = v.state.players.some((q) => q.team !== v.self.team && dist(q, v.self) <= 1)
        if (!marked && !toldOpen) { toldOpen = true; return { action: lane(v, true), say: [{ cue: { kind: "open" } }] } }
        return { action: lane(v, true) }
      }
      toldOpen = false
      // Nearest teammate goes for the ball and says so once; the rest hold their lane.
      const claimed = v.inbox.find((m) => m.cue?.kind === "mine")
      const nearest = [...mates].sort((a, b) => dist(a, v.state.ball) - dist(b, v.state.ball) || a.id.localeCompare(b.id))[0]
      if (claimed && claimed.from !== v.self.id) return { action: lane(v, false) }
      if (nearest.id !== v.self.id && !claimed) return { action: lane(v, false) }
      return { action: toward(v.self, v.state.ball), say: claimed ? [] : [{ cue: { kind: "mine" } }] }
    }
  },
}

export const POLICIES: Record<string, TeamPolicy> = { "free-talk": freeTalk, cue }
