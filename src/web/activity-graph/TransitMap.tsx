import { useEffect, useMemo, useState } from "react"
import {
  ReactFlow, Handle, Position, BaseEdge,
  type Node, type Edge, type NodeProps, type EdgeProps, type ReactFlowInstance,
} from "@xyflow/react"
import { metroPath, type NetEdge, type NetNode, type Network, type Orientation } from "./transit-layout"
import type { Train } from "./transit"

// Renders a laid-out Network with xyflow. Positions come from
// transit-layout.ts; this file only draws and forwards clicks.

type Ctx = { orientation: Orientation; focus: string | null; selected: string | null; onTrain: (t: Train) => void }
type NodeData = { n: NetNode; ctx: Ctx }
type EdgeData = { e: NetEdge; ctx: Ctx }

const STATE_ICON: Record<string, string> = { delayed: "!", running: "▶", held: "Ⅱ", review: "◔", delivered: "✓", done: "✓" }

function sides(o: Orientation) {
  return o === "horizontal" ? [Position.Left, Position.Right] as const : [Position.Top, Position.Bottom] as const
}

function dimmed(n: NetNode, ctx: Ctx): boolean {
  if (!ctx.focus) return false
  if (n.lineId) return n.lineId !== ctx.focus
  return false
}

function ChannelNode({ data }: NodeProps<Node<NodeData>>) {
  const { n, ctx } = data
  return (
    <div className={"tm-channel" + (n.idle ? " is-idle" : "")}>
      {n.label}
      <Handle type="source" position={sides(ctx.orientation)[1]} />
    </div>
  )
}

function StationNode({ data }: NodeProps<Node<NodeData>>) {
  const { n, ctx } = data
  const [tgt, src] = sides(ctx.orientation)
  const cls = ["tm-station", `is-${ctx.orientation}`]
  if (n.interchange) cls.push("is-interchange")
  if (n.idle) cls.push("is-idle")
  if (n.mesh) cls.push("is-mesh")
  return (
    <div className={cls.join(" ")}>
      <Handle type="target" position={tgt} />
      <span className="tm-station__dot">{n.code}</span>
      {n.running && <span className="tm-station__flag is-live" />}
      {!n.running && n.delayed && <span className="tm-station__flag is-warn" />}
      <span className="tm-station__card">
        <b>{n.label}</b>
        {n.sub && <small>{n.sub}</small>}
      </span>
      <Handle type="source" position={src} />
    </div>
  )
}

function TrainPill({ t, ctx }: { t: Train; ctx: Ctx }) {
  return (
    <button
      className={`tm-train is-${t.state}` + (ctx.selected === t.id ? " is-selected" : "")}
      onClick={(ev) => { ev.stopPropagation(); ctx.onTrain(t) }}
      title={t.title}
    >
      <i>{STATE_ICON[t.state]}</i>
      <b>{t.tag}</b>
      <span>{t.label}</span>
    </button>
  )
}

function GroupNode({ data }: NodeProps<Node<NodeData>>) {
  const { n, ctx } = data
  const [tgt, src] = sides(ctx.orientation)
  return (
    <div className={`tm-group is-${ctx.orientation}` + (dimmed(n, ctx) ? " is-dim" : "")} style={{ ["--lc" as string]: n.color }}>
      <Handle type="target" position={tgt} />
      <span className="tm-group__rail" />
      {n.trains!.map((t) => <TrainPill key={t.id} t={t} ctx={ctx} />)}
      {!!n.more && <span className="tm-train is-more">+{n.more} more</span>}
      <Handle type="source" position={src} />
    </div>
  )
}

function TerminalNode({ data }: NodeProps<Node<NodeData>>) {
  const { n, ctx } = data
  return (
    <div className={"tm-terminal" + (n.delayed ? " is-delayed" : "") + (dimmed(n, ctx) ? " is-dim" : "")} style={{ ["--lc" as string]: n.color }}>
      <Handle type="target" position={sides(ctx.orientation)[0]} />
      <span className="tm-code">{n.code}</span>
      <b>{n.label}</b>
    </div>
  )
}

