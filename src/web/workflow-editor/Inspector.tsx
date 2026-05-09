import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Icon } from "./Icons"
import { EXPR_VARS, type AgentInfo } from "./data"
import type { WorkflowNode } from "./types"
import type { GraphEdge, GraphNode, GraphModel } from "./graph"
import type { Selection, RunState } from "./Canvas"
// Pure-data schemas of every node type's output shape — shared with the
// server so the Context panel never drifts from what handlers actually emit.
import { NODE_OUTPUTS, outputFieldsFor, type OutputField } from "../../workflows/nodes/schemas"

// --- V2 Inspector: per-kind typed forms ---
//
// Config tab picks a form component based on node.type — every widget is
// typed (dropdowns, text inputs, list editors) so authors never edit raw
// JSON for routine work. Advanced tab keeps the JSON editor as a fallback
// for nodes not yet covered by a dedicated form or for power-users tweaking
// fields without a UI. Preview tab shows the latest run output for this
// node if one exists.

// ═══════════════════════════════════════════════════════════════════════════
// Form primitives
// ═══════════════════════════════════════════════════════════════════════════

function Section({ title, children, defaultOpen = true, right }: { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={"insp__section" + (open ? "" : " is-collapsed")}>
      <div className="insp__section-head" onClick={() => setOpen(!open)}>
        <span className="chev"><Icon.chev /></span>
        <h4>{title}</h4>
        {right}
      </div>
      <div className="insp__section-body">{children}</div>
    </div>
  )
}

function Field({ label, hint, err, children, mono }: { label: string; hint?: string; err?: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className={"fld" + (mono ? " is-mono" : "") + (err ? " is-err" : "")}>
      <div className="fld__label"><span>{label}</span>{hint && <span className="fld__hint">{hint}</span>}</div>
      {children}
      {err && <div className="fld__err"><Icon.err />{err}</div>}
    </div>
  )
}

function Input({ value, onChange, placeholder, mono, list }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; list?: string }) {
  return <input className={"fld__input" + (mono ? " mono" : "")} type="text" value={value} placeholder={placeholder} list={list} onChange={(e) => onChange(e.target.value)} />
}

function NumInput({ value, onChange, placeholder }: { value: number | undefined; onChange: (v: number | undefined) => void; placeholder?: string }) {
  return (
    <input
      className="fld__input"
      type="number"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => {
        const v = e.target.value.trim()
        if (v === "") onChange(undefined)
        else onChange(Number(v))
      }}
    />
  )
}

