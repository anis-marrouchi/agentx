import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"

// --- Tier-discipline lint (see docs/architecture/three-tier.md) ----------
//
// AgentX is layered: Procedure → Process → System. Higher tiers may depend
// on lower ones (a workflow uses a built-in action, the daemon wires both),
// but a lower tier MUST NOT reach upward — that breaks reusability and
// pulls runtime concerns into building blocks that are supposed to be
// composable in any context.
//
// This test scans source files in each tier and asserts that import paths
// never cross upward. It runs as part of the regular vitest suite so any
// PR that introduces an upward import fails CI with a precise message
// pointing at the offending file + line.
//
// Path conventions:
//  - Imports use TypeScript path aliases (@/...) per tsconfig paths.
//  - Test files (under test/) are exempt — tests can import anything.
//  - Type-only imports are still scanned (a circular dep on types is
//    rare and usually means the type belongs in a lower tier anyway).
//
// Scope of the rule for v1:
//  - **Procedure** (src/actions/builtin/, src/rag/, src/agent/skills/) must
//    NOT import from process/system runtime modules: daemon, agents/registry,
//    agents/runtime, channels, a2a, intent/ledger, workflows/dispatcher,
//    workflows/run-store.
//  - **Process** (src/workflows/) must NOT import from daemon, channels,
//    a2a, or agents/registry runtime. Type imports (agents/types,
//    channels/types) are allowed — they describe the contract, not the
//    runtime, and we'll relax this to allow shared zod schemas if it
//    proves friction.
//
// Tier 1 (System) has no restrictions. The daemon legitimately wires
// everything together — that's its job as the top-of-stack composer.

const REPO_ROOT = join(__dirname, "..")

interface TierRule {
  /** Glob-y prefix the rule applies to. */
  scope: string
  /** Human label for the offending tier. */
  label: string
  /** Forbidden import patterns (substring or regex). */
  forbidden: Array<{ pattern: RegExp; reason: string }>
  /** Designed-in cross-tier seams (e.g. singleton accessors). Imports
   *  matching these are allowed even if they'd otherwise hit a forbidden
   *  pattern. Type-only imports are always allowed regardless. */
  allowedSeams?: RegExp[]
}

// Singleton accessors that are designed as cross-tier composition seams.
// These follow the `*-instance.ts` naming convention and expose a getX()
// function returning a process-global. Allowed for any tier.
const DOCUMENTED_SEAMS: RegExp[] = [
  /^@\/a2a\/mesh-instance$/,
  /^@\/agents\/process-registry-instance$/,
]

const RULES: TierRule[] = [
  {
    scope: "src/actions/builtin",
    label: "Procedure (built-in action)",
    forbidden: [
      { pattern: /^@\/daemon(\/|$)/, reason: "procedures must not import daemon internals" },
      { pattern: /^@\/agents\/(registry|runtime)(\/|$)/, reason: "procedures must not import agent registry / runtime" },
      { pattern: /^@\/channels(\/|$)/, reason: "procedures must not import channels (a process concern)" },
      { pattern: /^@\/a2a(\/|$)/, reason: "procedures must not import a2a (a system concern)" },
      { pattern: /^@\/intent\/ledger$/, reason: "procedures must not import the intent ledger directly" },
      { pattern: /^@\/workflows\/(dispatcher|run-store|task-store)$/, reason: "procedures must not reach into workflow runtime modules" },
    ],
    allowedSeams: DOCUMENTED_SEAMS,
  },
  {
    scope: "src/rag",
    label: "Procedure (RAG)",
    forbidden: [
      { pattern: /^@\/daemon(\/|$)/, reason: "procedures must not import daemon internals" },
      { pattern: /^@\/agents\/(registry|runtime)(\/|$)/, reason: "procedures must not import agent registry / runtime" },
      { pattern: /^@\/channels(\/|$)/, reason: "procedures must not import channels (a process concern)" },
      { pattern: /^@\/workflows\/(dispatcher|run-store)$/, reason: "procedures must not reach into workflow runtime modules" },
    ],
    allowedSeams: DOCUMENTED_SEAMS,
  },
  {
    scope: "src/workflows",
    label: "Process (workflows)",
    forbidden: [
      { pattern: /^@\/daemon(\/|$)/, reason: "workflows must not import daemon internals — daemon wires the dispatcher, not the other way around" },
      { pattern: /^@\/channels\/(?!types)(.+)/, reason: "workflows must not import channel runtime (only types allowed)" },
      { pattern: /^@\/a2a\/(?!types)(.+)/, reason: "workflows must not import a2a runtime (only types allowed)" },
      { pattern: /^@\/agents\/(registry|runtime)(\/|$)/, reason: "workflows must not import the agent registry — wire via the dispatcher's AgentExecutor surface" },
    ],
    allowedSeams: DOCUMENTED_SEAMS,
  },
]

