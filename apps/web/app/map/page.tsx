"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useGet } from "@/lib/use-api";
import { GraphSchema, type Graph, type GraphNode } from "@/lib/api-types";
import ConceptInspector from "./ConceptInspector";

// Canvas is client-only (force-graph reaches for `window` at import).
const ForceGraph = dynamic(() => import("./ForceGraph"), {
  ssr: false,
  loading: () => (
    <div className="h-full grid place-items-center">
      <span className="font-mono text-xs text-muted">drawing your map…</span>
    </div>
  ),
});

function Swatch({ children, kind }: { children: React.ReactNode; kind: "card" | "concept" | "relation" | "similarity" }) {
  const dot =
    kind === "card" ? (
      <span className="w-3 h-3 rounded-full bg-marigold border border-marigold-deep" />
    ) : kind === "concept" ? (
      <span className="w-3 h-3 rounded-full border border-dashed border-taupe bg-[color-mix(in_srgb,var(--taupe)_18%,transparent)]" />
    ) : kind === "relation" ? (
      <span className="w-5 h-px bg-ink-soft/60" />
    ) : (
      <span className="w-5 h-px border-t border-dashed border-teal" />
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted">
      {dot}
      {children}
    </span>
  );
}

export default function MapPage() {
  const router = useRouter();
  const { data, loading, error } = useGet<Graph>("/v1/graph", GraphSchema);
  const empty = !!data && data.nodes.length === 0;

  // The AI-inferred concept whose inspector is pinned open (null = none). Derive
  // a "live" view so a graph reload that drops the node clears the panel without
  // a reset effect (and without a stale node lingering on screen).
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const liveSelected = selected && data?.nodes.some((n) => n.id === selected.id) ? selected : null;

  // Concept ids that have a saved "Tell me more" brief → drawn with the warm
  // story ring. Seeded from the loaded graph (hasStory), plus any saved this
  // session so a freshly-generated brief lights up its node without a refetch.
  const [newlyStoried, setNewlyStoried] = useState<Set<string>>(() => new Set());
  const storiedIds = useMemo(() => {
    const s = new Set<string>(newlyStoried);
    data?.nodes.forEach((n) => {
      if (n.kind === "concept" && n.hasStory) s.add(n.id);
    });
    return s;
  }, [data, newlyStoried]);

  // Reserve the overlay header's real height so the graph fit never parks nodes
  // behind the title band (measured live; it shrinks on mobile where the blurb hides).
  const headerRef = useRef<HTMLElement>(null);
  const [inset, setInset] = useState(150);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const apply = () => setInset(el.offsetHeight);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Deep-link straight to the clicked card's question on its note page.
  const open = (noteId: string, cardId?: string) =>
    router.push(cardId ? `/notes/${noteId}?card=${cardId}` : `/notes/${noteId}`);

  return (
    // Fills the (unpadded, full-height) main column — the graph is the page.
    <div className="relative h-full w-full">
      {/* graph fills everything; on mobile it stops above the bottom tab bar */}
      <div className="absolute inset-x-0 top-0 bottom-[calc(64px+env(safe-area-inset-bottom))] md:bottom-0">
        {loading ? (
          <div className="h-full grid place-items-center">
            <span className="font-mono text-xs text-muted">loading…</span>
          </div>
        ) : error ? (
          <div className="h-full grid place-items-center text-center px-6">
            <p className="text-[14px] text-ink-soft">Couldn&apos;t load your map. {error}</p>
          </div>
        ) : empty ? (
          <div className="h-full grid place-items-center text-center px-6">
            <div>
              <p className="font-display text-[20px] mb-1.5">Your map is still a blank page.</p>
              <p className="text-muted text-[13.5px] mb-4 max-w-[44ch] mx-auto">
                As you capture notes, entri pulls out the key concepts and draws the threads between
                them — across every note you&apos;ve taken.
              </p>
              <Link href="/capture" className="btn-p text-[14px]">
                Capture a note
              </Link>
            </div>
          </div>
        ) : (
          data && (
            <ForceGraph
              graph={data}
              onNavigate={open}
              onSelect={setSelected}
              selectedId={liveSelected?.id ?? null}
              storiedIds={storiedIds}
              topInset={inset}
            />
          )
        )}
      </div>

      {data && liveSelected && (
        <ConceptInspector
          key={liveSelected.id}
          node={liveSelected}
          graph={data}
          onClose={() => setSelected(null)}
          onPick={setSelected}
          onNavigate={open}
          onStoried={(id) => setNewlyStoried((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))}
        />
      )}

      {/* title + legend float ON TOP of the graph as a translucent paper panel
          (blur + near-opaque paper keeps every label legible over a busy graph);
          pointer-events-none lets you drag the graph underneath it */}
      <header
        ref={headerRef}
        className="pointer-events-none absolute inset-x-0 top-0 z-10 px-[18px] pt-4 pb-3 md:px-8 border-b border-line bg-[color-mix(in_srgb,var(--paper-2)_90%,transparent)] backdrop-blur-md"
      >
        <div className="kicker mb-1">Knowledge map</div>
        <h1 className="font-display font-semibold text-[clamp(20px,4vw,28px)] tracking-tight leading-[1.05]">
          How your notes connect
        </h1>
        <p className="text-ink-soft text-[12.5px] mt-1 max-w-[54ch] hidden sm:block">
          Every concept entri finds in your notes, woven into the relations between them. Drag to
          explore, scroll to zoom, hover a card to peek, click to open it.
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2">
          <Swatch kind="card">card (from your notes)</Swatch>
          <Swatch kind="concept">concept (AI-inferred)</Swatch>
          <Swatch kind="relation">relation</Swatch>
          <Swatch kind="similarity">similar / related</Swatch>
        </div>
      </header>

      {data?.truncated && (
        <p className="pointer-events-none absolute left-[18px] md:left-8 bottom-[calc(72px+env(safe-area-inset-bottom))] md:bottom-3 z-10 text-muted text-[11px] bg-[color-mix(in_srgb,var(--paper-2)_88%,transparent)] rounded-sm px-2 py-1">
          Showing the strongest connections — your map is larger than what&apos;s drawn here.
        </p>
      )}
    </div>
  );
}