function Area({ value, onChange, rows = 3, placeholder, mono }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; mono?: boolean }) {
  return <textarea className={"fld__input" + (mono ? " mono" : "")} rows={rows} spellCheck={false} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<string | { value: string; label: string }> }) {
  return (
    <select className="fld__select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => {
        const val = typeof o === "string" ? o : o.value
        const lab = typeof o === "string" ? o : o.label
        return <option key={val} value={val}>{lab}</option>
      })}
    </select>
  )
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="fld__check" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/** Comma-separated list editor — serialises to/from an array of strings. */
function ListInput({ value, onChange, placeholder, mono }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; mono?: boolean }) {
  return (
    <input
      className={"fld__input" + (mono ? " mono" : "")}
      type="text"
      value={value.join(", ")}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
    />
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// ExprField — textarea with {{var}} autocomplete
// ═══════════════════════════════════════════════════════════════════════════

function ExprField({ value, onChange, placeholder, rows = 3 }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const flat = useMemo(() => {
    const out: Array<{ group: string; path: string; type: string }> = []
    EXPR_VARS.forEach((g) => g.items.forEach((it) => out.push({ group: g.group, ...it })))
    return out
  }, [])

  const insert = (path: string) => {
    const ta = taRef.current
    if (!ta) return
    const pos = ta.selectionStart
    const before = value.slice(0, pos)
    const after = value.slice(pos)
    // If the caret is right after `{{`, inject just the path; otherwise
    // fence the insertion with `{{` + `}}` so the template is valid.
    const hasOpen = before.endsWith("{{")
    const prefix = hasOpen ? before : before + "{{"
    const next = prefix + path + "}}" + after
    onChange(next)
    setOpen(false)
    requestAnimationFrame(() => {
      ta.focus()
      const cp = prefix.length + path.length + 2
      ta.setSelectionRange(cp, cp)
    })
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) {
      if (e.key === "{" && e.shiftKey) setOpen(true)
      return
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setPick((p) => (p + 1) % flat.length) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setPick((p) => (p - 1 + flat.length) % flat.length) }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insert(flat[pick].path) }
    else if (e.key === "Escape") setOpen(false)
  }

  return (
    <div className="expr" style={{ position: "relative" }}>
      <textarea
        ref={taRef}
        className="fld__input mono"
        rows={rows}
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="fld__hint" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <Icon.variable />
        Type <code>{"{{"}</code> to insert a variable · <kbd>↑↓</kbd> <kbd>↵</kbd>
        <button type="button" style={{ marginLeft: "auto", background: "none", border: "none", color: "inherit", cursor: "pointer" }} onClick={() => setOpen(!open)}><Icon.plus /></button>
      </div>
      {open && (
        <div className="expr__popover" style={{
          position: "absolute", left: 0, right: 0, top: "100%", zIndex: 10,
          background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 4,
          maxHeight: 260, overflowY: "auto", boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
        }}>
          {EXPR_VARS.map((g) => (
            <Fragment key={g.group}>
              <div className="expr__pop-group" style={{ padding: "4px 10px", fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>{g.group}</div>
              {g.items.map((it) => {
                const idx = flat.findIndex((f) => f.path === it.path)
                const active = idx === pick
                return (
                  <div
                    key={it.path}
                    onMouseEnter={() => setPick(idx)}
                    onClick={() => insert(it.path)}
                    style={{
                      padding: "4px 10px", cursor: "pointer", fontSize: 11,
                      display: "flex", justifyContent: "space-between", gap: 12,
                      fontFamily: "var(--ax-mono, ui-monospace)",
                      background: active ? "var(--accent-soft)" : "transparent",
                    }}
                  >
                    <span>{`{{${it.path}}}`}</span>
                    <span style={{ color: "var(--muted)", fontSize: 10 }}>{it.type}</span>
                  </div>
                )
              })}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Agent combobox — fetched from /api/agents
// ═══════════════════════════════════════════════════════════════════════════

function AgentCombo({ value, onChange, agents }: { value: string | undefined; onChange: (id: string) => void; agents: AgentInfo[] }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("mousedown", handler)
    return () => window.removeEventListener("mousedown", handler)
  }, [])

  const current = agents.find((a) => a.id === value)
  const filtered = agents.filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()) || a.id.includes(q))

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="fld__input"
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 8, textAlign: "left", width: "100%", cursor: "pointer" }}
      >
        <span style={{
          display: "inline-flex", width: 22, height: 22, borderRadius: 4,
          background: `oklch(0.78 0.13 ${current?.color ?? 260})`, color: "#fff",
          alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 600, flexShrink: 0,
        }}>
          {(current?.name ?? "??").slice(0, 2).toUpperCase()}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 500 }}>{current?.name ?? "Select agent…"}</div>
          <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--ax-mono, ui-monospace)" }}>{current?.id ?? "—"}</div>
        </span>
        <Icon.chev />
      </button>
      {open && (
        <div style={{
          position: "absolute", left: 0, right: 0, top: "100%", zIndex: 10,
          background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 4,
          marginTop: 4, maxHeight: 280, overflowY: "auto", boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
        }}>
          <div style={{ padding: 6, borderBottom: "1px solid var(--line)" }}>
            <input
              autoFocus
              className="fld__input"
              value={q}
              placeholder="Filter agents…"
              onChange={(e) => setQ(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>
          <div>
            {filtered.map((a) => (
              <div
                key={a.id}
                onClick={() => { onChange(a.id); setOpen(false); setQ("") }}
                style={{
                  padding: "6px 10px", cursor: "pointer",
                  display: "flex", gap: 8, alignItems: "center",
                  background: a.id === value ? "var(--accent-soft)" : "transparent",
                }}
              >
                <span style={{
                  display: "inline-flex", width: 22, height: 22, borderRadius: 4,
                  background: `oklch(0.78 0.13 ${a.color})`, color: "#fff",
                  alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 600, flexShrink: 0,
                }}>
                  {a.name.slice(0, 2).toUpperCase()}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{a.name}</div>
                  <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--ax-mono, ui-monospace)" }}>{a.id}</div>
                </div>
                {a.tags.length > 0 && (
                  <div style={{ display: "flex", gap: 3 }}>
                    {a.tags.map((t) => <span key={t} style={{ fontSize: 9, color: "var(--muted)", background: "var(--surface)", padding: "1px 5px", borderRadius: 3 }}>{t}</span>)}
                  </div>
                )}
              </div>
            ))}
            {filtered.length === 0 && <div style={{ padding: 10, fontSize: 11, color: "var(--muted)" }}>No agents match.</div>}
          </div>
        </div>
      )}
      <Field label="" hint="Free text — type an agent id directly if it isn't in the list yet">
        <Input value={value ?? ""} onChange={onChange} placeholder="agent-id" mono />
      </Field>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-kind forms
// ═══════════════════════════════════════════════════════════════════════════

type FormProps = {
  node: WorkflowNode
  patch: (patch: Partial<WorkflowNode>) => void
  patchData: (data: Record<string, unknown>) => void
  agents: AgentInfo[]
  /** Sibling nodes — lets a form derive realistic template placeholders
   *  (e.g. ActionSendForm needs the trigger node's id, since it's auto-
   *  generated like "n-fcjwrx" rather than the literal "trigger"). */
  nodes: WorkflowNode[]
}

// --- Triggers ---

// Catalog of channel-trigger sources. One source of truth for: dropdown
// options, "fires when" descriptions, wired/schema-only badges, and which
// filter fields apply. Adding a new source means adding one entry here.
type ChannelSourceKey =
  | "whatsapp-message"
  | "telegram-message"
  | "discord-message"
  | "slack-message"
  | "gitlab-issue"
  | "gitlab-mr"
  | "gitlab-note"
  | "gitlab-pipeline"
  | "github-issue"
  | "github-pr"
  | "stripe-event"
  | "sentry-issue"
  | "vercel-deployment"

interface ChannelSourceMeta {
  /** Short label for the dropdown option. */
  label: string
  /** One-line "fires when" description shown under the source select. */
  fires: string
  /** True if there's a backend subscriber actually firing this. */
  wired: boolean
  /** Which filter group to render. */
  group: "channel-msg" | "gitlab" | "github" | "external-webhook"
  /** Whether this source supports the labels[] filter. */
  hasLabels: boolean
}

const CHANNEL_SOURCES: Record<ChannelSourceKey, ChannelSourceMeta> = {
  "whatsapp-message": {
    label: "WhatsApp — Incoming message",
    fires: "Fires when a contact or group sends a WhatsApp message to the paired account.",
    wired: true,
    group: "channel-msg",
    hasLabels: false,
  },
  "telegram-message": {
    label: "Telegram — Incoming message",
    fires: "Fires when a Telegram user or group sends a message to the bot.",
    wired: true,
    group: "channel-msg",
    hasLabels: false,
  },
  "discord-message": {
    label: "Discord — Incoming message",
    fires: "Fires when a Discord user posts a message in a watched channel or DM.",
    wired: false,
    group: "channel-msg",
    hasLabels: false,
  },
  "slack-message": {
    label: "Slack — Incoming message",
    fires: "Fires when a Slack user posts a message in a watched channel or DM.",
    wired: false,
    group: "channel-msg",
    hasLabels: false,
  },
  "gitlab-issue": {
    label: "GitLab — Issue event",
    fires: "Fires when a GitLab issue is opened, updated, reopened, or closed.",
    wired: true,
    group: "gitlab",
    hasLabels: true,
  },
  "gitlab-mr": {
    label: "GitLab — Merge request event",
    fires: "Fires when a GitLab merge request is opened, updated, approved, merged, or closed.",
    wired: true,
    group: "gitlab",
    hasLabels: true,
  },
  "gitlab-note": {
    label: "GitLab — Comment on issue or MR",
    fires: "Fires when a comment is posted on a GitLab issue or merge request.",
    wired: true,
    group: "gitlab",
    hasLabels: false,
  },
  "gitlab-pipeline": {
    label: "GitLab — Pipeline status change",
    fires: "Fires when a CI/CD pipeline transitions state (running, success, failed).",
    wired: true,
    group: "gitlab",
    hasLabels: false,
  },
  "github-issue": {
    label: "GitHub — Issue event",
    fires: "Fires when a GitHub issue is opened, updated, or closed (after webhook signature verification).",
    wired: true,
    group: "github",
    hasLabels: true,
  },
  "github-pr": {
    label: "GitHub — Pull request event",
    fires: "Fires when a GitHub pull request is opened, updated, reviewed, merged, or closed.",
    wired: true,
    group: "github",
    hasLabels: true,
  },
  "stripe-event": {
    label: "Stripe — Webhook event",
    fires: "Fires on any Stripe webhook (invoice.paid, customer.subscription.deleted, charge.refunded, etc.). Filter by event type in the workflow body.",
    wired: true,
    group: "external-webhook",
    hasLabels: false,
  },
  "sentry-issue": {
    label: "Sentry — Issue alert",
    fires: "Fires when Sentry triggers an issue alert (new issue, regression, threshold breach).",
    wired: true,
    group: "external-webhook",
    hasLabels: false,
  },
  "vercel-deployment": {
    label: "Vercel — Deployment event",
    fires: "Fires when Vercel reports a deployment state change (created, ready, error).",
    wired: true,
    group: "external-webhook",
    hasLabels: false,
  },
}

const CHANNEL_SOURCE_OPTIONS: Array<{ value: string; label: string }> = (Object.entries(CHANNEL_SOURCES) as Array<[ChannelSourceKey, ChannelSourceMeta]>)
  .map(([value, meta]) => ({
    value,
    label: meta.wired ? `${meta.label}  ✓` : `${meta.label}  ⚠ schema-only`,
  }))

function TriggerChannelForm({ node, patchData }: FormProps) {
  const cfg = node.config as { source?: string; filter?: Record<string, unknown>; passthrough?: boolean }
  const filter = (cfg.filter ?? {}) as Record<string, unknown>
  const patchFilter = (p: Record<string, unknown>) => patchData({ filter: { ...filter, ...p } })
  const src = String(cfg.source ?? "whatsapp-message") as ChannelSourceKey
  const meta = CHANNEL_SOURCES[src] ?? CHANNEL_SOURCES["whatsapp-message"]
  const isChannelMsg = meta.group === "channel-msg"
  const isGitLab = meta.group === "gitlab"
  const isGitHub = meta.group === "github"
  const hasFilters = isChannelMsg || isGitLab || isGitHub

  return (
    <>
      <Section title="Source">
        <Field
          label="Event"
          hint={meta.wired ? "✓ wired end-to-end" : "⚠ schema-only — no webhook subscriber configured for this source yet"}
        >
          <Select
            value={src}
            onChange={(v) => patchData({ source: v, filter: {} })}
            options={CHANNEL_SOURCE_OPTIONS}
          />
        </Field>
        <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5, marginTop: -6, marginBottom: 12 }}>
          {meta.fires}
        </div>
      </Section>
      {hasFilters && (
        <Section title="Match criteria">
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
            Limit when this trigger fires. Leave empty or use <span className="mono">*</span> to match anything.
          </div>
          {isGitLab && (
            <Field label="Project" hint={`GitLab project path. Empty or "*" matches any.`}>
              <Input mono value={String(filter.project ?? "")} onChange={(v) => patchFilter({ project: v })} placeholder="* (any) or noqta/web" />
            </Field>
          )}
          {isGitHub && (
            <Field label="Repo" hint={`GitHub "owner/repo". Empty or "*" matches any.`}>
              <Input mono value={String(filter.repo ?? "")} onChange={(v) => patchFilter({ repo: v })} placeholder="* (any) or owner/repo" />
            </Field>
          )}
          {isChannelMsg && (
            <Field
              label="Chat"
              hint={src === "whatsapp-message"
                ? `Contact number or JID (e.g. "+216 24 309 128", "21624309128@s.whatsapp.net"). Empty or "*" matches any.`
                : src === "telegram-message"
                  ? `Telegram chat id ("1816212449" for a DM, "-1003861455814" for a group). Empty or "*" matches any.`
                  : `Exact chat id. Empty or "*" matches any.`}
            >
              <Input mono value={String(filter.chat ?? "")} onChange={(v) => patchFilter({ chat: v })} placeholder="* (any)" />
            </Field>
          )}
          {meta.hasLabels && (
            <Field label="Labels (any of)" hint="Fires only when at least one of these labels is present on the issue/MR. Empty = no label filter.">
              <ListInput mono value={Array.isArray(filter.labels) ? (filter.labels as string[]) : []} onChange={(v) => patchFilter({ labels: v })} placeholder="bug, needs-review" />
            </Field>
          )}
        </Section>
      )}
      {isChannelMsg && (
        <Section title="Routing" defaultOpen={false}>
          <Field
            label="Passthrough"
            hint="When on, the default agent router ALSO replies alongside this workflow. Use for observability-only workflows (tag, log, forward) that shouldn't own the conversation."
          >
            <Check checked={!!cfg.passthrough} onChange={(v) => patchData({ passthrough: v })} label="Let the default agent also reply" />
          </Field>
        </Section>
      )}
    </>
  )
}

function TriggerCronForm({ node, patchData }: FormProps) {
  const cfg = node.config as { spec?: string; timezone?: string }
  return (
    <Section title="Schedule">
      <Field label="Cron spec" hint="5 fields: minute hour day month weekday. E.g. '0 9 * * 1-5' = 9am Mon–Fri.">
        <Input mono value={String(cfg.spec ?? "0 * * * *")} onChange={(v) => patchData({ spec: v })} placeholder="0 9 * * *" />
      </Field>
      <Field label="Timezone" hint="IANA timezone (e.g. Africa/Tunis, America/New_York). Defaults to UTC.">
        <Input mono value={String(cfg.timezone ?? "UTC")} onChange={(v) => patchData({ timezone: v })} placeholder="Africa/Tunis" />
      </Field>
      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5, marginTop: 4 }}>
        Fires the workflow on the schedule. The trigger payload is empty — downstream nodes won't have <span className="mono">{"{{start.*}}"}</span> data unless you wire it.
      </div>
    </Section>
  )
}

