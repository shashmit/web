import { generateText, Output, wrapLanguageModel, extractJsonMiddleware } from "ai";
import { z } from "zod";
import type { ChatSuggestion } from "@entri/types";
import { admin } from "../lib/insforge.js";
import { chatConfigured, chatModel } from "../lib/ai.js";

// "Ask your notes" suggested prompts, generated FROM the student's own cards so
// every suggestion is answerable by the grounded RAG (chat.ts refuses anything
// not in their notes — a suggestion that can't be answered would be a dead end).
// Cached in chat_suggestions and replaced wholesale; the ingest worker calls
// this after each new note, and the chat route lazily on first visit.

const COUNT = 6; // ask for 6 so the UI always has the "at least 5" it wants
const MAX_CARDS = 50; // cap the prompt: a recent, diverse slice is plenty

const Suggestions = z.object({
  questions: z.array(z.object({ question: z.string(), topic: z.string() })),
});

const PROMPT = `You are entri. Below are flashcards extracted from a student's OWN study notes (topic · question · answer). Propose ${COUNT} short, natural questions the student could ask an assistant that answers ONLY from these notes.

Rules:
- Every question MUST be answerable from the flashcards above — never ask about anything not present.
- Spread them across the DIFFERENT topics you see; do not cluster on one topic.
- Vary the type: some recall ("What is…", "Define…"), some reasoning ("Why does…", "How does…"), and one or two synthesis ("Summarise <topic>", "Compare X and Y").
- Phrase them the way a student types — first person where natural ("Why did I…"). Keep each under ~12 words.
- No duplicates, no numbering, no preamble.
Return ${COUNT} questions, each with the single most relevant topic.`;

type CardRow = { question: string | null; answer: string | null; topic: string | null };

/**
 * Regenerate (and persist) a user's suggested chat prompts from their cards.
 * Returns the new set. Uses the admin client (RLS-bypassing) scoped by userId,
 * so it's safe to call from both the worker and the request path. Fail-soft
 * callers should still try/catch — a flaky AI call shouldn't break ingest.
 */
export async function regenerateSuggestions(userId: string): Promise<ChatSuggestion[]> {
  if (!chatConfigured()) return [];

  const res = await admin.database
    .from("items")
    .select("question, answer, topic")
    .eq("user_id", userId)
    .eq("kind", "card")
    .eq("review_status", "active")
    .order("created_at", { ascending: false })
    .limit(MAX_CARDS);
  if (res.error) throw res.error;

  const usable = ((res.data ?? []) as CardRow[]).filter((c) => c.question || c.answer);
  if (usable.length === 0) {
    // Nothing to ground suggestions on — clear any stale ones so the UI is honest.
    await admin.database.from("chat_suggestions").delete().eq("user_id", userId);
    return [];
  }

  const corpus = usable
    .map((c) => `- (${c.topic ?? "general"}) Q: ${c.question ?? ""} A: ${(c.answer ?? "").slice(0, 160)}`)
    .join("\n");

  const model = wrapLanguageModel({ model: chatModel(), middleware: extractJsonMiddleware() });
  const { output } = await generateText({
    model,
    prompt: `${PROMPT}\n\nFLASHCARDS:\n${corpus}`,
    maxOutputTokens: 1024,
    maxRetries: 1,
    output: Output.object({ schema: Suggestions }),
  });

  // Dedupe (case-insensitive) and trim to COUNT.
  const seen = new Set<string>();
  const questions: ChatSuggestion[] = [];
  for (const q of output.questions) {
    const question = q.question.trim();
    const key = question.toLowerCase();
    if (!question || seen.has(key)) continue;
    seen.add(key);
    questions.push({ question, topic: q.topic?.trim() || null });
    if (questions.length >= COUNT) break;
  }
  if (questions.length === 0) return [];

  // Replace the cached set atomically-enough (delete then insert; admin bypasses
  // RLS so we MUST scope the delete by user_id).
  const del = await admin.database.from("chat_suggestions").delete().eq("user_id", userId);
  if (del.error) throw del.error;
  const ins = await admin.database
    .from("chat_suggestions")
    .insert(questions.map((q, i) => ({ user_id: userId, question: q.question, topic: q.topic, rank: i })));
  if (ins.error) throw ins.error;

  return questions;
}
