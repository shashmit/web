// Response shapes now live in the shared @entri/types package (single source of
// truth for the api↔web contract) as zod schemas + inferred types. Re-exported
// here so existing `@/lib/api-types` imports keep working; the *Schema exports
// let call sites validate responses at runtime (api.get/useGet take a schema).
// daysUntil stays local — it's a UI date helper, not a shape.
export type {
  Profile,
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
} from "@entri/types";
export {
  ProfileSchema,
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
} from "@entri/types";

export function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const ms = new Date(date).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}
