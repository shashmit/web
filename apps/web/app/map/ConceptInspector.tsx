"use client";

// Pinned inspector for an AI-inferred concept node. Opens on click (the hover
// tooltip is the quick peek; this is the interactive panel). It surfaces what
// entri already knows about the concept — its one-clause gloss, the concepts it
// relates to, and the cards it appears in — then lets the student go deeper:
// "Tell me more" streams a grounded, source-cited explanation right here, and
// "Continue in chat" carries the thread to the full /chat surface.
//
// Trust rule (DESIGN.md): everything here is AI-inferred, so it must read
// visibly tentative — taupe, dashed, italic — and the generated brief is
// grounded strictly in the student's own notes (it refuses if it can't find it).
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Graph, GraphNode } from "@/lib/api-types";
import { apiStream } from "@/lib/api";

type Related = { node: GraphNode; predicate: string | null; outgoing: boolean };

// Build the question we both stream inline and seed the full chat with — phrased
// so the grounded RAG retrieves this concept's chunks from the student's notes.
function conceptQuestion(node: GraphNode): string {
  const topic = node.topic ? ` (from ${node.topic})` : "";
  return `Explain the concept "${node.label}"${topic} from my notes — what is it, and how does it connect to the rest of my material?`;
}

const stripCard = (id: string) => (id.startsWith("card:") ? id.slice("card:".length) : id);

