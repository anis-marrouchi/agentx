# Wiki ontology: pillars, statements, law and obligations

Status: **approved** by the owner on 2026-10-08 (v0.2, the design mockups and v0.3, as a whole; #811). The decisions in section 8 were taken as recommended. The starter `ontology.yaml` is in `src/wiki/ontology/` (`agentx wiki ontology show | check | init`); the rest of the build follows the steps at the end.

Changes in v0.3 (section 5): how each page is **viewed**, "the right level of view at each node, like a zoom".

1. The sidebar is the widest view and stays short: Home, up to 5 pinned pages and the 9 pillars. No sub-types, counts or page lists.
2. Five zoom levels, Z0 to Z4. Every click goes one level in.
3. Each type has a **lens**: the panels its page opens with, in order. Lenses live in `ontology.yaml`, not in code.
4. Conversations become sources linked to the things they mention, shown in a "Discussed" panel on each page.
5. Devices and apps are Asset kinds with an `installed_on` relation; `owns` / `uses` are dated so belongings show on the person.

Changes in v0.2 (since v0.1):

1. The types come from established ontologies (section 1), not from the examples in the request. Each pillar names its source and gives a one-line reason.
2. The "rule" pillar is now **Law & Obligations**. It covers the company's whole relationship with the state (tax, social security, registries, data protection, any authority), plus contracts and internal policies. Every obligation names who owes it, the authority, the due rule and the penalties. It also links to the article of the text that creates it, with the official gazette reference.
3. A new law arrives as a new **source** that adds, changes, suspends or relieves obligations. Nothing is overwritten. Each version keeps the dates it applies.
4. The pilot pages are chosen to stress the model, not to match the examples.

Why this is needed, measured on a live fleet wiki (2026-10-08): 5,990 articles, half of them event pages at top level; one owner spread over 5 person pages written by different agents; the company spread over 30+ pages and 8 agents; one social-security agency on 14 pages with no single page for the obligation itself.

## 1. What a company world model needs

| Source | What it contributes | What we take |
|---|---|---|
| **schema.org** | The shared web vocabulary: `Person`, `Organization` (+ `GovernmentOrganization`, `Corporation`), `Place`, `Product` / `Service` / `Offer`, `Event`, `Legislation` (with `legislationIdentifier`, `legislationDate`, `legislationDateOfApplicability`, `legislationAmends`, `legislationRepeals`, `legislationChanges`, `legislationJurisdiction`, `legislationLegalForce`), `HowTo`, `MonetaryAmount` | Type names and the fields on legal texts |
| **Wikidata** | Statement model: item → property → value + qualifiers (start/end P580/P582, role P2868/P3831) + references (stated in P248, retrieved P813). Legal properties: issued by P2378, applies to jurisdiction P1001, main regulatory text P92, replaces P1365 | How each fact is stored, its sources and its validity dates |
| **FIBO** (BE, FND Agreements/Law) | Separates the **legal person** from the **role it plays** (party-in-role). Contracts as sources of commitments, registration identifiers, ownership and control | "Client", "employer" and "accountant" are **roles on a relation**, not types |
| **W3C ORG / RegOrg** | Membership and post with a role and a time interval; registered organization with legal identifier, legal form and status | `role_at` with qualifiers; registration as a statement with private identifiers |
| **ELI** (European Legislation Identifier) | A legal text has a stable identifier, versions over time, and amends / repeals / consolidates links. Document date, date in force and date of applicability are kept apart | How a law is cited and versioned, and how a new law changes an old one |
| **LegalRuleML** (OASIS) | Deontic statements (**Obligation, Prohibition, Permission, Right**) with a **bearer** and auxiliary parties. **Penalty statements linked to the violated obligation** (reparation). Separate validity, efficacy, applicability and in-force times | The shape of an Obligation and its Penalty, and why several dates are stored |
| **REA** (Resource–Event–Agent; ISO/IEC 15944-4) | Economic **agents** exchange **resources** through economic **events**, governed by **commitments** | Assets as a pillar; events that fulfil obligations (a filing or payment fulfils a due date); contracts as commitments |
| **PROV-O** | Provenance: who produced a statement, from what, and when | Every statement records its source agent, entry, document and check date |
| **gUFO / OntoUML** | A *kind* is what something is (a person). A *role* is what it does in a relation (an employee) | The modelling rule: no type is a role |

### Modelling rules

1. **Types are what a thing is. Roles go on relations.** One page per real thing for the whole fleet, with id `type/slug`. An organization can be a client, a supplier and an authority on different relations.
2. **Every fact is a statement** with a source (agent + entry id, or document), a check date, a status (proposed / confirmed by a person), an access level, and optional validity dates (from / to). The agent that wrote a statement is its source, never the folder.
3. **Two times:** when the fact is true in the world (valid from / to) and when we learned it (recorded / checked). A law that changes an obligation closes the old version's validity; it does not delete it.
4. **An obligation always traces to a source:** a law article, a contract clause or an internal decision. An obligation without a source is shown as unverified.
5. **Access is set per statement, not per page.** A public page can hold a private statement, such as an ID number. This is how one shared page stays safe.

A disagreement between two agents is two statements with different sources. The existing fact-disagreement flow (`src/wiki/facts/ledger.ts`, `agentx wiki questions`) settles which one stands.

## 2. Pillars (sidebar order)

| # | Pillar | Types inside | Mapped to | Why it is a pillar |
|---|---|---|---|---|
| 1 | **Parties** | Person, Organization (company, government body, bank, association) | schema.org Person / Organization, FIBO legal person, REA agent | Everything else is owed by, owned by or done by a party. One page per party, merged across agents. |
| 2 | **Places & Jurisdictions** | Country, city, address / site, jurisdiction | schema.org Place, ELI / Wikidata jurisdiction (P1001) | Law applies per jurisdiction. Offices and servers have locations. |
| 3 | **Assets** | Systems, apps, devices, servers, domains, accounts, bank accounts, IP (trademarks) | REA resource, schema.org Product / SoftwareApplication | What the company owns or runs. Incidents attach here. AgentX agents fit here as `kind: agent`. |
| 4 | **Offerings & Projects** | Product / service sold, project, client engagement | schema.org Service / Offer / Project | What the company does for money, and where the work happens |
| 5 | **Agreements** | Contract, licence, subscription, engagement letter, mandate | FIBO Agreements / Contracts, REA commitment | Private sources of obligations (pay, deliver, renew, notice periods), parallel to law |
| 6 | **Law & Obligations** | Legal source, Obligation, Penalty, Relief, Authority role | schema.org Legislation, ELI, LegalRuleML | The company's relationship with the state (section 3) |
| 7 | **Events** | Filing, payment, incident, meeting, release, change of status | schema.org Event, REA economic event | What happened. Importance rules in section 4. |
| 8 | **Decisions & Policies** | Decision, internal policy | schema.org ChooseAction; LegalRuleML (internal rule = obligation sourced from a decision) | Why things are the way they are. Internal rules use the same Obligation shape as law. |
| 9 | **Procedures** | Runbook, "how we file X", "how we deploy" | schema.org HowTo | How each obligation or task is carried out, linked from the obligation |
| — | Topics (fallback) | Concept, theme | SKOS Concept | Classification only. It should stay small; a growing count means a type is missing. |

Documents (a gazette issue, a contract PDF, a receipt) are **references on statements**, not pillars. A document gets its own page only when it is the source of obligations; it is then a Legal source or an Agreement.

Mapping from today's `WIKI_ARTICLE_TYPES` (`src/wiki/types.ts`): `person` → Parties; `project` → Offerings & Projects; `place` → Places, or Assets for servers and URLs; `event` → Events; `decision` → Decisions & Policies; `pattern` → Procedures; `concept` → split between Organization, Obligation, Procedure and Topics.

## 3. Law & Obligations

### 3.1 Types

**Legal source** (schema.org `Legislation`, ELI)

- `identifier`: official number and type (for example `Loi n° 60-30`, `Décret n° 2024-503`); title in the original language(s) with an English alias
- `published_in`: official gazette reference. For Tunisia this is **JORT issue no., date, page**; elsewhere the equivalent gazette.
- `date_signed`, `date_published`, `in_force_from`, `applies_from` (and `applies_to` when the text is temporary)
- `legal_force`: in force / partly repealed / repealed
- `amends`, `repeals`, `implements` (a decree implementing a law), `consolidates` (codes)
- `issued_by` → Organization (parliament, presidency, ministry)
- Sub-kinds: law, decree-law, decree, order (arrêté), **finance law** (the yearly main change vector for tax), and **interpretive guidance** (administration circulars, *notes communes*). Guidance is not law, but it binds practice and is cited.

**Obligation** (LegalRuleML Obligation; also covers Prohibition)

- `action`: register · declare · pay · withhold · keep records · notify · renew · publish
- `bearer`: a **condition**, not a name, for example "employer under the general private-sector scheme", "legal entity subject to corporate tax", "controller processing personal data". A party is linked to the obligation through `subject_to {as, since, source}`, inferred from its registrations and facts and confirmed by a person.
- `authority` → Organization (who collects or enforces); `beneficiary` when it differs
- `due_rule`: structured recurrence plus offset, for example `{period: quarter, due: +N days after period end}`, or the event that triggers it ("within N days of hiring")
- `amount_rule` (optional): base and rate, or a fixed amount; each value carries its source article
- `created_by` → Legal source **+ article** (or Agreement clause, or Decision)
- `changed_by[]` → later sources, each with the date it applies from
- `valid_from` / `valid_to`, `checked_at`, `status` (proposed / confirmed by owner or accountant)
- `procedure` → Procedure; `evidence_kind`: the receipt or acknowledgement that proves it was fulfilled

**Penalty** (LegalRuleML penalty statement + reparation)

- `for` → Obligation, and which failure (late, missing, wrong)
- `kind`: fixed fine / % of amount / interest per month / criminal
- `amount_rule`, `created_by` → Legal source + article, validity dates

**Relief** (LegalRuleML Permission / Right)

- Exemption, deadline extension, penalty remission or amnesty. It `relieves` an Obligation or Penalty, for a bearer condition, within a validity window, often **on a condition** (for example a payment schedule).

**Authority** is not a separate type. It is an Organization (`kind: government body`) in the authority role on obligations: tax administration, social security fund, health insurance fund, business registry, data protection authority, municipality, customs, central bank, labour inspection, IP office.

**Due date** (generated, not written by hand): one instance per obligation × bearer × period, for example "monthly return for 2026-09, due <date>". Its status is open; fulfilled by an Event (filing or payment, receipt reference private); or late, in which case the Penalty applies. Agents answer "what do we owe this month?" from these instances.

### 3.2 How a new law lands

1. A new text is published (seen in a gazette feed, or added by a person). It becomes a **Legal source** page with its gazette reference.
2. Absorb compares it with existing obligations in the same jurisdiction and topic, and **proposes** changes: a new Obligation, a new version of an existing one (the old version gets `valid_to`, the new one `valid_from`), a new Penalty or Relief, or `legal_force: repealed`.
3. Legal statements stay **proposed** until the owner or the accountant confirms them. Until then, agents state them as "proposed, unverified", with the source.
4. Due-date instances are regenerated from the confirmed versions. Past instances keep the rule that applied at the time.

### 3.3 A gazette wiki as a source (read-only)

The owner keeps a separate wiki of Tunisian gazette (JORT) acts. It was looked at read-only:

- About 7,100 act pages. Each has the act type, number, publication date, gazette issue key (`jo:<year>:<issue>:<entry>`) and bilingual FR/AR summaries. An act-to-act relations index (amends, repeals, implements, appoints and others) maps directly onto `amends` / `repeals` / `implements`.
- The founding texts are there: social security organisation (Loi 60-30), VAT code (Loi 88-61), personal and corporate income tax code (Loi 89-114), and a 2024 penalty-remission decree (Décret 2024-503).
- **Gaps for this use:**
  - (a) Pages summarise whole acts. They do not extract article-level obligations, deadlines or penalties.
  - (b) A filename check did not find the tax procedures code (Loi 2000-82) or recent finance laws.
  - (c) Pages are written by a model, and some are marked derived.
- **Proposal:** Legal source pages **link** to the gazette wiki entry and the gazette reference instead of copying text. A watcher on new acts tagged fiscal or social proposes candidate changes as in 3.2. Obligation details are extracted from article text and confirmed by a person, never taken from a summary alone.

## 4. Events and importance (unchanged from v0.1)

Each event has one `about` entity (exactly one primary) and one importance level.

| Level | Test | Where it shows |
|---|---|---|
| **minor** | Routine, nothing lasting changes, resolved by itself (disk full, cache cleared, a deploy that went fine) | **One line** in the entity's History (date · sentence · source). No page of its own. |
| **normal** | Changes a fact or needs a follow-up (new contact, deadline met, incident with a root cause) | Listed on the entity page. Its own page only if it needs more than a few lines. Not in global navigation. |
| **major** | Changes the owner's world: money, legal standing, a client relationship starting or ending, a production outage, a strategic decision | Own page, **Major events** in the sidebar and home page, linked from the entity's summary. |

- Absorb proposes the level with a one-line reason, and a person can change it.
- **Roll-up:** repeated minor events of the same kind on the same entity merge into one line ("disk full ×6 since Aug"). After N repeats (configurable) the roll-up is raised to normal, because a recurring problem is no longer minor.

Page layout follows the model: the writing agent is shown as a source badge, never as a section. Section 5 sets what the sidebar and each page show.

### Design mockups (v0.2)

Three desktop mockups, with sample content only, are on #811:

1. **Wiki home:** the sidebar lists the 9 pillars, with sub-types under Parties and Law & Obligations and Topics at the bottom (v0.3 moves sub-types to tabs on the pillar page and Topics to Home and search). The home page shows generated due dates, proposed statements waiting for confirmation (Confirm / Reject), major and normal events only (minor ones folded into their pages, with a count), and one card per pillar.
2. **Organization page:** summary → typed links → facts → decisions → history. Roles sit on relations. Facts show source, validity dates and status; private values are masked; a superseded value stays visible, struck through, with `valid_to`. Minor events fold into one row with a count per kind. A side rail shows provenance (which agent wrote what), open questions and related procedures.
3. **Obligation page:** a rule card reading WHO / MUST / TO / WHEN / HOW MUCH, built from the bearer, actions, authority, due rule and amount rule. The source with its gazette reference; a "Changed by" timeline that keeps superseded versions; penalties each with their own source article; relief with its condition and window, linked to the penalty it relieves; generated due dates per period with private receipt references.

## 5. Zoom levels and lenses (v0.3)

### 5.1 Zoom levels

| Level | What you see | Answers | Limit |
|---|---|---|---|
| **Z0 Sidebar** | Home, pinned pages (≤5, chosen by the owner), the 9 pillars | "Where is it?" | No sub-types, no counts, no page lists. Topics and recent changes move to Home and search. |
| **Z1 Pillar** | The kinds inside the pillar as tabs (Assets → Devices · Servers · Apps · Domains · Accounts · Agents), what needs attention, the most active pages | "What kinds do we have, and which need me?" | At most 5 pages per kind. The full list is Z3. |
| **Z2 Page overview** | One thing, through the lens of its type: summary, then 4–6 panels, each with its top items and a "zoom in" link | "What matters about this thing?" | 3–6 items per panel. Minor events folded. Private values masked. |
| **Z3 Panel** | One panel in full: every role, every event with minor ones unfolded under the event they rolled up into, every installed app. Filters kept in the URL. | "Show me all of this side" | No limit. Paginated. |
| **Z4 Statement** | One fact, event or role: value, when it was true, when it was recorded, source, writer, confirmer, importance, access, past versions | "Where does this come from, and can I trust it?" | Same layout for every type |

Rules:

- A link to a page opens at Z2, and so does a pinned page. An agent can link to a Z3 view with its filters, or to a Z4 statement.
- Breadcrumbs follow the zoom: Wiki / Pillar / Kind / Page / Panel.
- What a page shows at Z2 depends on its type, not on how much data it has. A page with 2,000 events and a page with 3 events have the same panels.

### 5.2 A lens per type (starting set)

| Pillar · type | Z2 opens with (in order) | Typical Z3 zooms |
|---|---|---|
| Parties · **Person** | Roles over time (dated, on relations) · Relations to people and organizations · Belongings (owns / uses) · Obligations they carry, directly or through a role · History · Discussed | All roles · relation graph · each belonging with its own events |
| Parties · **Organization** | Roles on relations · Key facts (with validity dates) · Obligations and next due dates · Agreements · Decisions · History · Discussed | All facts with versions · all due dates · all contacts |
| Places & Jurisdictions · **Place** | What is located here (sites, assets, parties) · Laws that apply here · Authorities with reach · Events here | All laws in force for this jurisdiction |
| Assets · **Device** | State now (latest readings) · Events (minor folded, repeated ones rolled up) · Installed apps · Discussed · Owner, user, location | All events · readings over time · all apps |
| Assets · **Server** | Device lens + uptime and hosted services | Incidents · deploys |
| Assets · **App / system** | Where it is installed or runs · Version and updates · Licence or subscription (→ Agreement) · Incidents · Discussed | All installs · version history |
| Assets · **Domain / account** | Holder · Renewal and due dates · Linked services · Events | Renewal history |
| Offerings & Projects · **Project** | Client and status · People and their roles · Milestones · Agreements · Decisions · Recent events | Full timeline · all deliverables |
| Agreements · **Contract** | Parties and roles · Key terms · Obligations it creates · Dates (start, renewal, notice) · Amendments | All clauses · every obligation from it |
| Law & Obligations · **Legal source** | Gazette reference and dates · Obligations, penalties and reliefs it creates, by article · Amends / amended by · Where it applies | Article by article |
| Law & Obligations · **Obligation** | Who must do what, by when · Next due dates · Source articles · Penalties and reliefs · Procedure · Recent fulfilments | All due dates and their evidence · all versions |
| Events · **Event** | What changed (before → after) · Who and what was involved · Source · What followed | Minor events it rolled up |
| Decisions & Policies · **Decision** | Context · Options · Choice, by whom, when · What it affects · Obligations it creates · Replaced by | Full discussion record |
| Procedures · **Procedure** | Steps · What triggers it (obligation, event) · Owner · Last runs | Every run |

The owner can reorder a lens or hide a panel. Agents cannot change lenses; they can only propose a change.

### 5.3 Model additions

- **Devices and apps** are Asset kinds (`kind: device` with sub-kind laptop / phone / server / printer; `kind: app`), mapped to schema.org `Product` / `SoftwareApplication`.
- **`installed_on`** (app → device) with `version`, `since`, `until`. By default the installed list is statements on the device. An app gets its own page only when something else points to it: a licence, incidents on several devices, or a decision.
- **`owns` / `uses`** (party → asset), dated, mapped to Wikidata owned by (P127) / owner of (P1830). This puts belongings on the person page and the user on the device page.
- **Readings** (disk used, uptime) are statements that change often. Only the latest shows at Z2; the history sits at Z3. A reading that crosses a threshold is a minor event, and repeated minor events roll up into one normal event (for example ≥5 in 30 days → "Recurring disk pressure").
- **Conversations as sources:** absorb links each conversation summary to the entities it mentions (`mentions`). The "Discussed" panel lists summaries with date, channel and any decision or open question that came out of them. Summaries are private to the owner by default. Transcripts are never copied into the wiki.

### 5.4 Design mockups (v0.3)

Four desktop mockups, with sample content only, are on #811:

1. **Sidebar (Z0) + Assets pillar (Z1):** Home, 3 pins and the 9 pillars; sub-types as tabs on the pillar page; a strip explaining Z0–Z4.
2. **Person page (Z2):** roles over time as a dated timeline, relations with the role on each, belongings, obligations carried through a role, history with minor events folded, Discussed. A side rail shows the type's lens and where each panel zooms in.
3. **Device page (Z2):** state now (disk gauge, 30-day readings), events with 14 disk warnings rolled up into one normal event, installed apps, Discussed (cleanup plan → decision → procedure), who uses and owns it.
4. **Device events (Z3) and one statement (Z4):** every minor event visible under the event it rolled up into; a drawer with one statement's two times, source, writer, importance, access, where it was mentioned and its versions.

## 6. Pilot pages

Chosen to test the model. Values are placeholders; private data is left out.

| # | Pilot | What it tests |
|---|---|---|
| P1 | **Social-security contributions** (declare and pay, employer) | Bearer condition, quarterly recurrence, authority, penalty, procedure, due-date instances. Source: Loi 60-30 + implementing texts. |
| P2 | **Monthly tax return** (VAT + withholding) | One obligation built from **several** sources (VAT code, income tax code, tax procedures code for penalties), changed by yearly finance laws: versioning with validity dates |
| P3 | **Décret 2024-503** (late-penalty remission, conditional on a payment schedule of at most 36 months) | **A new text that changes existing obligations**: Relief with a condition and a window, linked to the P1 penalty |
| P4 | **Personal-data protection** (Loi organique 2004-63 and its authority) | A non-tax, non-social authority. Obligations triggered by an activity (processing personal data), not by a calendar. Relevant to AgentX itself. |
| P5 | **A client contract** (anonymised) | The same Obligation and Penalty types sourced from an **Agreement** clause (payment terms, notice period, renewal). Roles on relations (client, supplier) |
| P6 | **The owner + the company** | Roles as relations (founder, legal representative, approver). Merging the owner's 5 pages into 1. `subject_to` links to P1–P4 with private qualifiers. The person lens. |
| P7 | **Internal policy "production deploys need owner approval"** + **a server with repeated disk-full events** | Internal rules as obligations sourced from a Decision. Minor-event roll-up on an Asset. The device lens. |

Shape of P1 (illustrative):

```yaml
# obligation/social-security-employer-contributions
type: Obligation
action: [declare, pay]
bearer: "employer under the general private-sector scheme"
authority: org/<social-security-fund>
jurisdiction: place/tunisia
due_rule: {period: quarter, due: "<offset from source>"}
amount_rule: {base: gross salaries, rate: "<from source>"}
created_by: {source: legal/loi-60-30, article: "<art.>", gazette: "JORT n° <issue>, <date>, p. <page>"}
changed_by: [ {source: <later text>, applies_from: <date>} ]
penalties: [penalty/social-security-late-payment]
relieved_by: [relief/decret-2024-503]
procedure: procedure/social-security-quarterly-declaration
status: proposed   checked_at: <date>
```

Before and after comparison per pilot: page count, duplicate pages merged, and whether an agent answers "what do we owe, to whom, by when, under which text, and what if we are late" from one page.

## 7. Configurable, not hardcoded

`.agentx/wiki/ontology.yaml` holds the pillars, types (with schema.org / Wikidata mapping and kinds), properties (domain, range, qualifiers), obligation and penalty fields, importance levels, the roll-up threshold, the sidebar and the lens of each type. For example:

```yaml
sidebar: {pins_max: 5, show: [home, pins, pillars]}
lenses:
  person:
    - {panel: roles_over_time, from: role_at, show: 6}
    - {panel: relations, group_by: role, show: 5}
    - {panel: belongings, from: [owns, uses], show: 5}
    - {panel: obligations, from: subject_to, show: 3}
    - {panel: history, importance: [major, normal], fold: minor}
    - {panel: discussed, from: mentions, access: owner}
  device:
    - {panel: state_now, from: readings, latest: true}
    - {panel: events, importance: [major, normal], fold: minor, rollup: {min: 5, days: 30}}
    - {panel: installed_apps, from: installed_on, show: 5}
    - {panel: discussed, from: mentions, access: owner}
    - {panel: parties, from: [owns, uses]}
```

When the file is missing, the wiki uses a starter in code (`src/wiki/ontology/starter.ts`), the same way the intent graph starts from `src/graph/starter-schema.ts`; `agentx wiki ontology init` writes it out for editing. A section the file leaves out comes from the starter, and lenses merge type by type. A file that does not check is not used: the wiki keeps the starter and `agentx wiki ontology check` lists why.

Jurisdiction packs, such as Tunisia (gazette = JORT, list of authorities, finance-law cycle), are data added on top, not code.

## 8. Owner decisions (all approved as recommended, 2026-10-08)

New in v0.3:

1. **Zoom levels Z0–Z4** as in 5.1? **Yes.**
2. **Sidebar:** Home + up to 5 pins + 9 pillars only; sub-types become tabs on the pillar page and Topics leaves the sidebar? **Yes.** **The owner picks pins; agents may suggest.**
3. **Lens table** in 5.2 as the starting point, editable in `ontology.yaml` by the owner? **Yes.**
4. **Conversations as sources** with a "Discussed" panel, summaries private to the owner by default? **Yes.**
5. **Installed apps** as statements on the device, with an app page only when something else points to it? **Yes.**

Still open from v0.2:

1. **Pillars:** approve the 9 names in section 2? **Yes.**
2. **One Obligation type** for law, contracts and internal policy, each with its source? **Yes.**
3. **Confirmation:** legal obligations stay "proposed, unverified" until the owner or the accountant confirms. Which of them confirms, or either? **Either; the confirmer is recorded.**
4. **Gazette wiki:** link to it and watch it read-only for new fiscal and social acts, as in 3.3? **Yes.**
5. **Due-date instances:** generate them now for the pilot, and leave reminders and calendar for a later step? **Yes.**
6. Still open from v0.1: agents as Assets (`kind: agent`), per-statement access, original-language titles with English aliases, and who may set `major`: **only the owner (or a rule in `ontology.yaml`) sets it; agents may propose.**

## Build steps

1. Ship `ontology.yaml` and its starter (no behaviour change). **Done:** `src/wiki/ontology/`, `agentx wiki ontology`, [docs](../../docs/jobs/wiki-ontology.md).
2. Absorb writes into this model (one pipeline; #808 covers its quality).
3. Pilots P1–P7, compared before and after with the owner.
4. Full reshape of existing articles. Nothing is merged before the pilots are reviewed.
5. Wiki layout: sidebar, zoom levels and lenses.
