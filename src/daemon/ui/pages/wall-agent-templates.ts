// Settings › Agents › Add an agent: start from a template (#2101 P10, mock
// R6). A template fills the form the owner already has (id, name, trigger
// words, engine, purpose) and says what comes next: the first thing to ask
// the new agent, the skills worth adding and the connections it needs, each
// linking to the Settings section that sets it up. Nothing is saved until
// the owner presses Add agent, and every field stays editable.
//
// Pure data and HTML, shipped to the browser with injectFns().

export interface AgentTemplate {
  key: string
  label: string
  /** One line under the label on the picker. */
  blurb: string
  id: string
  name: string
  triggers: string
  engine: string
  purpose: string
  /** The first thing to ask it once it runs. */
  firstAction: string
  /** Skills worth adding on its Skills tab. */
  skills: string[]
  /** What it needs connected, with the Settings section that does it. */
  connections: Array<{ label: string; section: string }>
}

/** The templates, as a function so injectFns() ships them with the helpers. */
export function atList(): AgentTemplate[] {
  return [
  {
    key: "support", label: "Support desk", blurb: "Answers customers on a chat channel",
    id: "support", name: "Support Desk", triggers: "@support, support", engine: "claude-code",
    purpose: "You answer customer questions politely and briefly. When you do not know, say so and pass the question to the owner.",
    firstAction: "Answer the next customer message on its channel.",
    skills: ["A short FAQ of your product, as a skill"],
    connections: [{ label: "A chat channel: Telegram, WhatsApp or Email", section: "channels" }],
  },
  {
    key: "reviewer", label: "Code reviewer", blurb: "Reviews pull and merge requests",
    id: "reviewer", name: "Reviewer", triggers: "@reviewer, review", engine: "claude-code",
    purpose: "You review pull and merge requests for bugs, missing tests and unclear names. You list findings by severity and never merge.",
    firstAction: "Review the newest open pull request.",
    skills: ["Your team's coding conventions, as a skill"],
    connections: [{ label: "GitHub or GitLab", section: "channels" }, { label: "A webhook for new pull requests (optional)", section: "webhooks" }],
  },
  {
    key: "reporter", label: "Daily reporter", blurb: "Sends a summary on a schedule",
    id: "reporter", name: "Reporter", triggers: "@reporter", engine: "claude-code",
    purpose: "You send a short daily summary: what changed, what is late, and the one number that matters most.",
    firstAction: "Add a schedule: weekdays at 9:00, send yesterday's summary.",
    skills: [],
    connections: [{ label: "A schedule", section: "schedules" }, { label: "A channel to send to", section: "channels" }],
  },
  {
    key: "research", label: "Researcher", blurb: "Looks things up and writes a brief",
    id: "research", name: "Researcher", triggers: "@research, research", engine: "claude-code",
    purpose: "You research a question on the web, compare at least three sources, and answer with a short brief and the links you used.",
    firstAction: "Ask it one question you need answered this week.",
    skills: [],
    connections: [],
  },
  ]
}

/** The picker over the Add an agent form: Blank plus one chip per template. */
export function atPickerHtml(picked: string, esc: (s: string) => string): string {
  const chip = (key: string, label: string, blurb: string) =>
    '<button type="button" class="wat__t' + (picked === key ? " is-on" : "") + '" data-st-act="agent-tpl" data-tpl="' + esc(key) + '" aria-pressed="' + (picked === key ? "true" : "false") + '"><b>' + esc(label) + "</b><small>" + esc(blurb) + "</small></button>"
  return '<div class="wat" role="group" aria-label="Start from a template">' +
    '<p class="wsf__hint">Start from a template, or from a blank form. A template only fills the form; change anything before you add the agent.</p>' +
    '<div class="wat__list">' + chip("", "Blank", "Fill every field yourself") +
    atList().map((t) => chip(t.key, t.label, t.blurb)).join("") + "</div></div>"
}

/** What comes after Add agent for a template: first action, skills, connections. */
export function atNextHtml(t: AgentTemplate | undefined, esc: (s: string) => string, href: (section: string) => string): string {
  if (!t) return ""
  const rows = ['<li><b>First thing to ask:</b> ' + esc(t.firstAction) + "</li>"]
  if (t.skills.length) rows.push("<li><b>Skills:</b> " + t.skills.map(esc).join(", ") + ', on its Skills tab after you add it.</li>')
  rows.push(t.connections.length
    ? "<li><b>Connect:</b> " + t.connections.map((c) => '<a href="' + esc(href(c.section)) + '">' + esc(c.label) + "</a>").join(", ") + ".</li>"
    : "<li><b>Connect:</b> nothing; it works from the Hub chat.</li>")
  return '<div class="wat__next"><h4>After you add it</h4><ul>' + rows.join("") + "</ul></div>"
}

/** The form values a template sets, by field id. */
export function atFields(t: AgentTemplate | undefined): Record<string, string> {
  if (!t) return { "st-a-id": "", "st-a-name": "", "st-a-triggers": "", "st-a-tier": "claude-code", "st-a-personality": "" }
  return { "st-a-id": t.id, "st-a-name": t.name, "st-a-triggers": t.triggers, "st-a-tier": t.engine, "st-a-personality": t.purpose }
}

export const AGENT_TEMPLATES_CSS = `
.wat { margin: 0 0 10px; }
.wat__list { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.wat__t { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 8px 10px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-surface); color: var(--ax-text); cursor: pointer; font: inherit; }
.wat__t small { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wat__t.is-on { border-color: var(--ax-accent); box-shadow: 0 0 0 1px var(--ax-accent); }
.wat__t.is-on:focus-visible { box-shadow: 0 0 0 1px var(--ax-accent), var(--ax-focus-ring); }
.wat__next { margin: 4px 0 10px; padding: 8px 12px; border-radius: var(--ax-radius); background: var(--ax-surface-2); font-size: var(--ax-fs-sm); }
.wat__next h4 { margin: 0 0 4px; font-size: var(--ax-fs-sm); }
.wat__next ul { margin: 0; padding-left: 18px; }
`