export default function ConceptInspector({
  node,
  graph,
  onClose,
  onPick,
  onNavigate,
}: {
  node: GraphNode;
  graph: Graph;
  onClose: () => void;
  // walk the graph from inside the panel: clicking a related concept re-opens
  // the inspector on it.
  onPick: (node: GraphNode) => void;
  // open a card's note (cardId deep-links to the exact question).
  onNavigate: (noteId: string, cardId?: string) => void;
}) {
  const [brief, setBrief] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  // Bumped per request; an in-flight stream checks it before writing state, so a
  // late chunk can't land after the user re-asks. (Switching concepts remounts
  // this panel via its `key`, so per-concept reset is handled by React.)
  const gen = useRef(0);

  // On unmount (incl. concept switch / close), invalidate any in-flight stream so
  // a trailing chunk can't write to a torn-down panel.
  useEffect(() => () => {
    gen.current++;
  }, []);

  // Escape closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Neighbours straight off the (unmutated) API graph — string endpoint ids, so
  // this stays stable regardless of what the force engine does to its own copy.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const related: Related[] = [];
  const cards: GraphNode[] = [];
  const seenCard = new Set<string>();
  for (const e of graph.edges) {
    const otherId = e.source === node.id ? e.target : e.target === node.id ? e.source : null;
    if (!otherId) continue;
    const other = byId.get(otherId);
    if (!other) continue;
    if (other.kind === "concept") {
      related.push({ node: other, predicate: e.label, outgoing: e.source === node.id });
    } else if (!seenCard.has(other.id)) {
      seenCard.add(other.id);
      cards.push(other);
    }
  }

  async function tellMore() {
    const myGen = ++gen.current;
    setStatus("loading");
    setError(null);
    setBrief("");
    setSources([]);
    try {
      const res = await apiStream("/v1/chat", { message: conceptQuestion(node) });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Couldn't reach entri (${res.status})`);
      }
      let srcs: string[] = [];
      try {
        srcs = JSON.parse(res.headers.get("X-Entri-Sources") ?? "[]");
      } catch {
        srcs = [];
      }
      if (gen.current === myGen) setSources(srcs);

      if (!res.body) {
        const text = await res.text();
        if (gen.current === myGen) {
          setBrief(text);
          setStatus("done");
        }
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        if (gen.current !== myGen) return; // concept switched — drop this stream
        setBrief(acc);
      }
      if (gen.current === myGen) setStatus("done");
    } catch (e) {
      if (gen.current !== myGen) return;
      setError(e instanceof Error ? e.message : "Something went wrong");
      setStatus("error");
    }
  }

  const confidence = Math.round(node.confidence * 100);

  return (
    <aside
      role="dialog"
      aria-label={`Concept: ${node.label}`}
      className="card-swap pointer-events-auto absolute z-20 left-3 right-3 bottom-[calc(64px+env(safe-area-inset-bottom)+12px)] md:left-auto md:right-4 md:bottom-4 md:w-[348px] max-h-[70%] md:max-h-[calc(100%-2rem)] overflow-y-auto card px-[18px] pt-3.5 pb-4"
    >
      {/* header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="kicker">AI-inferred concept</div>
          <h2 className="font-display italic text-taupe-ink text-[20px] leading-[1.2] mt-0.5 break-words">
            {node.label}
          </h2>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 -mr-1 w-8 h-8 grid place-items-center rounded-sm text-muted hover:text-ink hover:bg-surface transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-2">
        {node.topic && <span className="chip-inferred">{node.topic}</span>}
        <span className="font-mono text-[10.5px] text-muted tabnum">confidence ~{confidence}%</span>
      </div>

      {node.description && (
        <p className="text-ink-soft text-[13.5px] leading-[1.55] mt-2.5">{node.description}</p>
      )}

      {/* related concepts — clickable to walk the map */}
      {related.length > 0 && (
        <section className="mt-3.5">
          <div className="kicker mb-1.5">Related</div>
          <ul className="flex flex-col gap-1">
            {related.slice(0, 10).map((r, i) => (
              <li key={`${r.node.id}-${i}`}>
                <button
                  onClick={() => onPick(r.node)}
                  className="group w-full text-left flex items-baseline gap-1.5 text-[13px] hover:bg-surface rounded-sm px-1.5 py-1 -mx-1.5 transition-colors cursor-pointer"
                >
                  {r.predicate && (
                    <span className="font-mono text-[10px] text-muted whitespace-nowrap">
                      {r.outgoing ? `${r.predicate} →` : `← ${r.predicate}`}
                    </span>
                  )}
                  <span className="text-taupe-ink italic group-hover:text-ink transition-colors truncate">
                    {r.node.label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* the verified cards this concept appears in */}
      {cards.length > 0 && (
        <section className="mt-3.5">
          <div className="kicker mb-1.5">Appears in</div>
          <ul className="flex flex-col gap-1">
            {cards.slice(0, 8).map((card) => (
              <li key={card.id}>
                <button
                  onClick={() => card.noteId && onNavigate(card.noteId, stripCard(card.id))}
                  disabled={!card.noteId}
                  className="w-full text-left flex items-baseline gap-2 text-[13px] text-ink-soft hover:text-ink hover:bg-surface rounded-sm px-1.5 py-1 -mx-1.5 transition-colors cursor-pointer disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className="mt-[3px] w-2 h-2 shrink-0 rounded-full bg-marigold border border-marigold-deep" />
                  <span className="truncate">{card.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* chat more — generate a grounded brief inline, or carry on in full chat */}
      <div className="mt-4 pt-3.5 border-t border-line">
        {status === "idle" ? (
          <button onClick={tellMore} className="btn-p w-full text-[14px] py-2.5">
            Tell me more
          </button>
        ) : (
          <div className="inferred-card !py-3 !px-3.5">
            <div className="kicker mb-1.5">From your notes</div>
            {status === "error" ? (
              <>
                <p className="text-brick text-[13px] leading-[1.5]">{error}</p>
                <button onClick={tellMore} className="mt-2 font-mono text-[11px] text-marigold-deep hover:underline cursor-pointer">
                  Try again
                </button>
              </>
            ) : (
              <>
                <p className="text-ink-soft text-[13.5px] leading-[1.6] whitespace-pre-wrap">
                  {brief || <span className="text-muted">thinking…</span>}
                </p>
                {sources.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2.5">
                    {sources.map((s) => (
                      <span key={s} className="font-mono text-[10px] text-teal bg-teal-soft rounded-[3px] px-2 py-[3px]">
                        <span aria-hidden="true">→</span> {s}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <Link
          href={`/chat?q=${encodeURIComponent(conceptQuestion(node))}`}
          className="mt-2.5 inline-flex items-center gap-1 font-mono text-[11px] text-marigold-deep hover:underline"
        >
          Continue in chat <span aria-hidden="true">↗</span>
        </Link>
      </div>
    </aside>
  );
}