// Catalog of `on:*` hook events that workflow subscribers can listen to.
// One source of truth for the hook-trigger autocomplete + per-event help.
// Adding a new hook event means adding one entry here.
const HOOK_EVENTS: Array<{ value: string; label: string; fires: string }> = [
  {
    value: "on:gitlab-issue",
    label: "on:gitlab-issue",
    fires: "Fires when a GitLab issue is opened, updated, reopened, or closed (after the channel adapter dispatched it).",
  },
  {
    value: "on:gitlab-mr",
    label: "on:gitlab-mr",
    fires: "Fires when a GitLab merge request is opened, updated, approved, merged, or closed.",
  },
  {
    value: "on:gitlab-note",
    label: "on:gitlab-note",
    fires: "Fires when a comment is posted on a GitLab issue or merge request.",
  },
  {
    value: "on:gitlab-pipeline",
    label: "on:gitlab-pipeline",
    fires: "Fires when a GitLab CI/CD pipeline transitions state.",
  },
  {
    value: "on:github-issue",
    label: "on:github-issue",
    fires: "Fires when a GitHub issue is opened, updated, or closed (signature-verified webhook).",
  },
  {
    value: "on:github-pr",
    label: "on:github-pr",
    fires: "Fires when a GitHub pull request is opened, reviewed, merged, or closed.",
  },
  {
    value: "on:github-push",
    label: "on:github-push",
    fires: "Fires on any GitHub push event (branch updates).",
  },
  {
    value: "on:stripe-event",
    label: "on:stripe-event",
    fires: "Fires on any Stripe webhook (invoice.paid, charge.refunded, subscription.deleted, etc.). Filter by event type inside the workflow.",
  },
  {
    value: "on:sentry-issue",
    label: "on:sentry-issue",
    fires: "Fires when a Sentry issue alert lands (new issue, regression, error threshold).",
  },
  {
    value: "on:vercel-deployment",
    label: "on:vercel-deployment",
    fires: "Fires when a Vercel deployment changes state.",
  },
  {
    value: "on:error",
    label: "on:error",
    fires: "Fires when an agent task fails. Useful for incident-routing workflows.",
  },
]

function TriggerHookForm({ node, patchData }: FormProps) {
  const cfg = node.config as { event?: string }
  const ev = String(cfg.event ?? "on:")
  const known = HOOK_EVENTS.find(h => h.value === ev)
  const fires = known?.fires
    ?? (ev.startsWith("on:") && ev !== "on:"
      ? "Custom hook event. Fires whenever code in your agentx setup emits this event via the bus. Subscribe responsibly."
      : `Hook event names must start with "on:" — e.g. on:gitlab-issue.`)

  return (
    <Section title="Hook subscription">
      <Field label="Event" hint="Pick a known event or type your own (must start with on:)">
        <Input
          mono
          value={ev}
          onChange={(v) => patchData({ event: v })}
          placeholder="on:gitlab-issue"
          list="hook-events-list"
        />
        <datalist id="hook-events-list">
          {HOOK_EVENTS.map(h => (
            <option key={h.value} value={h.value}>{h.fires}</option>
          ))}
        </datalist>
      </Field>
      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5, marginTop: -6, marginBottom: 4 }}>
        {fires}
      </div>
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--muted)" }}>Available hook events</summary>
        <ul style={{ fontSize: 11, color: "var(--muted)", paddingLeft: 16, marginTop: 6 }}>
          {HOOK_EVENTS.map(h => (
            <li key={h.value} style={{ marginBottom: 4 }}>
              <span className="mono">{h.value}</span> — {h.fires}
            </li>
          ))}
        </ul>
      </details>
    </Section>
  )
}

function TriggerManualForm(_props: FormProps) {
  return (
    <Section title="Manual run">
      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
        No configuration needed. Fire this workflow via:
        <pre style={{ marginTop: 8, padding: 8, background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 4, fontSize: 11 }}>
          {`agentx workflow run <id>`}
        </pre>
        or <span className="mono">POST /workflows/&lt;id&gt;/run</span>.
      </div>
    </Section>
  )
}

// --- Agent ---

function AgentForm({ node, patchData, agents }: FormProps) {
  const cfg = node.config as { agentId?: string; prompt?: string; resultParser?: string; timeoutMinutes?: number }
  return (
    <>
      <Section title="Agent">
        <Field label="Which agent runs">
          <AgentCombo value={cfg.agentId} onChange={(id) => patchData({ agentId: id })} agents={agents} />
        </Field>
        <Field label="Prompt" hint="Supports {{nodeId.path}} variables from upstream context">
          <ExprField
            value={cfg.prompt ?? ""}
            onChange={(v) => patchData({ prompt: v })}
            placeholder="Classify {{trigger.text}} — reply RESULT: status-check | new-request | other"
            rows={5}
          />
        </Field>
      </Section>
      <Section title="Behavior" defaultOpen={false}>
        <Field label="Result parser" hint="How to extract a routing token from the agent's reply">
          <Select
            value={String(cfg.resultParser ?? "noqta-result-token")}
            onChange={(v) => patchData({ resultParser: v })}
            options={[
              { value: "noqta-result-token", label: "RESULT: token (recommended)" },
              { value: "json", label: "JSON block (```json …```)" },
              { value: "raw", label: "Raw reply (no parsing)" },
            ]}
          />
        </Field>
        <Field label="Timeout (minutes)">
          <NumInput value={cfg.timeoutMinutes} onChange={(v) => patchData({ timeoutMinutes: v })} placeholder="5" />
        </Field>
      </Section>
    </>
  )
}

// --- Transform ---

function TransformForm({ node, patchData }: FormProps) {
  const cfg = node.config as { path?: string; template?: Record<string, unknown> }
  const [mode, setMode] = useState<"path" | "template">(cfg.template && typeof cfg.template === "object" ? "template" : "path")

  return (
    <Section title="Transform">
      <Field label="Mode">
        <Select
          value={mode}
          onChange={(v) => {
            const next = v as "path" | "template"
            setMode(next)
            if (next === "path") patchData({ path: cfg.path ?? "", template: undefined })
            else patchData({ template: cfg.template ?? {}, path: undefined })
          }}
          options={[
            { value: "path", label: "Pick value from context (dotted path)" },
            { value: "template", label: "Build a bundle (template object)" },
          ]}
        />
      </Field>
      {mode === "path" && (
        <Field label="Path" hint="e.g. classify.reply or trigger.contact.name">
          <Input mono value={String(cfg.path ?? "")} onChange={(v) => patchData({ path: v })} placeholder="classify.reply" />
        </Field>
      )}
      {mode === "template" && (
        <Field label="Template (JSON object)" hint="Each string value is rendered with {{nodeId.path}} variables">
          <Area
            mono
            rows={6}
            value={JSON.stringify(cfg.template ?? {}, null, 2)}
            onChange={(v) => {
              try { patchData({ template: JSON.parse(v) }) } catch { /* keep typing; JSON may be mid-edit */ }
            }}
            placeholder={`{\n  "greeting": "hi {{trigger.sender.name}}"\n}`}
          />
        </Field>
      )}
    </Section>
  )
}

// --- Branch ---

type BranchCase = { when: { kind: string; params: Record<string, unknown> }; to: string }

function BranchForm({ node, patchData }: FormProps) {
  const cfg = node.config as { cases?: BranchCase[]; default?: string }
  const cases = (cfg.cases ?? []) as BranchCase[]
  const patchCases = (next: BranchCase[]) => patchData({ cases: next })
  const patchCaseAt = (i: number, next: BranchCase) => patchCases(cases.map((c, j) => j === i ? next : c))
  const patchWhen = (i: number, w: Partial<BranchCase["when"]>) => patchCaseAt(i, { ...cases[i], when: { ...cases[i].when, ...w } })
  const patchParams = (i: number, p: Record<string, unknown>) => patchCaseAt(i, { ...cases[i], when: { ...cases[i].when, params: { ...cases[i].when.params, ...p } } })

  return (
    <>
      <Section title="Cases" right={<span className="card__kind">{cases.length}</span>}>
        {cases.map((c, i) => {
          const p = c.when.params ?? {}
          return (
            <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 4, padding: 10, marginBottom: 8, background: "var(--bg)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <strong style={{ fontSize: 11 }}>Case #{i + 1}</strong>
                <button className="btn btn--ghost-icon" onClick={() => patchCases(cases.filter((_, j) => j !== i))}><Icon.trash /></button>
              </div>
              <Field label="If">
                <Select
                  value={c.when.kind}
                  onChange={(v) => patchWhen(i, { kind: v, params: {} })}
                  options={[
                    { value: "equals", label: "Path equals value" },
                    { value: "contains", label: "Path contains value" },
                    { value: "matches", label: "Path matches regex" },
                    { value: "exists", label: "Path exists (non-empty)" },
                  ]}
                />
              </Field>
              <Field label="Path" hint="e.g. classify.result">
                <Input mono value={String(p.path ?? "")} onChange={(v) => patchParams(i, { path: v })} placeholder="classify.result" />
              </Field>
              {(c.when.kind === "equals" || c.when.kind === "contains") && (
                <Field label="Value">
                  <Input mono value={String(p.value ?? "")} onChange={(v) => patchParams(i, { value: v })} />
                </Field>
              )}
              {c.when.kind === "matches" && (
                <Field label="Regex">
                  <Input mono value={String(p.regex ?? "")} onChange={(v) => patchParams(i, { regex: v })} placeholder="^(approved|done)$" />
                </Field>
              )}
              <Field label="Port" hint="Outgoing edge's `fromPort` must match this">
                <Input mono value={c.to} onChange={(v) => patchCaseAt(i, { ...c, to: v })} placeholder="approved" />
              </Field>
            </div>
          )
        })}
        <button
          className="btn btn--ghost-icon"
          style={{ width: "100%", padding: 8, justifyContent: "center" }}
          onClick={() => patchCases([...cases, { when: { kind: "equals", params: { path: "", value: "" } }, to: `case${cases.length + 1}` }])}
        >
          <Icon.plus /> Add case
        </button>
      </Section>
      <Section title="Fallback" defaultOpen={false}>
        <Field label="Default port" hint="Used when no case matches. Leave blank to drop the event.">
          <Input mono value={String(cfg.default ?? "fallback")} onChange={(v) => patchData({ default: v })} />
        </Field>
      </Section>
    </>
  )
}

// --- Checkpoint ---

