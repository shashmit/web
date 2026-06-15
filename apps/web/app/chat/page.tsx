"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiStream } from "@/lib/api";
import { useGet } from "@/lib/use-api";
import {
  ChatSuggestionListSchema,
  ChatSourceListSchema,
  type ChatSuggestion,
  type ChatSource,
  type ChatMode,
} from "@/lib/api-types";

type Msg = { role: "you" | "ai"; text: string; sources?: ChatSource[] };

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

  function changeMode(m: ChatMode) {
    setMode(m);
    try {
      localStorage.setItem("entri-chat-mode", m);
    } catch {
      /* private mode / quota — non-fatal */
    }
  }

  // Starter prompts drawn from the user's own cards (LLM-generated, cached
  // server-side and refreshed when new notes land). Each is answerable by the
  // grounded chat, so tapping one never hits the "not in your notes" refusal.
  const { data: suggestions, loading: loadingSuggestions } = useGet<ChatSuggestion[]>(
    "/v1/chat/suggestions",
    ChatSuggestionListSchema
  );

  // Seeded from the knowledge map: "Continue in chat ↗" on a concept opens
  // /chat?q=… — ask it once on arrival, then strip the param so a refresh or
  // back-nav doesn't re-fire it. Guarded by a ref to survive StrictMode remounts.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const q = new URLSearchParams(window.location.search).get("q");
    if (q?.trim()) {
      send(q);
      window.history.replaceState(null, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grow the textarea with its content, up to a cap (then it scrolls).
  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto"; // reset grown height
    setMessages((m) => [...m, { role: "you", text: q }, { role: "ai", text: "" }]);

    try {
      const res = await apiStream("/v1/chat", { message: q, mode });
      let sources: ChatSource[] = [];
      try {
        const parsed = ChatSourceListSchema.safeParse(JSON.parse(res.headers.get("X-Entri-Sources") ?? "[]"));
        if (parsed.success) sources = parsed.data;
      } catch {
        sources = [];
      }

      if (!res.body) {
        const fallback = await res.text();
        setMessages((m) => updateLast(m, fallback, sources));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((m) => updateLast(m, acc, sources));
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      }
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
              : "Your notes first — and when they don’t cover it, entri answers from general AI knowledge, clearly labeled."}
          </p>
        </div>
        <ModeToggle mode={mode} onChange={changeMode} />
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
              <AssistantBubble key={i} text={m.text} sources={m.sources} />
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
// collapse past three behind a "show more".
function AssistantBubble({ text, sources }: { text: string; sources?: ChatSource[] }) {
  const [expanded, setExpanded] = useState(false);
  const all = sources ?? [];
  const ai = all.filter((s) => s.kind === "ai");
  const notes = all.filter((s) => s.kind === "note");
  const LIMIT = 3;
  const shownNotes = expanded ? notes : notes.slice(0, LIMIT);
  const hidden = notes.length - shownNotes.length;

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
        <div className="mt-2.5 pt-2.5 border-t border-line flex flex-wrap items-center gap-1.5">
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
      )}
    </div>
  );
}

function updateLast(msgs: Msg[], text: string, sources: ChatSource[]): Msg[] {
  const copy = [...msgs];
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === "ai") {
      copy[i] = { ...copy[i], text, sources };
      break;
    }
  }
  return copy;
}
