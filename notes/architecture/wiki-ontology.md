# Wiki ontology: pillars, statements, law and obligations

Status: **draft v0.2, waiting for owner approval** (#811, step 1). It replaces v0.1. Nothing is built: no absorb code changed, no articles reshaped. This file must not be merged before the owner approves it.

Changes since v0.1:

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

Page layout follows the model: the sidebar lists the pillars in the order of section 2, then Major events, with the writing agent shown as a source badge, not a section. An entity page shows summary → typed links grouped by property → facts (value · source · checked date) → decisions → history (major and normal shown, minor folded).

### Design mockups

Three desktop mockups of this layout, with sample content only, are on #811:

1. **Wiki home:** the sidebar lists the 9 pillars, with sub-types under Parties and Law & Obligations and Topics at the bottom. The home page shows generated due dates, proposed statements waiting for confirmation (Confirm / Reject), major and normal events only (minor ones folded into their pages, with a count), and one card per pillar.
2. **Organization page:** summary → typed links → facts → decisions → history. Roles sit on relations. Facts show source, validity dates and status; private values are masked; a superseded value stays visible, struck through, with `valid_to`. Minor events fold into one row with a count per kind. A side rail shows provenance (which agent wrote what), open questions and related procedures.
3. **Obligation page:** a rule card reading WHO / MUST / TO / WHEN / HOW MUCH, built from the bearer, actions, authority, due rule and amount rule. The source with its gazette reference; a "Changed by" timeline that keeps superseded versions; penalties each with their own source article; relief with its condition and window, linked to the penalty it relieves; generated due dates per period with private receipt references.

## 5. Pilot pages

Chosen to test the model. Values are placeholders; private data is left out.

| # | Pilot | What it tests |
|---|---|---|
| P1 | **Social-security contributions** (declare and pay, employer) | Bearer condition, quarterly recurrence, authority, penalty, procedure, due-date instances. Source: Loi 60-30 + implementing texts. |
| P2 | **Monthly tax return** (VAT + withholding) | One obligation built from **several** sources (VAT code, income tax code, tax procedures code for penalties), changed by yearly finance laws: versioning with validity dates |
| P3 | **Décret 2024-503** (late-penalty remission, conditional on a payment schedule of at most 36 months) | **A new text that changes existing obligations**: Relief with a condition and a window, linked to the P1 penalty |
| P4 | **Personal-data protection** (Loi organique 2004-63 and its authority) | A non-tax, non-social authority. Obligations triggered by an activity (processing personal data), not by a calendar. Relevant to AgentX itself. |
| P5 | **A client contract** (anonymised) | The same Obligation and Penalty types sourced from an **Agreement** clause (payment terms, notice period, renewal). Roles on relations (client, supplier) |
| P6 | **The owner + the company** | Roles as relations (founder, legal representative, approver). Merging the owner's 5 pages into 1. `subject_to` links to P1–P4 with private qualifiers |
| P7 | **Internal policy "production deploys need owner approval"** + **a server with repeated disk-full events** | Internal rules as obligations sourced from a Decision. Minor-event roll-up on an Asset |

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

## 6. Configurable, not hardcoded

`.agentx/wiki/ontology.yaml` holds the pillars, types (with schema.org / Wikidata mapping and kinds), properties (domain, range, qualifiers), obligation and penalty fields, importance levels and the roll-up threshold. When the file is missing, the wiki seeds it from a starter in code, the same way the intent graph seeds `.agentx/graph/schema.json` from `src/graph/starter-schema.ts`.

Jurisdiction packs, such as Tunisia (gazette = JORT, list of authorities, finance-law cycle), are data added on top, not code.

## 7. Decisions needed from the owner

1. **Pillars:** approve the 9 names in section 2? *Recommend yes.*
2. **One Obligation type** for law, contracts and internal policy, each with its source? *Recommend yes.*
3. **Confirmation:** legal obligations stay "proposed, unverified" until the owner or the accountant confirms. Which of them confirms, or either? *Recommend either; the confirmer is recorded.*
4. **Gazette wiki:** link to it and watch it read-only for new fiscal and social acts, as in 3.3? *Recommend yes.*
5. **Due-date instances:** generate them now for the pilot, and leave reminders and calendar for a later step? *Recommend yes.*
6. Still open from v0.1: agents as Assets (`kind: agent`), per-statement access, original-language titles with English aliases, and who may set `major` (absorb may set it, with new majors in a weekly "check these" list). *Recommendations unchanged.*

## Next steps after approval

1. Ship `ontology.yaml` and its starter (no behaviour change).
2. Absorb writes into this model (one pipeline; #808 covers its quality).
3. Pilots P1–P7, compared before and after with the owner.
4. Full reshape of existing articles. Nothing is merged before the pilots are reviewed.
5. Wiki layout by pillar.