function CheckpointForm({ node, patchData }: FormProps) {
  const cfg = node.config as {
    name?: string
    waitFor?: { source?: string; project?: string; repo?: string; chat?: string; labels?: string[] }
    resumeMatch?: Record<string, unknown>
  }
  const waitFor = (cfg.waitFor ?? {}) as Record<string, unknown>
  const patchWaitFor = (p: Record<string, unknown>) => patchData({ waitFor: { ...waitFor, ...p } })
  const resumeMatch = (cfg.resumeMatch ?? {}) as Record<string, unknown>

  return (
    <>
      <Section title="Checkpoint">
        <Field label="Name" hint="Human label shown in logs + run timelines">
          <Input value={String(cfg.name ?? node.id)} onChange={(v) => patchData({ name: v })} placeholder="await-label-change" />
        </Field>
      </Section>
      <Section title="Wait for">
        <Field label="Source" hint="Which kind of event unpauses this run">
          <Select
            value={String(waitFor.source ?? "")}
            onChange={(v) => patchWaitFor({ source: v || undefined })}
            options={[
              { value: "", label: "Any (same entity)" },
              { value: "gitlab-issue", label: "GitLab issue update" },
              { value: "gitlab-pipeline", label: "GitLab pipeline event" },
              { value: "whatsapp-message", label: "WhatsApp reply" },
              { value: "telegram-message", label: "Telegram reply" },
              { value: "manual", label: "Manual poke" },
            ]}
          />
        </Field>
        <Field label="Labels (any of)" hint="e.g. a label change to one of these resumes the run">
          <ListInput mono value={Array.isArray(waitFor.labels) ? (waitFor.labels as string[]) : []} onChange={(v) => patchWaitFor({ labels: v.length ? v : undefined })} />
        </Field>
      </Section>
      <Section title="Advanced match" defaultOpen={false}>
        <Field label="Event id contains" hint="Optional substring match on the incoming event's id">
          <Input mono value={String(resumeMatch.eventIdLike ?? "")} onChange={(v) => patchData({ resumeMatch: { ...resumeMatch, eventIdLike: v || undefined } })} />
        </Field>
      </Section>
    </>
  )
}

// --- End ---

function EndForm({ node, patchData }: FormProps) {
  const cfg = node.config as { status?: string; summary?: string }
  return (
    <Section title="Terminal">
      <Field label="Status">
        <Select
          value={String(cfg.status ?? "completed")}
          onChange={(v) => patchData({ status: v })}
          options={[
            { value: "completed", label: "Completed (success)" },
            { value: "failed", label: "Failed" },
            { value: "canceled", label: "Canceled" },
          ]}
        />
      </Field>
      <Field label="Summary (optional)" hint="Surfaced in run history + notifications">
        <Area value={String(cfg.summary ?? "")} onChange={(v) => patchData({ summary: v })} rows={2} />
      </Field>
    </Section>
  )
}

// --- Actions ---

const CHANNEL_OPTIONS = ["gitlab", "github", "whatsapp", "telegram", "discord", "slack"]

/** Module-level cache keyed by channel name. Known-chat lookups are shared
 *  across every ActionSendForm mount (one per selected node) in a session,
 *  so a cache avoids a fresh /channels/<name>/chats round-trip every time
 *  the user clicks a different action.send node. TTL is deliberately short
 *  (60 s) — new chats appear as soon as a peer observes them.
 *
 *  Not persisted; Map lives for the tab's lifetime. */
type KnownChat = { id: string; name?: string; kind: "dm" | "group"; accountId?: string }
const knownChatCache: Map<string, { at: number; chats: KnownChat[]; source: string }> = new Map()
const KNOWN_CHATS_TTL_MS = 60_000

function useKnownChats(channel: string): { chats: KnownChat[]; source: string; loading: boolean } {
  const [state, setState] = useState<{ chats: KnownChat[]; source: string; loading: boolean }>(() => {
    const cached = knownChatCache.get(channel)
    if (cached && Date.now() - cached.at < KNOWN_CHATS_TTL_MS) return { chats: cached.chats, source: cached.source, loading: false }
    return { chats: [], source: "", loading: true }
  })
  useEffect(() => {
    let cancelled = false
    const cached = knownChatCache.get(channel)
    if (cached && Date.now() - cached.at < KNOWN_CHATS_TTL_MS) {
      setState({ chats: cached.chats, source: cached.source, loading: false })
      return
    }
    setState((s) => ({ ...s, loading: true }))
    fetch(`/channels/${encodeURIComponent(channel)}/chats`)
      .then((r) => r.ok ? r.json() : { chats: [], source: "" })
      .then((body: { chats?: KnownChat[]; source?: string }) => {
        if (cancelled) return
        const chats = Array.isArray(body.chats) ? body.chats : []
        const source = typeof body.source === "string" ? body.source : ""
        knownChatCache.set(channel, { at: Date.now(), chats, source })
        setState({ chats, source, loading: false })
      })
      .catch(() => {
        if (cancelled) return
        setState({ chats: [], source: "", loading: false })
      })
    return () => { cancelled = true }
  }, [channel])
  return state
}

function ActionSendForm({ node, patchData, nodes }: FormProps) {
  const cfg = node.config as { channel?: string; chatId?: string; text?: string; parseMode?: string; accountId?: string; replyTo?: string }
  // Find this workflow's actual trigger node id so the placeholder template
  // reflects reality. Hard-coded "trigger" was a footgun: the editor names new
  // trigger nodes like "n-fcjwrx", and `{{trigger.chatId}}` resolves to "" —
  // which then trips the "needs channel + chatId" guard.
  const triggerId = nodes.find((n) => n.type.startsWith("trigger."))?.id ?? "trigger"
  const tmpl = (path: string) => `{{${triggerId}.${path}}}`
  const channel = String(cfg.channel ?? "whatsapp")
  const chats = useKnownChats(channel)
  const datalistId = `chats-${channel}`
  return (
    <Section title="Send message">
      <Field label="Channel">
        <Select value={channel} onChange={(v) => patchData({ channel: v })} options={CHANNEL_OPTIONS} />
      </Field>
      <Field
        label="Chat id"
        hint={
          chats.chats.length > 0
            ? `Use ${tmpl("chatId")} to reply to the trigger's chat, or pick one of the ${chats.chats.length} known chat(s) ${chats.source === "local" ? "on this node" : `from ${chats.source}`} (click the field to see the list).`
            : chats.loading
              ? `Loading known chats for "${channel}"…`
              : `Use ${tmpl("chatId")} to reply to the trigger's chat. For a different destination, paste the channel-specific id (no discovered chats for "${channel}" yet).`
        }
      >
        <Input
          mono
          value={String(cfg.chatId ?? "")}
          onChange={(v) => patchData({ chatId: v })}
          placeholder={tmpl("chatId")}
          list={chats.chats.length > 0 ? datalistId : undefined}
        />
        {chats.chats.length > 0 && (
          <datalist id={datalistId}>
            {chats.chats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ? `${c.name} — ${c.id}${c.kind === "group" ? " (group)" : ""}` : `${c.id}${c.kind === "group" ? " (group)" : ""}`}
              </option>
            ))}
          </datalist>
        )}
      </Field>
      <Field label="Text" hint="Supports {{nodeId.path}} templates from any upstream node">
        <ExprField value={String(cfg.text ?? "")} onChange={(v) => patchData({ text: v })} rows={4} placeholder={`Thanks ${tmpl("sender.name")} — working on it.`} />
      </Field>
      <Field
        label="Account id"
        hint="Telegram only: which bot account sends. Leave empty to inherit from the trigger's account (recommended)."
      >
        <Input mono value={String(cfg.accountId ?? "")} onChange={(v) => patchData({ accountId: v })} placeholder={`(inherit from ${tmpl("accountId")})`} />
      </Field>
      <Field
        label="Reply to message id"
        hint="Optional. When set, the platform threads this reply under the referenced message."
      >
        <Input mono value={String(cfg.replyTo ?? "")} onChange={(v) => patchData({ replyTo: v })} placeholder={tmpl("event.id")} />
      </Field>
      <Field
        label="Parse mode"
        hint={
          cfg.channel === "telegram"
            ? `Telegram default is "markdown" (Telegram-flavoured HTML conversion). Use "plain" to send raw text without escaping.`
            : `Platform-specific. WhatsApp ignores; Telegram supports markdown/html.`
        }
      >
        <Select
          value={String(cfg.parseMode ?? "markdown")}
          onChange={(v) => patchData({ parseMode: v })}
          options={["markdown", "plain", "html"]}
        />
      </Field>
    </Section>
  )
}

function ActionCreateIssueForm({ node, patchData }: FormProps) {
  const cfg = node.config as { channel?: string; project?: string; title?: string; description?: string; labels?: string[]; assignees?: string[] }
  return (
    <>
      <Section title="Target">
        <Field label="Channel">
          <Select value={String(cfg.channel ?? "gitlab")} onChange={(v) => patchData({ channel: v })} options={["gitlab", "github"]} />
        </Field>
        <Field label="Project" hint={`GitLab "group/project" or GitHub "owner/repo"`}>
          <Input mono value={String(cfg.project ?? "")} onChange={(v) => patchData({ project: v })} placeholder="noqta/web" />
        </Field>
      </Section>
      <Section title="Issue">
        <Field label="Title">
          <ExprField rows={1} value={String(cfg.title ?? "")} onChange={(v) => patchData({ title: v })} placeholder="From WhatsApp: {{trigger.sender.name}}" />
        </Field>
        <Field label="Description">
          <ExprField rows={6} value={String(cfg.description ?? "")} onChange={(v) => patchData({ description: v })} placeholder="Reported by {{trigger.sender.name}}\n\n{{trigger.text}}" />
        </Field>
        <Field label="Labels">
          <ListInput mono value={Array.isArray(cfg.labels) ? cfg.labels : []} onChange={(v) => patchData({ labels: v })} placeholder="Triage, source::whatsapp" />
        </Field>
        <Field label="Assignees" hint="GitLab usernames (resolved to ids at runtime)">
          <ListInput mono value={Array.isArray(cfg.assignees) ? cfg.assignees : []} onChange={(v) => patchData({ assignees: v })} placeholder="alice, bob" />
        </Field>
      </Section>
    </>
  )
}

