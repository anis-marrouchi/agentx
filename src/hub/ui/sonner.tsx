// From shadcn/ui (MIT, see NOTICE.md), on Sonner (MIT), restyled on the AgentX tokens.
// Transient confirmations only ("Saved"); anything to read, retry or copy
// stays inline (orca-design P10). Bottom right, lucide icons, the popover
// colours and the one radius. Sonner turns its motion off under
// prefers-reduced-motion itself.
import * as React from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { Icon } from "./icons"

export { toast } from "sonner"

const ICONS: ToasterProps["icons"] = {
  success: <Icon name="circle-check" />,
  info: <Icon name="info" />,
  warning: <Icon name="triangle-alert" />,
  error: <Icon name="octagon-x" />,
  loading: <Icon name="loader-circle" className="animate-spin motion-reduce:animate-none" />,
}

const STYLE = {
  "--normal-bg": "var(--ax-surface)",
  "--normal-text": "var(--ax-text)",
  "--normal-border": "var(--ax-border)",
  "--border-radius": "var(--ax-radius)",
} as React.CSSProperties

export function Toaster(props: ToasterProps) {
  return <Sonner position="bottom-right" icons={ICONS} style={STYLE} {...props} />
}
