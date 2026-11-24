import { describe, expect, it } from "vitest"
import { readIssueCreates } from "../src/gates/issue-args"
import { missingParts } from "../src/gates/issue-complete"
import { gitlabCreateMatcher, gitlabServers, isGitlabCreateTool } from "../src/gates/gitlab-mcp"
import { evaluate } from "../src/guard/engine"
import { resolveInMemory } from "../src/guard/policy"
import { guardPolicySchema } from "../src/guard/types"

// #2085 G1, design v3 R, v4 R′, v5 U″: the reader for issue-create commands.
// A create it reads is checked; one it cannot read is "unchecked", never refused.

const BODY = "Steps:\n1) step one\n(note) it's here\n\n- [ ] works on staging\n/estimate 1h"

/** What the guard would say: the missing parts of each read create. */
function verdicts(command: string) {
  const r = readIssueCreates(command)
  return {
    missing: r.creates.map((c) => missingParts(c.description, c.hasMilestone, c.hasEstimate)),
    unchecked: r.unchecked.length,
  }
}

describe("glab issue create", () => {
  it("R1: a heredoc body with 1), (note) and a lone quote is read whole", () => {
    const cmd = `glab issue create -t T -m 12 -d "$(cat <<'EOF'\n${BODY}\nEOF\n)"`
    expect(readIssueCreates(cmd).creates[0].description).toBe(BODY)
    expect(verdicts(cmd)).toEqual({ missing: [[]], unchecked: 0 })
  })

  it("R2: the same without /estimate names it", () => {
    const cmd = `glab issue create -t T -m 12 -d "$(cat <<'EOF'\n${BODY.replace("/estimate 1h", "")}\nEOF\n)"`
    expect(verdicts(cmd).missing).toEqual([["/estimate"]])
  })

  it("R3: <<-EOF with a tab-indented terminator is read", () => {
    const cmd = `glab issue create -t T -m 12 -d "$(cat <<-EOF\n\t- [ ] x\n\t/estimate 2h\n\tEOF\n)"`
    expect(verdicts(cmd)).toEqual({ missing: [[]], unchecked: 0 })
  })

  it("R4: a heredoc with no terminator is unchecked", () => {
    expect(verdicts(`glab issue create -t T -d "$(cat <<'EOF'\n- [ ] x\n`)).toEqual({ missing: [], unchecked: 1 })
  })

  it("R5: a variable body is unchecked", () => {
    expect(verdicts('glab issue create -t T -m 3 -d "$DESC"')).toEqual({ missing: [], unchecked: 1 })
    expect(verdicts('glab issue create -t T -d "$(cat body.md)"')).toEqual({ missing: [], unchecked: 1 })
  })

  it("takes --milestone and --time-estimate as given, and reads after cd &&", () => {
    expect(verdicts("cd repo && glab issue create --title=T --milestone=7 --time-estimate 2h -d '- [ ] x'").missing).toEqual([[]])
    expect(verdicts("glab issue create -t T -d '- [ ] x\n/estimate 1h'").missing).toEqual([["milestone"]])
  })

  it("an unknown flag is unchecked, other glab commands are not read", () => {
    expect(verdicts("glab issue create -t T --frobnicate -d x")).toEqual({ missing: [], unchecked: 1 })
    expect(verdicts("glab issue list --milestone 3")).toEqual({ missing: [], unchecked: 0 })
    expect(verdicts("glab issue note 4 -m 'see issues'")).toEqual({ missing: [], unchecked: 0 })
  })
})

describe("glab api", () => {
  it("R6: an explicit POST with no milestone is refused", () => {
    expect(verdicts("glab api -X POST projects/1/issues -f title=T -f 'description=- [ ] x\n/estimate 1h'").missing).toEqual([["milestone"]])
  })

  it("R12: fields with no -X are a POST, as glab does", () => {
    expect(verdicts("glab api projects/12/issues -f title=T -f description=hello").missing).toEqual([["milestone", "/estimate", "checklist"]])
    expect(verdicts("glab api projects/12/issues -f title=T -F milestone_id=5 -f 'description=- [ ] x\n/estimate 1h'").missing).toEqual([[]])
  })

  it("a GET, a note or an update is not a create", () => {
    expect(verdicts("glab api projects/12/issues").missing).toEqual([])
    expect(verdicts("glab api projects/12/issues/7/notes -f body=x").missing).toEqual([])
    expect(verdicts("glab api -X PUT projects/12/issues/7 -f description=x").missing).toEqual([])
  })

  it("-F description=@- reads a stdin heredoc; @file is unchecked", () => {
    expect(verdicts("glab api projects/:id/issues -F milestone_id=2 -F description=@- <<'X'\n- [ ] a\n/estimate 1h\nX").missing).toEqual([[]])
    expect(verdicts("glab api projects/:id/issues -F description=@body.md")).toEqual({ missing: [], unchecked: 1 })
  })
})