function ActionSetLabelForm({ node, patchData }: FormProps) {
  const cfg = node.config as { channel?: string; project?: string; iid?: string; kind?: string; add?: string[]; remove?: string[] }
  return (
    <>
      <Section title="Target">
        <Field label="Channel">
          <Select value={String(cfg.channel ?? "gitlab")} onChange={(v) => patchData({ channel: v })} options={["gitlab", "github"]} />
        </Field>
        <Field label="Entity kind">
          <Select value={String(cfg.kind ?? "issue")} onChange={(v) => patchData({ kind: v })} options={["issue", "merge_request"]} />
        </Field>
        <Field label="Project">
          <Input mono value={String(cfg.project ?? "")} onChange={(v) => patchData({ project: v })} placeholder="{{trigger.project}}" />
        </Field>
        <Field label="iid">
          <Input mono value={String(cfg.iid ?? "")} onChange={(v) => patchData({ iid: v })} placeholder="{{trigger.issue.iid}}" />
        </Field>
      </Section>
      <Section title="Labels">
        <Field label="Add" hint="Comma-separated list">
          <ListInput value={Array.isArray(cfg.add) ? cfg.add : []} onChange={(v) => patchData({ add: v })} placeholder="In review" />
        </Field>
        <Field label="Remove">
          <ListInput value={Array.isArray(cfg.remove) ? cfg.remove : []} onChange={(v) => patchData({ remove: v })} placeholder="Triage" />
        </Field>
      </Section>
    </>
  )
}

function ActionReadLabelForm({ node, patchData }: FormProps) {
  const cfg = node.config as { channel?: string; project?: string; iid?: string; kind?: string }
  return (
    <Section title="Read labels">
      <Field label="Channel">
        <Select value={String(cfg.channel ?? "gitlab")} onChange={(v) => patchData({ channel: v })} options={["gitlab", "github"]} />
      </Field>
      <Field label="Entity kind">
        <Select value={String(cfg.kind ?? "issue")} onChange={(v) => patchData({ kind: v })} options={["issue", "merge_request"]} />
      </Field>
      <Field label="Project"><Input mono value={String(cfg.project ?? "")} onChange={(v) => patchData({ project: v })} /></Field>
      <Field label="iid"><Input mono value={String(cfg.iid ?? "")} onChange={(v) => patchData({ iid: v })} /></Field>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
        Output bundle: <span className="mono">{"{{ <nodeId>.labels }}"}</span> = string[]
      </div>
    </Section>
  )
}

function ActionReactForm({ node, patchData }: FormProps) {
  const cfg = node.config as { channel?: string; chatId?: string; messageId?: string; emoji?: string }
  return (
    <Section title="React">
      <Field label="Channel">
        <Select value={String(cfg.channel ?? "telegram")} onChange={(v) => patchData({ channel: v })} options={["telegram", "whatsapp"]} />
      </Field>
      <Field label="Chat id"><Input mono value={String(cfg.chatId ?? "")} onChange={(v) => patchData({ chatId: v })} placeholder="{{trigger.chatId}}" /></Field>
      <Field label="Message id"><Input mono value={String(cfg.messageId ?? "")} onChange={(v) => patchData({ messageId: v })} placeholder="{{trigger.event.id}}" /></Field>
      <Field label="Emoji"><Input value={String(cfg.emoji ?? "👀")} onChange={(v) => patchData({ emoji: v })} /></Field>
    </Section>
  )
}

function ActionEditMessageForm({ node, patchData }: FormProps) {
  const cfg = node.config as { channel?: string; chatId?: string; messageId?: string; text?: string; parseMode?: string }
  return (
    <Section title="Edit message">
      <Field label="Channel">
        <Select value={String(cfg.channel ?? "telegram")} onChange={(v) => patchData({ channel: v })} options={["telegram", "whatsapp", "gitlab", "github", "discord", "slack"]} />
      </Field>
      <Field label="Chat id"><Input mono value={String(cfg.chatId ?? "")} onChange={(v) => patchData({ chatId: v })} /></Field>
      <Field label="Message id"><Input mono value={String(cfg.messageId ?? "")} onChange={(v) => patchData({ messageId: v })} /></Field>
      <Field label="New text"><ExprField value={String(cfg.text ?? "")} onChange={(v) => patchData({ text: v })} rows={3} /></Field>
      <Field label="Parse mode">
        <Select value={String(cfg.parseMode ?? "plain")} onChange={(v) => patchData({ parseMode: v })} options={["plain", "markdown", "html"]} />
      </Field>
    </Section>
  )
}

function ActionLogTimeForm({ node, patchData }: FormProps) {
  const cfg = node.config as { channel?: string; chatId?: string; durationMs?: number }
  return (
    <Section title="Log time">
      <Field label="Channel">
        <Select value={String(cfg.channel ?? "gitlab")} onChange={(v) => patchData({ channel: v })} options={["gitlab"]} />
      </Field>
      <Field label="Chat id" hint={`"project:issue:42" or "project:merge_request:7"`}>
        <Input mono value={String(cfg.chatId ?? "")} onChange={(v) => patchData({ chatId: v })} placeholder="{{trigger.chatId}}" />
      </Field>
      <Field label="Duration (ms)">
        <NumInput value={cfg.durationMs} onChange={(v) => patchData({ durationMs: v })} placeholder="900000" />
      </Field>
    </Section>
  )
}

function ActionRunForm({ node, patchData }: FormProps) {
  const cfg = node.config as { actionId?: string; inputs?: Record<string, unknown> }
  const inputsJson = JSON.stringify(cfg.inputs ?? {}, null, 2)
  return (
    <>
      <Section title="Action">
        <Field label="Action id" hint="Slug of a registered action (.agentx/actions/<id>.json). Manage in Settings → Actions or via `agentx actions`.">
          <Input mono value={String(cfg.actionId ?? "")} onChange={(v) => patchData({ actionId: v })} placeholder="deploy-staging" />
        </Field>
      </Section>
      <Section title="Inputs" defaultOpen={true}>
        <Field label="Inputs (JSON object)" hint='Values templated into the action. Strings support {{nodeId.path}} — e.g. {"version": "{{trigger.tag}}"}'>
          <Area mono rows={5} value={inputsJson} onChange={(v) => {
            try { patchData({ inputs: JSON.parse(v) }) } catch { /* mid-edit */ }
          }} placeholder={'{\n  "version": "{{trigger.tag}}"\n}'} />
        </Field>
      </Section>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, padding: "0 10px" }}>
        Output: <span className="mono">{"{{ <nodeId>.ok / .status / .output / .errors / .durationMs }}"}</span>
      </div>
    </>
  )
}

function ActionCallHTTPForm({ node, patchData }: FormProps) {
  const cfg = node.config as { url?: string; method?: string; headers?: Record<string, string>; body?: unknown }
  return (
    <>
      <Section title="Request">
        <Field label="URL"><Input mono value={String(cfg.url ?? "")} onChange={(v) => patchData({ url: v })} placeholder="https://example.com/webhook" /></Field>
        <Field label="Method">
          <Select value={String(cfg.method ?? "POST")} onChange={(v) => patchData({ method: v })} options={["GET", "POST", "PUT", "PATCH", "DELETE"]} />
        </Field>
      </Section>
      <Section title="Body" defaultOpen={false}>
        <Field label="Body" hint="String — rendered with {{nodeId.path}}. Server parses as JSON when possible.">
          <ExprField rows={5} value={typeof cfg.body === "string" ? cfg.body : cfg.body ? JSON.stringify(cfg.body, null, 2) : ""} onChange={(v) => patchData({ body: v })} />
        </Field>
      </Section>
      <Section title="Headers" defaultOpen={false}>
        <Field label="Headers (JSON object)">
          <Area mono rows={3} value={JSON.stringify(cfg.headers ?? {}, null, 2)} onChange={(v) => {
            try { patchData({ headers: JSON.parse(v) }) } catch { /* mid-edit */ }
          }} placeholder={`{"Authorization": "Bearer ${"{{env.TOKEN}}"}"}`} />
        </Field>
      </Section>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, padding: "0 10px" }}>
        Output: <span className="mono">{"{{ <nodeId>.ok / .status / .body }}"}</span>
      </div>
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// BPM node inspectors
// ═══════════════════════════════════════════════════════════════════════════

interface FormField {
  key: string
  label: string
  type: string
  required?: boolean
  options?: string[]
  hint?: string
  defaultValue?: unknown
  validate?: { min?: number; max?: number; pattern?: string }
}
interface FormSchema {
  id?: string
  title: string
  description?: string
  fields?: FormField[]
  submitLabel?: string
  secondaryAction?: { key: string; label: string }
}

const FIELD_TYPES = ["text", "long-text", "number", "boolean", "date", "select", "multi-select", "file"] as const

/** Reusable form-schema editor. Edits a FormSchema in-place via the
 *  supplied patch fn. Used by userTask + trigger.form nodes. */
