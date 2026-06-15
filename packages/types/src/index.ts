// @entri/types — the single source of truth for the entri API contract.
// Shapes are zod schemas; the TS types are inferred from them (z.infer), so the
// type and the runtime validator can never disagree. Both the Hono API
// (apps/api) and the web app (apps/web) import these:
//   - web validates responses it receives (api.get(path, Schema))
//   - api validates request bodies it receives (Schema.parse(body))
// One definition, checked at compile time AND runtime, on both sides.
import { z } from "zod";

// ───────────────────────── responses ─────────────────────────

/** GET /v1/me, PATCH /v1/me — exams now live in their own table (GET /v1/exams). */
export const ProfileSchema = z.object({
  user_id: z.string(),
  display_name: z.string().nullable(),
  timezone: z.string(),
  study_hour_local: z.number(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** GET /v1/exams — a student's tracked exams, soonest first. */
export const ExamSchema = z.object({
  id: z.string(),
  name: z.string(),
  exam_date: z.string(), // ISO date (YYYY-MM-DD)
});
export type Exam = z.infer<typeof ExamSchema>;
export const ExamListSchema = z.array(ExamSchema);

/** POST /v1/exams, PATCH /v1/exams/:id body. */
export const ExamUpsertSchema = z.object({
  name: z.string().trim().min(1, "name required"),
  exam_date: z.string().trim().min(1, "date required"),
});
export type ExamUpsert = z.infer<typeof ExamUpsertSchema>;

/** GET /v1/today */
export const TodaySummarySchema = z.object({
  dueCards: z.number(),
  completed: z.number(),
  estMinutes: z.number(),
});
export type TodaySummary = z.infer<typeof TodaySummarySchema>;

/** GET /v1/streak — `week` is a 7-day strip; `null` = today, not-yet-done. */
export const StreakSchema = z.object({
  days: z.number(),
  longest: z.number(),
  week: z.array(z.boolean().nullable()),
});
export type Streak = z.infer<typeof StreakSchema>;

/** GET /v1/readiness */
export const ReadinessSchema = z.object({
  percent: z.number(),
  examDate: z.string().nullable(),
  cardCount: z.number(),
  topics: z.array(z.object({ topic: z.string(), percent: z.number() })),
  deltaWeek: z.number().nullable(),
});
export type Readiness = z.infer<typeof ReadinessSchema>;

/** GET /v1/notes */
export const NoteCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  ref: z.string(),
  topic: z.string().nullable(),
  excerpt: z.string(),
  capturedAt: z.string(),
});
export type NoteCard = z.infer<typeof NoteCardSchema>;
export const NoteCardListSchema = z.array(NoteCardSchema);

/** GET /v1/inferred — AI-inferred facts awaiting the user's OK. */
export const InferredItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  ref: z.string(),
});
export type InferredItem = z.infer<typeof InferredItemSchema>;
export const InferredItemListSchema = z.array(InferredItemSchema);

/** Whether a card came verbatim from a note or was AI-inferred (then accepted). */
export const CardOriginSchema = z.enum(["note", "inferred"]);
export type CardOrigin = z.infer<typeof CardOriginSchema>;

/** GET /v1/review/queue */
export const ReviewCardSchema = z.object({
  id: z.string(),
  topic: z.string().nullable(),
  origin: CardOriginSchema,
  question: z.string().nullable(),
  answer: z.string().nullable(),
  source: z.object({ quote: z.string(), highlight: z.string(), ref: z.string() }),
  intervals: z.object({ again: z.string(), hard: z.string(), good: z.string(), easy: z.string() }),
});
export type ReviewCard = z.infer<typeof ReviewCardSchema>;
export const ReviewCardListSchema = z.array(ReviewCardSchema);

/** GET /v1/notes/:id — a single note with its extracted cards + surfaced corrections. */
export const NoteCardItemSchema = z.object({
  id: z.string(),
  question: z.string().nullable(),
  answer: z.string().nullable(),
  source_quote: z.string().nullable(),
  source_highlight: z.string().nullable(),
});
export type NoteCardItem = z.infer<typeof NoteCardItemSchema>;

export const NoteCorrectionSchema = z.object({
  id: z.string(),
  original_text: z.string(),
  suggested_text: z.string(),
  rationale: z.string(),
  status: z.string(),
});
export type NoteCorrection = z.infer<typeof NoteCorrectionSchema>;

/** A source page uploaded for the note (lives in the private note-images bucket;
 * the browser downloads it by key with the user's own session). */
export const NoteImageSchema = z.object({
  blobKey: z.string(),
  pageIndex: z.number(),
  isPdf: z.boolean(),
});
export type NoteImage = z.infer<typeof NoteImageSchema>;

export const NoteDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  ref: z.string(),
  topic: z.string().nullable(),
  status: z.string(),
  capturedAt: z.string(),
  cards: z.array(NoteCardItemSchema),
  corrections: z.array(NoteCorrectionSchema),
  images: z.array(NoteImageSchema),
  shareToken: z.string().nullable(),
});
export type NoteDetail = z.infer<typeof NoteDetailSchema>;

/** GET /public/notes/:token — read-only public view of a shared note. No keys
 * are exposed; images load from /public/notes/:token/image/:pageIndex. */
export const SharedNoteSchema = z.object({
  title: z.string(),
  topic: z.string().nullable(),
  ref: z.string(),
  capturedAt: z.string(),
  cards: z.array(NoteCardItemSchema),
  corrections: z.array(NoteCorrectionSchema),
  images: z.array(z.object({ pageIndex: z.number(), isPdf: z.boolean() })),
});
export type SharedNote = z.infer<typeof SharedNoteSchema>;

