import { describe, expect, it } from "vitest"
import { renderWallPage, WALL_CLASSIC_LINKS } from "../src/daemon/ui/pages/wall"
import { renderMeshPage } from "../src/daemon/ui/pages/mesh"
import { HUB_OPERATIONS_SRC, hubOperationsPageHtml } from "../src/daemon/ui/pages/hub-operations"

// #2101 P8 (mock R8): Operations lives in the Hub, under the Hub's nav.
describe("the Hub's Operations page", () => {
  const page = renderWallPage({ owner: true })

  it("is a Fleet nav item that stays in the Hub", () => {
    expect(page).toContain('data-nav="operations" href="#page=operations"')
    expect(WALL_CLASSIC_LINKS).toContainEqual(["Operations", "#page=operations"])
  })

  it("holds /mesh in embed mode, loaded only when the page opens", () => {
    const s = hubOperationsPageHtml()
    expect(s).toContain('id="wall-operations"')
    expect(s).toContain(`data-src="${HUB_OPERATIONS_SRC}"`)
    expect(s).not.toMatch(/<iframe[^>]* src=/)
    expect(HUB_OPERATIONS_SRC).toBe("/mesh?embed=1&view=ops")
    expect(page).toContain('id="wall-operations"')
  })

  it("is where Dashboard goes, and nothing on it leaves for /mesh (#2101 R8)", () => {
    expect(page).toContain('data-nav="dashboard" href="#page=operations"')
    expect(page).not.toMatch(/data-nav="dashboard" href="\/mesh"/)
    expect(hubOperationsPageHtml()).not.toContain('href="/mesh"')
  })

  it("is one of the pages the Hub script switches to", () => {
    expect(page).toContain("'mobile', 'operations']")
    expect(page).toContain("$('wall-operations').hidden = page !== 'operations'")
    expect(page).toContain("opsShow(page === 'operations')")
  })
})

describe("/mesh in embed mode", () => {
  const full = renderMeshPage({})
  const embed = renderMeshPage({ embed: true })

  it("drops the top bar, page head and assistant drawer", () => {
    expect(full).toContain('class="ax-topbar')
    expect(embed).not.toContain('class="ax-topbar')
    expect(full).toContain("Mesh operations")
    expect(embed).not.toContain("<h1")
    expect(embed.length).toBeLessThan(full.length)
  })

  it("keeps the Operations views, their scripts and the details drawer", () => {
    for (const id of ['id="mx-view-ops"', 'id="mx-runs"', 'id="mx-routines"', 'id="mx-nodes"', 'id="mx-drawer"']) expect(embed).toContain(id)
  })

  it("opens the tab ?view= names without overwriting /mesh's remembered tab", () => {
    expect(embed).toContain("var asked=new URLSearchParams(location.search).get('view')")
    expect(embed).toContain("if(!asked)try{localStorage.setItem('mx-view',id)}")
  })
})
