import { generateText, Output, wrapLanguageModel, extractJsonMiddleware } from "ai";
import { z } from "zod";
import type { InsForgeClient } from "@insforge/sdk";
import type { Graph, GraphNode, GraphEdge } from "@entri/types";
import { chatModel, EMBED_MODEL } from "../lib/ai.js";
import { chunkLines, mapLimit } from "./extract.js";

// ── Concept + typed-relation extraction (the "Map" knowledge graph). ──────────
// Runs on the ALREADY-STRUCTURED cards (not raw OCR): cheaper, denoised, and
// grounded in verified text. Same chunk-and-parallelize + fail-soft pattern as
// structureNotes so it never trips Cloudflare's request timeout.

const GraphExtraction = z.object({
  concepts: z.array(
    z.object({
      label: z.string(), // canonical display form, e.g. "NITI Aayog"
      kind: z.enum(["concept", "entity", "term", "event", "other"]),
      description: z.string(), // one short clause, "" if none
    })
  ),
  relations: z.array(
    z.object({
      subject: z.string(), // must match a concept label above
      predicate: z.string(), // short verb phrase: "regulates", "under", "launched"
      object: z.string(), // must match a concept label above
      confidence: z.enum(["explicit", "inferred"]), // stated vs reasoned
    })
  ),
});
type GraphExtraction = z.infer<typeof GraphExtraction>;

const GRAPH_PROMPT = `You build a concept map from a student's study notes (already turned into flashcards).

From the cards below, extract:
- "concepts": the distinct named entities / key terms / concepts the cards are about (e.g. "SEBI", "AIF", "NITI Aayog", "social impact fund"). Use the canonical surface form the student wrote; expand an acronym only if you are certain. Give each a kind and a one-clause description ("" if none).
- "relations": how those concepts relate, as subject–predicate–object triples where BOTH subject and object are labels from your concepts list. predicate is a short verb phrase ("regulates", "is under", "launched", "part of", "approved"). Mark confidence "explicit" if the notes state it directly, "inferred" if you reasoned it.

Rules:
- Only include relations whose subject AND object are in your concepts list.
- Do NOT invent facts or relations the notes don't support. Prefer fewer, well-grounded relations.
- Keep concept labels short (a name or term, not a sentence).`;

async function extractGraphChunk(chunk: string): Promise<GraphExtraction> {
  const model = wrapLanguageModel({ model: chatModel(), middleware: extractJsonMiddleware() });
  try {
    const { output } = await generateText({
      model,
      prompt: `${GRAPH_PROMPT}\n\nCARDS:\n${chunk}`,
      maxOutputTokens: 4096,
      maxRetries: 1,
      output: Output.object({ schema: GraphExtraction }),
    });
    return output;
  } catch (e) {
    console.error("[graph] chunk failed, skipping", e instanceof Error ? e.message : e);
    return { concepts: [], relations: [] };
  }
}

export type GraphCard = {
  id: string;
  question: string | null;
  answer: string | null;
  source_quote: string | null;
  source_highlight: string | null;
};

/** Extract concepts + typed relations from a note's structured cards. */
export async function extractGraph(cards: GraphCard[]): Promise<GraphExtraction> {
  const text = cards
    .map((c) => [c.question, c.answer, c.source_quote].filter(Boolean).join(" — "))
    .filter(Boolean)
    .join("\n");
  if (!text.trim()) return { concepts: [], relations: [] };

  const chunks = chunkLines(text);
  const results =
    chunks.length === 1 ? [await extractGraphChunk(chunks[0])] : await mapLimit(chunks, 4, extractGraphChunk);

  // Merge: dedupe concepts by normalized label; keep all relations.
  const byNorm = new Map<string, { label: string; kind: string; description: string }>();
  for (const r of results) for (const c of r.concepts) {
    const k = norm(c.label);
    if (k && !byNorm.has(k)) byNorm.set(k, { label: c.label.trim(), kind: c.kind, description: c.description });
  }
  const concepts = [...byNorm.values()];
  const relations = results.flatMap((r) => r.relations);
  return { concepts, relations } as GraphExtraction;
}

// TS twin of the DB norm_label(): lowercase, collapse whitespace, trim non-alnum
// edges. MUST stay in sync — it's the dedupe key we insert into concepts.norm.
// The edge class mirrors Postgres [:alnum:] under a UTF-8 locale: Unicode LETTERS
// (\p{L}, so "café" survives) + ASCII digits [0-9]. Do NOT use \p{N} here — it
// also matches No/Nl number chars (²/₂/½/Ⅱ/①) that [:alnum:] rejects, which would
// make "CO₂" hash to "co₂" in TS but "co" in SQL and split one concept into two.
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\p{L}0-9]+|[^\p{L}0-9]+$/gu, "");
}

