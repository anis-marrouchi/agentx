// --- Default wiki ontology (#811) ---
//
// Generic starting point: nine pillars, the types inside them, the typed
// relations between them and a lens for every type. An owner overrides
// any section in `<wiki>/ontology.yaml`; `agentx wiki ontology init`
// writes this file out as a starting point. Keep it free of any
// particular organisation, person, country or product.

import type { LensPanel, Ontology, TypeDef } from "./types"

const history = (show = 5): LensPanel => ({
  panel: "history", title: "History", source: "history", show,
  importance: ["major", "normal"], fold: "minor", rollup: { min: 5, days: 30 },
})
const discussed: LensPanel = { panel: "discussed", title: "Discussed", source: "discussed", show: 3, access: "owner" }
const notes = (show = 1): LensPanel => ({ panel: "notes", title: "Notes", source: "notes", show })

const ASSET_TYPES = ["device", "server", "app", "domain", "account", "agent"]

const types: TypeDef[] = [
  // Parties
  {
    id: "person", label: "Person", plural: "People", pillar: "parties", schema: "Person", icon: "person",
    lens: [
      { panel: "roles", title: "Roles over time", from: ["role_at", "member_of", "founded"], show: 6, display: "timeline" },
      { panel: "relations", title: "Relations", from: ["works_with", "reports_to", "client_of", "works_on", "related"], types: ["person", "organization", "project"], show: 5, group_by: "role" },
      // Agents are not a person's belongings or relations (#819).
      { panel: "belongings", title: "Belongings", from: ["owns", "uses", "related"], types: ASSET_TYPES.filter(t => t !== "agent"), show: 5 },
      { panel: "obligations", title: "Obligations they carry", from: ["subject_to"], show: 3 },
      history(),
      discussed,
      notes(),
    ],
  },
  {
    id: "organization", label: "Organization", plural: "Organizations", pillar: "parties", schema: "Organization", icon: "org",
    lens: [
      { panel: "people", title: "People and roles", from: ["role_at", "member_of", "founded"], show: 6, group_by: "role" },
      { panel: "facts", title: "Key facts", from: ["registered_with", "located_in", "identifier", "legal_form"], show: 6 },
      { panel: "obligations", title: "Obligations and next due dates", from: ["subject_to"], show: 4 },
      { panel: "agreements", title: "Agreements", source: "linked", types: ["contract"], show: 4 },
      { panel: "decisions", title: "Decisions", source: "linked", types: ["decision", "policy"], show: 4 },
      history(),
      discussed,
      notes(),
    ],
  },
  // Places & Jurisdictions
  {
    id: "place", label: "Place", plural: "Places", pillar: "places", schema: "Place", icon: "pin",
    lens: [
      { panel: "here", title: "What is here", from: ["located_in", "related"], show: 6 },
      { panel: "laws", title: "Laws that apply here", from: ["applies_in"], show: 5 },
      history(),
      notes(),
    ],
  },
  {
    id: "jurisdiction", label: "Jurisdiction", plural: "Jurisdictions", pillar: "places", schema: "AdministrativeArea", icon: "pin",
    lens: [
      { panel: "laws", title: "Laws in force", from: ["applies_in"], show: 6 },
      { panel: "authorities", title: "Authorities with reach", from: ["jurisdiction_of"], show: 5 },
      { panel: "here", title: "What is here", from: ["located_in"], show: 5 },
      notes(),
    ],
  },
  // Assets
  {
    id: "device", label: "Device", plural: "Devices", pillar: "assets", schema: "Product", icon: "device",
    lens: [
      { panel: "state", title: "State now", source: "readings", latest: true, show: 6 },
      history(),
      { panel: "apps", title: "Installed apps", from: ["installed_on"], show: 5 },
      discussed,
      { panel: "parties", title: "Owner, user, location", from: ["owns", "uses", "located_in", "related"], types: ["person", "organization", "place"], show: 5 },
      notes(),
    ],
  },
  {
    id: "server", label: "Server", plural: "Servers", pillar: "assets", schema: "Product", icon: "server",
    lens: [
      { panel: "state", title: "State now", source: "readings", latest: true, show: 6 },
      history(),
      { panel: "hosts", title: "Hosted services", from: ["installed_on", "runs_on"], show: 6 },
      discussed,
      { panel: "parties", title: "Owner and location", from: ["owns", "uses", "located_in"], show: 4 },
      notes(),
    ],
  },
  {
    id: "app", label: "App or system", plural: "Apps", pillar: "assets", schema: "SoftwareApplication", icon: "app",
    lens: [
      { panel: "installs", title: "Where it runs", from: ["installed_on", "runs_on"], show: 5 },
      { panel: "licence", title: "Licence or subscription", from: ["party_to", "licensed_by"], show: 3 },
      history(),
      discussed,
      notes(),
    ],
  },
  {
    id: "domain", label: "Domain", plural: "Domains", pillar: "assets", schema: "WebSite", icon: "globe",
    lens: [
      { panel: "holder", title: "Holder", from: ["owns", "registrar"], show: 3 },
      { panel: "dues", title: "Renewal and due dates", source: "linked", types: ["due_date"], show: 4 },
      { panel: "services", title: "Linked services", from: ["related"], show: 5 },
      history(),
      notes(),
    ],
  },
  {
    id: "account", label: "Account", plural: "Accounts", pillar: "assets", schema: "Service", icon: "key",
    lens: [
      { panel: "holder", title: "Holder", from: ["owns", "uses"], show: 3 },
      { panel: "dues", title: "Renewal and due dates", source: "linked", types: ["due_date"], show: 4 },
      history(),
      notes(),
    ],
  },
  {
    id: "agent", label: "Agent", plural: "Agents", pillar: "assets", schema: "SoftwareApplication", icon: "agent",
    lens: [
      { panel: "runs", title: "Where it runs", from: ["runs_on", "installed_on", "related"], types: ["server", "device"], show: 4 },
      { panel: "works", title: "Works for", from: ["works_for", "uses", "related"], types: ["person", "organization", "project"], show: 5 },
      history(),
      discussed,
      notes(),
    ],
  },
  // Offerings & Projects
  {
    id: "project", label: "Project", plural: "Projects", pillar: "offerings", schema: "Project", icon: "project",
    lens: [
      { panel: "people", title: "Client and people", from: ["client", "client_of", "works_on", "related"], types: ["person", "organization", "agent"], show: 6, group_by: "role" },
      { panel: "agreements", title: "Agreements", source: "linked", types: ["contract"], show: 3 },
      { panel: "decisions", title: "Decisions", source: "linked", types: ["decision", "policy"], show: 4 },
      history(6),
      discussed,
      notes(),
    ],
  },
  {
    id: "offering", label: "Offering", plural: "Offerings", pillar: "offerings", schema: "Offer", icon: "project",
    lens: [
      { panel: "clients", title: "Clients", from: ["client_of", "related"], types: ["organization", "person"], show: 5 },
      history(),
      notes(),
    ],
  },
  // Agreements
  {
    id: "contract", label: "Agreement", plural: "Agreements", pillar: "agreements", schema: "Contract", icon: "contract",
    lens: [
      { panel: "parties", title: "Parties and roles", from: ["party_to"], show: 5, group_by: "role" },
      { panel: "terms", title: "Key terms and dates", from: ["starts", "renews", "notice", "amount"], show: 6 },
      { panel: "obligations", title: "Obligations it creates", from: ["creates"], show: 5 },
      { panel: "amendments", title: "Amendments", from: ["amends"], show: 4 },
      history(),
      notes(),
    ],
  },
  // Law & Obligations
  {
    id: "legal_source", label: "Legal source", plural: "Legal sources", pillar: "law", schema: "Legislation", icon: "law",
    lens: [
      { panel: "reference", title: "Gazette reference and dates", from: ["identifier", "published_in", "in_force_from", "legal_force", "issued_by"], show: 6 },
      { panel: "creates", title: "Obligations, penalties and reliefs it creates", from: ["creates", "created_by"], show: 6 },
      { panel: "amends", title: "Amends and amended by", from: ["amends", "repeals", "implements"], show: 5 },
      { panel: "applies", title: "Where it applies", from: ["applies_in"], show: 3 },
      notes(),
    ],
  },
  {
    id: "obligation", label: "Obligation", plural: "Obligations", pillar: "law", schema: "LegalRuleML Obligation", icon: "law",
    lens: [
      { panel: "rule", title: "Who must do what, by when", from: ["action", "bearer", "due_rule", "amount_rule", "authority", "status"], show: 6 },
      { panel: "dues", title: "Next due dates", source: "linked", types: ["due_date"], show: 4 },
      { panel: "sources", title: "Source articles", from: ["created_by", "changed_by"], show: 4 },
      { panel: "penalties", title: "Penalties and reliefs", from: ["penalty_for", "relieves"], show: 4 },
      { panel: "procedure", title: "Procedure", from: ["procedure"], show: 2 },
      { panel: "bearers", title: "Who carries it", from: ["subject_to"], show: 5 },
      history(4),
      notes(),
    ],
  },
  {
    id: "penalty", label: "Penalty", plural: "Penalties", pillar: "law", schema: "LegalRuleML Penalty", icon: "law",
    lens: [
      { panel: "rule", title: "For which failure, how much", from: ["penalty_for", "kind", "amount_rule", "created_by"], show: 6 },
      notes(),
    ],
  },
  {
    id: "relief", label: "Relief", plural: "Reliefs", pillar: "law", schema: "LegalRuleML Permission", icon: "law",
    lens: [
      { panel: "rule", title: "What it relieves, for whom, until when", from: ["relieves", "bearer", "condition", "created_by"], show: 6 },
      notes(),
    ],
  },
  {
    id: "due_date", label: "Due date", plural: "Due dates", pillar: "law", schema: "Event", icon: "calendar",
    lens: [
      { panel: "due", title: "Due", from: ["due_for", "bearer", "due", "status", "fulfilled_by"], show: 6 },
      notes(),
    ],
  },
  // Events
  {
    id: "event", label: "Event", plural: "Events", pillar: "events", schema: "Event", icon: "calendar",
    lens: [
      notes(1),
      { panel: "involved", title: "Who and what was involved", from: ["involves", "affects", "related"], show: 8 },
      { panel: "followed", title: "What followed", source: "linked", types: ["event", "decision"], show: 4 },
      discussed,
    ],
  },
  // Decisions & Policies
  {
    id: "decision", label: "Decision", plural: "Decisions", pillar: "decisions", schema: "ChooseAction", icon: "decision",
    lens: [
      notes(1),
      { panel: "affects", title: "What it affects", from: ["affects", "creates", "related"], show: 6 },
      { panel: "replaced", title: "Replaced by", from: ["replaced_by"], show: 2 },
      discussed,
    ],
  },
  {
    id: "policy", label: "Policy", plural: "Policies", pillar: "decisions", schema: "LegalRuleML Obligation", icon: "decision",
    lens: [
      { panel: "rule", title: "Rule", from: ["action", "bearer", "creates", "created_by"], show: 6 },
      { panel: "affects", title: "What it affects", from: ["affects", "related"], show: 6 },
      notes(),
    ],
  },
  // Procedures
  {
    id: "procedure", label: "Procedure", plural: "Procedures", pillar: "procedures", schema: "HowTo", icon: "steps",
    lens: [
      notes(1),
      { panel: "triggers", title: "What triggers it", from: ["procedure", "triggered_by", "related"], show: 5 },
      { panel: "runs", title: "Last runs", source: "linked", types: ["event"], show: 4 },
    ],
  },
  // Topics (fallback, not in the sidebar)
  {
    id: "topic", label: "Topic", plural: "Topics", pillar: "topics", schema: "skos:Concept", icon: "topic",
    lens: [
      notes(1),
      { panel: "related", title: "Related", from: ["related"], show: 8 },
      history(4),
    ],
  },
]