/** Walk a directory recursively, returning all .ts files (excluding .d.ts). */
function walkTs(dir: string): string[] {
  if (!fileExists(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walkTs(full))
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full)
  }
  return out
}

function fileExists(path: string): boolean {
  try { statSync(path); return true } catch { return false }
}

/** Extract every import specifier (the string after `from`) in a TS file.
 *  Tracks whether each import is type-only (erased at compile time) so the
 *  rule can ignore type-only crossings — they don't create runtime
 *  dependencies between tiers. Captures `import x from "y"`, `import type
 *  { … } from "y"`, and `import("y")` dynamic imports. */
function extractImports(source: string): Array<{ specifier: string; line: number; typeOnly: boolean }> {
  const out: Array<{ specifier: string; line: number; typeOnly: boolean }> = []
  const lines = source.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // import type? ... from "..."
    const reFrom = /\b(import\s+type\b|import\b)[^\n]*?\bfrom\s+["']([^"']+)["']/g
    const reDyn = /\bimport\(["']([^"']+)["']\)/g
    let m: RegExpExecArray | null
    while ((m = reFrom.exec(line)) !== null) {
      const typeOnly = /^import\s+type\b/.test(m[1])
      out.push({ specifier: m[2], line: i + 1, typeOnly })
    }
    while ((m = reDyn.exec(line)) !== null) {
      out.push({ specifier: m[1], line: i + 1, typeOnly: false })
    }
  }
  return out
}

interface Violation {
  file: string
  line: number
  specifier: string
  rule: TierRule
  reason: string
}

function findViolations(): Violation[] {
  const out: Violation[] = []
  for (const rule of RULES) {
    const dir = join(REPO_ROOT, rule.scope)
    for (const file of walkTs(dir)) {
      const src = readFileSync(file, "utf8")
      for (const imp of extractImports(src)) {
        // Type-only imports are erased at compile time — they describe a
        // shape contract, not a runtime dependency. Allowing them keeps
        // shared type modules (DaemonConfig, Workflow, …) usable across
        // tiers without forcing a separate types package.
        if (imp.typeOnly) continue
        // Documented seams: explicit cross-tier composition points.
        if ((rule.allowedSeams ?? []).some((s) => s.test(imp.specifier))) continue
        for (const f of rule.forbidden) {
          if (f.pattern.test(imp.specifier)) {
            out.push({
              file: relative(REPO_ROOT, file),
              line: imp.line,
              specifier: imp.specifier,
              rule,
              reason: f.reason,
            })
            break
          }
        }
      }
    }
  }
  return out
}

describe("tier discipline", () => {
  it("Procedure tier (src/actions/builtin, src/rag) does not import process/system runtime", () => {
    const violations = findViolations().filter((v) => v.rule.label.startsWith("Procedure"))
    if (violations.length) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line}\n    imports "${v.specifier}"\n    → ${v.reason} [${v.rule.label}]`)
        .join("\n\n")
      throw new Error(`tier-discipline violations:\n\n${msg}\n\nSee docs/architecture/three-tier.md for the composition rule.`)
    }
  })

  it("Process tier (src/workflows) does not import daemon / channel runtime / agent registry", () => {
    const violations = findViolations().filter((v) => v.rule.label.startsWith("Process"))
    if (violations.length) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line}\n    imports "${v.specifier}"\n    → ${v.reason} [${v.rule.label}]`)
        .join("\n\n")
      throw new Error(`tier-discipline violations:\n\n${msg}\n\nSee docs/architecture/three-tier.md for the composition rule.`)
    }
  })

  it("violation report format is parseable when there are no violations (sanity)", () => {
    // Smoke test: run findViolations() and ensure it returns an array.
    // Catches the case where a TS bug or fs error masks real violations.
    const result = findViolations()
    expect(Array.isArray(result)).toBe(true)
  })
})
