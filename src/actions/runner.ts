import { exec } from "child_process"
import type { Action, ActionRunResult, ActionInput } from "./types"

// --- Action runner ---
//
// Resolves {{name}} markers from `inputs` and ${VAR} from process.env,
// then dispatches by kind:
//   - "shell" — exec the command (cwd-aware, env-merge)
//   - "http"  — fetch the url with method/headers/body
//
// Output is capped at ~32KB so a runaway command doesn't blow up the
// dashboard JSON response.

const MAX_OUTPUT = 32 * 1024

/** Fill {{name}} markers from values; ${VAR} from process.env. */
export function template(s: string, values: Record<string, unknown>): string {
  return s
    .replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, name) => {
      const v = values[name]
      return v === undefined || v === null ? "" : String(v)
    })
    .replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_, name) => process.env[name] ?? "")
}

/** Validate inputs against the action's declared schema, applying defaults
 *  and rejecting missing required fields. Returns the cleaned values
 *  (booleans/numbers coerced from string CLI input). */
export function resolveInputs(action: Action, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const def of action.inputs as ActionInput[]) {
    let v: unknown = raw[def.name] ?? def.defaultValue
    if (v === undefined || v === "") {
      if (def.required) throw new Error(`input "${def.name}" is required`)
      continue
    }
    if (def.type === "number") {
      const n = typeof v === "number" ? v : Number(v)
      if (!Number.isFinite(n)) throw new Error(`input "${def.name}" must be a number`)
      v = n
    } else if (def.type === "boolean") {
      v = v === true || v === "true" || v === "1" || v === 1
    } else {
      v = String(v)
    }
    out[def.name] = v
  }
  return out
}

export async function runAction(action: Action, rawInputs: Record<string, unknown> = {}): Promise<ActionRunResult> {
  const start = Date.now()
  const values = resolveInputs(action, rawInputs)
  if (action.kind === "shell") return runShell(action, values, start)
  if (action.kind === "http") return runHttp(action, values, start)
  throw new Error(`unsupported action kind: ${(action as Action).kind}`)
}

function runShell(action: Extract<Action, { kind: "shell" }>, values: Record<string, unknown>, start: number): Promise<ActionRunResult> {
  const cmd = template(action.command, values)
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (action.env) {
    for (const [k, v] of Object.entries(action.env)) env[k] = template(v, values)
  }
  const cwd = action.cwd ? template(action.cwd, values) : process.cwd()

  return new Promise<ActionRunResult>((resolve) => {
    let settled = false
    const finish = (r: ActionRunResult) => { if (settled) return; settled = true; resolve(r) }
    exec(cmd, { cwd, env, timeout: action.timeoutMs, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      const out = String(stdout || "").slice(0, MAX_OUTPUT)
      const errs = String(stderr || "").slice(0, MAX_OUTPUT)
      const status = err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0
      finish({
        ok: !err,
        output: out,
        errors: errs || (err ? err.message : undefined),
        status: typeof status === "number" ? status : 1,
        durationMs: Date.now() - start,
      })
    })
  })
}

async function runHttp(action: Extract<Action, { kind: "http" }>, values: Record<string, unknown>, start: number): Promise<ActionRunResult> {
  const url = template(action.url, values)
  const headers: Record<string, string> = {}
  if (action.headers) for (const [k, v] of Object.entries(action.headers)) headers[k] = template(v, values)
  const body = action.method === "GET" || action.method === "DELETE" ? undefined : (action.body ? template(action.body, values) : undefined)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), action.timeoutMs)
  try {
    const res = await fetch(url, { method: action.method, headers, body, signal: ac.signal })
    const text = (await res.text()).slice(0, MAX_OUTPUT)
    return {
      ok: res.ok,
      output: text,
      status: res.status,
      durationMs: Date.now() - start,
    }
  } catch (e: any) {
    return {
      ok: false,
      output: "",
      errors: e?.message || String(e),
      status: 0,
      durationMs: Date.now() - start,
    }
  } finally {
    clearTimeout(timer)
  }
}
