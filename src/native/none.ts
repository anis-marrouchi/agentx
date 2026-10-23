import type { NativeAdapter } from "./types"

/** The adapter for a machine AgentX has no OS layer for, or where the owner
 *  turned it off. Every capability is absent; describe() says why. */
export function noneAdapter(reason: string): NativeAdapter {
  return {
    os: "none",
    async describe() {
      return { os: "none", tasks: false, notes: false, banner: false, sound: false, focus: false, problems: [reason] }
    },
  }
}
