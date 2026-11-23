import { agentDoneGate } from "./daemon-api"
import { PROOF_OFF, type CloseProofCtx } from "./close-proof"
import { DEFAULT_PROMISE_SETTINGS, parseProof, proofRefusal, type PromiseSettings } from "./promise"
import { OPEN_STATES, type RequestStore } from "./store"

// --- "State: done — <proof>" closes the run's own request (#2081) ---
//
// A run that ends with `State: done — <proof>` (or agentx_job_state done)
// had its state written on its job only (jobs/run-state-ledger.ts). The
// open request or promise that run was working on stayed open, so it sat
// on the owner's list after the work was done.
//
// Now the open request linked to the run is closed as done with that
// proof, through the same gates as the agent's own agentx_request done: a
// promise needs a proof (a link here), and proof per deliverable when that
// check is on. The close is the agent's, so the owner-words check reads it
// like any other. Left open: a standing order (only the owner ends it), a
// loop with a checker (its check closes it), or a close a gate refuses.

export type StatedDoneOutcome =
  | { id: string; closed: true }
  | { id: string; closed: false; why: string }

const URL_IN_TEXT = /https?:\/\/[^\s<>()`'"]+/

export function closeOnStatedDone(
  store: RequestStore,
  runIds: Array<string | undefined>,
  proofText: string,
  now: number,
  opts: { promise?: PromiseSettings; closeProof?: CloseProofCtx } = {},
): StatedDoneOutcome | null {
  const open = runIds
    .filter((id): id is string => !!id)
    .map((id) => store.byLink("run", id))
    .find((r) => !!r && (OPEN_STATES as readonly string[]).includes(r.state))
  if (!open) return null
  const text = proofText.trim()
  if (!text) return { id: open.id, closed: false, why: "no proof" }
  if (open.standing) return { id: open.id, closed: false, why: "a standing order: only the owner ends it" }
  if (open.closeWhen) return { id: open.id, closed: false, why: "its check closes it" }
  const url = text.match(URL_IN_TEXT)?.[0].replace(/[.,;:!?]+$/, "")
  const parsed = url ? parseProof(url, now) : null
  const proof = parsed && typeof parsed !== "string" ? parsed : null
  const refused = proofRefusal(open, proof, opts.promise ?? DEFAULT_PROMISE_SETTINGS)
  if (refused) return { id: open.id, closed: false, why: "a promise closes only with a link as its proof" }
  const gate = agentDoneGate(store, open.id, now, opts.closeProof ?? PROOF_OFF)
  if (gate) return { id: open.id, closed: false, why: "proof per deliverable is missing" }
  return store.close(open.id, "done", text, now, proof, open.agentId)
    ? { id: open.id, closed: true }
    : { id: open.id, closed: false, why: "already closed" }
}
