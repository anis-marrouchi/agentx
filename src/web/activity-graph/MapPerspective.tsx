import { useEffect, useMemo, useRef, useState } from "react"
import {
  ReactFlow, Background, Controls, Handle, Position, MarkerType,
  type Node, type Edge, type NodeProps, type ReactFlowInstance,
} from "@xyflow/react"
import { fmtDur, fmtRelative, type FleetDispatch, type FleetSnapshot } from "./api"
import { buildMapGraph, delegatorOf, itemsFor, linkFor, mapChannelId, type MapEdge, type MapNode, type Orientation } from "./map-graph"

// Map perspective — one picture of where work comes from, who does it and
// what it is about. Layout comes from map-graph.ts; this file only renders.

const ICONS: Record<string, string> = {
  "ch:whatsapp": "✆", "ch:telegram": "✈", "ch:voice": "🎙", "ch:desktop": "🖥",
  "ch:api": "⌁", "ch:gitlab": "◆", "ch:github": "●", "ch:cron": "⏱", "ch:mesh": "⇄",
}

type FleetNodeData = { n: MapNode; orientation: Orientation; pulse: boolean }
type ClusterData = { label: string; w: number; h: number }

function FleetNode({ data }: NodeProps<Node<FleetNodeData>>) {
  const { n, orientation, pulse } = data
  const [tgt, src] = orientation === "horizontal" ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom]
  const icon = ICONS[n.id] ?? (n.kind === "agent" ? n.label.slice(0, 2).toUpperCase() : n.kind === "project" ? "▣" : "•")
  const cls = ["map-node", `map-node--${n.kind}`, `is-${orientation}`]
  if (n.mesh) cls.push("is-mesh")
  if (n.active) cls.push("is-active")
  if (pulse) cls.push("is-pulse")
  if (!n.count && n.kind !== "agent") cls.push("is-idle")
  return (
    <div className={cls.join(" ")} style={{ ["--c" as string]: n.color }}>
      {n.kind !== "channel" && <Handle type="target" position={tgt} />}
      <span className="map-node__ic">{icon}</span>
      <span className="map-node__txt">
        <span className="map-node__lbl">{n.label}</span>
        {n.sub && <span className="map-node__sub">{n.sub}</span>}
      </span>
      <span className="map-node__ct">{n.active ? <b>{n.active}●</b> : null}{n.count || ""}</span>
      {n.kind !== "project" && <Handle type="source" position={src} />}
    </div>
  )
}

function ClusterNode({ data }: NodeProps<Node<ClusterData>>) {
  return <div className="map-cluster" style={{ width: data.w, height: data.h }}><span>{data.label}</span></div>
}

const nodeTypes = { fleet: FleetNode, cluster: ClusterNode }

function edgeWidth(count: number): number {
  return Math.min(9, 1.25 + Math.log2(count + 1) * 1.6)
}

/** Nodes touched by dispatches that became active since the last snapshot. */
function usePulse(dispatches: FleetDispatch[]): Set<string> {
  const seen = useRef<Set<string> | null>(null)
  const [pulse, setPulse] = useState<Set<string>>(new Set())
  useEffect(() => {
    const active = dispatches.filter((d) => d.active)
    const prev = seen.current
    seen.current = new Set(active.map((d) => d.id))
    if (!prev) return
    const fresh = active.filter((d) => !prev.has(d.id))
    if (!fresh.length) return
    const ids = new Set<string>()
    for (const d of fresh) {
      const from = delegatorOf(d)
      ids.add(`ag:${d.agentId}`)
      ids.add(from ? `ag:${from}` : `ch:${mapChannelId(d.channelId)}`)
    }
    setPulse(ids)
    const t = setTimeout(() => setPulse(new Set()), 2600)
    return () => clearTimeout(t)
  }, [dispatches])
  return pulse
}

function useOrientation(ref: React.RefObject<HTMLDivElement | null>): Orientation {
  const [o, setO] = useState<Orientation>(() => (window.innerWidth < 640 ? "vertical" : "horizontal"))
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(([e]) => setO(e.contentRect.width < 640 ? "vertical" : "horizontal"))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return o
}

