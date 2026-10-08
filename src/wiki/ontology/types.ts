// --- Wiki ontology types (#811) ---
//
// The ontology says what kinds of things the wiki holds (types grouped
// into pillars), how they relate (properties), how important an event is,
// and how each type's page is viewed (lenses). Every value here comes
// from `ontology.yaml` in the wiki root, falling back to the generic
// defaults in `defaults.ts`. Nothing about a particular organisation
// belongs in code.

export type Importance = "minor" | "normal" | "major"

export const IMPORTANCE_LEVELS: readonly Importance[] = ["minor", "normal", "major"] as const

export interface PillarDef {
  id: string
  label: string
  /** One line under the pillar title. */
  description?: string
  /** Icon name from the view's small built-in icon set. */
  icon?: string
  /** Shown in the sidebar. A fallback pillar such as Topics sets false. */
  sidebar?: boolean
}

export interface TypeDef {
  id: string
  label: string
  plural?: string
  pillar: string
  /** schema.org class, shown as a hint on the page. */
  schema?: string
  icon?: string
  /** Panels the page opens with, in order. */
  lens?: LensPanel[]
}

export interface PropertyDef {
  id: string
  /** Read from the subject: "Person — role at → Organization". */
  label: string
  /** Read from the value's side: "Organization — people ← Person". */
  inverse?: string
  /** Wikidata property id, kept as a mapping hint. */
  wikidata?: string
  /** Types the value is expected to be. Informational. */
  range?: string[]
  /** Types the subject may be. A lens shows other subjects' statements
   *  through the inverse; `wiki enrich` writes it only on these (#820). */
  domain?: string[]
}

export type PanelSource = "statements" | "linked" | "history" | "discussed" | "readings" | "notes"

export interface LensPanel {
  /** Panel id. Used in the zoom URL, so keep it short and stable. */
  panel: string
  title?: string
  /** Where items come from. Inferred from the other fields when omitted. */
  source?: PanelSource
  /** Properties to show (statements panels). `related` covers plain links. */
  from?: string | string[]
  /** Keep only items whose other end has one of these types. */
  types?: string[]
  /** Items shown at the overview level (Z2). The full list is Z3. */
  show?: number
  group_by?: "role" | "property"
  display?: "list" | "timeline"
  /** History: importance levels shown unfolded. */
  importance?: Importance[]
  /** History: levels folded under a count. */
  fold?: Importance
  /** History: repeated minor events shown as one recurring line. */
  rollup?: { min: number; days: number }
  /** Readings: only the latest value per metric. */
  latest?: boolean
  /** `owner` marks the panel as private to the owner. */
  access?: "owner"
}

export interface ClassifyRule {
  /** Type the matching page gets. */
  type: string
  /** Match when the page's legacy `type` is one of these. */
  legacy?: string[]
  /** Match when the page path starts with one of these folders. */
  path?: string[]
  /** Match when the page has any of these tags. */
  tags?: string[]
  /** Case-insensitive regular expression on the title. */
  title?: string
}

export interface Ontology {
  version: number
  pillars: PillarDef[]
  types: TypeDef[]
  properties: PropertyDef[]
  importance: {
    default: Importance
    /** Who may set `major`: "owner" means agents can only propose it. */
    major_set_by: "owner" | "anyone"
    rollup: { min: number; days: number }
  }
  sidebar: {
    pins_max: number
    /** Page titles the owner pinned, in order. */
    pins: string[]
  }
  /** Rules that give a page a type, tried in order. The first match wins. */
  classify: ClassifyRule[]
  /** Type for pages no rule matches. */
  fallback_type: string
  /** Extra names of the fleet's agents, for agents that run on another
   *  node or answer to a persona name (#819). The node's own agent ids,
   *  configured names and persona names are found without this. */
  agent_names?: string[]
}

/** One typed fact about a page: subject (the page) → property → value. */
export interface WikiStatement {
  property: string
  /** A page title (becomes a link) or a literal value. */
  value: string
  role?: string
  since?: string
  until?: string
  /** Metric name for readings (disk_used, uptime). */
  metric?: string
  /** When a reading was taken. */
  at?: string
  /** Where it comes from: entry id, document, gazette reference, article. */
  source?: string
  access?: "public" | "shared" | "private"
  status?: "proposed" | "confirmed"
  confirmed_by?: string
  checked_at?: string
  /** The job that wrote it, e.g. "wiki-enrich"; its next run replaces it. */
  by?: string
  note?: string
}
