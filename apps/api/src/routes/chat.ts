import { Hono } from "hono";
import { embedMany, streamText } from "ai";
import { ChatRequestSchema, CHAT_FOLLOWUP_MARKER, type ChatSuggestion, type ChatSource } from "@entri/types";
import type { AppEnv } from "../middleware/auth.js";
import { aiConfigured, chatConfigured, embedModel, chatModel, EMBED_MODEL } from "../lib/ai.js";
import { regenerateSuggestions } from "../services/suggestions.js";
import { env } from "../config/env.js";

export const chat = new Hono<AppEnv>();

// GET /v1/chat/suggestions — starter prompts drawn from the user's OWN cards, so
// each is answerable by the grounded chat below. Served from the chat_suggestions
// cache (refreshed by the ingest worker on every new note); generated lazily on
// first visit for users who captured before this shipped. Empty array degrades
// gracefully (the UI shows a hint instead of misleading generic prompts).
chat.get("/suggestions", async (c) => {
  const db = c.get("db");
  const cached = await db.database
    .from("chat_suggestions")
    .select("question, topic")
    .order("rank", { ascending: true });
  if (cached.error) throw cached.error;
  const rows = (cached.data ?? []) as ChatSuggestion[];
  if (rows.length > 0) return c.json(rows);

  if (!chatConfigured()) return c.json([] as ChatSuggestion[]);
  try {
    return c.json(await regenerateSuggestions(c.get("userId")));
  } catch (e) {
    console.error("[chat] suggestion generation failed", e instanceof Error ? e.message : e);
    return c.json([] as ChatSuggestion[]);
  }
});

type Chunk = { item_id: string; content: string; source_ref: string | null; similarity: number };

// Grounding thresholds for NOTES mode (bge clusters tightly + high — see config/env.ts,
// and the graph's own 0.7 "related" floor). FLOOR = min cosine for a chunk to count as
// relevant; STRONG = one chunk this strong grounds an answer alone. They decide whether
// strict "notes" mode answers or refuses. ("open" mode always answers + blends general
// knowledge, so it is NOT gated by these — it uses its own lenient context floor.)
const FLOOR = env.GROUNDING_FLOOR;
const STRONG = env.GROUNDING_STRONG;

// Snippet shown under a citation's "show more" — collapse whitespace and cap
// length so the X-Entri-Sources header stays small (and the chip stays readable).
const SNIPPET_MAX = 200;
function snippetOf(content: string): string {
  const t = content.replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX).trimEnd()}…` : t;
}

// X-Entri-Sources travels in an HTTP header (latin-1 only), but note labels and
// snippets come from arbitrary user notes — and the snippet ellipsis itself is
// non-ASCII. Escape everything outside ASCII to \uXXXX; it stays valid JSON, so
// the client's plain JSON.parse decodes it back transparently.
function sourcesHeader(sources: ChatSource[]): string {
  return JSON.stringify(sources).replace(/[\x80-\uFFFF]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

// POST /v1/chat  { message, mode } — retrieve-then-generate over the user's own notes.
//   - mode "notes" (default): answer STRICTLY from the notes; refuse unless >=2
//     relevant chunks (or 1 strong chunk) cover it — the trust pillar, no invention.
//   - mode "open" (Notes + AI): ALWAYS answer — ground in the notes where they apply
//     (cited inline) AND supplement with general AI knowledge. The 'ai' chip always
//     shows so general knowledge is never disguised as the user's own notes.
chat.post("/", async (c) => {
  if (!aiConfigured()) return c.json({ error: "AI not configured on the server" }, 503);

  const db = c.get("db");
  const parsed = ChatRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
  const { message, mode } = parsed.data;
  // Multi-turn: the model sees the recent thread, not just the latest message.
  // Capped so the prompt stays bounded; retrieval below still keys off `message`.
  const turns = [...parsed.data.history.slice(-10), { role: "user" as const, content: message }];

  // Embed the query, then nearest-neighbour over the user's chunks (RLS-scoped).
  const { embeddings } = await embedMany({ model: embedModel(), values: [message] });
  const rpc = await db.database.rpc("match_items", {
    query_embedding: JSON.stringify(embeddings[0]),
    model: EMBED_MODEL,
    match_count: 8,
    match_threshold: 0,
  });
  if (rpc.error) throw rpc.error;
  const chunks = (rpc.data ?? []) as Chunk[];

  // Grounding gate.
  const relevant = chunks.filter((ch) => ch.similarity >= FLOOR);
  const grounded = relevant.length >= 2 || (relevant.length === 1 && relevant[0].similarity >= STRONG);

  // Score visibility so FLOOR/STRONG can be tuned against real data (bge runs high).
  console.log(
    `[chat] mode=${mode} grounded=${grounded} floor=${FLOOR} strong=${STRONG} top=[${chunks
      .slice(0, 5)
      .map((ch) => ch.similarity.toFixed(3))
      .join(", ")}]`
  );

  // "open" (Notes + AI): the student opted in to general knowledge, so ALWAYS
  // answer — ground in their notes where those apply (cited inline) and supplement
  // with general AI knowledge. Never gated on the notes; that's the point of the
  // mode. A lenient floor decides which notes to offer the model (so loosely
  // related pages can still be cited), and the 'ai' chip always shows so the answer
  // is never mistaken for pure-notes.
  if (mode === "open") {
    const CONTEXT_FLOOR = 0.45; // lenient — blend mode errs toward offering notes
    const noteCtx = chunks.filter((ch) => ch.similarity >= CONTEXT_FLOOR);
    const context = noteCtx.length
      ? noteCtx.map((ch, i) => `[${i + 1}] (${ch.source_ref ?? "your notes"})\n${ch.content}`).join("\n\n")
      : "(No closely matching notes — answer from general knowledge.)";
    // Dedup sources by label, keeping the first (highest-similarity) chunk's text
    // as the snippet so the UI can reveal what each citation actually said.
    const seenLabels = new Set<string>();
    const noteSources: ChatSource[] = [];
    for (const ch of noteCtx) {
      const label = ch.source_ref;
      if (!label || seenLabels.has(label)) continue;
      seenLabels.add(label);
      noteSources.push({ label, kind: "note", snippet: snippetOf(ch.content) });
    }
    const sources: ChatSource[] = [...noteSources, { label: "General AI knowledge", kind: "ai" }];

    const openSystem = `You are entri, a knowledgeable, friendly study tutor for a student preparing for an exam. Answer their question fully and accurately. They've turned on "Notes + AI", so use BOTH their own notes (below, where relevant) and your general knowledge.
