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
    const s = skill("ksi-v1-coder", "Run `ssh root@134.122.119.251` to connect.")
    const r = discoverFromSkills([s], { namespace: "ksi" })
    const ssh = r.byKind.ssh
    expect(ssh).toHaveLength(1)
    expect(ssh[0].id).toBe("ksi.ssh.root-134-122-119-251")
    expect(ssh[0].fields).toMatchObject({ user: "root", host: "134.122.119.251" })
  })

  it("extracts a stranded public IP without a user (flagged needs-review)", () => {
    const s = skill("infra", "Server 64.226.102.124 hosts the daemon.")
    const r = discoverFromSkills([s], { namespace: "ksi" })
    expect(r.byKind.ssh).toHaveLength(1)
    expect(r.byKind.ssh[0].tags).toContain("needs-review")
  })

  it("ignores private/loopback IPs", () => {
    const s = skill("local", "Health: curl http://127.0.0.1:18800")
    const r = discoverFromSkills([s], { namespace: "ksi" })
    expect(r.byKind.ssh).toHaveLength(0)
  })

  it("extracts GitLab project IDs from table-style mentions", () => {
    const body = `
| Project | ID |
|---------|----|
| ksi/ksi-v1 | 269 |
| ksi/ksi-v2 | 270 |
`
    const r = discoverFromSkills([skill("ksi-pm", body)], { namespace: "ksi" })
    const gitlab = r.byKind.gitlab.map(c => c.id).sort()
    expect(gitlab).toContain("ksi.gitlab.project.ksi-v1")
    expect(gitlab).toContain("ksi.gitlab.project.ksi-v2")
    const v1 = r.byKind.gitlab.find(c => c.id === "ksi.gitlab.project.ksi-v1")!
    expect(v1.fields.projectId).toBe(269)
  })

  it("extracts emails as contacts", () => {
    const s = skill("ksi-cx-email", "Email t.ksibi@ksi.tn for routine. Escalate to h.ksibi@ksi.tn.")
    const r = discoverFromSkills([s], { namespace: "ksi" })
    const ids = r.byKind.contact.map(c => c.id).sort()
    expect(ids).toContain("ksi.contacts.t-ksibi")
    expect(ids).toContain("ksi.contacts.h-ksibi")
  })

  it("extracts filesystem paths", () => {
    const s = skill("ksi-v1-coder", "Theme: /var/www/ksi.tn/wp-content/themes/ksi/")
    const r = discoverFromSkills([s], { namespace: "ksi" })
    expect(r.byKind.path).toHaveLength(1)
    expect(r.byKind.path[0].fields.path).toBe("/var/www/ksi.tn/wp-content/themes/ksi/")
  })

  it("filters skills by name/tag substring", () => {
    const a = skill("ksi-pm", "Email a@ksi.tn", ["ksi"])
    const b = skill("mtgl-pm", "Email c@mtgl.tn", ["mtgl"])
    const r = discoverFromSkills([a, b], { namespace: "ksi", filter: ["ksi"] })
    expect(r.scannedSkills).toEqual(["ksi-pm"])
    const ids = r.byKind.contact.map(c => c.id)
    expect(ids).toEqual(["ksi.contacts.a"])
  })

  it("renders YAML-shaped output per kind", () => {
    const s = skill("ksi-v1-coder", "ssh root@1.2.3.4\nhttp://gitlab.example.com/grp/proj (ID: 99)")
    const r = discoverFromSkills([s], { namespace: "ksi" })
    const out = renderDiscovery(r, "ksi")
    expect(out["ssh.yaml"]).toContain("namespace: ksi.ssh")
    expect(out["ssh.yaml"]).toMatch(/host:\s+"?1\.2\.3\.4"?/)
    expect(out["gitlab.yaml"]).toContain("projectId: 99")
  })
})
