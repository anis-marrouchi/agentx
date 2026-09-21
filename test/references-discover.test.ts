import { describe, it, expect } from "vitest"
import { discoverFromSkills, renderDiscovery } from "../src/agents/references/discover"
import type { Skill } from "../src/agent/skills/types"

function skill(name: string, body: string, tags: string[] = []): Skill {
  return {
    frontmatter: { name, description: name, tags },
    instructions: body,
    source: "local",
  }
}

describe("discoverFromSkills", () => {
  it("extracts SSH user@host pairs", () => {
    const s = skill("initech-v1-coder", "Run `ssh root@203.0.113.11` to connect.")
    const r = discoverFromSkills([s], { namespace: "initech" })
    const ssh = r.byKind.ssh
    expect(ssh).toHaveLength(1)
    expect(ssh[0].id).toBe("initech.ssh.root-203-0-113-11")
    expect(ssh[0].fields).toMatchObject({ user: "root", host: "203.0.113.11" })
  })

  it("extracts a stranded public IP without a user (flagged needs-review)", () => {
    const s = skill("infra", "Server 203.0.113.10 hosts the daemon.")
    const r = discoverFromSkills([s], { namespace: "initech" })
    expect(r.byKind.ssh).toHaveLength(1)
    expect(r.byKind.ssh[0].tags).toContain("needs-review")
  })

  it("ignores private/loopback IPs", () => {
    const s = skill("local", "Health: curl http://127.0.0.1:18800")
    const r = discoverFromSkills([s], { namespace: "initech" })
    expect(r.byKind.ssh).toHaveLength(0)
  })

  it("extracts GitLab project IDs from table-style mentions", () => {
    const body = `
| Project | ID |
|---------|----|
| initech/initech-v1 | 269 |
| initech/initech-v2 | 270 |
`
    const r = discoverFromSkills([skill("initech-pm", body)], { namespace: "initech" })
    const gitlab = r.byKind.gitlab.map(c => c.id).sort()
    expect(gitlab).toContain("initech.gitlab.project.initech-v1")
    expect(gitlab).toContain("initech.gitlab.project.initech-v2")
    const v1 = r.byKind.gitlab.find(c => c.id === "initech.gitlab.project.initech-v1")!
    expect(v1.fields.projectId).toBe(269)
  })

  it("extracts emails as contacts", () => {
    const s = skill("initech-cx-email", "Email j.ellis@initech.example.com for routine. Escalate to m.reed@initech.example.com.")
    const r = discoverFromSkills([s], { namespace: "initech" })
    const ids = r.byKind.contact.map(c => c.id).sort()
    expect(ids).toContain("initech.contacts.j-ellis")
    expect(ids).toContain("initech.contacts.m-reed")
  })

  it("extracts filesystem paths", () => {
    const s = skill("initech-v1-coder", "Theme: /var/www/initech.example.com/wp-content/themes/initech/")
    const r = discoverFromSkills([s], { namespace: "initech" })
    expect(r.byKind.path).toHaveLength(1)
    expect(r.byKind.path[0].fields.path).toBe("/var/www/initech.example.com/wp-content/themes/initech/")
  })

  it("filters skills by name/tag substring", () => {
    const a = skill("initech-pm", "Email a@initech.example.com", ["initech"])
    const b = skill("globex-pm", "Email c@globex.example.com", ["globex"])
    const r = discoverFromSkills([a, b], { namespace: "initech", filter: ["initech"] })
    expect(r.scannedSkills).toEqual(["initech-pm"])
    const ids = r.byKind.contact.map(c => c.id)
    expect(ids).toEqual(["initech.contacts.a"])
  })

  it("renders YAML-shaped output per kind", () => {
    const s = skill("initech-v1-coder", "ssh root@1.2.3.4\nhttp://gitlab.example.com/grp/proj (ID: 99)")
    const r = discoverFromSkills([s], { namespace: "initech" })
    const out = renderDiscovery(r, "initech")
    expect(out["ssh.yaml"]).toContain("namespace: initech.ssh")
    expect(out["ssh.yaml"]).toMatch(/host:\s+"?1\.2\.3\.4"?/)
    expect(out["gitlab.yaml"]).toContain("projectId: 99")
  })
})
