import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import type { Graph } from "@entri/types";
import { orThrow } from "../utils/index.js";
import { assembleGraph, type EdgeRow, type ConceptRow, type CardRow } from "../services/graph.js";

export const graph = new Hono<AppEnv>();

// GET /v1/graph — the whole-corpus knowledge map (RLS-scoped to the caller).
graph.get("/", async (c) => {
  const db = c.get("db");
  const ed = await db.database.rpc("graph_corpus_edges", { max_relation: 1500, max_similarity: 600 });
  if (ed.error) throw ed.error;
  const rawEdges = (ed.data ?? []) as EdgeRow[];
  if (!rawEdges.length) return c.json({ nodes: [], edges: [], truncated: false } satisfies Graph);

  const conceptIds = new Set<string>();
  const cardIds = new Set<string>();
  for (const e of rawEdges) {
    (e.subj_kind === "concept" ? conceptIds : cardIds).add(e.subj_id);
    (e.obj_kind === "concept" ? conceptIds : cardIds).add(e.obj_id);
  }

  const concepts = conceptIds.size
    ? (orThrow(
        await db.database.from("concepts").select("id, label, topic, origin, confidence, description, brief_at").in("id", [...conceptIds])
      ) as ConceptRow[])
    : [];
  // cards filtered to live (non-deleted) notes — defense-in-depth alongside the
  // delete handler's purge.
  const cards = cardIds.size
    ? (orThrow(
        await db.database
          .from("items")
          .select("id, question, answer, topic, origin, note_id, notes!inner(deleted_at)")
          .in("id", [...cardIds])
          .is("notes.deleted_at", null)
      ) as CardRow[])
    : [];

  // graph_corpus_edges caps the two edge pools INDEPENDENTLY (max_relation,
  // max_similarity). Detect saturation per-pool — summing them would miss the
  // common case where typed relations hit their cap but similarity is sparse,
  // silently dropping the edges users care about most.
  const relCount = rawEdges.reduce((n, e) => n + (e.source === "extracted" ? 1 : 0), 0);
  const simCount = rawEdges.length - relCount;
  const truncatedAtCap = relCount >= 1500 || simCount >= 600;
  const g = assembleGraph(rawEdges, concepts, cards);
  return c.json({ ...g, truncated: g.truncated || truncatedAtCap } satisfies Graph);
});
