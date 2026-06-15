"use client";

// Pinned inspector for an AI-inferred concept node. Opens on click (the hover
// tooltip is the quick peek; this is the interactive panel). It surfaces what
// entri already knows about the concept — its one-clause gloss, the concepts it
// relates to, and the cards it appears in — then lets the student go deeper:
// "Tell me more" blends their notes with general AI knowledge into a brief that
// is SAVED (so it isn't regenerated, and the node grows a story ring), can be
// added to their reviews, and continues in the full /chat surface.
//
// Trust rule (DESIGN.md): everything here is AI-inferred, so it reads visibly
// tentative — taupe, dashed, italic. The brief cites note pages (teal) and
// labels general-AI parts (taupe); fabricated citations are stripped client-side.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatSourceListSchema, ConceptBriefSchema, type ChatSource, type Graph, type GraphNode } from "@/lib/api-types";
import { api, apiStream } from "@/lib/api";
import { reconcileCitations } from "@/lib/citations";

type Related = { node: GraphNode; predicate: string | null; outgoing: boolean };

// Build the question we both stream inline and seed the full chat with — phrased
// so the grounded RAG retrieves this concept's chunks from the student's notes.
function conceptQuestion(node: GraphNode): string {
  const topic = node.topic ? ` (from ${node.topic})` : "";
  return `Explain the concept "${node.label}"${topic} from my notes — what is it, and how does it connect to the rest of my material?`;
}

const stripCard = (id: string) => (id.startsWith("card:") ? id.slice("card:".length) : id);
// Graph concept ids are "concept:<uuid>"; the /v1/concepts API wants the bare uuid.
const conceptUuid = (id: string) => (id.startsWith("concept:") ? id.slice("concept:".length) : id);

