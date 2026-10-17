import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
// @ts-expect-error — plain .mjs script, no type declarations
import { GITHUB_ACTIONS_APP_ID, describeRequest, parseArgs, protectionRequest, workflowChecks } from "../scripts/branch-protection.mjs"

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")

describe("workflowChecks", () => {
  it("reads the check names ci.yml posts", () => {
    expect(workflowChecks(ci)).toEqual(["test"])
  })

  it("uses a job's display name when it has one", () => {
    expect(workflowChecks("jobs:\n  unit:\n    name: Unit tests\n  build: {}\n")).toEqual(["Unit tests", "build"])
  })

  it("refuses matrix jobs, whose check names vary", () => {
    expect(() => workflowChecks("jobs:\n  install:\n    strategy:\n      matrix:\n        os: [a, b]\n")).toThrow(/matrix/)
  })
})

describe("protectionRequest", () => {
  const opts = parseArgs([])

  it("requires the checks from GitHub Actions, enforces admins and asks for no reviews", () => {
    const req = protectionRequest(opts, ["test"])
    expect(req.method).toBe("PUT")
    expect(req.path).toBe("repos/anis-marrouchi/agentx/branches/main/protection")
    expect(req.payload).toEqual({
      required_status_checks: { strict: false, checks: [{ context: "test", app_id: GITHUB_ACTIONS_APP_ID }] },
      enforce_admins: true,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    })
  })

  it("--off deletes the protection and sends no payload", () => {
    const req = protectionRequest(parseArgs(["--off", "--repo", "acme/demo", "--dry-run"]), [])
    expect(req).toEqual({ method: "DELETE", path: "repos/acme/demo/branches/main/protection" })
    expect(describeRequest(req)).toBe("DELETE repos/acme/demo/branches/main/protection")
  })

  it("never applies an empty rule set", () => {
    expect(() => protectionRequest(opts, [])).toThrow(/no checks/)
  })
})

describe("parseArgs", () => {
  it("reads every flag", () => {
    expect(parseArgs(["--repo", "acme/demo", "--branch", "release", "--dry-run"])).toEqual({ repo: "acme/demo", branch: "release", dryRun: true, off: false })
  })

  it("refuses a flag with no value", () => {
    expect(() => parseArgs(["--repo"])).toThrow(/--repo needs a value/)
    expect(() => parseArgs(["--dry-run", "--branch"])).toThrow(/--branch needs a value/)
  })

  it("refuses another flag as a value", () => {
    expect(() => parseArgs(["--repo", "--off"])).toThrow(/--repo needs a value/)
  })
})
