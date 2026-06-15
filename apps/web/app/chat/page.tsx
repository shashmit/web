"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiStream } from "@/lib/api";
import { reconcileCitations } from "@/lib/citations";
import { useGet } from "@/lib/use-api";
import {
  ChatSuggestionListSchema,
  ChatSourceListSchema,
  CHAT_FOLLOWUP_MARKER,
  type ChatSuggestion,
  type ChatSource,
  type ChatMode,
} from "@/lib/api-types";

type Msg = { role: "you" | "ai"; text: string; sources?: ChatSource[]; followups?: string[] };

// Split a streamed answer into its body and the model's suggested follow-up
// questions. In "Notes + AI" mode the model prints CHAT_FOLLOWUP_MARKER after the
// answer, then the follow-ups (one per line) — so the marker and follow-ups never
// render in the answer body; they become tappable prompts beneath it instead.
function splitAnswer(raw: string): { body: string; followups: string[] } {
  const idx = raw.indexOf(CHAT_FOLLOWUP_MARKER);
  if (idx === -1) {
    // Hide a marker that's only partway through the stream so it never flashes.
    let cut = raw.length;
    for (let n = Math.min(raw.length, CHAT_FOLLOWUP_MARKER.length - 1); n > 0; n--) {
      if (raw.endsWith(CHAT_FOLLOWUP_MARKER.slice(0, n))) {
        cut = raw.length - n;
        break;
      }
    }
    return { body: raw.slice(0, cut), followups: [] };
  }
  const followups = raw
    .slice(idx + CHAT_FOLLOWUP_MARKER.length)
    .split("\n")
    .map((l) => l.replace(/^[\s\-*\d.)]+/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
  return { body: raw.slice(0, idx).trimEnd(), followups };
}

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Answer mode: "notes" stays strictly grounded in the user's own material;
  // "open" lets the assistant answer from general AI knowledge when the notes
  // don't cover it (clearly labeled). Persisted so the choice sticks.
  const [mode, setMode] = useState<ChatMode>("notes");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem("entri-chat-mode");
    if (saved === "open" || saved === "notes") setMode(saved);
  }, []);

  // Switching answer mode starts a FRESH chat — each answer is generated for one
  // mode, so we never splice two modes into a single thread. With no messages yet
  // the switch is free; mid-conversation we confirm first (pendingMode holds the
  // choice awaiting OK) so a chat is never cleared by accident.
  const [pendingMode, setPendingMode] = useState<ChatMode | null>(null);

  function applyMode(m: ChatMode) {
    setMode(m);
    try {
      localStorage.setItem("entri-chat-mode", m);
    } catch {
      /* private mode / quota — non-fatal */
    }
  }

  function requestMode(m: ChatMode) {
    if (m === mode) return;
    if (messages.length === 0) applyMode(m); // nothing to lose — switch straight away
    else setPendingMode(m); // confirm before clearing the conversation
  }

  function confirmSwitch() {
    if (!pendingMode) return;
    applyMode(pendingMode);
    setMessages([]); // new chat, generated from scratch in the new mode
    setInput("");
    setPendingMode(null);
  }

  // Escape dismisses the reset confirmation (keeps the current chat + mode).
  useEffect(() => {
    if (!pendingMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendingMode(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingMode]);

  // Starter prompts drawn from the user's own cards (LLM-generated, cached
  // server-side and refreshed when new notes land). Each is answerable by the
  // grounded chat, so tapping one never hits the "not in your notes" refusal.
  const { data: suggestions, loading: loadingSuggestions } = useGet<ChatSuggestion[]>(
    "/v1/chat/suggestions",
    ChatSuggestionListSchema
  );

  // Seeded from the knowledge map: "Continue in chat ↗" on a concept opens
  // /chat?q=…&mode=… — the inspector's popup picks the mode, so we honor it (and
  // reflect it in the toggle) instead of defaulting to notes-only. Ask once on
  // arrival, then strip the params. Guarded by a ref to survive StrictMode remounts.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    const urlMode = params.get("mode");
    const seedMode: ChatMode | undefined = urlMode === "open" || urlMode === "notes" ? urlMode : undefined;
    if (q?.trim()) {
      if (seedMode) applyMode(seedMode); // toggle reflects the chosen mode (+persist)
      send(q, seedMode); // explicit override — closure `mode` is stale on first render
      window.history.replaceState(null, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grow the textarea with its content, up to a cap (then it scrolls).
  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  // modeOverride lets the map seed force a mode regardless of the persisted toggle
  // (the first-render closure would otherwise capture the stale default).
  async function send(text: string, modeOverride?: ChatMode) {
    const q = text.trim();
    if (!q || busy) return;
    // Recent thread (excluding the empty placeholder) so chat is multi-turn — the
    // model sees prior turns, not just this message. Built before we append below.
    const history = messages
      .filter((m) => m.text.trim())
      .slice(-6)
      .map((m) => ({ role: m.role === "you" ? ("user" as const) : ("assistant" as const), content: m.text }));
    setBusy(true);
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto"; // reset grown height
    setMessages((m) => [...m, { role: "you", text: q }, { role: "ai", text: "" }]);

    try {
      const res = await apiStream("/v1/chat", { message: q, mode: modeOverride ?? mode, history });
      let sources: ChatSource[] = [];
      try {
        const parsed = ChatSourceListSchema.safeParse(JSON.parse(res.headers.get("X-Entri-Sources") ?? "[]"));
        if (parsed.success) sources = parsed.data;
      } catch {
        sources = [];
      }

      if (!res.body) {
        const { body, followups } = splitAnswer(await res.text());
        const final = reconcileCitations(body, sources);
        setMessages((m) => updateLast(m, final.text, final.sources, followups));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        const { body, followups } = splitAnswer(acc);
        setMessages((m) => updateLast(m, body, sources, followups));
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      }
      // Final pass: strip fabricated citations + keep only used note chips.
      const { body, followups } = splitAnswer(acc);
      const final = reconcileCitations(body, sources);
      setMessages((m) => updateLast(m, final.text, final.sources, followups));
    } catch (e) {
      setMessages((m) => updateLast(m, e instanceof Error ? e.message : "Something went wrong", []));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[680px] w-full mx-auto flex flex-col h-[calc(100dvh-110px)] md:h-[calc(100dvh-60px)]">
      <div className="mb-4 px-0.5 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display font-semibold text-[clamp(24px,5.5vw,30px)] tracking-tight leading-[1.1]">
            Ask your notes.
          </h1>
          <p className="text-muted text-[13px] mt-1 max-w-[46ch]">
            {mode === "notes"
              ? "Answers come only from your own material, with the page cited. If it’s not in your notes, it says so."
              : "Your notes and general AI knowledge, together — note pages are cited, anything from general AI is labeled."}
          </p>
        </div>
        <ModeToggle mode={mode} onChange={requestMode} />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto flex flex-col gap-3 pb-3">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-2 mt-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted px-0.5 mb-0.5">
              Drawn from your notes
            </p>
            {loadingSuggestions ? (
              [0, 1, 2, 3].map((i) => (
                <div key={i} className="card px-4 py-3.5 animate-pulse" aria-hidden="true">
                  <div className="h-3 rounded-[3px] bg-line" style={{ width: `${78 - i * 9}%` }} />
                </div>
              ))
            ) : suggestions && suggestions.length > 0 ? (
              suggestions.map((s) => (
                <button
                  key={s.question}
                  onClick={() => send(s.question)}
                  className="group text-left card px-4 py-3 text-[13.5px] text-ink-soft hover:border-marigold transition-colors flex items-center gap-2.5"
                >
                  <span aria-hidden="true" className="shrink-0 font-mono text-[13px] text-marigold">
                    →
                  </span>
                  <span className="flex-1">{s.question}</span>
                  {s.topic && (
                    <span className="hidden sm:inline shrink-0 font-mono text-[10px] text-muted">
                      {s.topic}
                    </span>
                  )}
                </button>
              ))
            ) : (
              <p className="text-muted text-[13px] px-0.5 leading-relaxed">
                Capture a note and entri will suggest questions drawn from your own material.
              </p>
            )}
          </div>
        ) : (
          messages.map((m, i) =>
            m.role === "you" ? (
              <div
                key={i}
                className="self-end max-w-[80%] bg-ink text-paper rounded-md rounded-br-sm px-4 py-2.5 text-[14.5px]"
              >
                {m.text}
              </div>
            ) : (
              <AssistantBubble key={i} text={m.text} sources={m.sources} followups={m.followups} onAsk={send} />
            )
          )
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="pt-3"
      >
        <div className="card flex items-end gap-2 px-2.5 py-2 focus-within:border-marigold transition-colors">
          <textarea
            ref={taRef}
            rows={1}
            className="composer-field flex-1 bg-transparent border-0 resize-none outline-none text-[15px] leading-[1.5] text-ink placeholder:text-muted px-2 py-1.5 max-h-40 overflow-y-auto"
            aria-label="Ask about your notes"
            placeholder={mode === "notes" ? "Ask about your notes…" : "Ask anything — notes first, then AI…"}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autosize(e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Send"
            className="shrink-0 inline-flex items-center justify-center font-semibold text-[14px] rounded-sm px-4 py-2 bg-marigold text-on-marigold transition-colors cursor-pointer hover:bg-marigold-deep disabled:opacity-40 disabled:cursor-default"
          >
            {busy ? "…" : "Ask"}
          </button>
        </div>
        <p className="text-center text-muted text-[11px] mt-2">
          {mode === "notes"
            ? "Answers are grounded in your own notes — entri won’t invent facts."
            : "“Notes + AI” on — answers beyond your notes are labeled General AI knowledge."}
        </p>
      </form>

      {/* Switching mode clears the thread — confirm first so a chat is never lost. */}
      {pendingMode && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="mode-reset-title"
          onClick={() => setPendingMode(null)}
          className="fixed inset-0 z-[60] grid place-items-center p-4 bg-[color-mix(in_srgb,var(--ink)_28%,transparent)] backdrop-blur-[2px]"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card-swap card max-w-[400px] w-full px-5 py-4"
          >
            <div className="kicker mb-1">Start a new chat?</div>
            <h2 id="mode-reset-title" className="font-display text-[19px] leading-snug mb-1.5">
              Switching to {pendingMode === "open" ? "Notes + AI" : "My notes"} resets this chat
            </h2>
            <p className="text-ink-soft text-[13.5px] leading-[1.55]">
              Answers are generated fresh for each mode, so your current conversation will be cleared and a new chat
              will start.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setPendingMode(null)} className="btn-s text-[14px] px-4 py-2" autoFocus>
                Keep chatting
              </button>
              <button onClick={confirmSwitch} className="btn-p text-[14px] px-4 py-2">
                Switch &amp; start new
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Notes-only ↔ Notes + AI segmented toggle. Square, warm-lined, no pills.
function ModeToggle({ mode, onChange }: { mode: ChatMode; onChange: (m: ChatMode) => void }) {
  const options: [ChatMode, string][] = [
    ["notes", "My notes"],
    ["open", "Notes + AI"],
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Answer mode"
      className="inline-flex shrink-0 rounded-sm border border-line bg-paper2 p-0.5 text-[12px] font-medium"
    >
      {options.map(([val, label]) => {
        const active = mode === val;
        return (
          <button
            key={val}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(val)}
            className={`rounded-[3px] px-2.5 py-1 transition-colors cursor-pointer ${
              active ? "bg-ink text-paper" : "text-muted hover:text-ink-soft"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// One assistant reply: Markdown-rendered body + a provenance footer. Note pages
// are teal (verified, from your material); a general-AI answer wears the dashed
// taupe "inferred" chip so it's never mistaken for the user's notes. Note chips
// collapse past three behind a "show more" — which also reveals each cited
// snippet. In "Notes + AI" the model's suggested follow-up questions ride along
// as tappable prompts, collapsed behind their own "show more".
function AssistantBubble({
  text,
  sources,
  followups,
  onAsk,
}: {
  text: string;
  sources?: ChatSource[];
  followups?: string[];
  onAsk: (q: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showFollowups, setShowFollowups] = useState(false);
  const all = sources ?? [];
  const ai = all.filter((s) => s.kind === "ai");
  const notes = all.filter((s) => s.kind === "note");
  const prompts = followups ?? [];
  const LIMIT = 3;
  const shownNotes = expanded ? notes : notes.slice(0, LIMIT);
  const hidden = notes.length - shownNotes.length;
  const withSnippets = notes.filter((s) => s.snippet);

  return (
    <div className="self-start max-w-[88%] card px-4 py-3 text-[14.5px] leading-[1.6] text-ink-soft">
      {text ? (
        <div className="chat-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      ) : (
        <span className="text-muted">…</span>
      )}

      {(ai.length > 0 || notes.length > 0) && (
        <div className="mt-2.5 pt-2.5 border-t border-line">
          <div className="flex flex-wrap items-center gap-1.5">
            {ai.map((s) => (
              <span key={s.label} className="chip-inferred" title="Answered from general AI knowledge, not your notes">
                {s.label}
              </span>
            ))}
            {shownNotes.map((s) => (
              <span
                key={s.label}
                className="font-mono text-[10px] text-teal bg-teal-soft rounded-[3px] px-2 py-[3px]"
              >
                <span aria-hidden="true">→</span> {s.label}
              </span>
            ))}
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="font-mono text-[10px] text-marigold hover:text-marigold-deep cursor-pointer"
              >
                +{hidden} more
              </button>
            )}
            {expanded && notes.length > LIMIT && (
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="font-mono text-[10px] text-muted hover:text-ink-soft cursor-pointer"
              >
                show less
              </button>
            )}
          </div>

          {/* Expanding the citations reveals what each cited page actually said. */}
          {expanded && withSnippets.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {withSnippets.map((s) => (
                <li key={s.label} className="text-[12px] leading-[1.5] text-muted">
                  <span className="font-mono text-[10px] text-teal">→ {s.label}</span>{" "}
                  <span className="text-ink-soft">{s.snippet}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {prompts.length > 0 && (
        <div className="mt-2.5 pt-2.5 border-t border-line">
          {!showFollowups ? (
            <button
              type="button"
              onClick={() => setShowFollowups(true)}
              className="font-mono text-[10px] uppercase tracking-[0.08em] text-marigold hover:text-marigold-deep cursor-pointer"
            >
              Show {prompts.length} follow-up{prompts.length > 1 ? "s" : ""}
            </button>
          ) : (
            <div className="flex flex-col gap-1.5">
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">Ask next</p>
              <div className="flex flex-wrap gap-1.5">
                {prompts.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => onAsk(q)}
                    className="text-left font-mono text-[11px] text-ink-soft border border-line hover:border-marigold rounded-[3px] px-2 py-[3px] transition-colors cursor-pointer"
                  >
                    <span aria-hidden="true" className="text-marigold">→</span> {q}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function updateLast(msgs: Msg[], text: string, sources: ChatSource[], followups: string[] = []): Msg[] {
  const copy = [...msgs];
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === "ai") {
      copy[i] = { ...copy[i], text, sources, followups };
      break;
    }
  }
  return copy;
}
