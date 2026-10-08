# Wiki ontology: page types, relations, importance levels

Status: **draft v0.1, waiting for owner approval** (#811, step 1). Nothing is built: no absorb code changed, no articles reshaped. Once approved, this page becomes the default `ontology.yaml` (section 8).

## 1. Why

Measured on a live fleet wiki (2026-10-08):

- 5,990 articles. **2,990 of them (50%) are event pages**, all at top level beside decisions and people.
- The owner has **5 separate person pages**: one shared, plus copies written by four different agents.
- The company has 2 shared pages, one agent copy, and 30+ pages with its name in the title, spread over 8 agents.
- The social-security agency appears on 14 pages: 5 "concept" pages, 7 event pages and 2 decisions. There is no single page for the obligation itself.

## 2. Principles

1. **One page per real thing for the whole fleet.** The page id is `type/slug` (for example `org/example-company`). Agents add *statements* to it. The agent is the source of each statement and is never the folder.
2. **Wikidata-style statements:** subject → property → value, plus qualifiers (role, start, end) and a reference (source agent + entry id + check date).
3. **Pillars on top, details inside.** Navigation shows types and major events. Everything else lives inside the page it is about.
4. **Access is set per statement, not per page.** A public page can hold a private statement, such as an ID number. This is how one shared page stays safe.

## 3. Entity types

| Type | schema.org | `kind` (sub-type) examples | Replaces today's `type` |
|---|---|---|---|
| Person | `Person` | owner, employee, contact | `person` |
| Organization | `Organization` (`Corporation`, `GovernmentOrganization`, `BankOrCreditUnion`) | company, client, bank, agency | parts of `concept` / `project` |
| Place | `Place` / `Country` / `City` | country, city, office | `place` (when a real place) |
| System | `Product` / `SoftwareApplication` | laptop, server, app, account, **agent** | `place` (servers, URLs), the agent roster |
| Rule | `Legislation` | law, filing obligation, contract term, internal policy | parts of `concept` / `decision` |
| Project | `Project` | product, client engagement | `project` |
| Procedure | `HowTo` | runbook, "how we do X here" | `pattern`, parts of `concept` |
| Event | `Event` | incident, meeting, payment, release | `event` |
| Decision | `ChooseAction` | approval, policy choice | `decision` |
| Concept | `Thing` | fallback only, should be rare | `concept` |

Today's types are in `src/wiki/types.ts` (`WIKI_ARTICLE_TYPES`).

## 4. Relations (properties)

| Property | From → To | Qualifiers | Wikidata |
|---|---|---|---|
| `founded` / `owns` | Person, Org → Org, System, Project | since, share | P112 / P127 |
| `role_at` | Person → Org | **role** (e.g. "accountant of"), start, end | P108 / P39 |
| `member_of` | Person, Org → Org | start, end | P463 |
| `client_of` | Org → Org | since, contract ref (private) | — |
| `registered_with` | Person, Org → Org | **as** (employer / self-employed), id (private), since | — |
| `located_in` | any → Place | — | P131 / P17 |
| `must_follow` | Person, Org, Project → Rule | as, since | ~P92 |
| `issued_by` | Rule → Org | — | P2378 |
| `applies_in` | Rule → Place | — | P1001 |
| `implements` | Procedure → Rule | — | — |
| `works_on` | Person, System (agent) → Project | role, start, end | — |
| `uses` / `runs_on` | Org, Project → System; System → System | since | P2283 |
| `part_of` | X → X | — | P361 |
| `about` | Event, Decision → any entity | **required, exactly one primary** | P921 |
| `involves` | Event → Person, Org | role | P710 |
| `decided_by` | Decision → Person | date | — |
| `supersedes` | Decision, Rule → same type | date | P1365 |

Every statement can carry `source` (agent + entry id), `checked_at`, `status` (proposed / confirmed by a person) and `access`. A disagreement between two agents is two statements with different sources. The existing fact-disagreement flow (`src/wiki/facts/ledger.ts`, `agentx wiki questions`) settles which one stands.

## 5. Events and importance

Each event has one `about` entity and one importance level.

| Level | Test | Where it shows |
|---|---|---|
| **minor** | Routine, nothing lasting changes, resolved by itself (disk full, cache cleared, a deploy that went fine) | **One line** in the entity's History (date · sentence · source). No page of its own. |
| **normal** | Changes a fact or needs a follow-up (new contact, deadline met, incident with a root cause) | Listed on the entity page. Gets its own page only if it needs more than a few lines. Not in global navigation. |
| **major** | Changes the owner's world: money, legal standing, a client relationship starting or ending, a production outage, a strategic decision | Own page, **Major events** in the sidebar and home page, linked from the entity's summary. |

- Absorb proposes the level with a one-line reason, and a person can change it.
- **Roll-up:** repeated minor events of the same kind on the same entity merge into one line ("disk full ×6 since Aug"). After N repeats (configurable) the roll-up is raised to normal, because a recurring problem is no longer minor.

## 6. Layout

- **Sidebar:** People · Organizations · Places · Systems · Rules · Projects · Procedures · Major events. The writing agent appears as a source badge, not as a section.
- **Entity page:** summary → typed links grouped by property → facts (value · source · checked date) → decisions → history (major and normal shown, minor folded).
- **Rule page:** applies to · issued by · jurisdiction · deadlines · penalties · what to do (→ Procedure) · sources · last checked. Agents answer from this page. A rule past its check date is checked again, using the existing `wiki facts` time-limit mechanism.

## 7. Pilot pages (shape only)

Values are placeholders. Private data is left out.

```yaml
# org/example-company
type: Organization   kind: company
statements:
  - founded_by: person/owner
  - located_in: place/example-country
  - registered_with: org/social-security-agency   {as: employer, id: <private>, source: accountant-agent}
  - must_follow: rule/employer-contributions
  - uses: system/agentx
  - client_of ← org/<client>     # client orgs link in; names live on private pages
history: major ▸ <dated company-level events> · normal ▸ … · minor ▸ folded
```

```yaml
# person/owner
type: Person   kind: owner
statements:
  - founded: org/example-company
  - role_at: org/example-company {role: founder, approver of production + money}
  - registered_with: org/social-security-agency {as: <private>, access: private}
  - must_follow: rule/<scheme> {access: private}
  - contact points: {access: private, source: fact sources}
merges: the shared page + 4 agent copies → 1 page
decisions: "production deploys need owner approval" etc. (from an ops agent's patterns)
```

```yaml
# org/social-security-agency            # rule/employer-contributions
type: Organization                         type: Rule   kind: filing obligation
kind: GovernmentOrganization               issued_by: org/social-security-agency
located_in: place/example-country          applies_in: place/example-country
issues: rule/*                             applies_to: employers (as registered)
                                           deadline: <from source, checked date>
                                           penalty: <from source, checked date>
                                           procedure: procedure/contribution-declaration
                                           sources: [<official URL>], checked_at: <date>
```

The agency's 7 event pages become history lines on the company or the owner page, whichever they are `about`. Its 5 "concept" pages become a Rule, a Procedure or private statements.

## 8. Configurable, not hardcoded

`.agentx/wiki/ontology.yaml` holds:

- types, with their schema.org mapping and kinds
- properties: domain (from), range (to) and allowed qualifiers
- importance levels and their tests
- the roll-up threshold
- the sidebar order

This page is the default file. When the file is missing, the wiki seeds it from a starter in code, the same way the intent graph seeds `.agentx/graph/schema.json` from `src/graph/starter-schema.ts`.

## 9. Decisions needed from the owner

1. **Agents as entities:** model AgentX agents as `System` (kind: agent)? *Recommend yes.*
2. **Decision type:** keep it as its own type rather than an event sub-type? *Recommend own type.*
3. **Who sets `major`:** absorb may set it, and new majors appear in a weekly "check these" list? *Recommend yes.*
4. **Per-statement access** as the confidentiality model? *Recommend yes.*
5. **Titles:** keep the original-language name (for example French administrative terms) with English aliases? *Recommend yes.*

## Next steps after approval

1. Ship `ontology.yaml` and its starter (no behaviour change).
2. Absorb writes into this model (one pipeline; #808 covers its quality).
3. Pilot on the three entities above; compare before and after with the owner.
4. Full reshape of existing articles. Nothing is merged before the pilot is reviewed.
5. Wiki layout by type.
