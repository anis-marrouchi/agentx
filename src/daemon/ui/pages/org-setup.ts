// --- Edit the org chart on /org, owner only (#1420) ---
//
// The owner adds agents and people to the org chart, sets each one's role,
// and adds or removes typed relations: reports to, dotted line, acts for.
// It reads GET /api/admin/org (its `setup`, `choices` and `canEdit`) and
// writes one change at a time with POST /api/admin/org/chart, which checks
// the change and refuses it with a plain sentence. Anyone else gets no
// Edit button, and the server refuses them (403).
//
// A change to a line, and a removal, waits for Save the move or Cancel
// (#1463 section 5): orgConfirmFor says in one line what changes and lists
// the POSTs to send. Adding a member and saving a role save at once.
//
// Shipped to the browser through injectFns, so each function is
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
export interface OrgConfirm { text: string; steps: OrgChange[]; undo: OrgChange[] }

/** The confirm step for a change that moves or removes a line: one line
 *  on what changes, the POSTs to send in order, and the POSTs that put
 *  things back if a later one is refused. A new boss for a member who has
 *  one is "remove the old line, add the new one", since the server keeps
 *  one boss each. Null for a change that saves at once. */
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
      return {
        text: F + " will report to " + T + ", not " + name(boss.to) + "." + stuck,
        steps: [{ op: "remove-relation", from: boss.from, type: "reports-to", to: boss.to }, change],
        undo: [{ op: "add-relation", from: boss.from, type: "reports-to", to: boss.to }],
      }
    }
    return { text: F + " will report to " + T + "." + stuck, steps: [change], undo: [] }
  }
  if (change.op === "add-relation") {
    return { text: F + " will " + (WILL[change.type || ""] || change.type) + " " + T + ".", steps: [change], undo: [] }
  }
  if (change.op === "remove-relation") {
    const stuck = change.type === "reports-to" && agent(change.from) ? " When " + F + " is stuck, it no longer asks " + T + "." : ""
    return { text: F + " will no longer " + (WILL[change.type || ""] || change.type) + " " + T + "." + stuck, steps: [change], undo: [] }
  }
  if (change.op === "remove-member") {
    const lines = setup.relations.filter((r) => r.from === change.member || r.to === change.member).length
    const below = setup.relations.filter((r) => r.type === "reports-to" && r.to === change.member).map((r) => name(r.from))
    return {
      text: name(change.member) + " will leave the org chart" + (lines ? ", with " + lines + " " + (lines === 1 ? "line" : "lines") : "") + "." +
        (below.length ? " " + list(below) + " will report to no one." : ""),
      steps: [change],
      undo: [],
    }
  }
  return null
}

/** The edit panel. `msg` is the answer to the last change; `pending` is
 *  the line of a change waiting for Save the move or Cancel. */
