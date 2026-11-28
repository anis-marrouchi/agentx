import { describe, expect, it } from "vitest"
import { DEFAULT_PITCH, kickoff, resolveTick, tickRng, type MatchState } from "../bench/football/engine"
import { measure } from "../bench/football/measures"
import { cue, freeTalk } from "../bench/football/policies"
import { playMatch, replayMatch, type TeamPolicy } from "../bench/football/referee"

const opts = { seed: 7, ticks: 120, messageBudget: 2 }

describe("football bench engine", () => {
  it("draws the same chance for the same seed and tick, whatever came before", () => {
    const a = tickRng(7, 30), b = tickRng(7, 30), c = tickRng(8, 30)
    const xs = [a(), a(), a()]
    expect([b(), b(), b()]).toEqual(xs)
    expect([c(), c(), c()]).not.toEqual(xs)
  })

  it("kicks off with the ball at the kicking team's striker", () => {
    const s = kickoff(DEFAULT_PITCH, "B")
    expect(s.players).toHaveLength(8)
    expect(s.ball.owner?.startsWith("B")).toBe(true)
  })

  it("treats a pass or shot by a player without the ball as invalid", () => {
    const s = kickoff(DEFAULT_PITCH, "A")
    const r = resolveTick(s, { B2: { type: "shoot" } }, 1)
    expect(r.events).toContainEqual({ kind: "invalid", by: "B2", action: "shoot" })
    expect(r.state.score).toEqual({ A: 0, B: 0 })
  })

  it("restarts from kickoff for the other team after a goal", () => {
    const s: MatchState = kickoff(DEFAULT_PITCH, "A")
    const striker = s.players.find((p) => p.id === s.ball.owner)!
    striker.x = DEFAULT_PITCH.width - 2
    s.ball.x = striker.x
    // Find a seed where the close shot goes in.
    const seed = [...Array(50).keys()].find((k) => resolveTick(s, { [striker.id]: { type: "shoot" } }, k).state.score.A === 1)!
    const r = resolveTick(s, { [striker.id]: { type: "shoot" } }, seed)
    expect(r.events).toContainEqual({ kind: "kickoff", team: "B" })
    expect(r.state.ball.owner?.startsWith("B")).toBe(true)
    expect(r.state.tick).toBe(1)
  })
})

describe("football bench referee", () => {
  it("plays the same match twice on the same seed", async () => {
    const a = await playMatch(freeTalk, cue, opts)
    const b = await playMatch(freeTalk, cue, opts)
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it("replays a recorded match identically and catches a changed move", async () => {
    const log = await playMatch(cue, freeTalk, opts)
    expect(replayMatch(log).mismatchAt).toBeNull()
    const moved = log.ticks.findIndex((t) => Object.values(t.actions).some((a) => a.type === "move"))
    const id = Object.keys(log.ticks[moved].actions).find((k) => log.ticks[moved].actions[k].type === "move")!
    log.ticks[moved].actions[id] = { type: "stay" }
    expect(replayMatch(log).mismatchAt).not.toBeNull()
  })

  it("holds the message budget per team and counts what it drops", async () => {
    const chatty: TeamPolicy = { name: "chatty", seat: () => () => ({ action: { type: "stay" }, say: [{ text: "a" }, { text: "b" }] }) }
    const log = await playMatch(chatty, cue, { ...opts, ticks: 3, messageBudget: 3 })
    const t0 = log.ticks[0]
    expect(t0.messages.filter((m) => m.from.startsWith("A"))).toHaveLength(3)
    expect(t0.dropped.A).toBe(5)
    expect(log.ticks[1].before.tick).toBe(1)
  })

  it("delivers a message to teammates on the next tick, never to the other team", async () => {
    const heard: Record<string, string[][]> = { A3: [], B2: [] }
    const listen = (id: string, inbox: { from: string }[]) => { if (heard[id]) heard[id].push(inbox.map((m) => m.from)) }
    const talker: TeamPolicy = { name: "talker", seat: (id) => (v) => { listen(id, v.inbox); return { action: { type: "stay" }, say: id === "A2" ? [{ text: "hi" }] : [] } } }
    const ear: TeamPolicy = { name: "ear", seat: (id) => (v) => { listen(id, v.inbox); return { action: { type: "stay" } } } }
    await playMatch(talker, ear, { ...opts, ticks: 3 })
    expect(heard.A3).toEqual([[], ["A2"], ["A2"]])
    expect(heard.B2.flat()).toEqual([])
  })
})

describe("football bench measures", () => {
  it("scores both teams and shows cues cost fewer messages than free talk", async () => {
    const log = await playMatch(cue, freeTalk, opts)
    const m = measure(log)
    expect(m.A.goals).toBe(log.final.score.A)
    expect(m.A.messages).toBeLessThan(m.B.messages)
    expect(m.B.messages + m.B.dropped).toBe(opts.ticks * DEFAULT_PITCH.playersPerTeam)
    expect(m.A.passesLanded).toBeLessThanOrEqual(m.A.passesTried)
    expect(m.B.collisions).toBeGreaterThan(m.A.collisions)
  })
})
