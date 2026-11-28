# Football bench (Harmonious Agents, tactical layer)

Issue #2567, phase 1. A small turn-based football game used as a
controlled, repeatable experiment for agent coordination. Minutes long,
fast to rerun.

```bash
pnpm bench:football                                  # free-talk (A) vs cue (B), seed 1, 200 ticks
pnpm bench:football --experiment --seed 7            # free talk vs cues against the same opponent, same seed
pnpm bench:football --home cue --away free-talk --budget 1 --ticks 300
pnpm bench:football --out match.json                 # keep every message and move
pnpm bench:football --replay match.json              # re-apply the record on its seed, check, rescore
```

No model is called. The seats are scripted baselines that check the bench
works; they are not research evidence.

## Pieces

| File | What it does |
|---|---|
| `engine.ts` | Grid pitch (12×8 by default), one ball, 3–5 players a side. One decision per player per tick: `stay`, `move`, `pass`, `shoot`. Every chance (pass, shot, tackle, loose ball) comes from a random stream fixed by seed and tick. |
| `referee.ts` | Asks each seat for its move, holds the message budget per team per tick (the rest is dropped and counted), applies the rules, records every message and move. `replayMatch` re-applies a record and names the first tick that differs. |
| `measures.ts` | Reads a record and scores each team. |
| `policies.ts` | `free-talk` (everyone chases, keeps asking in words) and `cue` (typed events only when something changes, no asking). |

A seat is `(view) => { action, say? }`, sync or async, so an agent behind
a mesh can take a seat without changing the engine or the referee.
Teammates hear a message on the next tick; the other team never does.

## Measures

| Measure | Reads as | Harmonious Agents term |
|---|---|---|
| passes landed / tried | handoffs that land | pass = handoff |
| goals per 100 messages | result per unit of talk | Composition's goal |
| collisions | ticks where 2+ teammates chase a ball the team does not have | Crowded Room |
| awareness (ticks) | after losing the ball, mean ticks until each player steps toward the ball or back toward its goal (cap 10) | Tuning |

## Same seed, before and after

The random stream depends only on seed and tick, not on what happened
before. Two matches on the same seed with the same moves are identical;
a fix that changes the moves changes only what follows from them. Compare
a fix by running the same seeds before and after, over several seeds, not
one.

## Not built yet

- Agent seats: two fleets on two meshes (proposed: the Mac node vs the
  `clawd-server` peer), one agent per position, budget set before the run.
- The first experiment with agents in the seats: free talk vs Cue-style
  events, same seed.
