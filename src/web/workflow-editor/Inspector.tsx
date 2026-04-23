import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Icon } from "./Icons"
import { EXPR_VARS, type AgentInfo } from "./data"
import type { WorkflowNode } from "./types"
import type { GraphEdge, GraphNode } from "./graph"
import type { Selection, RunState } from "./Canvas"

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

function Input({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return <input className={"fld__input" + (mono ? " mono" : "")} type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
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
}

// --- Triggers ---

const CHANNEL_SOURCES_WIRED = new Set(["whatsapp-message", "telegram-message", "gitlab-issue", "gitlab-pipeline"])

function TriggerChannelForm({ node, patchData }: FormProps) {
  const cfg = node.config as { source?: string; filter?: Record<string, unknown> }
  const filter = (cfg.filter ?? {}) as Record<string, unknown>
  const patchFilter = (p: Record<string, unknown>) => patchData({ filter: { ...filter, ...p } })
  const src = String(cfg.source ?? "whatsapp-message")
  const wired = CHANNEL_SOURCES_WIRED.has(src)

  return (
    <>
      <Section title="Source">
        <Field label="Channel event" hint={wired ? "✓ wired end-to-end" : "schema-only — no hook subscriber yet"}>
          <Select
            value={src}
            onChange={(v) => patchData({ source: v, filter: {} })}
            options={[
              { value: "whatsapp-message", label: "WhatsApp message ✓" },
              { value: "telegram-message", label: "Telegram message ✓" },
              { value: "gitlab-issue", label: "GitLab issue ✓" },
              { value: "gitlab-pipeline", label: "GitLab pipeline ✓" },
              { value: "github-issue", label: "GitHub issue (not wired)" },
              { value: "github-pr", label: "GitHub PR (not wired)" },
              { value: "discord-message", label: "Discord message" },
              { value: "slack-message", label: "Slack message" },
            ]}
          />
        </Field>
        {(src === "gitlab-issue" || src === "gitlab-pipeline") && (
          <Field label="Project" hint={`GitLab path (e.g. "noqta/web") or "*" for any`}>
            <Input mono value={String(filter.project ?? "")} onChange={(v) => patchFilter({ project: v })} placeholder="noqta/web" />
          </Field>
        )}
        {(src === "github-issue" || src === "github-pr") && (
          <Field label="Repo" hint={`"owner/repo" or "*" for any`}>
            <Input mono value={String(filter.repo ?? "")} onChange={(v) => patchFilter({ repo: v })} placeholder="owner/repo" />
          </Field>
        )}
        {(src === "whatsapp-message" || src === "telegram-message" || src === "discord-message" || src === "slack-message") && (
          <Field label="Chat" hint={`chat id or substring; "*" matches any`}>
            <Input mono value={String(filter.chat ?? "")} onChange={(v) => patchFilter({ chat: v })} placeholder="*" />
          </Field>
        )}
        <Field label="Label filter (any of)" hint="Fires only when at least one of these labels is present">
          <ListInput mono value={Array.isArray(filter.labels) ? (filter.labels as string[]) : []} onChange={(v) => patchFilter({ labels: v })} placeholder="bug, needs-review" />
        </Field>
      </Section>
    </>
  )
}

function TriggerCronForm({ node, patchData }: FormProps) {
  const cfg = node.config as { spec?: string; timezone?: string }
  return (
    <Section title="Schedule">
      <Field label="Cron spec" hint="Standard 5-field cron (minute hour day month weekday)">
        <Input mono value={String(cfg.spec ?? "0 * * * *")} onChange={(v) => patchData({ spec: v })} placeholder="0 9 * * *" />
      </Field>
      <Field label="Timezone" hint="IANA timezone string — defaults to UTC">
        <Input mono value={String(cfg.timezone ?? "UTC")} onChange={(v) => patchData({ timezone: v })} placeholder="Africa/Tunis" />
      </Field>
    </Section>
  )
}

function TriggerHookForm({ node, patchData }: FormProps) {
  const cfg = node.config as { event?: string }
  return (
    <Section title="Hook subscription">
      <Field label="Event" hint={`Any "on:*" hook event fired elsewhere in agentx`}>
        <Input mono value={String(cfg.event ?? "on:")} onChange={(v) => patchData({ event: v })} placeholder="on:gitlab-issue" />
      </Field>
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

function ActionSendForm({ node, patchData }: FormProps) {
  const cfg = node.config as { channel?: string; chatId?: string; text?: string; parseMode?: string }
  return (
    <Section title="Send message">
      <Field label="Channel">
        <Select value={String(cfg.channel ?? "whatsapp")} onChange={(v) => patchData({ channel: v })} options={CHANNEL_OPTIONS} />
      </Field>
      <Field label="Chat id" hint="Often {{trigger.chatId}} to reply to the original sender">
        <Input mono value={String(cfg.chatId ?? "")} onChange={(v) => patchData({ chatId: v })} placeholder="{{trigger.chatId}}" />
      </Field>
      <Field label="Text" hint="Supports {{nodeId.path}} templates">
        <ExprField value={String(cfg.text ?? "")} onChange={(v) => patchData({ text: v })} rows={4} placeholder="Thanks {{trigger.sender.name}} — working on it." />
      </Field>
      <Field label="Parse mode" hint="Platform-specific formatting hint">
        <Select
          value={String(cfg.parseMode ?? "plain")}
          onChange={(v) => patchData({ parseMode: v })}
          options={["plain", "markdown", "html"]}
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
// Dispatch
// ═══════════════════════════════════════════════════════════════════════════

const FORM_FOR_TYPE: Record<string, (p: FormProps) => ReactNode> = {
  "trigger.channel":    (p) => <TriggerChannelForm {...p} />,
  "trigger.cron":       (p) => <TriggerCronForm {...p} />,
  "trigger.hook":       (p) => <TriggerHookForm {...p} />,
  "trigger.manual":     (p) => <TriggerManualForm {...p} />,
  "agent":              (p) => <AgentForm {...p} />,
  "transform":          (p) => <TransformForm {...p} />,
  "branch":             (p) => <BranchForm {...p} />,
  "checkpoint":         (p) => <CheckpointForm {...p} />,
  "end":                (p) => <EndForm {...p} />,
  "action.send":        (p) => <ActionSendForm {...p} />,
  "action.createIssue": (p) => <ActionCreateIssueForm {...p} />,
  "action.setLabel":    (p) => <ActionSetLabelForm {...p} />,
  "action.readLabel":   (p) => <ActionReadLabelForm {...p} />,
  "action.react":       (p) => <ActionReactForm {...p} />,
  "action.editMessage": (p) => <ActionEditMessageForm {...p} />,
  "action.logTime":     (p) => <ActionLogTimeForm {...p} />,
  "action.callHTTP":    (p) => <ActionCallHTTPForm {...p} />,
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
}

export function Inspector(props: InspectorProps) {
  const { selection, nodes, edges, patch, patchData, onDelete, onDuplicate, validation, runState, agents } = props

  if (!selection) {
    return (
      <aside className="insp">
        <div className="insp__empty">
          <Icon.slide />
          <h3>Nothing selected</h3>
          <p>Pick a node or edge on the canvas, or drag one in from the palette.</p>
          <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 16 }}>
            V2 workflows are dataflow DAGs. Each node's output becomes available as{" "}
            <span className="mono">{`{{nodeId.path}}`}</span> to downstream nodes.
          </p>
        </div>
      </aside>
    )
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

function NodePane({ node, patch, patchData, onDelete, onDuplicate, validation, runOutput, agents }: {
  node: WorkflowNode
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
          Form
            ? Form({ node, patch, patchData, agents })
            : (
              <Section title="Config">
                <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
                  No typed form yet for <span className="mono">{node.type}</span>. Use the Advanced tab to edit raw JSON.
                </div>
              </Section>
            )
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
