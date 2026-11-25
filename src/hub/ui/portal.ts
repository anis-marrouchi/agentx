// Radix draws dialogs and tooltips in a portal on <body>, outside the React
// root. The Hub's styles are scoped to `.ax-hub` (C1: old pages do not
// change), so portals go into one `.ax-hub` host of their own.

let host: HTMLElement | null = null

export function hubPortal(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined
  if (host && host.isConnected) return host
  host = document.getElementById("ax-hub-portal")
  if (!host) {
    host = document.createElement("div")
    host.id = "ax-hub-portal"
    host.className = "ax-hub"
    document.body.appendChild(host)
  }
  return host
}
