import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

// --- tldraw offline's local HTTP API ---
//
// The desktop app serves a per-launch port and bearer token from
// server.json; a clean quit removes the file. `/api/doc/:id/exec` runs
// JavaScript against the live editor in that document's window, which is
// what lets one request create a finished shape instead of a dozen cursor
// actions on the toolbar.

export const TLDRAW_SERVER_JSON = join(homedir(), "Library", "Application Support", "tldraw", "server.json")

export interface TldrawDoc { id: string; name: string; filePath: string | null; windowId?: number }

export class TldrawApi {
  constructor(private serverJson = TLDRAW_SERVER_JSON, private fetchFn: typeof fetch = fetch) {}

  /** Port and token are re-read per call: a relaunch rotates both. */
  private server(): { port: number; token: string } {
    let raw: string
    try { raw = readFileSync(this.serverJson, "utf8") } catch {
      throw new Error("tldraw offline is not running (no server.json)")
    }
    const { port, token } = JSON.parse(raw) as { port: number; token: string }
    return { port, token }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const { port, token } = this.server()
    const res = await this.fetchFn(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const data = await res.json() as { success?: boolean; result?: T; error?: string }
    if (!res.ok || data.success === false) throw new Error(`tldraw ${path}: ${data.error ?? res.status}`)
    return data.result as T
  }

  /** Create `<name>.tldraw` in `directory` and open it in a new window. */
  createDoc(name: string, directory?: string): Promise<TldrawDoc> {
    return this.post("/api/docs/create", { name, ...(directory ? { directory } : {}) })
  }

  /** Run `code` (an async function body with `editor`, `helpers`) in a document. */
  exec<T = unknown>(docId: string, code: string): Promise<T> {
    return this.post(`/api/doc/${docId}/exec`, { code })
  }

  /** Run `code` with the `api` object (docs, shapes, screenshots). */
  search<T = unknown>(code: string): Promise<T> {
    return this.post("/api/search", { code })
  }
}
