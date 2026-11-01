import { describe, it, expect } from "vitest"
import { businessConfigSchema } from "../src/business/config"
import { configRelationsProblem, departmentsProblem, orgDepartments } from "../src/business/relations"
import { buildOrgView } from "../src/business/org-view"
import { Organization } from "../src/business/organization"
import { applyOrgEdit, readOrgSetup } from "../src/business/org-edit"

// Departments on the org chart (#1681): business.departments holds several
// departments, each headed by a person or an agent, with members written
// like the ends of a relation. The first one is Engineering.

const schedule = { days: ["mon"], start: "09:00", end: "17:00" }
const role = (r: string) => ({ role: r, schedule, utilizationTarget: 0.8 })

/** The Engineering seed: head person:anis; members pm-agent (Hakim),
 *  devops-agent, dev-session, coder-agent and person:saber. */
function seed(): any {
  return {
    agents: {
      "pm-agent": { name: "Hakim" },
      "devops-agent": { name: "DevOps" },
      "dev-session": { name: "Dev Session" },
      "coder-agent": { name: "Coder" },
    },
    people: [{ id: "anis", name: "Anis", role: "owner" }, { id: "saber", name: "Saber" }],
    business: {
      roles: { pm: { title: "Project manager" }, eng: { title: "Engineer" } },
      orgChart: {
        "pm-agent": role("pm"),
        "devops-agent": role("eng"),
        "dev-session": role("eng"),
        "coder-agent": role("eng"),
      },
      departments: {
        engineering: {
          name: "Engineering",
          head: "person:anis",
          members: ["pm-agent", "agent:devops-agent", "agent:dev-session", "agent:coder-agent", "person:saber"],
        },
      },
    },
  }
}

describe("business.departments (#1681)", () => {
  it("accepts the Engineering seed: a person head, agents and a person as members", () => {
    const cfg = seed()
    const parsed = businessConfigSchema.parse(cfg.business)
    expect(parsed.departments.engineering.head).toBe("person:anis")
    expect(configRelationsProblem(cfg)).toBeUndefined()
    expect(orgDepartments(parsed)).toEqual([{
      id: "engineering",
      name: "Engineering",
      head: "person:anis",
      members: ["agent:pm-agent", "agent:devops-agent", "agent:dev-session", "agent:coder-agent", "person:saber"],
    }])
  })

  it("holds several departments, one headed by an agent", () => {
    const cfg = seed()
    cfg.agents["support-agent"] = { name: "Support" }
    cfg.business.orgChart["support-agent"] = role("eng")
    cfg.business.departments.support = { name: "Support", head: "agent:pm-agent", members: ["support-agent", "person:saber"] }
    const parsed = businessConfigSchema.parse(cfg.business)
    expect(Object.keys(parsed.departments)).toEqual(["engineering", "support"])
    expect(configRelationsProblem(cfg)).toBeUndefined()
    expect(() => new Organization(parsed, cfg.people)).not.toThrow()
    const view = buildOrgView(cfg, {}, null)
    expect(view.departments.map((d) => [d.id, d.head])).toEqual([["engineering", "person:anis"], ["support", "agent:pm-agent"]])
    // A member may sit in two departments; its card names both.
    expect(view.diagram.boxes.find((b) => b.key === "person:saber")?.departments).toEqual(["engineering", "support"])
    expect(view.diagram.boxes.find((b) => b.key === "agent:pm-agent")?.departments).toEqual(["engineering", "support"])
    expect(view.problem).toBeUndefined()
  })

  it("defaults to none, so an existing config validates unchanged", () => {
    expect(businessConfigSchema.parse({}).departments).toEqual({})
    expect(orgDepartments(undefined)).toEqual([])
  })

  it("does not repeat the head among the members, or a member twice", () => {
    const [d] = orgDepartments({ departments: { engineering: { name: "Engineering", head: "person:anis", members: ["person:anis", "pm-agent", "agent:pm-agent"] } } })
    expect(d.members).toEqual(["agent:pm-agent"])
  })

  it("refuses an unknown head or member, as relations are refused", () => {
    const agents = new Set(["pm-agent"]), people = new Set(["anis"])
    const dept = (head: string | undefined, members: string[]) => orgDepartments({ departments: { engineering: { name: "Engineering", ...(head ? { head } : {}), members } } })
    expect(departmentsProblem(dept("person:nobody", []), agents, people))
      .toBe('Department "Engineering" has head "nobody", which is not a person in people')
    expect(departmentsProblem(dept("person:anis", ["ghost"]), agents, people))
      .toBe('Department "Engineering" has member "ghost", which is not an agent in business.orgChart')
    expect(departmentsProblem(dept(undefined, ["pm-agent"]), agents, people)).toBeUndefined()
    const cfg = seed()
    cfg.people = cfg.people.filter((p: any) => p.id !== "saber")
    expect(configRelationsProblem(cfg)).toBe('Department "Engineering" has member "saber", which is not a person in people')
    expect(() => new Organization(businessConfigSchema.parse(cfg.business), cfg.people)).toThrow(/saber/)
    expect(buildOrgView(cfg, {}, null).problem).toMatch(/saber/)
  })

  it("refuses a department with no name", () => {
    expect(businessConfigSchema.safeParse({ departments: { engineering: { name: "", members: [] } } }).success).toBe(false)
  })
})

describe("departments in the org view (#1681)", () => {
  it("gives each department one band's data and a person named only there a card", () => {
    const view = buildOrgView(seed(), {}, null)
    expect(view.departments).toHaveLength(1)
    expect(view.departments[0].name).toBe("Engineering")
    const keys = view.diagram.boxes.map((b) => b.key)
    expect(keys).toContain("person:anis")
    expect(keys).toContain("person:saber")
    const anis = view.diagram.boxes.find((b) => b.key === "person:anis")!
    expect(anis.kind).toBe("person")
    expect(anis.departments).toEqual(["engineering"])
    expect(view.diagram.boxes.find((b) => b.key === "agent:coder-agent")?.departments).toEqual(["engineering"])
  })
})

describe("Edit org keeps departments sound (#1681)", () => {
  it("lists a person named only in a department as a member", () => {
    expect(readOrgSetup(seed()).members.map((m) => m.ref)).toContain("person:saber")
  })

  it("takes a removed member out of its departments, head included", () => {
    const cfg = seed()
    const said = applyOrgEdit(cfg, { op: "remove-member", member: "agent:coder-agent" })
    expect(said).toBe("Coder removed from the org chart and out of Engineering")
    expect(cfg.business.departments.engineering.members).not.toContain("agent:coder-agent")
    expect(configRelationsProblem(cfg)).toBeUndefined()
    applyOrgEdit(cfg, { op: "remove-member", member: "person:anis" })
    expect(cfg.business.departments.engineering.head).toBeUndefined()
    expect(cfg.business.departments.engineering.name).toBe("Engineering")
  })
})
