import { useState } from "react"
import { fmtRelative, fmtTime, type FleetDispatch } from "./api"
import { channelLabel, routeOf, type Line, type Train } from "./transit"
import { COLLAPSE_AT } from "./transit-layout"
import { nodeLabel, Shell, type CardCtx } from "./MapCards"

// The train card: status, route, the ordered hop timeline (#267), the
// issues/MRs it carries, and the one next action.

export const TRAIN_STATUS: Record<Train["state"], string> = {
  delayed: "Delays", running: "Running", held: "Held", review: "In review", delivered: "Delivered", done: "Done",
}

/** Every hop in order; long chains show the ends and a "+n" for the middle. */
function HopTimeline({ t, ctx }: { t: Train; ctx: CardCtx }) {
  const [open, setOpen] = useState(false)
  const hops = t.hops
  const fold = !open && hops.length >= COLLAPSE_AT
  const shown = fold ? [hops[0], null, ...hops.slice(-2)] : hops
  return (
    <ol className="tm-timeline">
      {shown.map((h, i) => h === null ? (
        <li key="more" className="tm-timeline__more">
          <button className="tm-link" onClick={() => setOpen(true)} aria-label={`Show ${hops.length - 3} more hops`}>+{hops.length - 3} hops</button>
        </li>
      ) : (
        <li key={`${h.dispatchId ?? "root"}|${i}`} className={h.kind === "return" ? "is-return" : ""}>
          <button onClick={() => ctx.onSelect({ kind: "hop", from: h.from, to: h.to, dispatchId: h.dispatchId, lineId: t.lineId })}>
            <span className="mono">{fmtTime(h.at)}</span>
            <b>
              {h.kind === "return" ? "↩ " : ""}
              {h.from ? ctx.agentName(h.from) : channelLabel(t.channel)} → {ctx.agentName(h.to)}
            </b>
            {h.node && <small>{nodeLabel(ctx.snap, h.node)}</small>}
          </button>
        </li>
      ))}
    </ol>
  )
}

export function TrainPanel(props: {
  train: Train; line: Line | undefined; ctx: CardCtx; sheet?: boolean; onClose: () => void
}) {
  const { train: t, line, ctx, sheet, onClose } = props
  const { snap, byId, agentName, onOpenItem } = ctx
  const others = (line?.trains ?? []).filter((x) => x.id !== t.id).slice(0, 4)
  const gitlab = snap.forges?.gitlab?.replace(/\/+$/, "")
  const project = t.items.find((i) => i.url)?.url?.match(/^https?:\/\/[^/]+\/(.+?)\/-\//)?.[1]
  const latest = byId.get(t.dispatchIds[t.dispatchIds.length - 1])
  let cta: { label: string; href?: string; run?: FleetDispatch } | null = null
  if (t.failedPipelines.length === 1) cta = { label: "Open failed pipeline", href: t.failedPipelines[0] }
  else if (t.failedPipelines.length > 1) cta = {
    label: `Open ${t.failedPipelines.length} failed pipelines`,
    href: gitlab && project ? `${gitlab}/${project}/-/pipelines?scope=all&status=failed` : t.failedPipelines[0],
  }
  else if (t.link) cta = { label: t.items[0].ref?.startsWith("#") ? "Open issue" : "Open MR", href: t.link }
  else if (latest) cta = { label: "Open run details", run: latest }

  return (
    <Shell kick={`Train · ${line?.name ?? t.lineId}`} title={t.title} sheet={sheet} onClose={onClose}
      badge={<span className={`tm-badge is-${t.state}`}>{TRAIN_STATUS[t.state]}</span>}>
      <div className="tm-route">
        {routeOf(t, line, agentName).map((r, i, all) => (
          <span key={i} className="tm-route__stop">
            {i > 0 && <i>›</i>}
            <span className={"tm-chip" + (i === all.length - 1 ? " is-line" : "")} style={i === all.length - 1 ? { ["--lc" as string]: line?.color } : undefined}>{r}</span>
          </span>
        ))}
      </div>
      <div className="tm-panel__who">Started by {t.startedBy} · {fmtTime(t.startedAt)} · last activity {fmtRelative(t.lastAt)}</div>
      {t.reason && (
        <div className={`tm-reason is-${t.state}`}>
          <b>{t.state === "held" ? "Held" : t.failedPipelines.length ? "Builds failing" : "Stopped"}</b>
          <span>{t.reason}</span>
        </div>
      )}
      {t.hops.length > 1 && (
        <>
          <div className="tm-panel__sec">Hops</div>
          <HopTimeline t={t} ctx={ctx} />
        </>
      )}
      <div className="tm-items">
        {t.items.map((it) => {
          const d = byId.get(it.dispatchId)
          return (
            <div key={it.key} className="tm-item" role="button" tabIndex={0} onClick={() => d && onOpenItem(d)}
              onKeyDown={(e) => { if (d && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpenItem(d) } }}>
              {it.ref && <b className="mono">{it.ref}</b>}
              <span className="tm-item__t">{it.title}</span>
              <span className={`tm-pill is-${it.status.tone}`}>{it.status.label}</span>
              {it.url
                ? <a href={it.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{it.ref?.startsWith("#") ? "Issue" : "MR"} ›</a>
                : <span className="tm-item__go">Run ›</span>}
            </div>
          )
        })}
      </div>
      {others.length > 0 && (
        <>
          <div className="tm-panel__sec">Also on this line</div>
          <div className="tm-also">
            {others.map((o) => (
              <button key={o.id} onClick={() => ctx.onSelect({ kind: "train", id: o.id })}>
                <span className={`tm-badge is-${o.state} is-sm`}>{TRAIN_STATUS[o.state]}</span>
                <b className="mono">{o.tag}</b> <span>{o.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div style={{ flex: 1 }} />
      {cta && (cta.href
        ? <a className="tm-cta" href={cta.href} target="_blank" rel="noreferrer">{cta.label}</a>
        : <button className="tm-cta" onClick={() => cta!.run && onOpenItem(cta!.run)}>{cta.label}</button>)}
    </Shell>
  )
}