describe("curl", () => {
  const URL = "https://gitlab.example.com/api/v4/projects/12/issues"

  it("R7: a form POST with checklist and estimate but no milestone names it", () => {
    const cmd = `curl -X POST -H "PRIVATE-TOKEN: $T" ${URL} -d title=T -d 'description=- [ ] x%0A/estimate 1h'`
    expect(verdicts(cmd).missing).toEqual([["milestone"]])
  })

  it("R8: --data-urlencode is decoded, -d milestone_id counts", () => {
    const cmd = `curl -sS --request POST --header "PRIVATE-TOKEN: $T" "${URL}" --data-urlencode "description=- [ ] x%0A/estimate 1h" -d milestone_id=5`
    expect(verdicts(cmd)).toEqual({ missing: [[]], unchecked: 0 })
  })

  it("R9: a JSON body with all three is allowed", () => {
    const json = JSON.stringify({ title: "T", milestone_id: 9, description: "- [ ] a\n/estimate 30m" })
    expect(verdicts(`curl -H 'Content-Type: application/json; charset=utf-8' -d '${json}' ${URL}`)).toEqual({ missing: [[]], unchecked: 0 })
  })

  it("R10: notes, links and updates are not matched", () => {
    expect(verdicts(`curl -X POST ${URL}/7/notes -d body=x`).missing).toEqual([])
    expect(verdicts(`curl -X PUT ${URL}/7 -d description=x`).missing).toEqual([])
  })

  it("R11: -d @body.json is unchecked", () => {
    expect(verdicts(`curl -H 'Content-Type: application/json' -d @body.json ${URL}`)).toEqual({ missing: [], unchecked: 1 })
  })

  it("R13–R20: the accepted forms read right or stay unchecked, never refused wrongly", () => {
    // -XPOST, --request=POST, --url, an encoded path, a $VAR id.
    const full = "description=- [ ] a%0A/estimate 1h&milestone_id=4"
    expect(verdicts(`curl -XPOST ${URL} -d '${full}'`).missing).toEqual([[]])
    expect(verdicts(`curl --request=POST --url ${URL.replace("12", "noqta%2Fnoqta")} -d '${full}'`).missing).toEqual([[]])
    expect(verdicts(`curl -X POST "$GITLAB/api/v4/projects/$PID/issues" -d '${full}'`).missing).toEqual([[]])
    // Fields in the URL query.
    expect(verdicts(`curl -X POST "${URL}?milestone_id=4" -d 'description=- [ ] a%0A/estimate 1h'`).missing).toEqual([[]])
    // -G / -I are never a create.
    expect(verdicts(`curl -G ${URL} -d state=opened`).missing).toEqual([])
    // A body starting with { that is not declared JSON is unchecked.
    expect(verdicts(`curl -X POST ${URL} -d '{"description":"x"}'`)).toEqual({ missing: [], unchecked: 1 })
    // A JSON body from a stdin heredoc.
    const json = JSON.stringify({ milestone_id: 3, description: "- [ ] a\n/estimate 1h" })
    expect(verdicts(`curl -H 'Content-Type: application/json' -d @- ${URL} <<'J'\n${json}\nJ`).missing).toEqual([[]])
    // A pipe into @- and an unknown flag are unchecked.
    expect(verdicts(`cat b.json | curl -H 'Content-Type: application/json' -d @- ${URL}`)).toEqual({ missing: [], unchecked: 1 })
    expect(verdicts(`curl --frob x -X POST ${URL} -d description=x`)).toEqual({ missing: [], unchecked: 1 })
  })
})

describe("GitLab MCP create tools", () => {
  it("finds GitLab servers by key, command, args or URL, and every create alias", () => {
    const servers = gitlabServers({
      noqta_gitlab_server: {},
      tracker: { command: "npx", args: ["-y", "@zereight/mcp-gitlab"] },
      remote: { url: "https://gitlab.example.com/api/v4/mcp" },
      github: { command: "github-mcp-server" },
    })
    expect(servers).toEqual(["noqta_gitlab_server", "tracker", "remote"])
    const re = new RegExp(gitlabCreateMatcher(servers)!)
    for (const t of ["create_issue", "create_gitlab_issue", "gitlab_create_issue"]) expect(re.test(`mcp__tracker__${t}`)).toBe(true)
    expect(re.test("mcp__tracker__create_issue_note")).toBe(false)
    expect(re.test("mcp__github__create_issue")).toBe(false)
    expect(isGitlabCreateTool("mcp__tracker__create_issue", servers)).toBe(true)
    expect(isGitlabCreateTool("mcp__tracker__create_issue")).toBe(false)
    expect(isGitlabCreateTool("mcp__my_gitlab__gitlab_create_issue")).toBe(true)
  })

  it("the guard checks an aliased server's create when told it is GitLab", () => {
    const policy = resolveInMemory(guardPolicySchema.parse({
      mode: "warn",
      rules: [{ id: "issue-complete", check: "issue-complete", match: {}, action: "deny", mode: "enforce" }],
    }))
    const input = { tool: "mcp__tracker__create_issue", toolInput: { description: "- [ ] a\n/estimate 1h" } }
    expect(evaluate(input, policy).effectiveAction).toBe("allow")
    expect(evaluate({ ...input, gitlabServers: ["tracker"] }, policy)).toMatchObject({ effectiveAction: "deny", message: "missing: milestone" })
  })

  it("the guard reports an unread create and allows it", () => {
    const policy = resolveInMemory(guardPolicySchema.parse({
      mode: "enforce",
      rules: [{ id: "issue-complete", check: "issue-complete", match: {}, action: "deny" }],
    }))
    const v = evaluate({ tool: "Bash", command: 'glab issue create -t T -d "$DESC"' }, policy)
    expect(v.effectiveAction).toBe("allow")
    expect(v.issueUnchecked).toEqual(["glab issue create: description is not literal"])
  })
})
