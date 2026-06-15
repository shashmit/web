// Response shapes now live in the shared @entri/types package (single source of
// truth for the api↔web contract) as zod schemas + inferred types. Re-exported
// here so existing `@/lib/api-types` imports keep working; the *Schema exports
// let call sites validate responses at runtime (api.get/useGet take a schema).
// daysUntil stays local — it's a UI date helper, not a shape.
export type {
  Profile,
  Exam,
  ExamUpsert,
  TodaySummary,
  Streak,
  Readiness,
  NoteCard,
  InferredItem,
  CardOrigin,
  ReviewCard,
  NoteDetail,
  NoteCardItem,
  NoteCorrection,
  SharedNote,
  Graph,
  GraphNode,
  GraphEdge,
  ChatSuggestion,
  ChatMode,
  ChatSource,
} from "@entri/types";
export {
  ProfileSchema,
  ExamSchema,
  ExamListSchema,
  ExamUpsertSchema,
  TodaySummarySchema,
  StreakSchema,
  ReadinessSchema,
  NoteCardListSchema,
  InferredItemListSchema,
  ReviewCardListSchema,
  NoteDetailSchema,
  SharedNoteSchema,
  GraphSchema,
  ChatSuggestionListSchema,
  ChatSourceListSchema,
} from "@entri/types";

export function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const ms = new Date(date).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

// The exam to surface in ambient chrome (sidebar/header/greeting): the soonest
// one still ahead, or — if every tracked exam is past — the most recent. Mirrors
// the API's readiness fallback so the countdown and the % agree by default.
export function nextExam<T extends { exam_date: string }>(exams: T[] | null | undefined): T | null {
  if (!exams || exams.length === 0) return null;
  const sorted = [...exams].sort((a, b) => (a.exam_date < b.exam_date ? -1 : 1));
  const today = new Date().toISOString().slice(0, 10);
  return sorted.find((e) => e.exam_date >= today) ?? sorted[sorted.length - 1];
}