Rules:
- When a fact comes from their notes, CITE it inline as (→ <source>) using the labels shown.
- Add accurate, well-established general knowledge to complete or clarify the answer. Do NOT attach a (→ source) citation to general knowledge, and never claim it came from their notes.
- Ignore any note snippet below that isn't actually relevant to the question.
- If their notes and general knowledge conflict, point out the discrepancy rather than silently overriding their notes.
- If you're unsure or the question is ambiguous, say so plainly rather than guessing.
- Format with light Markdown for readability: **bold** key terms, *italics* for emphasis, "-" bullet lists, and short paragraphs.
- AFTER your complete answer, output a line containing exactly ${CHAT_FOLLOWUP_MARKER} and then 2–3 natural follow-up questions the student is likely to ask next about this topic — one per line, phrased as the student would ask them, no numbering or bullets. Write nothing after the last follow-up.
Notes:
${context}`;
    const openResult = streamText({ model: chatModel(), system: openSystem, messages: turns });
    return openResult.toTextStreamResponse({
      headers: { "X-Entri-Sources": sourcesHeader(sources) },
    });
  }

  // "notes" (default): strict — answer ONLY from the notes, refuse if uncovered.
  if (!grounded) {
    return c.text(
      "I can't find this in your notes yet. Capture the page it's on, or switch on “Notes + AI” to let me answer from general knowledge."
    );
  }

  const context = relevant
    .map((ch, i) => `[${i + 1}] (${ch.source_ref ?? "your notes"})\n${ch.content}`)
    .join("\n\n");
  const sources: ChatSource[] = [...new Set(relevant.map((ch) => ch.source_ref).filter(Boolean))].map(
    (label) => ({ label: label as string, kind: "note" })
  );

  const system = `You are entri, answering a student strictly from THEIR OWN notes below.
Rules:
- Use ONLY the provided notes. Do not add outside facts.
- Cite the source inline in the form (→ <source>) using the source labels shown.
- If the notes don't fully answer, say what they do say and that the rest isn't in their notes.
- Format with light Markdown for readability: **bold** key terms, *italics* for emphasis, "-" bullet lists, and short paragraphs.
Notes:
${context}`;

  const result = streamText({ model: chatModel(), system, messages: turns });
  return result.toTextStreamResponse({
    headers: { "X-Entri-Sources": sourcesHeader(sources) },
  });
});
