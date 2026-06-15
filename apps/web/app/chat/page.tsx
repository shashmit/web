"use client";

import { useRef, useState } from "react";
import { apiStream } from "@/lib/api";
import { useGet } from "@/lib/use-api";
import { ChatSuggestionListSchema, type ChatSuggestion } from "@/lib/api-types";

type Msg = { role: "you" | "ai"; text: string; sources?: string[] };

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Starter prompts drawn from the user's own cards (LLM-generated, cached
  // server-side and refreshed when new notes land). Each is answerable by the
  // grounded chat, so tapping one never hits the "not in your notes" refusal.
  const { data: suggestions, loading: loadingSuggestions } = useGet<ChatSuggestion[]>(
    "/v1/chat/suggestions",
    ChatSuggestionListSchema
  );

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
      const res = await apiStream("/v1/chat", { message: q });
      let sources: string[] = [];
      try {
        sources = JSON.parse(res.headers.get("X-Entri-Sources") ?? "[]");
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
      <div className="mb-4 px-0.5">
        <h1 className="font-display font-semibold text-[clamp(24px,5.5vw,30px)] tracking-tight leading-[1.1]">
          Ask your notes.
        </h1>
        <p className="text-muted text-[13px] mt-1">
          Answers come only from your own material, with the page cited. If it&apos;s not in your
          notes, it says so.
        </p>
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
              <div key={i} className="self-end max-w-[80%] bg-ink text-paper rounded-md rounded-br-sm px-4 py-2.5 text-[14.5px]">
                {m.text}
              </div>
            ) : (
              <div key={i} className="self-start max-w-[88%] card px-4 py-3 text-[14.5px] leading-[1.6] text-ink-soft whitespace-pre-wrap">
                {m.text || <span className="text-muted">…</span>}
                {m.sources && m.sources.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2.5">
                    {m.sources.map((s) => (
                      <span key={s} className="font-mono text-[10px] text-teal bg-teal-soft rounded-[3px] px-2 py-[3px]">
                        <span aria-hidden="true">→</span> {s}
                      </span>
                    ))}
                  </div>
                )}
              </div>
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
            placeholder="Ask about your notes…"
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
          Answers are grounded in your own notes — entri won&apos;t invent facts.
        </p>
      </form>
    </div>
  );
}

function updateLast(msgs: Msg[], text: string, sources: string[]): Msg[] {
  const copy = [...msgs];
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === "ai") {
      copy[i] = { ...copy[i], text, sources };
      break;
    }
  }
  return copy;
}