// ── Persist the graph (admin client — RLS bypassed, so EVERY row is scoped to
// userId explicitly; reads are scoped too to avoid cross-tenant concept reuse). ─
type WriteCtx = { userId: string; noteId: string; topic: string | null; cards: GraphCard[] };

export async function writeConceptGraph(admin: InsForgeClient, ctx: WriteCtx, graph: GraphExtraction): Promise<void> {
  const { userId, noteId, topic, cards } = ctx;
  if (!graph.concepts.length) return;

  // 1) Upsert concepts (dedupe on (user_id, norm)); get ids back.
  const conceptRows = graph.concepts
    .map((c) => ({ user_id: userId, label: c.label, norm: norm(c.label), kind: c.kind, description: c.description || null, topic, origin: "inferred" as const }))
    .filter((r) => r.norm.length > 0);
  if (!conceptRows.length) return;

  const up = await admin.database
    .from("concepts")
    .upsert(conceptRows, { onConflict: "user_id,norm" })
    .select("id, norm");
  if (up.error) throw up.error;
  const idByNorm = new Map<string, string>();
  for (const row of (up.data ?? []) as { id: string; norm: string }[]) idByNorm.set(row.norm, row.id);

  // 2) Concept→concept typed relations (both endpoints must resolve).
  const relRows: Record<string, unknown>[] = [];
  for (const r of graph.relations) {
    const s = idByNorm.get(norm(r.subject));
    const o = idByNorm.get(norm(r.object));
    if (!s || !o || s === o) continue;
    relRows.push({
      user_id: userId, subj_kind: "concept", subj_id: s, obj_kind: "concept", obj_id: o,
      predicate: r.predicate.slice(0, 60), source: "extracted", confidence: r.confidence,
      weight: r.confidence === "explicit" ? 0.9 : 0.6, note_id: noteId,
    });
  }

  // 3) Concept→card "appears in" edges + mentions: a concept grounded to the card
  //    whose verbatim line names it. Always emit a note-level mention so every
  //    concept has >=1 mention (drives orphan-reap on note delete).
  const mentionRows: Record<string, unknown>[] = [];
  for (const c of graph.concepts) {
    const cid = idByNorm.get(norm(c.label));
    if (!cid) continue;
    mentionRows.push({ user_id: userId, concept_id: cid, note_id: noteId, item_id: null });
    const needle = c.label.toLowerCase();
    if (needle.length < 3) continue;
    for (const card of cards) {
      const hay = `${card.source_highlight ?? ""} ${card.source_quote ?? ""} ${card.question ?? ""} ${card.answer ?? ""}`.toLowerCase();
      if (hay.includes(needle)) {
        relRows.push({
          user_id: userId, subj_kind: "concept", subj_id: cid, obj_kind: "card", obj_id: card.id,
          predicate: "appears in", source: "extracted", confidence: "explicit", weight: 0.7, note_id: noteId,
        });
        mentionRows.push({ user_id: userId, concept_id: cid, note_id: noteId, item_id: card.id, snippet: card.source_quote ?? null });
      }
    }
  }

  if (mentionRows.length) {
    const m = await admin.database
      .from("concept_mentions")
      .upsert(mentionRows, { onConflict: "user_id,concept_id,note_id,item_id", ignoreDuplicates: true });
    if (m.error) throw m.error;
  }
  if (relRows.length) {
    const r = await admin.database
      .from("relations")
      .upsert(relRows, { onConflict: "user_id,subj_kind,subj_id,obj_kind,obj_id,predicate,source", ignoreDuplicates: true });
    if (r.error) throw r.error;
  }
}

// ── Similarity edges: cross-note "related" links between cards via embeddings. ──
const SIM_K = 6; // neighbours per card
const SIM_FLOOR = 0.7; // cosine floor (bge clusters tightly; keep it high)
const SIM_MAX_PER_NOTE = 120; // cap total similarity edges written per ingest

/** For each new card, fetch cross-note nearest neighbours and store card↔card
 *  'similarity' relations (subj_id < obj_id, deduped by the relations UNIQUE). */
