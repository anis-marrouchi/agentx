// --- Set up the org, a page in the Wall space (#1420) ---
//
// The owner adds agents and people to the org chart, sets each one's role,
// and adds or removes typed relations: reports to, dotted line, acts for.
// It reads GET /api/admin/org (its `setup`, `choices` and `canEdit`) and
// writes one change at a time with POST /api/admin/org/chart, which checks
// the change and refuses it with a plain sentence. Owner only: the page
// says so to anyone else, and the server refuses them.
//
// Shipped to the browser through injectFns, so the function is
// self-contained.

interface SetupMember { ref: string; kind: "agent" | "person"; id: string; name: string; title?: string }
interface SetupRelation { from: string; to: string; type: string }
export interface OrgSetupReply {
  exists?: boolean
  canEdit?: boolean
  setup?: { members: SetupMember[]; relations: SetupRelation[] }
  choices?: { agents: Array<{ ref: string; name: string }>; people: Array<{ ref: string; name: string }>; roles: Array<{ key: string; title: string }>; types: string[] }
}

export interface OrgChange { op: string; member?: string; role?: string; from?: string; to?: string; type?: string }
export interface OrgConfirm { text: string; save: string; steps: OrgChange[]; undo: OrgChange[] }

/** The confirm step for a change that moves or removes a line (#1463
 *  section 5): one sentence on what changes, the button that saves it, the
 *  POSTs to send in order, and the POSTs that put things back if a later
 *  step is refused. A new boss for a member who has one is "remove the old
 *  line, add the new one", since the server allows one boss at a time.
 *  Returns null for a change that saves without asking (add a member, set
 *  a role). */
export function orgConfirmFor(setup: { members: SetupMember[]; relations: SetupRelation[] }, change: OrgChange): OrgConfirm | null {
  const WILL: Record<string, string> = { "reports-to": "report to", "dotted-line": "have a dotted line to", "acts-for": "act for" }
  const byRef: Record<string, SetupMember> = {}
  for (const m of setup.members) byRef[m.ref] = m
  const name = (ref?: string) => (ref && byRef[ref] ? byRef[ref].name : String(ref || "").replace(/^(agent|person):/, ""))
  const agent = (ref?: string) => !!ref && !!byRef[ref] && byRef[ref].kind === "agent"
  const list = (names: string[]) => names.length < 2 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1]
  const F = name(change.from), T = name(change.to)
  if (change.op === "add-relation" && change.type === "reports-to") {
    const boss = setup.relations.find((r) => r.type === "reports-to" && r.from === change.from)
    const stuck = agent(change.from) ? " When " + F + " is stuck, it asks " + T + " first." : ""
    // Same boss, or a member as their own boss: one step, which the server refuses.
    if (boss && boss.to !== change.to && change.from !== change.to) {
      const old: OrgChange = { op: "add-relation", from: boss.from, type: "reports-to", to: boss.to }
      return {
        text: F + " will report to " + T + ", not " + name(boss.to) + "." + stuck,
        save: "Save the move",
        steps: [{ op: "remove-relation", from: boss.from, type: "reports-to", to: boss.to }, change],
        undo: [old],
      }
    }
    return { text: F + " will report to " + T + "." + stuck, save: "Save the move", steps: [change], undo: [] }
  }
  if (change.op === "add-relation") {
    return { text: F + " will " + (WILL[change.type || ""] || change.type) + " " + T + ".", save: "Save", steps: [change], undo: [] }
  }
  if (change.op === "remove-relation") {
    const up = change.type === "reports-to"
    const stuck = up && agent(change.from) ? " When " + F + " is stuck, it no longer asks " + T + "." : ""
    return { text: F + " will no longer " + (WILL[change.type || ""] || change.type) + " " + T + "." + stuck, save: up ? "Save the move" : "Save", steps: [change], undo: [] }
  }
  if (change.op === "remove-member") {
    const M = name(change.member)
    const lines = setup.relations.filter((r) => r.from === change.member || r.to === change.member).length
    const below = setup.relations.filter((r) => r.type === "reports-to" && r.to === change.member).map((r) => name(r.from))
    return {
      text: M + " will leave the org chart" + (lines ? ", with " + lines + " " + (lines === 1 ? "line" : "lines") : "") + "." +
        (below.length ? " " + list(below) + " will report to no one." : ""),
      save: "Save the move",
      steps: [change],
      undo: [],
    }
  }
  return null
}

/** The page. `msg` is the answer to the last change; `face(member)` draws
 *  a member's avatar; `pending` is a change waiting for Save or Cancel. */