function DistrictNode({ data }: NodeProps<Node<NodeData>>) {
  const { n } = data
  return (
    <div className="tm-district" style={{ width: n.w, height: n.h }}>
      <span><b>Mesh</b> {n.label} · {n.sub}</span>
    </div>
  )
}

const nodeTypes = { channel: ChannelNode, station: StationNode, trains: GroupNode, terminal: TerminalNode, district: DistrictNode }

function MetroEdge(props: EdgeProps<Edge<EdgeData>>) {
  const { e, ctx } = props.data!
  const d = metroPath(props.sourceX, props.sourceY, props.targetX, props.targetY, ctx.orientation, e.offset)
  const dim = ctx.focus && e.lineId && e.lineId !== ctx.focus
  const style = e.kind === "feeder"
    ? { stroke: "var(--tm-feeder)", strokeWidth: 3, strokeDasharray: "2 7", strokeLinecap: "round" as const }
    : { stroke: e.color, strokeWidth: 7, strokeLinejoin: "round" as const, strokeLinecap: "round" as const }
  return (
    <BaseEdge
      id={props.id} path={d}
      className={"tm-edge" + (e.active ? " is-active" : "") + (dim ? " is-dim" : "")}
      style={style}
    />
  )
}
const edgeTypes = { metro: MetroEdge }

export function TransitMap(props: {
  net: Network; orientation: Orientation; focus: string | null; selected: string | null
  onTrain: (t: Train) => void; onPane: () => void
  /** Phone: fit the width and scroll down rather than shrinking to fit. */
  fitWidth?: boolean
}) {
  const { net, orientation, focus, selected, onTrain, onPane, fitWidth } = props
  const [rf, setRf] = useState<ReactFlowInstance<any, any> | null>(null)
  const ctx: Ctx = useMemo(() => ({ orientation, focus, selected, onTrain }), [orientation, focus, selected, onTrain])

  const nodes: Node[] = useMemo(() => net.nodes.map((n) => ({
    id: n.id, type: n.kind, position: { x: n.x, y: n.y },
    width: n.w, height: n.h,
    data: { n, ctx }, draggable: false, selectable: false,
    zIndex: n.kind === "district" ? -1 : n.kind === "trains" ? 2 : 1,
  })), [net, ctx])
  const edges: Edge[] = useMemo(() => net.edges.map((e) => ({
    id: e.id, source: e.source, target: e.target, type: "metro", data: { e, ctx },
    zIndex: e.kind === "feeder" ? 0 : 1, selectable: false,
  })), [net, ctx])

  // Refit when the network changes shape or the drawer opens/closes (the
  // canvas width changes), not on every live tick or train click.
  const shape = net.nodes.map((n) => n.id).join(",") + `|${selected !== null}`
  useEffect(() => {
    if (!rf) return
    // Deferred so xyflow has measured and positioned the new nodes.
    const id = window.setTimeout(() => {
      if (!fitWidth) { rf.fitView({ padding: 0.06 }); return }
      const el = document.querySelector(".tm-canvas") as HTMLElement | null
      if (!el) return
      const b = rf.getNodesBounds(rf.getNodes())
      const zoom = Math.min(1, (el.clientWidth - 16) / Math.max(1, b.width + 24))
      rf.setViewport({ x: (el.clientWidth - b.width * zoom) / 2 - b.x * zoom, y: 16 - b.y * zoom, zoom })
    }, 60)
    return () => clearTimeout(id)
  }, [rf, shape, fitWidth])

  return (
    <div className="tm-canvas">
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onInit={setRf} fitView fitViewOptions={{ padding: 0.06 }}
        minZoom={0.25} maxZoom={2}
        nodesConnectable={false} nodesDraggable={false} elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        onPaneClick={onPane}
        panOnScroll={!fitWidth}
        // Phone: the page scrolls; a drag on the map must not hijack it.
        panOnDrag={!fitWidth} zoomOnScroll={!fitWidth} preventScrolling={!fitWidth}
      />
    </div>
  )
}