function FormBuilder({ form, patch }: { form: FormSchema; patch: (f: FormSchema) => void }) {
  const fields = form.fields ?? []
  const patchField = (idx: number, partial: Partial<FormField>) => {
    const next = [...fields]
    next[idx] = { ...next[idx], ...partial }
    patch({ ...form, fields: next })
  }
  const patchValidate = (idx: number, partial: Partial<NonNullable<FormField["validate"]>>) => {
    const next = [...fields]
    next[idx] = { ...next[idx], validate: { ...(next[idx].validate ?? {}), ...partial } }
    patch({ ...form, fields: next })
  }
  const remove = (idx: number) => patch({ ...form, fields: fields.filter((_, i) => i !== idx) })
  const move = (idx: number, delta: number) => {
    const j = idx + delta
    if (j < 0 || j >= fields.length) return
    const next = [...fields]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    patch({ ...form, fields: next })
  }
  const add = () => patch({ ...form, fields: [...fields, { key: `field_${fields.length + 1}`, label: "New field", type: "text" }] })

  return (
    <>
      <Section title="Form">
        <Field label="Title" hint="Header shown to the assignee above the form">
          <Input value={form.title ?? ""} onChange={(v) => patch({ ...form, title: v })} placeholder="Review application" />
        </Field>
        <Field label="Description" hint="Optional one-line context shown under the title">
          <Input value={form.description ?? ""} onChange={(v) => patch({ ...form, description: v })} placeholder="" />
        </Field>
        <Field label="Primary button" hint="Label on the submit button; default: Submit">
          <Input value={form.submitLabel ?? "Submit"} onChange={(v) => patch({ ...form, submitLabel: v })} />
        </Field>
        <Field label="Secondary action" hint="Optional reject/hold button. Submissions carry action='secondary'.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <Input value={form.secondaryAction?.key ?? ""} onChange={(v) => patch({ ...form, secondaryAction: v ? { key: v, label: form.secondaryAction?.label ?? v } : undefined })} placeholder="key (e.g. reject)" mono />
            <Input value={form.secondaryAction?.label ?? ""} onChange={(v) => patch({ ...form, secondaryAction: { key: form.secondaryAction?.key ?? "secondary", label: v } })} placeholder="label (e.g. Reject)" />
          </div>
        </Field>
      </Section>
      <Section title={`Fields (${fields.length})`}>
        {fields.length === 0 && <div className="hint" style={{ fontSize: 12, color: "var(--ax-muted)" }}>No fields — approve/reject form with no input.</div>}
        {fields.map((f, idx) => (
          <div key={idx} className="fld__field-row" style={{ border: "1px solid var(--ax-border)", borderRadius: 6, padding: 8, marginBottom: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 6, alignItems: "end" }}>
              <Field label="Key" hint="Stored under values.<key>">
                <Input mono value={f.key} onChange={(v) => patchField(idx, { key: v })} />
              </Field>
              <Field label="Label">
                <Input value={f.label} onChange={(v) => patchField(idx, { label: v })} />
              </Field>
              <div style={{ display: "flex", gap: 4 }}>
                <button className="fld__btn" type="button" onClick={() => move(idx, -1)} title="Move up">↑</button>
                <button className="fld__btn" type="button" onClick={() => move(idx, 1)} title="Move down">↓</button>
                <button className="fld__btn" type="button" onClick={() => remove(idx)} title="Remove">✕</button>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
              <Field label="Type">
                <Select value={f.type} onChange={(v) => patchField(idx, { type: v })} options={FIELD_TYPES.slice()} />
              </Field>
              <Field label="">
                <Check checked={!!f.required} onChange={(v) => patchField(idx, { required: v })} label="Required" />
              </Field>
            </div>
            {(f.type === "select" || f.type === "multi-select") && (
              <Field label="Options" hint="Comma-separated list of allowed values">
                <ListInput value={f.options ?? []} onChange={(v) => patchField(idx, { options: v })} placeholder="low, medium, high" />
              </Field>
            )}
            <Field label="Hint" hint="Helper text shown under the input">
              <Input value={f.hint ?? ""} onChange={(v) => patchField(idx, { hint: v })} />
            </Field>
            {(f.type === "text" || f.type === "long-text" || f.type === "number") && (
              <div style={{ display: "grid", gridTemplateColumns: f.type === "number" ? "1fr 1fr" : "1fr 1fr 1fr", gap: 6 }}>
                <Field label="Min"><NumInput value={f.validate?.min} onChange={(v) => patchValidate(idx, { min: v })} /></Field>
                <Field label="Max"><NumInput value={f.validate?.max} onChange={(v) => patchValidate(idx, { max: v })} /></Field>
                {f.type !== "number" && (
                  <Field label="Pattern" hint="Regex — optional"><Input mono value={f.validate?.pattern ?? ""} onChange={(v) => patchValidate(idx, { pattern: v })} /></Field>
                )}
              </div>
            )}
          </div>
        ))}
        <button className="fld__btn" type="button" onClick={add} style={{ marginTop: 4 }}>+ Add field</button>
      </Section>
    </>
  )
}

function UserTaskForm({ node, patchData }: FormProps) {
  const cfg = node.config as { assignTo?: string; title?: string; description?: string; dueIn?: string; form?: FormSchema }
  const form = cfg.form ?? { title: "", fields: [], submitLabel: "Submit" }
  return (
    <>
      <Section title="Assignment">
        <Field label="Assignee" hint="actor:<id> or role:<id> — managed via `agentx actor` / `agentx role`">
          <Input mono value={String(cfg.assignTo ?? "")} onChange={(v) => patchData({ assignTo: v })} placeholder="role:reviewers" />
        </Field>
        <Field label="Title" hint="Shown in the inbox + notification">
          <Input value={String(cfg.title ?? "")} onChange={(v) => patchData({ title: v })} />
        </Field>
        <Field label="Description">
          <Area value={String(cfg.description ?? "")} onChange={(v) => patchData({ description: v })} rows={2} />
        </Field>
        <Field label="Due in" hint="ISO-8601 duration (PT2H, P1D) or number of minutes">
          <Input mono value={String(cfg.dueIn ?? "")} onChange={(v) => patchData({ dueIn: v })} placeholder="P2D" />
        </Field>
      </Section>
      <FormBuilder form={form} patch={(f) => patchData({ form: f })} />
    </>
  )
}

function TriggerFormForm({ node, patchData }: FormProps) {
  const cfg = node.config as { startableBy?: string; form?: FormSchema }
  const form = cfg.form ?? { title: "", fields: [], submitLabel: "Submit" }
  return (
    <>
      <Section title="Start conditions">
        <Field label="Startable by" hint="actor:<id> or role:<id> — who is allowed to initiate a new run">
          <Input mono value={String(cfg.startableBy ?? "")} onChange={(v) => patchData({ startableBy: v })} placeholder="role:public" />
        </Field>
      </Section>
      <FormBuilder form={form} patch={(f) => patchData({ form: f })} />
    </>
  )
}

function SubProcessForm({ node, patchData }: FormProps) {
  const cfg = node.config as { workflowId?: string; inputMap?: unknown; awaitCompletion?: boolean }
  return (
    <Section title="Sub-process">
      <Field label="Workflow id" hint="id of another workflow definition — it runs to completion, then parent resumes">
        <Input mono value={String(cfg.workflowId ?? "")} onChange={(v) => patchData({ workflowId: v })} placeholder="child-workflow-id" />
      </Field>
      <Field label="Input map (JSON)" hint={`Object mapping child-context keys to templated values; "*" for full inheritance`}>
        <Area mono rows={4} value={JSON.stringify(cfg.inputMap ?? {}, null, 2)} onChange={(v) => { try { patchData({ inputMap: JSON.parse(v) }) } catch { /* ignore */ } }} />
      </Field>
    </Section>
  )
}

function SignalEmitForm({ node, patchData }: FormProps) {
  const cfg = node.config as { name?: string; scope?: string; payload?: unknown }
  return (
    <Section title="Emit signal">
      <Field label="Name" hint="Signal identifier; other workflows' signal.wait nodes subscribe by this">
        <Input mono value={String(cfg.name ?? "")} onChange={(v) => patchData({ name: v })} placeholder="approved" />
      </Field>
      <Field label="Scope" hint="workflow = only same-workflow waiters; global = every waiter">
        <Select value={String(cfg.scope ?? "workflow")} onChange={(v) => patchData({ scope: v })} options={["workflow", "global"]} />
      </Field>
      <Field label="Payload (JSON)" hint="Templated object delivered with the signal">
        <Area mono rows={4} value={JSON.stringify(cfg.payload ?? {}, null, 2)} onChange={(v) => { try { patchData({ payload: JSON.parse(v) }) } catch { /* ignore */ } }} />
      </Field>
    </Section>
  )
}

function SignalWaitForm({ node, patchData }: FormProps) {
  const cfg = node.config as { name?: string; scope?: string; match?: unknown }
  return (
    <Section title="Wait for signal">
      <Field label="Name">
        <Input mono value={String(cfg.name ?? "")} onChange={(v) => patchData({ name: v })} placeholder="approved" />
      </Field>
      <Field label="Scope">
        <Select value={String(cfg.scope ?? "workflow")} onChange={(v) => patchData({ scope: v })} options={["workflow", "global"]} />
      </Field>
      <Field label="Match filter (JSON)" hint="Only resume when the emitted payload matches every key here">
        <Area mono rows={3} value={JSON.stringify(cfg.match ?? {}, null, 2)} onChange={(v) => { try { patchData({ match: JSON.parse(v) }) } catch { /* ignore */ } }} />
      </Field>
    </Section>
  )
}

function TimerBoundaryForm({ node, patchData }: FormProps) {
  const cfg = node.config as { after?: string }
  return (
    <Section title="Timer">
      <Field label="After" hint="ISO-8601 duration (PT30M, PT2H, P1D) or minutes as a number">
        <Input mono value={String(cfg.after ?? "")} onChange={(v) => patchData({ after: v })} placeholder="PT1H" />
      </Field>
    </Section>
  )
}

function GatewayParallelForm({ node, patchData }: FormProps) {
  const cfg = node.config as { mode?: string }
  return (
    <Section title="Parallel gateway">
      <Field label="Mode" hint="fanOut = send to all outgoing edges; join = wait for every incoming edge">
        <Select value={String(cfg.mode ?? "fanOut")} onChange={(v) => patchData({ mode: v })} options={["fanOut", "join"]} />
      </Field>
    </Section>
  )
}