export const DEFAULT_ONTOLOGY: Ontology = {
  version: 1,
  pillars: [
    { id: "parties", label: "Parties", description: "People and organisations, and the roles between them", icon: "person" },
    { id: "places", label: "Places & Jurisdictions", description: "Where things are, and whose rules apply there", icon: "pin" },
    { id: "assets", label: "Assets", description: "What is owned or run: devices, servers, apps, domains, accounts, agents", icon: "server" },
    { id: "offerings", label: "Offerings & Projects", description: "What is sold, built or delivered", icon: "project" },
    { id: "agreements", label: "Agreements", description: "Contracts, subscriptions and their terms", icon: "contract" },
    { id: "law", label: "Law & Obligations", description: "Legal sources, the obligations they create, penalties, reliefs and due dates", icon: "law" },
    { id: "events", label: "Events", description: "What happened, by importance", icon: "calendar" },
    { id: "decisions", label: "Decisions & Policies", description: "Why things are the way they are", icon: "decision" },
    { id: "procedures", label: "Procedures", description: "How things are done", icon: "steps" },
    { id: "topics", label: "Topics", description: "Pages no type fits yet. A growing count means a type is missing.", icon: "topic", sidebar: false },
  ],
  types,
  properties: [
    { id: "related", label: "related to", inverse: "related to" },
    { id: "role_at", label: "role at", inverse: "people", wikidata: "P108", range: ["organization"], domain: ["person"] },
    { id: "member_of", label: "member of", inverse: "members", wikidata: "P463", range: ["organization"], domain: ["person", "organization"] },
    { id: "founded", label: "founded", inverse: "founded by", wikidata: "P112", domain: ["person", "organization"] },
    { id: "works_with", label: "works with", inverse: "works with", domain: ["person", "organization"] },
    { id: "reports_to", label: "reports to", inverse: "manages", domain: ["person"] },
    { id: "client_of", label: "client of", inverse: "clients", wikidata: "P1972", domain: ["person", "organization"] },
    { id: "client", label: "is for client", inverse: "projects", range: ["organization", "person"], domain: ["project", "offering", "contract"] },
    { id: "works_on", label: "works on", inverse: "people", range: ["project"], domain: ["person", "organization", "agent"] },
    { id: "works_for", label: "works for", inverse: "agents", wikidata: "P108", domain: ["agent", "person"] },
    { id: "owns", label: "owns", inverse: "owned by", wikidata: "P1830" },
    { id: "uses", label: "uses", inverse: "used by", wikidata: "P2283" },
    { id: "located_in", label: "located in", inverse: "here", wikidata: "P276" },
    { id: "installed_on", label: "installed on", inverse: "installed apps", range: ["device", "server"] },
    { id: "runs_on", label: "runs on", inverse: "hosts" },
    { id: "registered_with", label: "registered with", inverse: "registered" },
    { id: "identifier", label: "identifier", wikidata: "P1448" },
    { id: "legal_form", label: "legal form", wikidata: "P1454" },
    { id: "registrar", label: "registrar" },
    { id: "licensed_by", label: "licensed by", inverse: "licences" },
    { id: "party_to", label: "party to", inverse: "parties" },
    { id: "starts", label: "starts" },
    { id: "renews", label: "renews" },
    { id: "notice", label: "notice period" },
    { id: "amount", label: "amount" },
    { id: "creates", label: "creates", inverse: "created by" },
    { id: "created_by", label: "created by", inverse: "creates" },
    { id: "changed_by", label: "changed by", inverse: "changes" },
    { id: "amends", label: "amends", inverse: "amended by", wikidata: "P144" },
    { id: "repeals", label: "repeals", inverse: "repealed by" },
    { id: "implements", label: "implements", inverse: "implemented by" },
    { id: "issued_by", label: "issued by", inverse: "issues" },
    { id: "published_in", label: "published in", wikidata: "P1433" },
    { id: "in_force_from", label: "in force from", wikidata: "P7588" },
    { id: "legal_force", label: "legal force" },
    { id: "applies_in", label: "applies in", inverse: "laws that apply", wikidata: "P1001" },
    { id: "jurisdiction_of", label: "authority in", inverse: "authorities" },
    { id: "subject_to", label: "subject to", inverse: "carried by" },
    { id: "action", label: "action" },
    { id: "bearer", label: "bearer" },
    { id: "due_rule", label: "due" },
    { id: "amount_rule", label: "amount" },
    { id: "authority", label: "authority", inverse: "collects" },
    { id: "status", label: "status" },
    { id: "penalty_for", label: "penalty for", inverse: "penalties" },
    { id: "relieves", label: "relieves", inverse: "reliefs" },
    { id: "condition", label: "condition" },
    { id: "kind", label: "kind" },
    { id: "procedure", label: "procedure", inverse: "carries out" },
    { id: "due_for", label: "due for", inverse: "due dates" },
    { id: "due", label: "due on" },
    { id: "fulfilled_by", label: "fulfilled by", inverse: "fulfils" },
    { id: "involves", label: "involves", inverse: "events", wikidata: "P710" },
    { id: "affects", label: "affects", inverse: "affected by" },
    { id: "replaced_by", label: "replaced by", inverse: "replaces", wikidata: "P1366" },
    { id: "triggered_by", label: "triggered by", inverse: "triggers" },
    { id: "mentions", label: "mentions", inverse: "discussed in" },
    { id: "reading", label: "reading" },
    { id: "importance_set", label: "importance set" },
  ],
  importance: {
    default: "normal",
    major_set_by: "owner",
    rollup: { min: 5, days: 30 },
    // Routine machine upkeep: true for any fleet, so safe as a default.
    rules: [
      { level: "minor", title: "\\b(disk|storage) (is |was |almost |nearly )?(full|pressure|cleanup|clean-up|usage|space)\\b" },
      { level: "minor", title: "\\b(cache|logs?|temp files?) (was |were )?(cleared|cleaned|purged|rotated|pruned)\\b" },
      { level: "minor", title: "\\b(restart(ed)?|reboot(ed)?|health ?check|heartbeat)\\b" },
    ],
  },
  sidebar: { pins_max: 5, pins: [] },
  classify: [
    // Old pages filed agents as people and machines as places; the title
    // tells them apart until absorb writes `class` on the page.
    { type: "agent", legacy: ["person", "concept", "project"], title: "\\bagents?\\b|\\bbot\\b" },
    { type: "server", legacy: ["place", "concept"], title: "\\b(server|vps|host|node)\\b" },
    { type: "device", legacy: ["place", "concept"], title: "\\b(laptop|macbook|desktop|phone|tablet|printer|router)\\b" },
    { type: "person", legacy: ["person"] },
    { type: "event", legacy: ["event"] },
    { type: "decision", legacy: ["decision"] },
    { type: "procedure", legacy: ["pattern"] },
    { type: "place", legacy: ["place"] },
    // Folder and tag rules below refine untyped and concept pages only.
    { type: "project", legacy: ["project"] },
    { type: "organization", path: ["clients", "customers", "vendors", "suppliers", "organizations", "orgs", "companies"] },
    { type: "organization", tags: ["organization", "company", "client", "vendor", "supplier", "agency", "bank"] },
    { type: "server", path: ["servers", "hosts", "infrastructure"] },
    { type: "server", tags: ["server", "vps", "host"] },
    { type: "device", path: ["devices"] },
    { type: "device", tags: ["device", "laptop", "phone", "printer"] },
    { type: "agent", tags: ["agent"], title: "\\bagent\\b" },
    { type: "app", path: ["apps", "systems", "services"] },
    { type: "domain", tags: ["domain", "dns"] },
    { type: "contract", path: ["contracts", "agreements"] },
    { type: "contract", tags: ["contract", "agreement", "subscription"] },
    { type: "legal_source", path: ["laws", "legislation"] },
    { type: "legal_source", tags: ["law", "legislation", "decree"] },
    { type: "obligation", path: ["obligations", "compliance"] },
    { type: "obligation", tags: ["obligation", "compliance"] },
    { type: "policy", path: ["policies"] },
    { type: "policy", tags: ["policy"] },
    { type: "procedure", path: ["runbooks", "procedures"] },
    { type: "procedure", tags: ["runbook", "procedure", "how-to"] },
  ],
  fallback_type: "topic",
}