export function MapPerspective(props: {
  snap: FleetSnapshot; dispatches: FleetDispatch[]
  onOpenItem: (d: FleetDispatch) => void
}) {
  const { snap, dispatches, onOpenItem } = props
  const wrap = useRef<HTMLDivElement>(null)
  const orientation = useOrientation(wrap)
  const [showIdle, setShowIdle] = useState(false)
  const [sel, setSel] = useState<{ nodeId?: string; edge?: MapEdge; title: string } | null>(null)
  const [rf, setRf] = useState<ReactFlowInstance<any, any> | null>(null)
  const pulse = usePulse(dispatches)

  const graph = useMemo(() => buildMapGraph(snap, dispatches, { showIdle, orientation }), [snap, dispatches, showIdle, orientation])

  const nodes: Node[] = useMemo(() => [
    ...graph.clusters.map((c) => ({
      id: c.id, type: "cluster", position: { x: c.x, y: c.y }, data: { label: c.label, w: c.w, h: c.h },
      selectable: false, draggable: false, zIndex: -1,
    })),
    ...graph.nodes.map((n) => ({
      id: n.id, type: "fleet", position: { x: n.x, y: n.y },
      data: { n, orientation, pulse: pulse.has(n.id) }, draggable: false,
    })),
  ], [graph, orientation, pulse])

  const edges: Edge[] = useMemo(() => graph.edges.map((e) => {
    const color = e.kind === "delegation" ? "var(--ax-warn)" : e.active ? "var(--ax-success)" : "var(--ax-muted)"
    return {
      id: e.id, source: e.source, target: e.target,
      animated: e.active,
      label: e.count > 1 ? String(e.count) : undefined,
      className: `map-edge map-edge--${e.kind}`,
      style: { stroke: color, strokeWidth: edgeWidth(e.count), opacity: e.active || e.kind === "delegation" ? 0.95 : 0.55 },
      markerEnd: e.kind === "delegation" ? { type: MarkerType.ArrowClosed, color: "#d29922" } : undefined,
    }
  }), [graph])

  // Refit when the shape changes (window, toggle, rotation), not on every tick.
  const shapeKey = `${orientation}|${showIdle}|${graph.nodes.map((n) => n.id).join(",")}`
  // Deferred a frame so xyflow has measured the nodes it is fitting. On a
  // phone the tiers stack tall, so fit the width and pan vertically instead
  // of shrinking everything into one unreadable screen.
  useEffect(() => {
    if (!rf) return
    const id = requestAnimationFrame(() => {
      const el = wrap.current?.querySelector(".react-flow") as HTMLElement | null
      if (orientation === "horizontal" || !el) { rf.fitView({ padding: 0.12, duration: 250 }); return }
      const b = rf.getNodesBounds(rf.getNodes())
      const zoom = Math.min(1.2, (el.clientWidth - 16) / b.width)
      rf.setViewport({ x: (el.clientWidth - b.width * zoom) / 2 - b.x * zoom, y: 12 - b.y * zoom, zoom }, { duration: 250 })
    })
    return () => cancelAnimationFrame(id)
  }, [rf, shapeKey, orientation])

  const items = sel ? itemsFor(sel, dispatches) : []
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))

  return (
    <div className="map-wrap" ref={wrap}>
      <div className="map-tools">
        <button className={"facet " + (showIdle ? "is-on" : "")} onClick={() => setShowIdle(!showIdle)}>◌ show idle</button>
        <span className="map-legend">
          <i className="lg lg--dispatch" /> dispatch <i className="lg lg--deleg" /> delegation <i className="lg lg--active" /> active now
        </span>
      </div>
      {graph.nodes.length === 0
        ? <div className="empty">No dispatches in this window. Toggle “show idle” to see the fleet.</div>
        : (
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onInit={setRf}
            fitView fitViewOptions={{ padding: 0.12 }}
            minZoom={0.2} maxZoom={2.5}
            nodesConnectable={false} nodesDraggable={false} elementsSelectable
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => {
              const m = nodeById.get(n.id)
              if (m) setSel({ nodeId: m.id, title: m.label })
            }}
            onEdgeClick={(_, e) => {
              const m = graph.edges.find((x) => x.id === e.id)
              if (m) setSel({ edge: m, title: `${nodeById.get(m.source)?.label ?? m.source} → ${nodeById.get(m.target)?.label ?? m.target}` })
            }}
            onPaneClick={() => setSel(null)}
          >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      {sel && (
        <div className="map-panel">
          <div className="map-panel__hd">
            <span className="map-panel__title">{sel.title}</span>
            <span className="map-panel__ct">{items.length} latest</span>
            <button className="x" onClick={() => setSel(null)}>✕</button>
          </div>
          <div className="map-panel__body">
            {items.map((d) => {
              const link = linkFor(d, snap.forges)
              const init = snap.initiators.find((i) => i.id === d.initiatorId)
              return (
                <div key={d.id} className="map-item" onClick={() => onOpenItem(d)}>
                  <div className="map-item__subj">{d.subject}</div>
                  {d.inputPreview && <div className="map-item__prev">{d.inputPreview}</div>}
                  <div className="map-item__meta">
                    {d.active ? <span className="chip chip--active">live</span>
                      : d.outcome === "error" ? <span className="chip chip--error">err</span>
                      : <span className="chip chip--done">done</span>}
                    <span>{init?.name || d.initiatorId} → {d.agentId}</span>
                    <span className="mono">{fmtRelative(d.startedAt)} · {fmtDur(d.duration)}</span>
                    {link && <a href={link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>open ↗</a>}
                  </div>
                </div>
              )
            })}
            {!items.length && <div className="empty">Nothing in this window.</div>}
          </div>
        </div>
      )}
    </div>
  )
}