function RuleForm({ node, patchData }: FormProps) {
  const cfg = node.config as {
    inputs?: string[]
    rules?: Array<{ when?: unknown[]; to?: string; output?: Record<string, unknown> }>
    default?: { to?: string; output?: Record<string, unknown> }
  }
  const inputs = Array.isArray(cfg.inputs) ? cfg.inputs.map(String) : []
  const rules = Array.isArray(cfg.rules) ? cfg.rules : []
  const patchInputs = (v: string[]) => patchData({ inputs: v, rules: rules.map((r) => ({ ...r, when: (Array.isArray(r.when) ? r.when.slice(0, v.length) : []).concat(Array(Math.max(0, v.length - (r.when?.length ?? 0))).fill("*")) })) })
  const patchRule = (idx: number, p: Partial<{ when: unknown[]; to: string; output: Record<string, unknown> }>) => {
    const next = [...rules]
    next[idx] = { ...next[idx], ...p }
    patchData({ rules: next })
  }
  const addRule = () => patchData({ rules: [...rules, { when: inputs.map(() => "*"), to: "port", output: {} }] })
  const removeRule = (idx: number) => patchData({ rules: rules.filter((_, i) => i !== idx) })
  return (
    <>
      <Section title="Inputs">
        <Field label="Input expressions" hint="Comma-separated; each is a template evaluated per-run against the run context">
          <ListInput mono value={inputs} onChange={patchInputs} placeholder="{{classify.result}}, {{trigger.values.amount}}" />
        </Field>
      </Section>
      <Section title={`Rules (${rules.length})`}>
        {rules.map((r, idx) => (
          <div key={idx} style={{ border: "1px solid var(--ax-border)", borderRadius: 6, padding: 8, marginBottom: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, alignItems: "end" }}>
              <Field label="Port (to)" hint="Outgoing edge port taken when this row matches">
                <Input mono value={String(r.to ?? "")} onChange={(v) => patchRule(idx, { to: v })} />
              </Field>
              <button className="fld__btn" type="button" onClick={() => removeRule(idx)}>✕</button>
            </div>
            <Field label="When (per-input cells)" hint={`One per input. "*" wildcard, "x" equals, ">10" numeric, "!=x", "/regex/"`}>
              <ListInput mono value={(Array.isArray(r.when) ? r.when : []).map(String)} onChange={(v) => patchRule(idx, { when: v })} placeholder="gold, >100" />
            </Field>
            <Field label="Output (JSON)">
              <Area mono rows={2} value={JSON.stringify(r.output ?? {}, null, 2)} onChange={(v) => { try { patchRule(idx, { output: JSON.parse(v) }) } catch { /* ignore */ } }} />
            </Field>
          </div>
        ))}
        <button className="fld__btn" type="button" onClick={addRule}>+ Add rule</button>
      </Section>
      <Section title="Default">
        <Field label="Port (to)">
          <Input mono value={String(cfg.default?.to ?? "fallback")} onChange={(v) => patchData({ default: { ...(cfg.default ?? {}), to: v } })} />
        </Field>
      </Section>
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Dispatch
// ═══════════════════════════════════════════════════════════════════════════

const FORM_FOR_TYPE: Record<string, (p: FormProps) => ReactNode> = {
  "trigger.channel":    (p) => <TriggerChannelForm {...p} />,
  "trigger.cron":       (p) => <TriggerCronForm {...p} />,
  "trigger.hook":       (p) => <TriggerHookForm {...p} />,
  "trigger.manual":     (p) => <TriggerManualForm {...p} />,
  "trigger.form":       (p) => <TriggerFormForm {...p} />,
  "agent":              (p) => <AgentForm {...p} />,
  "transform":          (p) => <TransformForm {...p} />,
  "branch":             (p) => <BranchForm {...p} />,
  "gateway.parallel":   (p) => <GatewayParallelForm {...p} />,
  "rule":               (p) => <RuleForm {...p} />,
  "checkpoint":         (p) => <CheckpointForm {...p} />,
  "userTask":           (p) => <UserTaskForm {...p} />,
  "subProcess":         (p) => <SubProcessForm {...p} />,
  "signal.emit":        (p) => <SignalEmitForm {...p} />,
  "signal.wait":        (p) => <SignalWaitForm {...p} />,
  "timer.boundary":     (p) => <TimerBoundaryForm {...p} />,
  "end":                (p) => <EndForm {...p} />,
  "action.send":        (p) => <ActionSendForm {...p} />,
  "action.createIssue": (p) => <ActionCreateIssueForm {...p} />,
  "action.setLabel":    (p) => <ActionSetLabelForm {...p} />,
  "action.readLabel":   (p) => <ActionReadLabelForm {...p} />,
  "action.react":       (p) => <ActionReactForm {...p} />,
  "action.editMessage": (p) => <ActionEditMessageForm {...p} />,
  "action.logTime":     (p) => <ActionLogTimeForm {...p} />,
  "action.callHTTP":    (p) => <ActionCallHTTPForm {...p} />,
  "action.run":         (p) => <ActionRunForm {...p} />,
}

// ═══════════════════════════════════════════════════════════════════════════
// Inspector component
// ═══════════════════════════════════════════════════════════════════════════

export interface InspectorProps {
  selection: Selection | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  patch: (patch: Partial<GraphNode> | Partial<GraphEdge>) => void
  patchData: (data: Record<string, unknown>) => void
  onDelete: (s: Selection) => void
  onDuplicate: (s: Selection) => void
  validation?: Array<{ message: string }>
  runState: RunState | null
  agents: AgentInfo[]
  meta: GraphModel["meta"]
  patchMeta: (patch: Partial<GraphModel["meta"]>) => void
  onDeleteWorkflow?: () => void
  isNew: boolean
}

export function Inspector(props: InspectorProps) {
  const { selection, nodes, edges, patch, patchData, onDelete, onDuplicate, validation, runState, agents, meta, patchMeta, onDeleteWorkflow, isNew } = props

  if (!selection) {
    return <WorkflowPane meta={meta} patchMeta={patchMeta} onDeleteWorkflow={onDeleteWorkflow} isNew={isNew} />
  }

  if (selection.kind === "edge") {
    const edge = edges.find((e) => (e as { id?: string }).id === selection.id)
    if (!edge) return null
    return <EdgePane edge={{ ...edge, id: (edge as { id?: string }).id ?? "" }} patch={patch as (p: Partial<GraphEdge>) => void} onDelete={() => onDelete(selection)} />
  }

  const node = nodes.find((n) => n.id === selection.id)
  if (!node) return null
  return (
    <NodePane
      node={node}
      nodes={nodes}
      edges={edges}
      patch={patch as (p: Partial<WorkflowNode>) => void}
      patchData={patchData}
      onDelete={() => onDelete(selection)}
      onDuplicate={() => onDuplicate(selection)}
      validation={validation}
      runOutput={runState?.outputs?.[node.id]}
      agents={agents}
    />
  )
}

function NodePane({ node, nodes, edges, patch, patchData, onDelete, onDuplicate, validation, runOutput, agents }: {
  node: WorkflowNode
  nodes: WorkflowNode[]
  edges: GraphEdge[]
  patch: (p: Partial<WorkflowNode>) => void
  patchData: (p: Record<string, unknown>) => void
  onDelete: () => void
  onDuplicate: () => void
  validation?: Array<{ message: string }>
  runOutput?: string
  agents: AgentInfo[]
}) {
  const [tab, setTab] = useState<"config" | "advanced" | "preview">("config")
  const Form = FORM_FOR_TYPE[node.type]

  return (
    <aside className="insp">
      <div className="insp__head">
        <div className="insp__top">
          <span className="insp__type-pill">{node.type}</span>
          <input className="insp__name" value={node.id}
                 onChange={(e) => patch({ id: e.target.value })} />
          <button className="btn btn--ghost-icon" title="Duplicate" onClick={onDuplicate}><Icon.dup /></button>
          <button className="btn btn--ghost-icon" title="Delete" onClick={onDelete}><Icon.trash /></button>
        </div>
        <div className="insp__tabs">
          <button className={"insp__tab" + (tab === "config" ? " is-active" : "")} onClick={() => setTab("config")}><Icon.gear /> Config</button>
          <button className={"insp__tab" + (tab === "advanced" ? " is-active" : "")} onClick={() => setTab("advanced")}><Icon.layout /> Advanced</button>
          <button className={"insp__tab" + (tab === "preview" ? " is-active" : "")} onClick={() => setTab("preview")}><Icon.eye /> Preview {runOutput && <span className="count">●</span>}</button>
        </div>
      </div>
      <div className="insp__body">
        {tab === "config" && (
          <>
            {Form
              ? Form({ node, nodes, patch, patchData, agents })
              : (
                <Section title="Config">
                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
                    No typed form yet for <span className="mono">{node.type}</span>. Use the Advanced tab to edit raw JSON.
                  </div>
                </Section>
              )}
            <ContextPanel node={node} nodes={nodes} edges={edges} />
          </>
        )}
        {tab === "advanced" && (
          <AdvancedJson node={node} patchData={patchData} />
        )}
        {tab === "preview" && (
          <Section title="Latest run output">
            {runOutput ? (
              <pre style={{ fontSize: 11, color: "var(--ink-2)", padding: 8, background: "var(--bg)", borderRadius: 4, border: "1px solid var(--line)" }}
                   dangerouslySetInnerHTML={{ __html: runOutput }} />
            ) : (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>No run data for this node yet.</div>
            )}
          </Section>
        )}

        {validation && validation.length > 0 && (
          <Section title="Issues" right={<span className="card__kind" style={{ color: "var(--err)" }}>{validation.length}</span>}>
            {validation.map((v, i) => (
              <div key={i} className="fld__err" style={{ padding: "6px 0" }}><Icon.warn /> {v.message}</div>
            ))}
          </Section>
        )}
      </div>
    </aside>
  )
}

// --- Context panel (template-path discoverability) ---
//
// For the selected node, walks the DAG backward via incoming edges and lists
// every upstream node with its declared output fields (from
// `src/workflows/nodes/schemas.ts`). Each field is a button that copies
// `{{<nodeId>.<path>}}` to the clipboard so authors can drop it into a Text
// or Chat-id input without guessing.
//
// Why "upstream"? Templates can only reference data that's been computed
// before this node runs. Showing siblings or downstream nodes would be
// misleading — their context entries don't exist when this node renders.
//
// The trigger is always treated as upstream of every other node, even when
// not directly connected (which is the common case for action.send templates
// like {{trigger.chatId}}).

function collectUpstream(nodeId: string, nodes: WorkflowNode[], edges: GraphEdge[]): WorkflowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const))
  const visited = new Set<string>()
  const order: WorkflowNode[] = []
  const visit = (id: string) => {
    if (visited.has(id)) return
    visited.add(id)
    for (const e of edges) {
      if (e.to === id) visit(e.from)
    }
    if (id !== nodeId) {
      const n = byId.get(id)
      if (n) order.push(n)
    }
  }
  visit(nodeId)

  // Always surface the trigger node even if not transitively connected, so a
  // detached `action.send` (still being wired up) can still see what the
  // trigger will provide.
  for (const n of nodes) {
    if (n.type.startsWith("trigger.") && !visited.has(n.id) && n.id !== nodeId) {
      order.push(n)
    }
  }
  return order
}

