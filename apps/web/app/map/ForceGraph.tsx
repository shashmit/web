"use client";

// The interactive knowledge-graph canvas. Force-directed (d3), Marginalia-styled:
// cards are the verified marigold anchors, concepts the tentative taupe vocabulary
// (dashed when low-confidence), AI similarity links are thin teal dashes vs solid
// pencil-line typed relations. Loaded via next/dynamic({ssr:false}) — force-graph
// touches `window` at import, so it must never run on the server.
import ForceGraph2D, {
  type ForceGraphMethods,
  type NodeObject,
  type LinkObject,
} from "react-force-graph-2d";
import { useEffect, useMemo, useRef, useState } from "react";
import { forceCollide } from "d3-force";
import type { Graph, GraphNode, GraphEdge } from "@/lib/api-types";
import { useGraphTheme, rgba, nodeRadius, truncate } from "./graph-theme";

type LinkExtra = { kind: GraphEdge["kind"]; label: string | null; weight: number };
type GNode = NodeObject<GraphNode>;
type GLink = LinkObject<GraphNode, LinkExtra>;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export default function ForceGraph({
  graph,
  onNavigate,
  onSelect,
  selectedId,
  topInset = 0,
}: {
  graph: Graph;
  // card -> (noteId, cardId) so the caller can deep-link to that exact question.
  onNavigate?: (noteId: string, cardId?: string) => void;
  // concept clicked -> open the inspector panel for it (null = background click,
  // deselect). When omitted (e.g. the note MiniMap), concept clicks zoom instead.
  onSelect?: (node: GraphNode | null) => void;
  // id of the currently-inspected node, drawn with a focus ring for feedback.
  selectedId?: string | null;
  // px reserved at the top for an overlay (the Map page's title band) so the fit
  // never parks nodes underneath it.
  topInset?: number;
}) {
  const theme = useGraphTheme();
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<GraphNode, LinkExtra> | undefined>(undefined);
  const fitted = useRef(false);
  const fitFn = useRef<() => void>(() => {});
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Fit the graph into the area BELOW the overlay (reserve `topInset` at the top)
  // and bias the camera down so no node hides behind the title band. Manual fit
  // (vs zoomToFit, which only centers in the full canvas with a symmetric margin).
  fitFn.current = () => {
    const fg = fgRef.current;
    const el = wrapRef.current;
    if (!fg || !el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const bb = fg.getGraphBbox();
    if (!bb || !bb.x || w === 0 || h === 0) return;
    const pad = 40;
    const availW = Math.max(1, w - 2 * pad);
    const availH = Math.max(1, h - topInset - 2 * pad);
    const bw = Math.max(1e-6, bb.x[1] - bb.x[0]);
    const bh = Math.max(1e-6, bb.y[1] - bb.y[0]);
    const k = Math.max(0.4, Math.min(6, availW / bw, availH / bh));
    const cx = (bb.x[0] + bb.x[1]) / 2;
    const cy = (bb.y[0] + bb.y[1]) / 2;
    fg.zoom(k, 450);
    fg.centerAt(cx, cy - topInset / 2 / k, 450); // shift content down, clear of the overlay
  };

  // Fill the parent: measure both dimensions (the canvas needs explicit pixels)
  // and re-fit on container resize (sidebar collapse/expand, window resize) so the
  // graph never ends up off-center — debounced, and only after the first fit.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout>;
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      clearTimeout(t);
      t = setTimeout(() => {
        if (fitted.current) fitFn.current();
      }, 220);
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, []);

  // Clone into the {nodes, links} shape the engine mutates (adds x/y, swaps
  // source/target for node refs). Fresh objects per fetch so a reload re-seeds.
  const data = useMemo(
    () => ({
      nodes: graph.nodes.map((n) => ({ ...n })),
      links: graph.edges.map((e) => ({
        source: e.source,
        target: e.target,
        kind: e.kind,
        label: e.label,
        weight: e.weight,
      })),
    }),
    [graph]
  );

  // Re-fit once per new graph, but never again automatically — re-fitting on every
  // engine stop would yank the camera each time a drag re-heats the simulation.
  useEffect(() => {
    fitted.current = false;
  }, [data]);

  // The canvas mounts only once theme + size are known; gate force config on the
  // same readiness so it runs AFTER fgRef is populated (and re-runs per new graph).
  const ready = !!theme && size.w > 0 && size.h > 0;

  // Spread the layout out. d3's defaults (charge -30, link distance 30) pack a
  // note's concepts into an unreadable hairball, so we crank up repulsion, push
  // links longer (similarity edges longest, so related cards sit in their own
  // orbit), and add a collision radius padded well past each node so labels have
  // room to breathe. Re-applied per graph — the lib resets forces on data change.
  useEffect(() => {
    const fg = fgRef.current;
    if (!ready || !fg) return;
    const charge = fg.d3Force("charge") as unknown as {
      strength: (n: number) => unknown;
      distanceMax: (n: number) => unknown;
    } | undefined;
    charge?.strength(-340);
    charge?.distanceMax(700);
    const link = fg.d3Force("link") as unknown as {
      distance: (fn: (l: GLink) => number) => unknown;
    } | undefined;
    link?.distance((l) => (l.kind === "similarity" ? 110 : 64));
    // forceCollide: keep node circles + a generous label gap from overlapping.
    const collide = forceCollide<GNode>((n) => nodeRadius(n.kind, n.degree) + 14).strength(0.9);
    (fg.d3Force as (name: string, force: unknown) => unknown)("collide", collide);
    fg.d3ReheatSimulation();
  }, [data, ready]);

  return (
    <div ref={wrapRef} className="w-full h-full">
      {ready && (
        <ForceGraph2D<GraphNode, LinkExtra>
          ref={fgRef}
          graphData={data}
          width={size.w}
          height={size.h}
          backgroundColor="rgba(0,0,0,0)"
          cooldownTicks={120}
          d3VelocityDecay={0.32}
          minZoom={0.4}
          maxZoom={6}
          onEngineStop={() => {
            if (!fitted.current) {
              fitFn.current();
              fitted.current = true;
            }
          }}
          nodeRelSize={1}
          nodeLabel={(node) => {
            // Rich hover popover (HTML, styled in globals.css as .float-tooltip-kap).
            // Concepts render tentative (taupe/italic via .gt-concept) — they're
            // AI-inferred and must never read as confirmed (DESIGN.md trust rule).
            const n = node as GNode;
            if (n.kind === "card") {
              const a = n.answer ? `<div class="gt-a">${esc(n.answer)}</div>` : "";
              return `<div><div class="gt-q">${esc(n.label || "(card)")}</div>${a}<div class="gt-k">card · click to open</div></div>`;
            }
            const sub = n.topic ? ` · ${esc(n.topic)}` : "";
            const gloss = n.description ? `<div class="gt-a">${esc(n.description)}</div>` : "";
            return `<div><div class="gt-q gt-concept">${esc(n.label)}</div>${gloss}<div class="gt-k">AI-inferred concept${sub} · click to explore</div></div>`;
          }}
          nodeCanvasObjectMode={() => "replace"}
          nodeCanvasObject={(node, ctx, scale) => {
            const n = node as GNode;
            const x = n.x ?? 0;
            const y = n.y ?? 0;
            const r = nodeRadius(n.kind, n.degree);

            ctx.beginPath();
            ctx.arc(x, y, r, 0, 2 * Math.PI);
            if (n.kind === "card") {
              ctx.fillStyle = theme.marigold;
              ctx.fill();
              ctx.lineWidth = 1 / scale;
              ctx.strokeStyle = theme.marigoldDeep;
              ctx.stroke();
            } else {
              ctx.fillStyle = rgba(theme.taupe, 0.18);
              ctx.fill();
              ctx.lineWidth = 1.3 / scale;
              ctx.strokeStyle = rgba(theme.taupe, 0.95);
              if (n.confidence < 0.66) ctx.setLineDash([3.5 / scale, 2.5 / scale]);
              ctx.stroke();
              ctx.setLineDash([]);
            }

            // Concepts (the map's vocabulary) are labelled whenever legible or when
            // they're hubs; cards only when zoomed in, to keep the field readable.
            const showLabel = n.kind === "concept" ? scale > 0.55 || n.degree >= 3 : scale > 1.5;
            if (showLabel && n.label) {
              const fontPx = Math.max(9, 11 / scale);
              ctx.font = `${fontPx}px ${theme.font}`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              const text = truncate(n.label, n.kind === "concept" ? 22 : 32);
              const tw = ctx.measureText(text).width;
              const ty = y + r + 2 / scale;
              ctx.fillStyle = rgba(theme.paper2, 0.78);
              ctx.fillRect(x - tw / 2 - 2 / scale, ty - 1 / scale, tw + 4 / scale, fontPx + 2 / scale);
              ctx.fillStyle = n.kind === "concept" ? theme.taupeInk : theme.ink;
              ctx.fillText(text, x, ty);
            }

            // Focus ring on the node whose inspector is open — a marigold halo
            // (the signature accent) so the selection reads at any zoom.
            if (selectedId && n.id === selectedId) {
              ctx.beginPath();
              ctx.arc(x, y, r + 3.5 / scale, 0, 2 * Math.PI);
              ctx.lineWidth = 1.5 / scale;
              ctx.strokeStyle = theme.marigoldDeep;
              ctx.stroke();
            }
          }}
          nodePointerAreaPaint={(node, color, ctx) => {
            const n = node as GNode;
            const r = nodeRadius(n.kind, n.degree);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, r + 2, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkColor={(link) =>
            (link as GLink).kind === "similarity" ? rgba(theme.teal, 0.3) : rgba(theme.inkSoft, 0.4)
          }
          linkWidth={(link) => 0.5 + (link as GLink).weight * 1.6}
          linkLineDash={(link) => ((link as GLink).kind === "similarity" ? [4, 3] : null)}
          linkLabel={(link) => {
            const l = link as GLink;
            return l.kind === "similarity" ? "related" : l.label ?? "";
          }}
          onNodeClick={(node) => {
            const n = node as GNode;
            if (n.kind === "card" && n.noteId && onNavigate) {
              onNavigate(n.noteId, n.id.startsWith("card:") ? n.id.slice("card:".length) : undefined);
            } else if (n.kind === "concept" && onSelect) {
              onSelect(n);
            } else if (fgRef.current && n.x != null && n.y != null) {
              fgRef.current.centerAt(n.x, n.y, 500);
              fgRef.current.zoom(2.4, 500);
            }
          }}
          onBackgroundClick={() => onSelect?.(null)}
        />
      )}
    </div>
  );
}
