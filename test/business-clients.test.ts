import { describe, expect, it } from "vitest"
import {
  clientFromProject, agentClients, matchContact, resolveClient, parseWorkRef,
  clientPolicy, listClients, parseDuration, mayProceedUnattended, UNMAPPED,
  type BusinessShape,
} from "../src/business/clients"
import { MONITOR_SCRIPT, renderMonitorPage } from "../src/daemon/ui/pages/monitor"

// Mirrors the real peer config: projects under globex/initech/acme, a deep
// orgChart, and umbrella work that no project entry covers.
const business: BusinessShape = {
  projects: [
    { id: "globex/globex-system-v2", pm: "pm-globex" },
    { id: "initech/initech.example.com", pm: "pm-initech" },
    { id: "umbrella-lab/umbrella-v1", pm: "pm-umbrella", client: "umbrella" },
  ],
  orgChart: {
    "pm-globex": {}, "globex-v2": { reportsTo: "pm-globex" }, "globex-junior": { reportsTo: "globex-v2" },
    "pm-umbrella": {}, "umbrella-coding": { reportsTo: "pm-umbrella" },
  },
  contactMap: [{ channel: "telegram", chatId: "1816212449", client: "acme" }],
  clients: { umbrella: { name: "Umbrella Lab", kind: "client", respondWithin: "4h" } },
}

describe("client resolution", () => {
  it("derives a client from the project namespace when none is declared", () => {
    expect(clientFromProject("globex/globex-system-v2", business.projects)).toBe("globex")
    expect(clientFromProject("umbrella-lab/umbrella-v1", business.projects)).toBe("umbrella")
    expect(clientFromProject("some-internal-thing", [])).toBe("some-internal-thing")
    expect(clientFromProject(null, [])).toBe(UNMAPPED)
  })

  it("carries a client down the org chart, so mesh dispatches are attributable", () => {
    const map = agentClients(business)
    expect(map.get("pm-globex")).toBe("globex")
    expect(map.get("globex-v2")).toBe("globex")
    expect(map.get("globex-junior")).toBe("globex")       // transitive, two hops
    expect(map.get("umbrella-coding")).toBe("umbrella")
  })

  it("lets a hand-written contact rule beat any heuristic", () => {
    expect(matchContact("telegram", { chatId: "1816212449" }, business.contactMap)?.client).toBe("acme")
    expect(matchContact("telegram", { chatId: "999" }, business.contactMap)).toBeUndefined()
  })

  it("reads the principal off a monitor session id, whatever the channel", () => {
    const gl = parseWorkRef("umbrella-coding:gitlab:umbrella-lab/umbrella-v1:issue:94")
    expect(gl.project).toBe("umbrella-lab/umbrella-v1")
    expect(resolveClient(gl, business)).toBe("umbrella")

    const tg = parseWorkRef("marketing-agent:telegram:1816212449")
    expect(tg.chatId).toBe("1816212449")
    expect(resolveClient(tg, business)).toBe("acme")

    const wa = parseWorkRef("atlas:whatsapp:10000000000@s.whatsapp.net")
    expect(wa.chatId).toBe("10000000000")

    // api and cron carry nothing addressable, so the agent's org seat decides.
    expect(resolveClient(parseWorkRef("umbrella-coding:api:default"), business)).toBe("umbrella")
    expect(resolveClient(parseWorkRef("nobody:api:default"), business)).toBe(UNMAPPED)
  })

  it("gives every derived client a policy without anyone declaring it", () => {
    const ids = listClients(business).map(c => c.id)
    expect(ids).toEqual(["acme", "globex", "initech", "umbrella"])
    const globex = clientPolicy("globex", business)
    expect(globex).toMatchObject({ name: "globex", declared: false, standing: [] })
    const umbrella = clientPolicy("umbrella", business)
    expect(umbrella).toMatchObject({ name: "Umbrella Lab", kind: "client", respondWithinMinutes: 240, declared: true })
  })

  it("treats an unparseable duration as no clock rather than an urgent one", () => {
    expect(parseDuration("4h")).toBe(240)
    expect(parseDuration("90m")).toBe(90)
    expect(parseDuration("2d")).toBe(2880)
    for (const bad of ["soon", "4 hours", "", undefined, "-1h"]) expect(parseDuration(bad as any)).toBeUndefined()
  })

  it("never lets an agent act unattended on a paying client's work", () => {
    const paying = clientPolicy("umbrella", { ...business, clients: { umbrella: { kind: "client", standing: ["*"] } } })
    expect(mayProceedUnattended(paying, "rebase-branch")).toBe(false)
    const own = clientPolicy("acme", { ...business, clients: { acme: { kind: "own", standing: ["rebase-branch"] } } })
    expect(mayProceedUnattended(own, "rebase-branch")).toBe(true)
    expect(mayProceedUnattended(own, "deploy")).toBe(false)
  })

  it("gives the monitor a principals band that filters, and stays parseable", () => {
    expect(renderMonitorPage()).toContain('id="principals"')
    expect(MONITOR_SCRIPT).toContain("renderPrincipals")
    // Clicking a principal must narrow the action list, not just decorate it.
    expect(MONITOR_SCRIPT).toContain("clientFilter?actions.filter")
    // Nothing configured means no band at all, so the overview stays compact.
    expect(MONITOR_SCRIPT).toContain("if(!rows.length){$('principals').innerHTML='';return;}")
    expect(() => new Function(MONITOR_SCRIPT)).not.toThrow()
  })
})
