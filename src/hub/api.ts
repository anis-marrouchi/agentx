// --- The Hub's one API client (#2218 part 1) ---
//
// Every read goes through here, so the token, the error shape and the
// sign-in redirect are written once. On this machine the page carries
// AX_LOCAL_TOKEN; from off the box the session cookie carries the call.

export class HubApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function headers(extra?: HeadersInit): Headers {
  const h = new Headers(extra)
  const token = typeof window !== "undefined" ? window.AX_LOCAL_TOKEN : undefined
  if (token && !h.has("Authorization")) h.set("Authorization", "Bearer " + token)
  // The daemon refuses a write without it (board-dashboard.ts), as for the old Hub.
  if (!h.has("X-Requested-With")) h.set("X-Requested-With", "agentx-board")
  return h
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: headers(init.headers) })
  if (!res.ok) {
    let msg = res.statusText || "request failed"
    try { const body = await res.json(); if (body && typeof body.error === "string") msg = body.error } catch { /* not JSON */ }
    throw new HubApiError(res.status, msg)
  }
  return (await res.json()) as T
}

export const apiGet = <T,>(path: string) => apiFetch<T>(path)
/** A write; `peer` sends it to the mesh node that keeps the item. */
export const apiPost = <T,>(path: string, body: unknown, peer?: string | null) =>
  apiFetch<T>(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...(peer ? { "X-Agentx-Peer": peer } : {}) } })

/** A text reply, such as an SVG to draw as an image; "" when there is none (204). */
export async function apiText(path: string): Promise<string> {
  const res = await fetch(path, { credentials: "same-origin", headers: headers() })
  if (!res.ok) throw new HubApiError(res.status, res.statusText || "request failed")
  return res.status === 204 ? "" : res.text()
}
