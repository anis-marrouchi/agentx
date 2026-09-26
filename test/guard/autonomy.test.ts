import { describe, it, expect } from "vitest"
import { evaluateAutonomy, shellView, toolWords, isRestricted, autonomyLevelSchema } from "../../src/guard/autonomy"

// Routine autonomy rule sets (#80). report is an allowlist, propose a
// denylist over act-level steps, act is unrestricted.

const bash = (command: string) => ({ tool: "Bash", command })
const allowed = (level: "report" | "propose" | "act", input: { tool: string; command?: string; filePath?: string }) =>
  evaluateAutonomy(level, input).allowed

describe("autonomy level schema", () => {
  it("accepts the three levels and nothing else", () => {
    for (const l of ["report", "propose", "act"]) expect(autonomyLevelSchema.parse(l)).toBe(l)
    expect(autonomyLevelSchema.safeParse("full").success).toBe(false)
  })
  it("only report and propose are restricted", () => {
    expect(isRestricted("report")).toBe(true)
    expect(isRestricted("propose")).toBe(true)
    expect(isRestricted("act")).toBe(false)
    expect(isRestricted(undefined)).toBe(false)
  })
})

describe("report — read-only", () => {
  it.each([
    "ls -la src",
    "git status && git log --oneline -20",
    "git -C repo diff HEAD~3 --stat",
    "grep -rn TODO src | head -20",
    "cat package.json | jq .version",
    "gh pr list --state open",
    "glab mr view 12",
    "gh api repos/acme/app/pulls",
    "curl -s https://status.example.com/health",
    "find . -name '*.ts' -newer package.json",
    "echo \"today is $(date +%F)\"",
    "wc -l src/**/*.ts 2>/dev/null",
    "for f in a b; do cat $f; done",
    "git branch --show-current",
    "cat <<'EOF'\nsome > text; rm -rf /\nEOF",
  ])("allows %s", (cmd) => {
    expect(evaluateAutonomy("report", bash(cmd))).toEqual({ allowed: true, ruleId: null, reason: null })
  })

  it.each([
    ["echo hi > notes.md", "redirect"],
    ["cat a | tee b", "tee"],
    ["git commit -m 'x'", "commit"],
    ["git push origin feature", "push"],
    ["git branch new-branch", "branch create"],
    ["git -c core.pager=sh log", "git -c"],
    ["rm notes.md", "rm"],
    ["npm install", "npm"],
    ["python3 -c 'open(\"x\",\"w\")'", "interpreter"],
    ["node scripts/sync.js", "node"],
    ["curl -X POST https://api.example.com/hook", "curl POST"],
    ["curl -d '{}' https://api.example.com/hook", "curl body"],
    ["curl -o out.html https://example.com", "curl -o"],
    ["gh pr create --fill", "gh pr create"],
    ["gh api -X PATCH repos/acme/app/issues/1", "gh api PATCH"],
    ["gh api repos/acme/app/issues -f title=x", "gh api field"],
    ["find . -name '*.log' -delete", "find -delete"],
    ["echo \"$(rm -rf build)\"", "substitution in double quotes"],
    ["ls `touch x`", "backticks"],
    ["sed -i s/a/b/ file", "sed"],
    ["echo 'unterminated", "irregular"],
  ])("blocks %s (%s)", (cmd) => {
    const d = evaluateAutonomy("report", bash(cmd))
    expect(d.allowed).toBe(false)
    expect(d.ruleId).toMatch(/^autonomy\.report\./)
    expect(d.reason).toBeTruthy()
  })

  it("blocks every file-writing tool", () => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      const d = evaluateAutonomy("report", { tool, filePath: "/w/src/a.ts" })
      expect(d.allowed).toBe(false)
      expect(d.ruleId).toBe("autonomy.report.write")
    }
  })

  it("allows read-only native tools and blocks unknown ones", () => {
    for (const tool of ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite"]) {
      expect(allowed("report", { tool })).toBe(true)
    }
    expect(allowed("report", { tool: "SomeFutureTool" })).toBe(false)
  })

  it("allows read MCP tools, blocks outward/mutating ones and unclassifiable ones", () => {
    expect(allowed("report", { tool: "mcp__gitlab__get_merge_request" })).toBe(true)
    expect(allowed("report", { tool: "mcp__github__list_issues" })).toBe(true)
    expect(allowed("report", { tool: "mcp__github__search_code" })).toBe(true)
    expect(allowed("report", { tool: "mcp__gitlab__create_note" })).toBe(false)
    expect(allowed("report", { tool: "mcp__slack__send_message" })).toBe(false)
    expect(allowed("report", { tool: "mcp__github__add_issue_comment" })).toBe(false)
    expect(allowed("report", { tool: "mcp__gitlab__get_and_merge" })).toBe(false)
    expect(allowed("report", { tool: "mcp__custom__frobnicate" })).toBe(false)
  })
})

