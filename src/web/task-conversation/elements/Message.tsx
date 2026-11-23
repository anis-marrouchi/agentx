import type { ReactNode } from "react"

// AI Elements' Message: one turn of the conversation, the agent's on the
// left with its name; the steps and the reply under it.
export function Message({ from, children }: { from: "assistant" | "user"; children: ReactNode }) {
  return <div className={`axc-msg axc-msg--${from}`}>{children}</div>
}
