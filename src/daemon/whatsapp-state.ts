// --- WhatsApp pairing state (daemon-local, in-memory) ---
//
// The WhatsApp adapter emits a QR string every time a fresh pairing is needed
// (first run, after logout, after 440/408 timeouts). We stash the latest QR +
// connection state here so the admin dashboard can poll for it and render an
// inline pairing image without touching the daemon logs.
//
// All state is intentionally in-memory: if the daemon restarts, the adapter
// reconnects and re-emits anyway. Nothing here is sensitive — the QR is only
// useful to the person with physical access to the WhatsApp account.

export type WhatsAppConnection = "init" | "connecting" | "open" | "close"

export interface WhatsAppState {
  connection: WhatsAppConnection
  detail?: string
  qr: string | null
  qrUpdatedAt?: string
  statusUpdatedAt?: string
}

const state: WhatsAppState = {
  connection: "init",
  qr: null,
}

export function setWhatsAppQR(qr: string | null): void {
  state.qr = qr
  state.qrUpdatedAt = new Date().toISOString()
}

export function setWhatsAppStatus(connection: WhatsAppConnection, detail?: string): void {
  state.connection = connection
  state.detail = detail
  state.statusUpdatedAt = new Date().toISOString()
  if (connection === "open") state.qr = null
}

export function getWhatsAppState(): WhatsAppState {
  return { ...state }
}