function ContextPanel({ node, nodes, edges }: { node: WorkflowNode; nodes: WorkflowNode[]; edges: GraphEdge[] }) {
  const upstream = useMemo(() => collectUpstream(node.id, nodes, edges), [node.id, nodes, edges])
  if (upstream.length === 0) {
    return (
      <Section title="Available inputs" defaultOpen={false}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          No upstream nodes yet — connect a trigger or upstream node to make its outputs available as <span className="mono">{`{{nodeId.path}}`}</span> templates here.
        </div>
      </Section>
    )
  }
  return (
    <Section
      title={`Available inputs (${upstream.length})`}
      defaultOpen={false}
      right={<span className="card__kind" style={{ color: "var(--muted)" }}>click to copy</span>}
    >
      <div style={{ display: "grid", gap: 10 }}>
        {upstream.map((u) => <UpstreamCard key={u.id} node={u} />)}
      </div>
    </Section>
  )
}

function UpstreamCard({ node }: { node: WorkflowNode }) {
  const schema = NODE_OUTPUTS[node.type as keyof typeof NODE_OUTPUTS]
  const fields: OutputField[] = schema ? outputFieldsFor(node.type as any, node.config) : []
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 8, background: "var(--bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-2)" }}>{node.id}</span>
        <span className="insp__type-pill" style={{ fontSize: 10 }}>{node.type}</span>
      </div>
      {schema?.summary && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>{schema.summary}</div>
      )}
      {fields.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--muted)" }}>No declared outputs.</div>
      ) : (
        <div style={{ display: "grid", gap: 2 }}>
          {fields.map((f) => <OutputFieldRow key={f.path} nodeId={node.id} field={f} />)}
        </div>
      )}
    </div>
  )
}

function OutputFieldRow({ nodeId, field }: { nodeId: string; field: OutputField }) {
  const [copied, setCopied] = useState(false)
  const expr = field.path ? `{{${nodeId}.${field.path}}}` : `{{${nodeId}}}`
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(expr)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 900)
    } catch {
      /* clipboard refused (browser perms) — best-effort */
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={field.description}
      style={{
        textAlign: "left",
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 6,
        padding: "4px 6px",
        background: copied ? "var(--ok-soft, rgba(0, 200, 100, 0.12))" : "transparent",
        border: "1px solid transparent",
        borderRadius: 4,
        cursor: "pointer",
        color: "var(--ink-1)",
        fontSize: 11,
        lineHeight: 1.35,
      }}
    >
      <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {expr}
      </span>
      <span style={{ color: copied ? "var(--ok, #2ea043)" : "var(--muted)", fontSize: 10 }}>
        {copied ? "copied" : field.type}
      </span>
    </button>
  )
}

function AdvancedJson({ node, patchData }: { node: WorkflowNode; patchData: (p: Record<string, unknown>) => void }) {
  const [text, setText] = useState(() => JSON.stringify(node.config, null, 2))
  const [err, setErr] = useState<string | null>(null)
  // Re-seed when a different node is selected.
  useMemo(() => { setText(JSON.stringify(node.config, null, 2)); setErr(null) }, [node.id])

  const apply = () => {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        patchData(parsed); setErr(null)
      } else setErr("config must be a JSON object")
    } catch (e: any) { setErr(e.message) }
  }

  return (
    <Section title="Raw config JSON">
      <Area mono rows={14} value={text} onChange={setText} />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn btn--ghost-icon" onClick={apply}><Icon.check /> Apply</button>
        <button className="btn btn--ghost-icon" onClick={() => setText(JSON.stringify(node.config, null, 2))}><Icon.undo /> Reset</button>
      </div>
      {err && <div className="fld__err" style={{ color: "var(--err)", fontSize: 11, marginTop: 4 }}><Icon.err /> {err}</div>}
    </Section>
  )
}

// WorkflowPane — shown when nothing is selected. Exposes workflow-level meta
// fields (id, title, description, priority, fanOut, envAllow, retention) so
// authors don't have to dig through Advanced JSON or close panels just to
// rename a flow. Mutations dispatch through patchMeta and ride the same
// undo + save pipeline as node/edge edits.
function WorkflowPane({ meta, patchMeta, onDeleteWorkflow, isNew }: {
  meta: GraphModel["meta"]
  patchMeta: (p: Partial<GraphModel["meta"]>) => void
  onDeleteWorkflow?: () => void
  isNew: boolean
}) {
  const retention = meta.retention ?? { maxRuns: 500, maxDays: 90 }
  return (
    <aside className="insp">
      <div className="insp__head">
        <div className="insp__top">
          <span className="insp__type-pill">workflow</span>
          <input className="insp__name" value={meta.title}
                 placeholder="Untitled workflow"
                 onChange={(e) => patchMeta({ title: e.target.value })} />
        </div>
      </div>
      <div className="insp__body">
        <Section title="Identity">
          <Field label="ID" hint={isNew ? "URL slug — set once on first save" : "URL slug — read-only after creation"}>
            <Input mono value={meta.id} onChange={(v) => isNew && patchMeta({ id: v })} />
          </Field>
          <Field label="Title">
            <Input value={meta.title} onChange={(v) => patchMeta({ title: v })} />
          </Field>
          <Field label="Description" hint="Optional one-liner shown on the workflows index">
            <Area rows={2} value={(meta as { description?: string }).description ?? ""}
                  onChange={(v) => patchMeta({ description: v } as Partial<GraphModel["meta"]>)} />
          </Field>
        </Section>
        <Section title="Execution">
          <Field label="Priority" hint="Higher numbers run before lower ones when multiple workflows match the same trigger">
            <NumInput value={meta.priority} onChange={(v) => patchMeta({ priority: v ?? 0 })} placeholder="0" />
          </Field>
          <Field label="">
            <Check checked={!!meta.fanOut}
                   onChange={(v) => patchMeta({ fanOut: v })}
                   label="Fan out — let multiple workflows match the same trigger event" />
          </Field>
          <Field label="Allowed env vars" hint="Comma-separated. Only these env names are exposed to actions/agents in this flow.">
            <ListInput mono value={meta.envAllow ?? []} onChange={(v) => patchMeta({ envAllow: v })} placeholder="GITLAB_TOKEN, SLACK_WEBHOOK" />
          </Field>
        </Section>
        <Section title="Retention" defaultOpen={false}>
          <Field label="Max runs to keep">
            <NumInput value={retention.maxRuns} onChange={(v) => patchMeta({ retention: { ...retention, maxRuns: v ?? 0 } })} placeholder="500" />
          </Field>
          <Field label="Max age (days)">
            <NumInput value={retention.maxDays} onChange={(v) => patchMeta({ retention: { ...retention, maxDays: v ?? 0 } })} placeholder="90" />
          </Field>
        </Section>
        <div style={{ fontSize: 11, color: "var(--muted)", padding: "4px 16px 14px", borderTop: "1px solid var(--line-soft)", marginTop: 4 }}>
          Tip: pick a node or edge on the canvas to edit its config. Each node's output becomes available as{" "}
          <span className="mono">{`{{nodeId.path}}`}</span> to downstream nodes.
        </div>
        {onDeleteWorkflow && !isNew && (
          <div className="insp__danger">
            <button className="btn btn--ghost-icon insp__delete-wf"
                    onClick={onDeleteWorkflow}
                    title="Delete this workflow permanently">
              <Icon.trash /> Delete workflow
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

function EdgePane({ edge, patch, onDelete }: { edge: GraphEdge & { id: string }; patch: (p: Partial<GraphEdge>) => void; onDelete: () => void }) {
  return (
    <aside className="insp">
      <div className="insp__head">
        <div className="insp__top">
          <span className="insp__type-pill">edge</span>
          <div className="insp__name" style={{ padding: 0, fontSize: 13, color: "var(--ink-2)" }}>
            <span className="mono">{edge.from}</span>{edge.fromPort ? <span className="mono"> :{edge.fromPort}</span> : null} → <span className="mono">{edge.to}</span>
          </div>
          <button className="btn btn--ghost-icon" onClick={onDelete}><Icon.trash /></button>
        </div>
      </div>
      <div className="insp__body">
        <Section title="Label">
          <Field label="Label" hint="Shown on the edge (cosmetic only)">
            <Input mono value={edge.label ?? ""} onChange={(v) => patch({ label: v })} />
          </Field>
        </Section>
        <Section title="Port" defaultOpen={false}>
          <Field label="fromPort" hint="Set when the source is a branch node. Must match a case's `to` field or the default port.">
            <Input mono value={edge.fromPort ?? ""} onChange={(v) => patch({ fromPort: v || undefined })} />
          </Field>
        </Section>
      </div>
    </aside>
  )
}
