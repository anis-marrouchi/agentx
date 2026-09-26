import { captureAround, type Region, type Shot } from "@/computer-use/capture"
import type { LocalAlert } from "./local"

// Proof that a banner rendered: `agentx notify --proof`.
//
// Wraps the local alert so the capture is armed on the banner region
// before the banner is posted, and returns the first frame after the
// region changed and settled. A banner is gone within seconds; a capture
// taken whenever the caller gets round to it finds an empty corner.

export interface Proof {
  /** The frame showing the banner, when one was captured. */
  shot: Shot | null
  /** Why there is no usable proof: no banner was posted, the region never
   *  changed, or the capture itself failed. */
  error?: string
}

export function proofAlert(
  alert: LocalAlert,
  region: Region,
  deps: Parameters<typeof captureAround>[3] = {},
): { alert: LocalAlert; proof: () => Proof } {
  let proof: Proof = { shot: null, error: "no banner was shown (held for Focus, or the banner is off)" }
  return {
    alert: async (title, message) => {
      const { shot, error } = await captureAround(() => alert(title, message), region, {}, deps)
      proof = shot?.timedOut && !shot.changed
        ? { shot, error: "the banner region did not change — Do Not Disturb, or notifications not allowed" }
        : { shot, error }
    },
    proof: () => proof,
  }
}