export function orgEditHtml(org: OrgSetupReply | null, msg: { text: string; bad: boolean }, pending?: string): string {
  const esc = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
  const TYPE: Record<string, string> = { "reports-to": "Reports to", "dotted-line": "Dotted line to", "acts-for": "Acts for" }
  const LINE: Record<string, string> = { "reports-to": "reports to", "dotted-line": "has a dotted line to", "acts-for": "acts for" }
  const opt = (v: string, label: string) => '<option value="' + esc(v) + '">' + esc(label) + "</option>"
  if (!org) return '<p class="org-quiet">Loading…</p>'
  if (!org.canEdit || !org.setup || !org.choices) return ""
  const note = '<p class="oe-msg' + (msg.bad ? " is-bad" : "") + '" role="status">' + esc(msg.text) + "</p>"
  const confirm = pending
    ? '<div class="oe-confirm" id="oe-confirm" role="group" aria-label="Confirm the change"><p class="oe-confirm-text">' + esc(pending) + "</p>" +
      '<span class="oe-acts"><button type="button" class="ax-btn ax-btn--primary" id="oe-confirm-save" data-oe="confirm">Save the move</button>' +
      '<button type="button" class="ax-btn" data-oe="cancel">Cancel</button></span></div>'
    : ""
  const c = org.choices
  const members = org.setup.members
  const byRef: Record<string, SetupMember> = {}
  for (const m of members) byRef[m.ref] = m
  const name = (ref: string) => (byRef[ref] ? byRef[ref].name : ref.replace(/^(agent|person):/, ""))

  const free = (items: Array<{ ref: string; name: string }>) => items.filter((x) => !byRef[x.ref]).map((x) => opt(x.ref, x.name)).join("")
  const fa = free(c.agents), fp = free(c.people)
  const add = '<div class="oe-form" role="group" aria-label="Add a member">' +
    '<label for="oe-add-member">Member <select id="oe-add-member">' +
      (fa || fp ? (fa ? '<optgroup label="Agents">' + fa + "</optgroup>" : "") + (fp ? '<optgroup label="People">' + fp + "</optgroup>" : "") : '<option value="">Everyone is in the chart</option>') +
    "</select></label>" +
    '<label for="oe-add-role">Role <input id="oe-add-role" list="oe-roles" maxlength="80" placeholder="Engineer" autocomplete="off"></label>' +
    '<button type="button" class="ax-btn" data-oe="add-member"' + (fa || fp ? "" : " disabled") + ">Add</button></div>" +
    '<datalist id="oe-roles">' + c.roles.map((r) => opt(r.title, r.key)).join("") + "</datalist>"

  const rows = members.length ? '<ul class="oe-rows">' + members.map((m, i) =>
    '<li class="oe-row"><span class="oe-who"><b>' + esc(m.name) + '</b><span class="org-kind">' + (m.kind === "person" ? "Person" : "Agent") + "</span></span>" +
      '<label class="oe-role" for="oe-role-' + i + '"><span class="org-kind">Role</span><input id="oe-role-' + i + '" list="oe-roles" maxlength="80" value="' + esc(m.title || "") + '" aria-label="Role of ' + esc(m.name) + '"></label>' +
      '<span class="oe-acts"><button type="button" class="ax-btn" data-oe="set-role" data-oe-i="' + i + '" data-oe-member="' + esc(m.ref) + '">Save role</button>' +
      '<button type="button" class="ax-btn" data-oe="remove-member" data-oe-member="' + esc(m.ref) + '" aria-label="Remove ' + esc(m.name) + '">Remove</button></span></li>',
  ).join("") + "</ul>" : '<p class="org-quiet">No one in the org chart yet. Add a member above.</p>'

  const rels = org.setup.relations
  const lines = rels.length ? '<ul class="oe-rows">' + rels.map((r) =>
    '<li class="oe-row"><span class="oe-who">' + esc(name(r.from)) + ' <span class="org-kind">' + esc(LINE[r.type] || r.type) + "</span> " + esc(name(r.to)) + "</span>" +
      '<span class="oe-acts"><button type="button" class="ax-btn" data-oe="remove-relation" data-oe-from="' + esc(r.from) + '" data-oe-type="' + esc(r.type) + '" data-oe-to="' + esc(r.to) + '" aria-label="Remove: ' + esc(name(r.from) + " " + (LINE[r.type] || r.type) + " " + name(r.to)) + '">Remove</button></span></li>',
  ).join("") + "</ul>" : '<p class="org-quiet">No relations yet.</p>'
  const mo = members.map((m) => opt(m.ref, m.name + (m.kind === "person" ? " (person)" : ""))).join("")
  const addRel = members.length >= 2 ? '<div class="oe-form" role="group" aria-label="Add a relation">' +
    '<label for="oe-rel-from">Member <select id="oe-rel-from">' + mo + "</select></label>" +
    '<label for="oe-rel-type">Relation <select id="oe-rel-type">' + c.types.map((t) => opt(t, TYPE[t] || t)).join("") + "</select></label>" +
    '<label for="oe-rel-to">Target <select id="oe-rel-to">' + mo + "</select></label>" +
    '<button type="button" class="ax-btn" data-oe="add-relation">Add relation</button></div>'
    : '<p class="org-quiet">Add two members to link them.</p>'

  return '<p class="oe-lead">Each change is checked, saved to agentx.json with a backup, and used at once, with no restart. A change to a line, or a removal, asks you first.</p>' +
    note + confirm +
    '<h2 class="org-h2">Add a member</h2>' + add +
    '<h2 class="org-h2">Members <span class="org-kind">' + members.length + "</span></h2>" + rows +
    '<h2 class="org-h2">Relations <span class="org-kind">' + rels.length + "</span></h2>" + lines + addRel +
    '<dl class="oe-legend"><dt>Reports to</dt><dd>The line manager, one at most. Work an agent cannot finish goes up this line.</dd>' +
      "<dt>Dotted line to</dt><dd>A second manager for one topic or project.</dd>" +
      "<dt>Acts for</dt><dd>An agent works on behalf of a person.</dd></dl>"
}

/** What a page gives the editor: the org it shows, how a change is sent,
 *  how the org is read again, and how the page repaints. */
export interface OrgEditorHost {
  org(): OrgSetupReply | null
  post(change: OrgChange): Promise<{ summary?: string }>
  reload(): Promise<unknown>
  paint(): void
}

/** The editor's behaviour, one for /org and Settings → Business (#1678):
 *  html() is the panel, click() and key() handle its buttons, focus() puts
 *  the focus on Save the move once the page has painted. A move or removal
 *  waits in `pending`; nothing is sent before Save the move. */
