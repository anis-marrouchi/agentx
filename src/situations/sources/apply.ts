import type { SituationsConfig } from "../config"
import type { SituationStore } from "../store"
import { isUnknown, type Signal } from "./types"

// --- A signal moves the record (#1892 phase 3, design 3.4) ---
//
// One rule in phase 3, in code: a `left` signal for a chat in `during`
// moves it to `ending` when the source says nobody but us is left
// (`remaining === 0`). The talk is over for want of anyone to talk to.
//
// Everything else changes nothing, by design:
//   - remaining unknown (null or absent), or the value unknown: unknown is
//     absent (fail open);
//   - others still there: which party is "required" is a template's
//     business (phase 6, `meeting.external`); a conversation does not end
//     because one of several people left;
//   - a person's "not this" override, `ending`, `ended`: left alone;
//   - an expired signal, or the feature `off`.
// Shadow mode writes the record as the gate does (shadow changes no
// delivery, it keeps the record).
//
// The move is the store's conditional write (S9), so a copy of the same
// leave from a second account or a service message does nothing. The
// `why` names the source only, never the person: it reaches the agent's
// prompt.

export function applySignal(store: Pick<SituationStore, "get" | "move">, settings: () => SituationsConfig, s: Signal): { moved: boolean } {
  try {
    if (settings().mode === "off") return { moved: false }
    if (s.kind !== "left" || !s.scope || isUnknown(s)) return { moved: false }
    if (s.expiresAt !== null && s.expiresAt <= Date.now()) return { moved: false }
    if (s.remaining !== 0) return { moved: false }
    const row = store.get(s.scope)
    if (!row || row.phase !== "during" || row.override === "not-this") return { moved: false }
    const moved = store.move(s.scope, { phase: "during", since: row.phaseChangedAt }, "ending", { why: `the last other party left (${s.source})` })
    return { moved }
  } catch {
    return { moved: false }
  }
}