export function orgSetupHtml(org: OrgSetupReply | null, msg: { text: string; bad: boolean }, face: (m: SetupMember) => string, pending?: { text: string; save: string } | null): string {
  const esc = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
  const TYPE: Record<string, string> = { "reports-to": "Reports to", "dotted-line": "Dotted line to", "acts-for": "Acts for" }
  const LINE: Record<string, string> = { "reports-to": "reports to", "dotted-line": "has a dotted line to", "acts-for": "acts for" }
  const opt = (v: string, label: string) => '<option value="' + esc(v) + '">' + esc(label) + "</option>"
  const note = msg.text ? '<p class="wos__msg' + (msg.bad ? " is-bad" : "") + '" role="status">' + esc(msg.text) + "</p>" : '<p class="wos__msg" role="status"></p>'
  if (!org) return '<p class="ax-wall__empty">Loading…</p>'
  if (!org.exists) return '<p class="ax-wall__empty">This computer has no agentx.json, so there is no org chart to set up.</p>'
  if (!org.canEdit || !org.setup || !org.choices) {
    return '<p class="ax-wall__empty">Only the owner can set up the org. Sign in to the dashboard with the owner\'s key to change who reports to whom.</p>'
  }
  const confirm = pending
    ? '<div class="wos__confirm" role="group" aria-label="Confirm the change"><p class="wos__confirm-text">' + esc(pending.text) + "</p>" +
      '<span class="wos__acts"><button type="button" class="ax-btn" id="wos-confirm-save" data-os="confirm">' + esc(pending.save) + "</button>" +
      '<button type="button" class="ax-btn ax-btn--ghost" data-os="cancel">Cancel</button></span></div>'
    : ""
  const c = org.choices
  const members = org.setup.members
  const byRef: Record<string, SetupMember> = {}
  for (const m of members) byRef[m.ref] = m
  const name = (ref: string) => (byRef[ref] ? byRef[ref].name : ref.replace(/^(agent|person):/, ""))

  const free = (list: Array<{ ref: string; name: string }>) => list.filter((x) => !byRef[x.ref]).map((x) => opt(x.ref, x.name)).join("")
  const fa = free(c.agents), fp = free(c.people)
  const add = '<form class="wos__form" data-os-form="add-member" aria-label="Add a member">' +
    '<label for="wos-add-member">Member <select id="wos-add-member">' +
      (fa || fp ? (fa ? '<optgroup label="Agents">' + fa + "</optgroup>" : "") + (fp ? '<optgroup label="People">' + fp + "</optgroup>" : "") : '<option value="">Everyone is in the chart</option>') +
    "</select></label>" +
    '<label for="wos-add-role">Role <input id="wos-add-role" list="wos-roles" maxlength="80" placeholder="Engineer" autocomplete="off"></label>' +
    '<button type="button" class="ax-btn" data-os="add-member"' + (fa || fp ? "" : " disabled") + ">Add</button></form>" +
    '<datalist id="wos-roles">' + c.roles.map((r) => opt(r.title, r.key)).join("") + "</datalist>"

  const rows = members.length ? '<ul class="wos__rows">' + members.map((m, i) =>
    '<li class="wos__row">' + face(m) +
      '<span class="wos__who"><b>' + esc(m.name) + '</b><span class="chip">' + (m.kind === "person" ? "Person" : "Agent") + "</span></span>" +
      '<label class="wos__role" for="wos-role-' + i + '"><span class="k">Role</span><input id="wos-role-' + i + '" list="wos-roles" maxlength="80" value="' + esc(m.title || "") + '" aria-label="Role of ' + esc(m.name) + '"></label>' +
      '<span class="wos__acts"><button type="button" class="ax-btn ax-btn--ghost" data-os="set-role" data-os-i="' + i + '" data-os-member="' + esc(m.ref) + '">Save role</button>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-os="remove-member" data-os-member="' + esc(m.ref) + '">Remove</button></span></li>',
  ).join("") + "</ul>" : '<p class="ax-wall__empty">No one in the org chart yet. Add a member above.</p>'

  const rels = org.setup.relations
  const lines = rels.length ? '<ul class="wos__rows">' + rels.map((r) =>
    '<li class="wos__row wos__line is-' + esc(r.type) + '"><span class="wos__who">' + esc(name(r.from)) + " <span class=\"k\">" + esc(LINE[r.type] || r.type) + "</span> " + esc(name(r.to)) + "</span>" +
      '<span class="wos__acts"><button type="button" class="ax-btn ax-btn--ghost" data-os="remove-relation" data-os-from="' + esc(r.from) + '" data-os-type="' + esc(r.type) + '" data-os-to="' + esc(r.to) + '" aria-label="Remove: ' + esc(name(r.from) + " " + (LINE[r.type] || r.type) + " " + name(r.to)) + '">Remove</button></span></li>',
  ).join("") + "</ul>" : '<p class="ax-wall__empty">No relations yet.</p>'
  const mo = members.map((m) => opt(m.ref, m.name + (m.kind === "person" ? " (person)" : ""))).join("")
  const addRel = members.length >= 2 ? '<form class="wos__form" data-os-form="add-relation" aria-label="Add a relation">' +
    '<label for="wos-rel-from">Member <select id="wos-rel-from">' + mo + "</select></label>" +
    '<label for="wos-rel-type">Relation <select id="wos-rel-type">' + c.types.map((t) => opt(t, TYPE[t] || t)).join("") + "</select></label>" +
    '<label for="wos-rel-to">Target <select id="wos-rel-to">' + mo + "</select></label>" +
    '<button type="button" class="ax-btn" data-os="add-relation">Add relation</button></form>'
    : '<p class="ax-wall__count">Add two members to link them.</p>'

  return '<div class="wos">' +
    '<p class="wos__lead">Who is in your org, their role, and who reports to whom. Each change is checked, saved to agentx.json with a backup, and used at once. No restart. A change to a line or a removal asks you to confirm first.</p>' +
    note + confirm +
    '<h2 class="wos__h">Add a member</h2>' + add +
    '<h2 class="wos__h">Members <span class="ax-wall__count">' + members.length + "</span></h2>" + rows +
    '<h2 class="wos__h">Relations <span class="ax-wall__count">' + rels.length + "</span></h2>" + lines + addRel +
    '<dl class="wos__legend"><dt>Reports to</dt><dd>The line manager, one at most. Work an agent cannot finish goes up this line.</dd>' +
      "<dt>Dotted line to</dt><dd>A second manager for one topic or project.</dd>" +
      "<dt>Acts for</dt><dd>An agent works on behalf of a person.</dd></dl>" +
  "</div>"
}