export function orgEditor(host: OrgEditorHost) {
  const E = { msg: "", bad: false, pending: null as OrgConfirm | null, focus: false }
  const field = (id: string) => { const el = document.getElementById(id) as HTMLInputElement | null; return el ? el.value : "" }
  // Sends the steps in order. If a later one is refused, the undo steps put
  // back what the earlier ones changed.
  async function save(steps: OrgChange[], undo: OrgChange[], button?: HTMLButtonElement) {
    if (button) button.disabled = true
    let done = 0, d: { summary?: string } = {}
    try {
      for (; done < steps.length; done++) d = await host.post(steps[done])
      E.msg = (d.summary || "Saved") + ". Saved."; E.bad = false
    } catch (e: any) {
      E.msg = e.message; E.bad = true
      if (done > 0) {
        try { for (const u of undo) await host.post(u); E.msg += " Nothing was changed." }
        catch (e2: any) { E.msg += " Putting the old line back failed too: " + e2.message + ". Check the chart below." }
      }
    }
    await host.reload()
    host.paint()
    if (button) button.disabled = false
  }
  function ask(change: OrgChange, button: HTMLButtonElement) {
    const org = host.org()
    const c = org && org.setup ? orgConfirmFor(org.setup, change) : null
    if (!c) { save([change], [], button); return }
    E.pending = c; E.msg = ""; E.bad = false; E.focus = true
    host.paint()
  }
  function cancel() {
    E.pending = null; E.msg = "Cancelled. Nothing changed."; E.bad = false
    host.paint()
  }
  return {
    E,
    html: () => orgEditHtml(host.org(), { text: E.msg, bad: E.bad }, E.pending ? E.pending.text : ""),
    focus() {
      if (E.focus) { const sv = document.getElementById("oe-confirm-save"); if (sv) sv.focus() }
      E.focus = false
    },
    /** Handles a click on one of the editor's buttons; false for any other click. */
    click(target: EventTarget | null): boolean {
      const b = target && (target as Element).closest ? (target as Element).closest("[data-oe]") as HTMLButtonElement | null : null
      if (!b) return false
      const op = b.getAttribute("data-oe") || ""
      const at = (k: string) => b.getAttribute("data-oe-" + k) || ""
      if (op === "confirm") {
        const p = E.pending
        if (!p) return true
        E.pending = null
        save(p.steps, p.undo, b)
      } else if (op === "cancel") cancel()
      else if (op === "add-member") { if (field("oe-add-member")) save([{ op, member: field("oe-add-member"), role: field("oe-add-role") }], [], b) }
      else if (op === "set-role") save([{ op, member: at("member"), role: field("oe-role-" + at("i")) }], [], b)
      else if (op === "add-relation") ask({ op, from: field("oe-rel-from"), type: field("oe-rel-type"), to: field("oe-rel-to") }, b)
      else if (op === "remove-member") ask({ op, member: at("member") }, b)
      else if (op === "remove-relation") ask({ op, from: at("from"), type: at("type"), to: at("to") }, b)
      return true
    },
    /** Escape cancels a change waiting for Save the move. */
    key(ev: KeyboardEvent) {
      if (ev.key === "Escape" && E.pending) { ev.preventDefault(); cancel() }
    },
  }
}

/** The editor's styles, under an .org-edit box, for both pages. */
export const ORG_EDIT_CSS = `
.org-edit { margin: 0 0 24px; padding: 12px 16px 16px; border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); font-size: var(--ax-fs-sm); }
.oe-lead { margin: 0 0 6px; color: var(--ax-text-2); }
.oe-msg { min-height: 1.4em; margin: 0 0 6px; }
.oe-msg.is-bad { color: var(--ax-red-ink); }
.oe-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 8px; padding: 10px 12px; border: var(--ax-border-w) solid var(--ax-border-2); border-radius: var(--ax-radius); background: var(--ax-surface-2); }
.oe-confirm-text { flex: 1 1 240px; margin: 0; }
.oe-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; margin: 6px 0 10px; }
.oe-form label, .oe-role { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.org-edit select, .org-edit input { font: inherit; font-size: var(--ax-fs-sm); min-width: 0; max-width: 100%; padding: 5px 8px; border-radius: var(--ax-radius-sm); border: var(--ax-border-w) solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text); }
.oe-rows { list-style: none; margin: 0; padding: 0; }
.oe-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 0; border-bottom: var(--ax-border-w) solid var(--ax-border); }
.oe-who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; flex: 1 1 160px; min-width: 0; }
.oe-role { flex: 0 1 200px; }
.oe-acts { display: flex; flex-wrap: wrap; gap: 6px; }
.oe-legend { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 16px 0 0; padding: 10px 12px; border: var(--ax-border-w) solid var(--ax-border); border-radius: var(--ax-radius); }
.oe-legend dt { font-weight: 600; }
.oe-legend dd { margin: 0; color: var(--ax-text-2); }
@media (max-width: 640px) {
  .org-edit { padding: 10px 12px 14px; }
  .oe-form > *, .oe-role { flex: 1 1 100%; }
  .oe-legend { grid-template-columns: 1fr; }
}
`
