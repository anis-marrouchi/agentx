import { describe, expect, it } from "vitest"
import {
  clientFromProject, agentClients, matchContact, resolveClient, parseWorkRef,
  clientPolicy, listClients, parseDuration, mayProceedUnattended, UNMAPPED,
  type BusinessShape,
} from "../src/business/clients"
import { MONITOR_SCRIPT, renderMonitorPage } from "../src/daemon/ui/pages/monitor"

// Mirrors the real clawd config: projects under mtgl/ksi/noqta, a deep
// orgChart, and hasanah work that no project entry covers.
const business: BusinessShape = {
  projects: [
    { id: "mtgl/mtgl-system-v2", pm: "pm-mtgl" },
    { id: "ksi/ksi.tn", pm: "pm-ksi" },
    { id: "hasanah-lab/hasanah-v1", pm: "pm-hasanah", client: "hasanah" },
  ],
  orgChart: {
    "pm-mtgl": {}, "mtgl-v2": { reportsTo: "pm-mtgl" }, "mtgl-junior": { reportsTo: "mtgl-v2" },
    "pm-hasanah": {}, "hasanah-coding": { reportsTo: "pm-hasanah" },
  },
  contactMap: [{ channel: "telegram", chatId: "1816212449", client: "noqta" }],
  clients: { hasanah: { name: "Hasanah Lab", kind: "client", respondWithin: "4h" } },
}

describe("client resolution", () => {
  it("derives a client from the project namespace when none is declared", () => {
    expect(clientFromProject("mtgl/mtgl-system-v2", business.projects)).toBe("mtgl")
    expect(clientFromProject("hasanah-lab/hasanah-v1", business.projects)).toBe("hasanah")
    expect(clientFromProject("some-internal-thing", [])).toBe("some-internal-thing")
    expect(clientFromProject(null, [])).toBe(UNMAPPED)
  })

  it("carries a client down the org chart, so mesh dispatches are attributable", () => {
    const map = agentClients(business)
    expect(map.get("pm-mtgl")).toBe("mtgl")
    expect(map.get("mtgl-v2")).toBe("mtgl")
    expect(map.get("mtgl-junior")).toBe("mtgl")       // transitive, two hops
    expect(map.get("hasanah-coding")).toBe("hasanah")
  })

  it("lets a hand-written contact rule beat any heuristic", () => {
    expect(matchContact("telegram", { chatId: "1816212449" }, business.contactMap)?.client).toBe("noqta")
    expect(matchContact("telegram", { chatId: "999" }, business.contactMap)).toBeUndefined()
  })

  it("reads the principal off a monitor session id, whatever the channel", () => {
    const gl = parseWorkRef("hasanah-coding:gitlab:hasanah-lab/hasanah-v1:issue:94")
    expect(gl.project).toBe("hasanah-lab/hasanah-v1")
    expect(resolveClient(gl, business)).toBe("hasanah")

    const tg = parseWorkRef("marketing-agent:telegram:1816212449")
    expect(tg.chatId).toBe("1816212449")
    expect(resolveClient(tg, business)).toBe("noqta")

    const wa = parseWorkRef("atlas:whatsapp:21624309128@s.whatsapp.net")
    expect(wa.chatId).toBe("21624309128")

    // api and cron carry nothing addressable, so the agent's org seat decides.
    expect(resolveClient(parseWorkRef("hasanah-coding:api:default"), business)).toBe("hasanah")
    expect(resolveClient(parseWorkRef("nobody:api:default"), business)).toBe(UNMAPPED)
  })

  it("gives every derived client a policy without anyone declaring it", () => {
    const ids = listClients(business).map(c => c.id)
    expect(ids).toEqual(["hasanah", "ksi", "mtgl", "noqta"])
    const mtgl = clientPolicy("mtgl", business)
    expect(mtgl).toMatchObject({ name: "mtgl", declared: false, standing: [] })
    const hasanah = clientPolicy("hasanah", business)
    expect(hasanah).toMatchObject({ name: "Hasanah Lab", kind: "client", respondWithinMinutes: 240, declared: true })
  })

  it("treats an unparseable duration as no clock rather than an urgent one", () => {
    expect(parseDuration("4h")).toBe(240)
    expect(parseDuration("90m")).toBe(90)
    expect(parseDuration("2d")).toBe(2880)
    for (const bad of ["soon", "4 hours", "", undefined, "-1h"]) expect(parseDuration(bad as any)).toBeUndefined()
  })

  it("never lets an agent act unattended on a paying client's work", () => {
    const paying = clientPolicy("hasanah", { ...business, clients: { hasanah: { kind: "client", standing: ["*"] } } })
    expect(mayProceedUnattended(paying, "rebase-branch")).toBe(false)
    const own = clientPolicy("noqta", { ...business, clients: { noqta: { kind: "own", standing: ["rebase-branch"] } } })
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
