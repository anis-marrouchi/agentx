// --- Routes for the knowledge-graph view (#811) ---
//
//   /                      Home: pillars, recent events, needs attention
//   /p/<pillar>?kind=<t>   Z1 pillar, one kind open
//   /p/<pillar>/<type>     every page of one kind (paginated)
//   /e/<id>                Z2 entity overview, through its type's lens
//   /e/<id>/<panel>        Z3 one panel in full (paginated)
//   /e/<id>/s/<n>          Z4 one statement and its source
//   /find?q=               search by name, then by text
//   /ontology              the ontology in use and its problems

import type { WikiHub } from "../hub"
import { GraphCache } from "./graph"
import { loadOntology } from "./load"
import { entityPage, panelPage, statementPage, type EntityViewCtx } from "./view-entity"
import { findPage, homePage, kindListPage, ontologyPage, pillarPage } from "./view-browse"

export class OntologyRoutes {
  private cache = new GraphCache()

  constructor(private hub: WikiHub, private wikiDir: string) {}

  /** HTML for the path, or null when the path is not one of these routes
   *  or names something that does not exist. */
  handle(path: string, params: URLSearchParams): string | null {
    if (!(path === "/" || path === "" || path.startsWith("/p/") || path.startsWith("/e/") || path === "/find" || path === "/ontology")) return null
    const { ontology, errors, file } = loadOntology(this.wikiDir)
    const g = this.cache.get(this.hub, ontology)
    const page = Math.max(1, Number(params.get("page")) || 1)

    if (path === "/" || path === "") return homePage(g, errors)
    if (path === "/find") return findPage(g, params.get("q") ?? "")
    if (path === "/ontology") return ontologyPage(g, errors, file)

    // The caller already decoded the path.
    const parts = path.split("/").filter(Boolean)
    if (parts[0] === "p") {
      if (parts.length === 2) return pillarPage(g, parts[1], params.get("kind"))
      if (parts.length === 3) return kindListPage(g, parts[1], parts[2], page, params.get("importance"))
      return null
    }
    const e = g.entities.get(parts[1] ?? "")
    if (!e) return null
    const ctx: EntityViewCtx = {
      g,
      readEntries: ids => this.hub.getSharedStore().readEntries(ids),
      versions: (agentId, articlePath) => this.hub.getAgentWiki(agentId).getVersions(articlePath),
    }
    if (parts.length === 2) return entityPage(ctx, e)
    if (parts.length === 3) return panelPage(ctx, e, parts[2], page)
    if (parts.length === 4 && parts[2] === "s") return statementPage(ctx, e, Number(parts[3]))
    return null
  }
}