// ───────────────────────── knowledge graph ("Map") ─────────────────────────
// GET /v1/graph (global) and GET /v1/notes/:id/graph (per-note) both return this.
// Node ids are prefixed ("concept:<uuid>" | "card:<uuid>") so the two kinds share
// one collision-free id namespace (the force-graph engine mutates edge endpoints
// into node refs by id). Fields are flat; origin='inferred' drives tentative styling.
export const GraphNodeKindSchema = z.enum(["concept", "card"]);
export const GraphEdgeKindSchema = z.enum(["relation", "similarity"]);

export const GraphNodeSchema = z.object({
  id: z.string(),
  kind: GraphNodeKindSchema,
  label: z.string(), // card -> the question; concept -> the concept name
  answer: z.string().nullable(), // card -> its answer (for the hover popover); null for concepts
  description: z.string().nullable(), // concept -> one-clause AI gloss (tentative); null for cards
  topic: z.string().nullable(),
  noteId: z.string().nullable(), // card -> its note; concept -> a primary note or null
  origin: CardOriginSchema, // 'inferred' concepts render tentative
  confidence: z.number().min(0).max(1),
  degree: z.number().int().nonnegative(), // computed at read -> node size / label priority
  hasStory: z.boolean(), // concept -> a saved "Tell me more" brief exists (graph ring); false for cards
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  source: z.string(), // node id
  target: z.string(),
  kind: GraphEdgeKindSchema, // 'relation' = AI-typed, 'similarity' = embedding
  label: z.string().nullable(), // predicate; null for similarity
  weight: z.number().min(0).max(1),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  truncated: z.boolean(),
});
export type Graph = z.infer<typeof GraphSchema>;

// ───────────────────────── requests ─────────────────────────

/** Chat answering mode. `notes` = grounded strictly in the user's own material
 * (refuses what isn't there). `open` = notes first, but if the notes don't cover
 * it the assistant may answer from general AI knowledge (clearly labeled). */
export const ChatModeSchema = z.enum(["notes", "open"]);
export type ChatMode = z.infer<typeof ChatModeSchema>;

/** One prior turn, sent so chat can be multi-turn (the model sees the thread,
 * not just the latest message). Retrieval still keys off the newest message. */
export const ChatTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

/** POST /v1/chat body */
export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1, "empty message"),
  mode: ChatModeSchema.optional().default("notes"),
  history: z.array(ChatTurnSchema).max(20).optional().default([]),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** A provenance chip shown under a chat answer (sent via the X-Entri-Sources
 * header). `note` = a cited page from the user's OWN material (trusted/teal);
 * `ai` = general AI knowledge, rendered visibly tentative (dashed taupe) and
 * never disguised as the user's notes. */
export const ChatSourceSchema = z.object({
  label: z.string(),
  kind: z.enum(["note", "ai"]),
  /** For `note` sources: the actual snippet the answer drew on (truncated),
   * revealed under "show more" so a citation can be inspected, not just named. */
  snippet: z.string().optional(),
});
export type ChatSource = z.infer<typeof ChatSourceSchema>;
export const ChatSourceListSchema = z.array(ChatSourceSchema);

/** Sentinel the model emits after its answer in "Notes + AI" mode, followed by
 * suggested follow-up questions (one per line). The API instructs the model to
 * print it; the web client splits on it so the marker + follow-ups never render
 * in the answer body — they become tappable prompts under the answer instead. */
export const CHAT_FOLLOWUP_MARKER = "§FOLLOWUPS§";

/** GET /v1/concepts/:id/brief — a saved "Tell me more" brief for a concept,
 * generated on the map and persisted so it isn't regenerated (and so the node
 * can show a "has a story" ring). Empty `text` = no brief saved yet. */
export const ConceptBriefSchema = z.object({
  text: z.string(),
  sources: ChatSourceListSchema,
  savedAt: z.string().nullable(),
});
export type ConceptBrief = z.infer<typeof ConceptBriefSchema>;

/** POST /v1/concepts/:id/brief body. */
export const ConceptBriefSaveSchema = z.object({
  text: z.string().trim().min(1, "empty brief"),
  sources: ChatSourceListSchema.optional().default([]),
});
export type ConceptBriefSave = z.infer<typeof ConceptBriefSaveSchema>;

/** GET /v1/chat/suggestions — LLM-generated prompts drawn from the user's own
 * cards, so each one is answerable by the grounded chat. `topic` is an optional
 * label for grouping/affordance in the UI. */
export const ChatSuggestionSchema = z.object({
  question: z.string(),
  topic: z.string().nullable(),
});
export type ChatSuggestion = z.infer<typeof ChatSuggestionSchema>;
export const ChatSuggestionListSchema = z.array(ChatSuggestionSchema);

/** PATCH /v1/me body — every field optional; unknown keys are stripped. */
export const ProfilePatchSchema = z.object({
  display_name: z.string().nullable().optional(),
  timezone: z.string().optional(),
  study_hour_local: z.number().optional(),
});
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

/** PATCH /v1/notes/:id body — rename + recategorize a note. `topic` is the category. */
export const NotePatchSchema = z.object({
  title: z.string().nullable().optional(),
  topic: z.string().nullable().optional(),
  source_ref: z.string().nullable().optional(),
});
export type NotePatch = z.infer<typeof NotePatchSchema>;