export async function buildSimilarityEdges(admin: InsForgeClient, userId: string, itemIds: string[]): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const itemId of itemIds) {
    if (rows.length >= SIM_MAX_PER_NOTE) break;
    const res = await admin.database.rpc("match_neighbors_for", {
      source_item_id: itemId, caller_user_id: userId, model: EMBED_MODEL,
      match_count: SIM_K, match_threshold: SIM_FLOOR,
    });
    if (res.error) {
      console.error("[graph] similarity rpc failed for", itemId, res.error.message);
      continue;
    }
    for (const n of (res.data ?? []) as { neighbor_item_id: string; similarity: number }[]) {
      const [a, b] = itemId < n.neighbor_item_id ? [itemId, n.neighbor_item_id] : [n.neighbor_item_id, itemId];
      rows.push({
        user_id: userId, subj_kind: "card", subj_id: a, obj_kind: "card", obj_id: b,
        predicate: "related", source: "similarity",
        weight: Math.min(1, Math.max(0, Math.round(n.similarity * 1000) / 1000)),
        note_id: null,
      });
    }
  }
  if (rows.length) {
    const r = await admin.database
      .from("relations")
      .upsert(rows, { onConflict: "user_id,subj_kind,subj_id,obj_kind,obj_id,predicate,source", ignoreDuplicates: true });
    if (r.error) throw r.error;
  }
}

// ── Read side: assemble a renderable graph from stored rows. Used by the /graph
// route (whole-corpus map) and by /notes/:id (per-note subgraph). ──────────────
const NODE_CAP = 400; // hard ceiling so a huge corpus stays renderable

export type EdgeRow = {
  subj_kind: "concept" | "card";
  subj_id: string;
  obj_kind: "concept" | "card";
  obj_id: string;
  predicate: string;
  source: "extracted" | "similarity";
  confidence: string | null;
  weight: number | string;
};
export type ConceptRow = { id: string; label: string; topic: string | null; origin: string; confidence: number | string; description: string | null };
export type CardRow = { id: string; question: string | null; answer: string | null; topic: string | null; origin: string; note_id: string | null };

export const GRAPH_EDGE_COLS = "subj_kind, subj_id, obj_kind, obj_id, predicate, source, confidence, weight";

const nid = (kind: string, id: string) => `${kind}:${id}`;

// Assemble {nodes, edges, truncated} from raw edge rows + the concept/card records
// they reference. Node set is derived FROM the edges; degree is counted from the
// kept edges; capping or a missing/deleted endpoint drops the node+edge and flags
// truncated — so no edge ever dangles and no strong edge is silently lost.
export function assembleGraph(
  rawEdges: EdgeRow[],
  concepts: ConceptRow[],
  cards: CardRow[],
  nodeCap = NODE_CAP
): Graph {
  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const present = (kind: string, id: string) =>
    kind === "concept" ? conceptById.has(id) : cardById.has(id);

  // edges whose BOTH endpoints we actually fetched (others were deleted/missing)
  const live = rawEdges.filter((e) => present(e.subj_kind, e.subj_id) && present(e.obj_kind, e.obj_id));
  let truncated = live.length < rawEdges.length;

  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const e of live) {
    bump(nid(e.subj_kind, e.subj_id));
    bump(nid(e.obj_kind, e.obj_id));
  }

  // candidate nodes = endpoints of live edges
  const wanted = new Set<string>();
  for (const e of live) {
    wanted.add(nid(e.subj_kind, e.subj_id));
    wanted.add(nid(e.obj_kind, e.obj_id));
  }
  let nodes: GraphNode[] = [...wanted].map((id) => {
    const [kind, raw] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
    if (kind === "concept") {
      const c = conceptById.get(raw)!;
      return {
        id, kind: "concept" as const, label: c.label, answer: null, description: c.description ?? null,
        topic: c.topic, noteId: null,
        origin: (c.origin === "note" ? "note" : "inferred") as GraphNode["origin"],
        confidence: Number(c.confidence), degree: degree.get(id) ?? 0,
      };
    }
    const c = cardById.get(raw)!;
    return {
      id, kind: "card" as const, label: c.question ?? "(card)", answer: c.answer, description: null,
      topic: c.topic, noteId: c.note_id,
      origin: (c.origin === "inferred" ? "inferred" : "note") as GraphNode["origin"],
      confidence: 1, degree: degree.get(id) ?? 0,
    };
  });

  // cap by degree
  if (nodes.length > nodeCap) {
    nodes = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, nodeCap);
    truncated = true;
  }
  const keep = new Set(nodes.map((n) => n.id));

  const edges: GraphEdge[] = [];
  for (const e of live) {
    const s = nid(e.subj_kind, e.subj_id);
    const t = nid(e.obj_kind, e.obj_id);
    if (!keep.has(s) || !keep.has(t)) {
      truncated = true;
      continue;
    }
    edges.push({
      source: s, target: t,
      kind: e.source === "extracted" ? "relation" : "similarity",
      label: e.source === "extracted" ? e.predicate : null,
      weight: Number(e.weight),
    });
  }
  return { nodes, edges, truncated };
}
