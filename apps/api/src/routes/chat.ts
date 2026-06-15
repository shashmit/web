import { Hono } from "hono";
import { embedMany, streamText } from "ai";
import { ChatRequestSchema, type ChatSuggestion } from "@entri/types";
import type { AppEnv } from "../middleware/auth.js";
import { aiConfigured, chatConfigured, embedModel, chatModel, EMBED_MODEL } from "../lib/ai.js";
import { regenerateSuggestions } from "../services/suggestions.js";

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

const FLOOR = 0.3; // min cosine similarity to count a chunk as relevant
const STRONG = 0.55; // a single chunk this strong is enough (sparse-corpus degrade)

// POST /v1/chat  { message } — retrieve-then-generate over the user's own notes.
// >=2 relevant chunks, or 1 strong chunk, grounds an answer; otherwise it
// refuses rather than inventing. Answers cite the source page inline.
chat.post("/", async (c) => {
  if (!aiConfigured()) return c.json({ error: "AI not configured on the server" }, 503);

  const db = c.get("db");
  const parsed = ChatRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
  const { message } = parsed.data;

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
  if (!grounded) {
    return c.text(
      "I can't find this in your notes yet. Capture the page it's on and I'll be able to answer from your own material."
    );
  }

  const context = relevant
    .map((ch, i) => `[${i + 1}] (${ch.source_ref ?? "your notes"})\n${ch.content}`)
    .join("\n\n");
  const sources = [...new Set(relevant.map((ch) => ch.source_ref).filter(Boolean))];

  const system = `You are entri, answering a student strictly from THEIR OWN notes below.
Rules:
- Use ONLY the provided notes. Do not add outside facts.
- Cite the source inline in the form (→ <source>) using the source labels shown.
- If the notes don't fully answer, say what they do say and that the rest isn't in their notes.
Notes:
${context}`;

  const result = streamText({ model: chatModel(), system, prompt: message });
  return result.toTextStreamResponse({
    headers: { "X-Entri-Sources": JSON.stringify(sources) },
  });
});
