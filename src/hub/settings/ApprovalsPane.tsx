// --- Settings › Approvals (#2101 ST2b) ---
//
// The mock's Approvals (settings-mock/full/approvals.html): where approval
// cards reach you and how long they wait, the daily digest, and how agents
// follow your requests and plans. Each change saves at once, as a patch of
// that one setting, to the old Settings' endpoints: POST approvals/settings
// and approvals/requests/settings. The values come from the GETs the old
// page read, /api/admin/approvals and /api/admin/approvals/requests.
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { apiGet } from "../api"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from "../ui"
import { ChipList, NumberField, TextField, WriteNote, useWrite } from "./fields"
import { Disclosure, ErrorLine, PaneHeader, SettingsGroup, SettingsRow, SkeletonRows } from "./parts"
import { paneDef } from "./panes"
import type { ApprovalSettings, Reach, RequestSettings } from "./work-data"

const PANE = "approvals"
const APV_KEY = ["settings", "approvals"] as const
const REQ_KEY = ["settings", "requests"] as const
const REACH: readonly [Reach, string][] = [["all", "Everything new"], ["urgent", "Expiring within a day"], ["off", "Nothing"]]
const TIMES = ["07:00", "08:00", "09:00", "12:00", "18:00"]
const positive = (n: number) => (n > 0 ? null : "More than 0.")
const whole = (n: number) => (Number.isInteger(n) && n >= 0 ? null : "A whole number, 0 or more.")

export default function ApprovalsPane() {
  const pane = paneDef(PANE)
  const apv = useQuery({ queryKey: APV_KEY, queryFn: () => apiGet<{ settings?: ApprovalSettings }>("/api/admin/approvals").then((r) => r.settings ?? null) })
  const req = useQuery({ queryKey: REQ_KEY, queryFn: () => apiGet<{ settings?: RequestSettings }>("/api/admin/approvals/requests").then((r) => r.settings ?? null) })
  return (
    <>
      <PaneHeader pane={pane} />
      <div className="flex flex-col gap-8">
        <Loaded q={apv} what="the approval settings">{(s) => <ApprovalGroups s={s} />}</Loaded>
        <Loaded q={req} what="the request settings">{(s) => <RequestGroups s={s} />}</Loaded>
      </div>
    </>
  )
}

/** The groups once their settings are read; a skeleton or Retry before. */
function Loaded<T>({ q, what, children }: { q: { data?: T | null; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown }; what: string; children: (s: T) => ReactNode }) {
  if (q.isPending) return <SkeletonRows />
  if (q.isError || !q.data) return <ErrorLine text={`Could not read ${what}${q.error ? ": " + (q.error as Error).message : ""}.`} onRetry={() => q.refetch()} />
  return <>{children(q.data)}</>
}