export default function ConceptInspector({
  node,
  graph,
  onClose,
  onPick,
  onNavigate,
  onStoried,
}: {
  node: GraphNode;
  graph: Graph;
  onClose: () => void;
  // walk the graph from inside the panel: clicking a related concept re-opens
  // the inspector on it.
  onPick: (node: GraphNode) => void;
  // open a card's note (cardId deep-links to the exact question).
  onNavigate: (noteId: string, cardId?: string) => void;
  // tell the map a brief now exists for this concept (lights up its story ring).
  onStoried: (nodeId: string) => void;
}) {
  const [brief, setBrief] = useState("");
  const [sources, setSources] = useState<ChatSource[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [askMode, setAskMode] = useState(false); // mode-choice popup before continuing to full chat
  const [srcExpanded, setSrcExpanded] = useState(false); // sources show-more
  const [saved, setSaved] = useState(false); // a brief is persisted for this concept
  const [studyState, setStudyState] = useState<"idle" | "saving" | "done" | "error">("idle");
  // Bumped per request; an in-flight stream checks it before writing state, so a
  // late chunk can't land after the user re-asks. (Switching concepts remounts
  // this panel via its `key`, so per-concept reset is handled by React.)
  const gen = useRef(0);

  // On unmount (incl. concept switch / close), invalidate any in-flight stream so
  // a trailing chunk can't write to a torn-down panel.
  useEffect(() => () => {
    gen.current++;
  }, []);

  // Escape closes the mode popup first (if open), otherwise the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (askMode) setAskMode(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, askMode]);

  // If this concept already has a saved story, load + show it instead of making
  // the student regenerate. (Remounts per concept via `key`, so [] is correct.)
  useEffect(() => {
    if (!node.hasStory) return;
    let live = true;
    api
      .get(`/v1/concepts/${conceptUuid(node.id)}/brief`, ConceptBriefSchema)
      .then((b) => {
        if (!live || !b.text.trim()) return;
        setBrief(b.text);
        setSources(b.sources);
        setStatus("done");
        setSaved(true);
      })
      .catch(() => {
        /* fall back to the "Tell me more" button */
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // "open" mode: blend the student's notes with general AI knowledge — note
      // pages cited (teal), general knowledge labeled 'ai' (taupe, tentative).
      const res = await apiStream("/v1/chat", { message: conceptQuestion(node), mode: "open" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Couldn't reach entri (${res.status})`);
      }
      let srcs: ChatSource[] = [];
      try {
        const parsed = ChatSourceListSchema.safeParse(JSON.parse(res.headers.get("X-Entri-Sources") ?? "[]"));
        if (parsed.success) srcs = parsed.data;
      } catch {
        srcs = [];
      }
      if (gen.current === myGen) setSources(srcs);

      // Reconcile (strip fabricated citations, keep only used note chips), show the
      // final brief, and persist it so it isn't regenerated and the node's story
      // ring lights up. Best-effort save — the brief still shows if the POST fails.
      const finalize = (rawText: string) => {
        if (gen.current !== myGen) return;
        const final = reconcileCitations(rawText, srcs);
        setBrief(final.text);
        setSources(final.sources);
        setStatus("done");
        setSaved(true);
        api
          .post(`/v1/concepts/${conceptUuid(node.id)}/brief`, { text: final.text, sources: final.sources })
          .then(() => onStoried(node.id))
          .catch(() => {
            /* non-fatal: brief still shows, just not saved */
          });
      };

      if (!res.body) {
        finalize(await res.text());
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
      finalize(acc);
    } catch (e) {
      if (gen.current !== myGen) return;
      setError(e instanceof Error ? e.message : "Something went wrong");
      setStatus("error");
    }
  }

  // Promote this concept into a studyable card (origin 'inferred' → tentative in
  // review) and seed its FSRS state. Idempotent server-side, so a re-tap is safe.
  async function addToReviews() {
    setStudyState("saving");
    try {
      await api.post(`/v1/concepts/${conceptUuid(node.id)}/study`);
      setStudyState("done");
    } catch {
      setStudyState("error");
    }
  }

  const confidence = Math.round(node.confidence * 100);
  // Split provenance: verified note pages (teal) vs general AI knowledge (taupe,
  // tentative) — an AI answer must never read as if it came from the notes.
  const aiSources = sources.filter((s) => s.kind === "ai");
  const noteSources = sources.filter((s) => s.kind === "note");
  // Sources sit at the bottom of the reply; note chips collapse past three behind
  // a show-more toggle (mirrors the full chat's AssistantBubble).
  const SRC_LIMIT = 3;
  const shownNotes = srcExpanded ? noteSources : noteSources.slice(0, SRC_LIMIT);
  const hiddenNotes = noteSources.length - shownNotes.length;

  return (
    <>
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

      {/* chat more — notes first, then general AI knowledge; inline or in full chat */}
      <div className="mt-4 pt-3.5 border-t border-line">
        {status === "idle" ? (
          <>
            <button onClick={tellMore} className="btn-p w-full text-[14px] py-2.5">
              Tell me more
            </button>
            <p className="text-muted text-[11px] leading-snug mt-1.5">
              Blends your notes with general AI knowledge — note pages cited, AI parts labeled. Saved so you don&apos;t regenerate it.
            </p>
          </>
        ) : status === "error" ? (
          <>
            <p className="text-brick text-[13px] leading-[1.5]">{error}</p>
            <button onClick={tellMore} className="mt-2 font-mono text-[11px] text-marigold-deep hover:underline cursor-pointer">
              Try again
            </button>
          </>
        ) : (
          <>
            {brief ? (
              <div className="chat-md text-[13.5px] leading-[1.6] text-ink-soft">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{brief}</ReactMarkdown>
              </div>
            ) : (
              <span className="text-muted text-[13px]">thinking…</span>
            )}
            {(aiSources.length > 0 || noteSources.length > 0) && (
              <div className="mt-2.5 pt-2.5 border-t border-line flex flex-wrap items-center gap-1.5">
                {aiSources.map((s) => (
                  <span key={s.label} className="chip-inferred" title="From general AI knowledge, not your notes">
                    {s.label}
                  </span>
                ))}
                {shownNotes.map((s) => (
                  <span key={s.label} className="font-mono text-[10px] text-teal bg-teal-soft rounded-[3px] px-2 py-[3px]">
                    <span aria-hidden="true">→</span> {s.label}
                  </span>
                ))}
                {hiddenNotes > 0 && (
                  <button
                    type="button"
                    onClick={() => setSrcExpanded(true)}
                    className="font-mono text-[10px] text-marigold hover:text-marigold-deep cursor-pointer"
                  >
                    +{hiddenNotes} more
                  </button>
                )}
                {srcExpanded && noteSources.length > SRC_LIMIT && (
                  <button
                    type="button"
                    onClick={() => setSrcExpanded(false)}
                    className="font-mono text-[10px] text-muted hover:text-ink-soft cursor-pointer"
                  >
                    show less
                  </button>
                )}
              </div>
            )}
            {status === "done" && (
              <div className="mt-2 flex items-center gap-2.5">
                {saved && <span className="font-mono text-[10px] text-muted">✓ Saved</span>}
                <button
                  type="button"
                  onClick={tellMore}
                  className="font-mono text-[10px] text-muted hover:text-ink-soft cursor-pointer"
                >
                  ↻ Regenerate
                </button>
              </div>
            )}
          </>
        )}

        {/* actions — continue the thread, or turn this into a study card */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <button
            type="button"
            onClick={() => setAskMode(true)}
            className="inline-flex items-center gap-1 font-mono text-[11px] text-marigold-deep hover:underline cursor-pointer"
          >
            Continue in chat <span aria-hidden="true">↗</span>
          </button>

          {(status === "done" || node.description) &&
            (studyState === "done" ? (
              <span className="font-mono text-[11px] text-teal">✓ In your reviews</span>
            ) : (
              <button
                type="button"
                onClick={addToReviews}
                disabled={studyState === "saving"}
                className="inline-flex items-center gap-1 font-mono text-[11px] text-marigold-deep hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-default"
              >
                {studyState === "saving"
                  ? "Adding…"
                  : studyState === "error"
                    ? "Couldn’t add — retry"
                    : "+ Add to my reviews"}
              </button>
            ))}
        </div>
      </div>
    </aside>

      {/* "Continue in chat" mode chooser — pick what entri draws on, then carry the
          choice to /chat via ?mode= so the seeded answer isn't stuck on notes-only. */}
      {askMode && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="ask-mode-title"
          onClick={() => setAskMode(false)}
          className="fixed inset-0 z-[60] grid place-items-center p-4 bg-[color-mix(in_srgb,var(--ink)_28%,transparent)] backdrop-blur-[2px]"
        >
          <div onClick={(e) => e.stopPropagation()} className="card-swap card max-w-[400px] w-full px-5 py-4">
            <div className="kicker mb-1">Continue in chat</div>
            <h2 id="ask-mode-title" className="font-display text-[19px] leading-snug mb-1.5 break-words">
              How should entri answer about “{node.label}”?
            </h2>
            <p className="text-ink-soft text-[13.5px] leading-[1.55] mb-3.5">
              Pick what entri draws on — more context usually means a fuller, more useful answer.
            </p>
            <div className="flex flex-col gap-2">
              <Link
                href={`/chat?q=${encodeURIComponent(conceptQuestion(node))}&mode=open`}
                className="card px-4 py-3 hover:border-marigold transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[14px] text-ink">Notes + AI</span>
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-marigold-deep">Recommended</span>
                </div>
                <p className="text-muted text-[12px] mt-0.5">Your notes plus general AI knowledge — broader context; AI parts are labeled.</p>
              </Link>
              <Link
                href={`/chat?q=${encodeURIComponent(conceptQuestion(node))}&mode=notes`}
                className="card px-4 py-3 hover:border-marigold transition-colors"
              >
                <span className="font-semibold text-[14px] text-ink">My notes only</span>
                <p className="text-muted text-[12px] mt-0.5">Strictly your own material, with the page cited.</p>
              </Link>
            </div>
            <div className="flex justify-end mt-3.5">
              <button onClick={() => setAskMode(false)} className="btn-ghost text-[13px] px-3 py-1.5">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