describe("propose — branches, commits and MRs, never merge/deploy/delete", () => {
  it.each([
    "git checkout -b fix/typo",
    "git add src/a.ts && git commit -m 'fix: typo; deploy later > soon'",
    "git push -u origin fix/typo",
    "git push origin HEAD:fix/typo",
    "git push -o merge_request.create origin fix/typo",
    "gh pr create --draft --title 'x' --body 'y'",
    "glab mr create --draft --fill",
    "npm test",
    "rm src/obsolete.ts",
    "cat docs/deploy.md",
    "git merge origin/main",
    "echo hi > notes.md",
  ])("allows %s", (cmd) => {
    expect(evaluateAutonomy("propose", bash(cmd)).allowed).toBe(true)
  })

  it.each([
    ["gh pr merge 12 --squash", "merge"],
    ["glab mr merge 7", "merge"],
    ["git push -o merge_request.merge_when_pipeline_succeeds origin fix/x", "merge"],
    ["curl -X PUT \"https://gitlab.example.com/api/v4/projects/1/merge_requests/2/merge\"", "merge"],
    ["git push origin main", "push"],
    ["git push origin HEAD:master", "push"],
    ["git push", "push"],
    ["git push origin HEAD", "push"],
    ["git push --force origin fix/x", "push"],
    ["git push -f origin fix/x", "push"],
    ["git push origin +fix/x", "push"],
    ["git push origin :old-branch", "push"],
    ["git push --delete origin old-branch", "push"],
    ["git push --tags", "push"],
    ["git branch -D old", "delete"],
    ["git reset --hard origin/main", "delete"],
    ["rm -rf build", "delete"],
    ["gh repo delete acme/app --yes", "delete"],
    ["psql -c 'DROP TABLE users'", "delete"],
    ["curl -X DELETE https://api.example.com/items/1", "delete"],
    ["npm run deploy", "deploy"],
    ["./deploy.sh production", "deploy"],
    ["make deploy", "deploy"],
    ["kubectl apply -f k8s/", "deploy"],
    ["terraform apply", "deploy"],
    ["npm publish", "deploy"],
    ["npx prisma migrate deploy", "deploy"],
    ["ssh app-host 'systemctl restart app'", "prod"],
    ["sudo systemctl restart nginx", "prod"],
    ["cd repo && git push origin main", "push"],
  ])("blocks %s (%s)", (cmd, id) => {
    const d = evaluateAutonomy("propose", bash(cmd))
    expect(d.allowed).toBe(false)
    expect(d.ruleId).toBe(`autonomy.propose.${id}`)
  })

  it("allows file edits", () => {
    expect(allowed("propose", { tool: "Write", filePath: "/w/src/a.ts" })).toBe(true)
    expect(allowed("propose", { tool: "Edit", filePath: "/w/src/a.ts" })).toBe(true)
  })

  it("allows MR-creating MCP tools and blocks act-level ones", () => {
    expect(allowed("propose", { tool: "mcp__gitlab__create_merge_request" })).toBe(true) // "merge request" is a noun
    expect(allowed("propose", { tool: "mcp__gitlab__merge_merge_request" })).toBe(false)
    expect(allowed("propose", { tool: "mcp__github__create_pull_request" })).toBe(true)
    expect(allowed("propose", { tool: "mcp__gitlab__create_note" })).toBe(true)
    expect(allowed("propose", { tool: "mcp__github__merge_pull_request" })).toBe(false)
    expect(allowed("propose", { tool: "mcp__github__delete_file" })).toBe(false)
    expect(allowed("propose", { tool: "mcp__vercel__deploy_project" })).toBe(false)
  })

  it("blocks handing the work to another agent, which would run unrestricted", () => {
    expect(evaluateAutonomy("propose", { tool: "mcp__agentx__agentx_task" }).ruleId).toBe("autonomy.propose.delegate")
    expect(allowed("propose", { tool: "mcp__agentx__agentx_send_agent" })).toBe(false)
    expect(allowed("propose", { tool: "mcp__tracker__get_task" })).toBe(true)
    expect(evaluateAutonomy("propose", bash("agentx ask ops 'deploy it'")).ruleId).toBe("autonomy.propose.delegate")
    expect(evaluateAutonomy("propose", bash("curl -X POST http://127.0.0.1:18800/ask -d '{}'")).ruleId).toBe("autonomy.propose.delegate")
    // and report already blocks all of these
    expect(allowed("report", { tool: "mcp__agentx__agentx_task" })).toBe(false)
    expect(allowed("report", bash("agentx ask ops hi"))).toBe(false)
  })
})

describe("act — unchanged", () => {
  it("allows everything", () => {
    for (const input of [
      bash("git push --force origin main"),
      bash("rm -rf build && npm run deploy"),
      { tool: "Write", filePath: "/etc/hosts" },
      { tool: "mcp__github__merge_pull_request" },
    ]) {
      expect(evaluateAutonomy("act", input)).toEqual({ allowed: true, ruleId: null, reason: null })
    }
  })
})

describe("helpers", () => {
  it("toolWords splits snake, kebab and camel case", () => {
    expect(toolWords("mcp__gitlab__createMergeRequest")).toEqual(["mcp", "gitlab", "create", "merge", "request"])
    expect(toolWords("mcp__a-b__list_items")).toEqual(["mcp", "a", "b", "list", "items"])
  })
  it("shellView blanks literals but keeps substitutions visible", () => {
    expect(shellView("echo 'a > b' \"c; d\"")).toBe("echo '' \"\"")
    expect(shellView("echo \"x $(whoami)\"")).toContain("$(whoami)")
    expect(shellView("echo 'open")).toBeNull()
  })
})
