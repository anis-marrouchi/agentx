import type { Ontology } from "./types"

/**
 * The built-in ontology, used for every section `.agentx/wiki/ontology.yaml`
 * leaves out (and in full when there is no file). Generic on purpose: no
 * organisation, person or country lives here; a jurisdiction is data added
 * on top.
 *
 * Grounding (#811, v0.2): types from schema.org, statements and qualifiers
 * from Wikidata, party-in-role from FIBO, legal texts from ELI, obligations
 * and penalties from LegalRuleML, resources and events from REA. Roles
 * (client, employer, accountant) are qualifiers on links, never types.
 */
export const STARTER_ONTOLOGY: Ontology = {
  version: 1,

  pillars: [
    { id: "parties", label: "Parties", types: ["person", "organization"], description: "Everything else is owed by, owned by or done by a party." },
    { id: "places", label: "Places & Jurisdictions", types: ["place"], description: "Law applies per jurisdiction; offices and servers have locations." },
    { id: "assets", label: "Assets", types: ["device", "server", "app", "domain", "account", "agent", "ip_right"], description: "What the organization owns or runs. Incidents attach here." },
    { id: "offerings", label: "Offerings & Projects", types: ["offering", "project"], description: "What the organization does for money, and where the work happens." },
    { id: "agreements", label: "Agreements", types: ["agreement"], description: "Private sources of obligations, parallel to law." },
    { id: "law", label: "Law & Obligations", types: ["legal_source", "obligation", "penalty", "relief", "due_date"], description: "The relationship with the state, contracts and internal policy." },
    { id: "events", label: "Events", types: ["event"], description: "What happened. Minor events stay inside the page they are about." },
    { id: "decisions", label: "Decisions & Policies", types: ["decision"], description: "Why things are the way they are." },
    { id: "procedures", label: "Procedures", types: ["procedure"], description: "How each obligation or task is carried out." },
  ],

  types: [
    { id: "person", label: "Person", schema_org: ["Person"], kinds: ["owner", "employee", "contact"] },
    { id: "organization", label: "Organization", schema_org: ["Organization", "Corporation", "GovernmentOrganization", "BankOrCreditUnion"], kinds: ["company", "government_body", "bank", "association"] },
    { id: "place", label: "Place", schema_org: ["Place", "Country", "City"], kinds: ["country", "region", "city", "site"] },
    { id: "device", label: "Device", schema_org: ["Product"], kinds: ["laptop", "desktop", "phone", "printer"] },
    { id: "server", label: "Server", schema_org: ["Product"], kinds: ["physical", "virtual"] },
    { id: "app", label: "App", schema_org: ["SoftwareApplication"], kinds: ["installed", "web", "service"] },
    { id: "domain", label: "Domain", schema_org: ["WebSite"], kinds: [] },
    { id: "account", label: "Account", schema_org: ["Thing"], kinds: ["online", "bank"] },
    { id: "agent", label: "Agent", schema_org: ["SoftwareApplication"], kinds: [], description: "An AgentX agent." },
    { id: "ip_right", label: "IP right", schema_org: ["Intangible"], kinds: ["trademark", "patent", "copyright"] },
    { id: "offering", label: "Offering", schema_org: ["Service", "Offer", "Product"], kinds: ["product", "service"] },
    { id: "project", label: "Project", schema_org: ["Project"], kinds: ["product", "client_engagement", "internal"] },
    { id: "agreement", label: "Agreement", schema_org: [], kinds: ["contract", "licence", "subscription", "engagement_letter", "mandate"] },
    { id: "legal_source", label: "Legal source", schema_org: ["Legislation"], kinds: ["law", "decree_law", "decree", "order", "finance_law", "guidance"], description: "A legal text, cited by its official identifier and gazette reference." },
    { id: "obligation", label: "Obligation", schema_org: [], kinds: ["obligation", "prohibition"], description: "Who must do what, by when, under which source. Law, contracts and internal policy use the same type." },
    { id: "penalty", label: "Penalty", schema_org: [], kinds: ["fixed_fine", "percent_of_amount", "interest", "criminal"] },
    { id: "relief", label: "Relief", schema_org: [], kinds: ["exemption", "extension", "remission", "amnesty"] },
    { id: "due_date", label: "Due date", schema_org: [], kinds: [], generated: true, description: "One per obligation, bearer and period." },
    { id: "event", label: "Event", schema_org: ["Event"], kinds: ["filing", "payment", "incident", "meeting", "release", "status_change"] },
    { id: "decision", label: "Decision", schema_org: ["ChooseAction"], kinds: ["approval", "policy_choice"] },
    { id: "procedure", label: "Procedure", schema_org: ["HowTo"], kinds: ["runbook", "how_to"] },
    { id: "topic", label: "Topic", schema_org: ["DefinedTerm"], kinds: [], fallback: true },
  ],

  properties: [
    // Parties and what they hold
    { id: "founded", label: "founded", inverse: "founded by", from: ["person", "organization"], to: ["organization"], qualifiers: ["since"], required: [], private: [], wikidata: ["P112"] },
    { id: "owns", label: "owns", inverse: "owned by", from: ["person", "organization"], to: ["organization", "device", "server", "app", "domain", "account", "agent", "ip_right", "offering", "project"], qualifiers: ["since", "until", "share"], required: [], private: [], wikidata: ["P127", "P1830"] },
    { id: "uses", label: "uses", inverse: "used by", from: ["person", "organization", "project", "agent"], to: ["device", "server", "app", "domain", "account", "agent"], qualifiers: ["since", "until"], required: [], private: [], wikidata: ["P2283"] },
    { id: "role_at", label: "has role at", inverse: "people", from: ["person"], to: ["organization"], qualifiers: ["role", "start", "end"], required: ["role"], private: [], wikidata: ["P108", "P39"] },
    { id: "member_of", label: "member of", inverse: "members", from: ["person", "organization"], to: ["organization"], qualifiers: ["start", "end"], required: [], private: [], wikidata: ["P463"] },
    { id: "client_of", label: "client of", inverse: "clients", from: ["person", "organization"], to: ["organization"], qualifiers: ["since", "until", "contract"], required: [], private: ["contract"], wikidata: [] },
    { id: "supplier_of", label: "supplier of", inverse: "suppliers", from: ["organization", "person"], to: ["organization"], qualifiers: ["what", "since", "until"], required: [], private: [], wikidata: [] },
    { id: "registered_with", label: "registered with", inverse: "registrations", from: ["person", "organization"], to: ["organization"], qualifiers: ["as", "id", "since"], required: ["as"], private: ["id"], wikidata: [] },
    { id: "party_to", label: "party to", inverse: "parties", from: ["person", "organization"], to: ["agreement"], qualifiers: ["role", "since"], required: ["role"], private: [], wikidata: [] },
    { id: "for_client", label: "for client", inverse: "projects", from: ["project", "offering"], to: ["organization", "person"], qualifiers: ["since", "until"], required: [], private: [], wikidata: [] },
    { id: "works_on", label: "works on", inverse: "worked on by", from: ["person", "agent", "organization"], to: ["project"], qualifiers: ["role", "start", "end"], required: [], private: [], wikidata: [] },
    { id: "located_in", label: "located in", inverse: "located here", from: ["*"], to: ["place"], qualifiers: ["since", "until"], required: [], private: [], wikidata: ["P131", "P17"] },
    { id: "part_of", label: "part of", inverse: "parts", from: ["*"], to: ["*"], qualifiers: [], required: [], private: [], wikidata: ["P361"] },

    // Assets
    { id: "installed_on", label: "installed on", inverse: "installed apps", from: ["app"], to: ["device", "server"], qualifiers: ["version", "since", "until"], required: [], private: [], wikidata: [] },
    { id: "runs_on", label: "runs on", inverse: "runs", from: ["app", "agent", "project", "server", "domain"], to: ["server", "device", "app"], qualifiers: ["since", "until"], required: [], private: [], wikidata: [] },
    { id: "covered_by", label: "covered by", inverse: "covers", from: ["app", "server", "domain", "account", "project", "offering"], to: ["agreement"], qualifiers: ["since", "until"], required: [], private: [], wikidata: [] },

    // Law & Obligations
    { id: "subject_to", label: "subject to", inverse: "applies to", from: ["person", "organization", "project"], to: ["obligation"], qualifiers: ["as", "since", "until"], required: ["as"], private: [], wikidata: ["P92"] },
    { id: "authority", label: "authority", inverse: "enforces", from: ["obligation"], to: ["organization"], qualifiers: [], required: [], private: [], wikidata: [] },
    { id: "beneficiary", label: "beneficiary", inverse: "benefits from", from: ["obligation"], to: ["person", "organization"], qualifiers: [], required: [], private: [], wikidata: [] },
    { id: "issued_by", label: "issued by", inverse: "issued", from: ["legal_source"], to: ["organization"], qualifiers: [], required: [], private: [], wikidata: ["P2378"] },
    { id: "applies_in", label: "applies in", inverse: "laws that apply here", from: ["legal_source", "obligation"], to: ["place"], qualifiers: [], required: [], private: [], wikidata: ["P1001"] },
    { id: "created_by", label: "created by", inverse: "creates", from: ["obligation", "penalty", "relief"], to: ["legal_source", "agreement", "decision"], qualifiers: ["article", "clause"], required: [], private: [], wikidata: ["P92"] },
    { id: "changed_by", label: "changed by", inverse: "changes", from: ["obligation", "penalty", "relief"], to: ["legal_source", "agreement", "decision"], qualifiers: ["article", "applies_from"], required: ["applies_from"], private: [], wikidata: [] },
    { id: "amends", label: "amends", inverse: "amended by", from: ["legal_source"], to: ["legal_source"], qualifiers: ["article", "applies_from"], required: [], private: [], wikidata: [] },
    { id: "repeals", label: "repeals", inverse: "repealed by", from: ["legal_source"], to: ["legal_source"], qualifiers: ["article", "applies_from"], required: [], private: [], wikidata: [] },
    { id: "implements", label: "implements", inverse: "implemented by", from: ["legal_source", "procedure"], to: ["legal_source", "obligation"], qualifiers: [], required: [], private: [], wikidata: [] },
    { id: "consolidates", label: "consolidates", inverse: "consolidated in", from: ["legal_source"], to: ["legal_source"], qualifiers: [], required: [], private: [], wikidata: [] },
    { id: "penalty_for", label: "penalty for", inverse: "penalties", from: ["penalty"], to: ["obligation"], qualifiers: ["failure"], required: ["failure"], private: [], wikidata: [] },
    { id: "relieves", label: "relieves", inverse: "relieved by", from: ["relief"], to: ["obligation", "penalty"], qualifiers: ["condition", "from", "to"], required: [], private: [], wikidata: [] },
    { id: "has_procedure", label: "procedure", inverse: "carries out", from: ["obligation", "decision", "project"], to: ["procedure"], qualifiers: [], required: [], private: [], wikidata: [] },
    { id: "due_for", label: "due for", inverse: "due dates", from: ["due_date"], to: ["obligation"], qualifiers: ["period", "bearer"], required: ["period"], private: [], wikidata: [] },
    { id: "fulfils", label: "fulfils", inverse: "fulfilled by", from: ["event"], to: ["due_date", "obligation"], qualifiers: ["evidence"], required: [], private: ["evidence"], wikidata: [] },

    // Events and decisions
    { id: "about", label: "about", inverse: "events", from: ["event", "decision"], to: ["*"], qualifiers: ["primary"], required: [], private: [], wikidata: ["P921"], description: "Every event has exactly one primary page it is about." },
    { id: "involves", label: "involves", inverse: "involved in", from: ["event"], to: ["person", "organization", "agent"], qualifiers: ["role"], required: [], private: [], wikidata: ["P710"] },
    { id: "decided_by", label: "decided by", inverse: "decisions", from: ["decision"], to: ["person"], qualifiers: ["date"], required: [], private: [], wikidata: [] },
    { id: "supersedes", label: "supersedes", inverse: "superseded by", from: ["decision", "legal_source", "obligation", "agreement"], to: ["decision", "legal_source", "obligation", "agreement"], qualifiers: ["date"], required: [], private: [], wikidata: ["P1365"] },

    // Sources and fallback
    { id: "mentions", label: "mentions", inverse: "discussed", from: ["*"], to: ["*"], qualifiers: ["channel", "date"], required: [], private: [], wikidata: [], description: "A conversation summary, kept as a source, names this page. Transcripts are never copied." },
    { id: "related_to", label: "related to", inverse: "related to", from: ["*"], to: ["*"], qualifiers: [], required: [], private: [], wikidata: [], description: "Fallback when no other property fits." },
  ],

  importance: [
    { id: "minor", label: "Minor", test: "Routine; nothing lasting changes and it resolved by itself (disk full, cache cleared, a deploy that went fine).", nav: false, own_page: "never" },
    { id: "normal", label: "Normal", test: "Changes a fact or needs a follow-up (new contact, deadline met, incident with a root cause).", nav: false, own_page: "if_long" },
    { id: "major", label: "Major", test: "Changes the owner's world: money, legal standing, a client relationship starting or ending, a production outage, a strategic decision.", nav: true, own_page: "always" },
  ],

  rollup: { level: "minor", min: 5, window_days: 30, raise_to: "normal" },
  major: { level: "major", set_by: ["owner"], agents_propose: true },
  confirm: { legal: ["owner", "accountant"] },
  sidebar: { pins_max: 5, show: ["home", "pins", "pillars"] },

  lenses: {
    person: [
      { panel: "roles_over_time", from: "role_at", show: 6 },
      { panel: "relations", from: ["member_of", "client_of", "supplier_of", "registered_with", "party_to"], group_by: "role", show: 5 },
      { panel: "belongings", from: ["owns", "uses"], show: 5 },
      { panel: "obligations", from: "subject_to", show: 3 },
      { panel: "history", from: "events", importance: ["major", "normal"], fold: "minor" },
      { panel: "discussed", from: "mentions", access: "owner" },
    ],
    organization: [
      { panel: "roles", from: ["role_at", "client_of", "supplier_of", "party_to"], group_by: "role", show: 6 },
      { panel: "key_facts", from: "facts", show: 6 },
      { panel: "obligations", from: ["subject_to", "due_dates"], show: 4 },
      { panel: "agreements", from: "party_to", show: 4 },
      { panel: "decisions", from: "decisions", show: 3 },
      { panel: "history", from: "events", importance: ["major", "normal"], fold: "minor" },
      { panel: "discussed", from: "mentions", access: "owner" },
    ],
    place: [
      { panel: "located_here", from: "located_in", show: 6 },
      { panel: "laws", from: "applies_in", show: 5 },
      { panel: "authorities", from: "located_in", group_by: "kind", show: 5 },
      { panel: "events_here", from: "events", importance: ["major", "normal"], fold: "minor" },
    ],
    device: [
      { panel: "state_now", from: "readings", latest: true },
      { panel: "events", from: "events", importance: ["major", "normal"], fold: "minor", rollup: { min: 5, days: 30 } },
      { panel: "installed_apps", from: "installed_on", show: 5 },
      { panel: "discussed", from: "mentions", access: "owner" },
      { panel: "parties", from: ["owns", "uses", "located_in"] },
    ],
    server: [
      { panel: "state_now", from: "readings", latest: true },
      { panel: "hosted", from: ["runs_on", "installed_on"], show: 5 },
      { panel: "events", from: "events", importance: ["major", "normal"], fold: "minor", rollup: { min: 5, days: 30 } },
      { panel: "discussed", from: "mentions", access: "owner" },
      { panel: "parties", from: ["owns", "uses", "located_in"] },
    ],
    app: [
      { panel: "where_it_runs", from: ["installed_on", "runs_on"], show: 5 },
      { panel: "version", from: "facts", show: 3 },
      { panel: "licence", from: "covered_by", show: 3 },
      { panel: "incidents", from: "events", importance: ["major", "normal"], fold: "minor" },
      { panel: "discussed", from: "mentions", access: "owner" },
    ],
    domain: [
      { panel: "holder", from: ["owns", "uses"], show: 3 },
      { panel: "renewals", from: "due_dates", show: 3 },
      { panel: "linked_services", from: ["runs_on", "covered_by"], show: 5 },
      { panel: "events", from: "events", importance: ["major", "normal"], fold: "minor" },
    ],
    account: [
      { panel: "holder", from: ["owns", "uses"], show: 3 },
      { panel: "renewals", from: "due_dates", show: 3 },
      { panel: "linked_services", from: ["uses", "covered_by"], show: 5 },
      { panel: "events", from: "events", importance: ["major", "normal"], fold: "minor" },
    ],
    agent: [
      { panel: "work", from: ["works_on", "uses"], show: 5 },
      { panel: "where_it_runs", from: "runs_on", show: 3 },
      { panel: "events", from: "events", importance: ["major", "normal"], fold: "minor" },
      { panel: "discussed", from: "mentions", access: "owner" },
    ],
    project: [
      { panel: "client_and_status", from: ["for_client", "facts"], show: 4 },
      { panel: "people", from: "works_on", group_by: "role", show: 6 },
      { panel: "milestones", from: "events", importance: ["major", "normal"], show: 5 },
      { panel: "agreements", from: "covered_by", show: 3 },
      { panel: "decisions", from: "decisions", show: 3 },
      { panel: "recent_events", from: "events", importance: ["major", "normal"], fold: "minor" },
    ],
    agreement: [
      { panel: "parties", from: "party_to", group_by: "role", show: 4 },
      { panel: "key_terms", from: "facts", show: 6 },
      { panel: "obligations", from: "created_by", show: 5 },
      { panel: "dates", from: "due_dates", show: 4 },
      { panel: "amendments", from: ["changed_by", "supersedes"], show: 3 },
    ],
    legal_source: [
      { panel: "reference", from: "facts", show: 6 },
      { panel: "creates", from: "created_by", group_by: "article", show: 6 },
      { panel: "amends", from: ["amends", "repeals", "implements", "consolidates"], show: 5 },
      { panel: "applies_in", from: "applies_in", show: 3 },
    ],
    obligation: [
      { panel: "rule", from: ["facts", "subject_to", "authority"], show: 6 },
      { panel: "next_due", from: "due_dates", show: 3 },
      { panel: "sources", from: ["created_by", "changed_by"], show: 4 },
      { panel: "penalties_and_reliefs", from: ["penalty_for", "relieves"], show: 4 },
      { panel: "procedure", from: "has_procedure", show: 2 },
      { panel: "fulfilments", from: "fulfils", show: 3 },
    ],
    event: [
      { panel: "what_changed", from: "facts", show: 6 },
      { panel: "involved", from: ["about", "involves"], show: 6 },
      { panel: "source", from: "statements", show: 3 },
      { panel: "rolled_up", from: "events", show: 6 },
    ],
    decision: [
      { panel: "context", from: "facts", show: 6 },
      { panel: "choice", from: "decided_by", show: 3 },
      { panel: "affects", from: "about", show: 5 },
      { panel: "obligations", from: "created_by", show: 3 },
      { panel: "replaced_by", from: "supersedes", show: 2 },
    ],
    procedure: [
      { panel: "steps", from: "facts", show: 6 },
      { panel: "triggers", from: ["has_procedure", "implements"], show: 4 },
      { panel: "last_runs", from: "events", show: 5 },
    ],
    default: [
      { panel: "facts", from: "facts", show: 6 },
      { panel: "links", from: "statements", show: 6 },
      { panel: "history", from: "events", importance: ["major", "normal"], fold: "minor" },
      { panel: "discussed", from: "mentions", access: "owner" },
    ],
  },
}