function ReachSelect({ value, label, disabled, onChange }: { value: Reach; label: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger className="w-[200px]" aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>{REACH.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
    </Select>
  )
}

function ApprovalGroups({ s }: { s: ApprovalSettings }) {
  const a = useWrite(APV_KEY), d = useWrite(APV_KEY)
  const save = (w: typeof a, patch: Record<string, unknown>) => w.write("POST", "approvals/settings", patch, "Saved")
  const dest = s.digest.destination ? `${s.digest.destination.channel}:${s.digest.destination.chatId}` : ""
  const times = TIMES.includes(s.digest.time) ? TIMES : [...TIMES, s.digest.time].sort()
  return (
    <>
      <SettingsGroup pane={PANE} title="New approvals" help="When an agent asks you to approve something.">
        <SettingsRow pane={PANE} row="ap-phone" control={<ReachSelect value={s.desk.phone} label="Send to your phone at once" disabled={a.busy} onChange={(v) => save(a, { deskPhone: v })} />} />
        <SettingsRow pane={PANE} row="ap-computer" control={<ReachSelect value={s.desk.computer} label="Show on this computer at once" disabled={a.busy} onChange={(v) => save(a, { deskComputer: v })} />} />
        <SettingsRow pane={PANE} row="ap-expiry" control={<NumberField value={s.defaultExpiryDays} unit="days" label="Cards expire after" check={positive} disabled={a.busy} onCommit={(v) => save(a, { defaultExpiryDays: v })} />} />
        <SettingsRow pane={PANE} row="ap-notify" control={<Switch checked={s.notifyAgent} disabled={a.busy} onCheckedChange={(v) => save(a, { notifyAgent: v })} aria-label="Tell the agent the result" />} />
        <Disclosure id="apv-adv" label="Advanced">
          <SettingsRow pane={PANE} row="ap-max" control={<NumberField value={s.maxExpiryDays} unit="days" label="Longest a card may wait" check={positive} disabled={a.busy} onCommit={(v) => save(a, { maxExpiryDays: v })} />} />
          <SettingsRow pane={PANE} row="ap-later" control={<NumberField value={s.laterHours} unit="hours" label="Later hides a card for" check={positive} disabled={a.busy} onCommit={(v) => save(a, { laterHours: v })} />} />
        </Disclosure>
        <WriteNote note={a.note} />
      </SettingsGroup>
      <SettingsGroup pane={PANE} title="Daily digest" help="One message with everything still waiting.">
        <SettingsRow pane={PANE} row="ap-digest" help="" control={<Switch checked={s.digest.enabled} disabled={d.busy} onCheckedChange={(v) => save(d, { digestEnabled: v })} aria-label="Send one digest a day" />} />
        <SettingsRow pane={PANE} row="ap-time" control={
          <Select value={s.digest.time} disabled={d.busy || !s.digest.enabled} onValueChange={(v) => save(d, { digestTime: v })}>
            <SelectTrigger className="w-[96px] font-mono" aria-label="Digest time"><SelectValue /></SelectTrigger>
            <SelectContent>{times.map((t) => <SelectItem key={t} value={t} className="font-mono">{t}</SelectItem>)}</SelectContent>
          </Select>
        } />
        <Disclosure id="dg-adv" label="Advanced">
          <SettingsRow pane={PANE} row="ap-dest" control={<TextField value={dest} label="Digest goes to" placeholder="telegram:123456789" mono disabled={d.busy} onCommit={(v) => save(d, { destination: v })} />} />
        </Disclosure>
        <WriteNote note={d.note} />
      </SettingsGroup>
    </>
  )
}

function RequestGroups({ s }: { s: RequestSettings }) {
  const r = useWrite(REQ_KEY), p = useWrite(REQ_KEY), l = useWrite(REQ_KEY)
  const save = (w: typeof r, patch: Record<string, unknown>) => w.write("POST", "approvals/requests/settings", patch, "Saved")
  const csv = (xs: string[]) => xs.join(",")
  const plans = s.plans ?? {}, checks = s.checkers ?? {}
  return (
    <>
      <SettingsGroup pane={PANE} title="Requests" help="What you ask an agent for is recorded and followed until it is done.">
        <SettingsRow pane={PANE} row="rq-on" help="" control={<Switch checked={s.enabled} disabled={r.busy} onCheckedChange={(v) => save(r, { enabled: v })} aria-label="Record and follow my requests" />} />
        <SettingsRow pane={PANE} row="rq-stale" control={<NumberField value={s.staleAfterHours} unit="hours" label="Comes back after" check={positive} disabled={r.busy} onCommit={(v) => save(r, { staleAfterHours: v })} />} />
        <Disclosure id="rq-adv" label="Advanced">
          <SettingsRow pane={PANE} row="rq-from" layout="stack" control={<ChipList values={s.from ?? []} label="Counts as me on shared channels" addLabel="Add" disabled={r.busy} onChange={(v) => save(r, { from: csv(v) })} />} />
          <SettingsRow pane={PANE} row="rq-channels" layout="stack" control={<ChipList values={s.channels ?? []} label="Channels to record on" disabled={r.busy} onChange={(v) => save(r, { channels: csv(v) })} />} />
          <SettingsRow pane={PANE} row="rq-keep" control={<NumberField value={s.retentionDays} unit="days" label="Keep closed requests for" check={positive} disabled={r.busy} onCommit={(v) => save(r, { retentionDays: v })} />} />
          <SettingsRow pane={PANE} row="rq-head" control={<Switch checked={s.headlines?.enabled !== false} disabled={r.busy} onCheckedChange={(v) => save(r, { headlines: v })} aria-label="Write a headline when the agent gave none" />} />
        </Disclosure>
        <WriteNote note={r.note} />
      </SettingsGroup>
      <SettingsGroup pane={PANE} title="Plans" help="A request of two or more steps is followed step by step.">
        <SettingsRow pane={PANE} row="pl-on" help="" control={<Switch checked={plans.enabled !== false} disabled={p.busy} onCheckedChange={(v) => save(p, { plansEnabled: v })} aria-label="Follow requests as plans" />} />
        <SettingsRow pane={PANE} row="pl-stall" control={<NumberField value={plans.stallMinutes ?? 30} unit="minutes" label="Nudge a stalled step after" check={positive} disabled={p.busy} onCommit={(v) => save(p, { stallMinutes: v })} />} />
        <Disclosure id="pl-adv" label="Advanced">
          <SettingsRow pane={PANE} row="pl-nudges" control={<NumberField value={plans.maxNudges ?? 3} label="Nudges before it is blocked" check={whole} disabled={p.busy} onCommit={(v) => save(p, { maxNudges: v })} />} />
          <SettingsRow pane={PANE} row="pl-over" control={<NumberField value={plans.requireOverMinutes ?? 30} unit="minutes" label="Plan work estimated over" check={(n) => (n >= 0 ? null : "0 or more.")} disabled={p.busy} onCommit={(v) => save(p, { planOverMinutes: v })} />} />
          <SettingsRow pane={PANE} row="pl-approve" layout="stack" control={<ChipList values={plans.approveKinds ?? []} label="Step kinds you approve once" disabled={p.busy} onChange={(v) => save(p, { approveKinds: csv(v) })} />} />
          <SettingsRow pane={PANE} row="pl-work" layout="stack" control={<ChipList values={plans.requireForWork ?? []} label="Work that must be planned first" disabled={p.busy} onChange={(v) => save(p, { planForWork: csv(v) })} />} />
          <SettingsRow pane={PANE} row="pl-off" layout="stack" control={<ChipList values={plans.disabledAgents ?? []} label="Agents that may not open a plan" addLabel="Add agent" disabled={p.busy} onChange={(v) => save(p, { plansOffFor: csv(v) })} />} />
        </Disclosure>
        <WriteNote note={p.note} />
      </SettingsGroup>
      <SettingsGroup pane={PANE} title="Loop checks" help="How agents prove a request is done.">
        <Disclosure id="lc-adv" label="Advanced">
          <SettingsRow pane={PANE} row="lc-checks" layout="stack" control={<ChipList values={checks.enabled ?? []} label="Checks agents may use to close a loop" disabled={l.busy} onChange={(v) => save(l, { checkKinds: csv(v) })} />} />
          <SettingsRow pane={PANE} row="lc-every" control={<NumberField value={checks.checkEveryMinutes ?? 10} unit="minutes" label="Run each check every" check={positive} disabled={l.busy} onCommit={(v) => save(l, { checkEveryMinutes: v })} />} />
        </Disclosure>
        <WriteNote note={l.note} />
      </SettingsGroup>
    </>
  )
}
