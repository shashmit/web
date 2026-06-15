import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { InsForgeClient } from "@insforge/sdk";
import type { AppEnv } from "../middleware/auth.js";
import type { NoteCard, NoteDetail, Graph } from "@entri/types";
import { NotePatchSchema } from "@entri/types";
import { orThrow } from "../utils/index.js";
import { admin } from "../lib/insforge.js";
import { assembleGraph, GRAPH_EDGE_COLS, type EdgeRow, type ConceptRow, type CardRow } from "../services/graph.js";

export const notes = new Hono<AppEnv>();

type NoteRow = {
  id: string;
  title: string | null;
  source_ref: string | null;
  topic: string | null;
  created_at: string;
  items: { body: string | null }[];
};

// Build the full note-detail payload (note + cards + surfaced corrections).
// Shared by GET and PATCH so both always return the same shape.
async function loadDetail(db: InsForgeClient, id: string): Promise<NoteDetail | null> {
  const note = orThrow(
    await db.database.from("notes").select("id, title, source_ref, topic, status, created_at, share_token").eq("id", id).is("deleted_at", null).maybeSingle()
  ) as { id: string; title: string | null; source_ref: string | null; topic: string | null; status: string; created_at: string; share_token: string | null } | null;
  if (!note) return null;

  const items = orThrow(
    await db.database
      .from("items")
      .select("id, question, answer, source_quote, source_highlight, created_at")
      .eq("note_id", id)
      .eq("kind", "card")
      .order("created_at", { ascending: true })
  ) as { id: string; question: string | null; answer: string | null; source_quote: string | null; source_highlight: string | null }[];

  const corrections = orThrow(
    await db.database
      .from("corrections")
      .select("id, original_text, suggested_text, rationale, status, created_at")
      .eq("note_id", id)
      .order("created_at", { ascending: true })
  ) as { id: string; original_text: string; suggested_text: string; rationale: string; status: string }[];

  // Source pages (private bucket; the browser downloads each by blob_key with
  // the user's own session). We only expose the key + page index, never a URL.
  const imgs = orThrow(
    await db.database
      .from("images")
      .select("blob_key, page_index")
      .eq("note_id", id)
      .order("page_index", { ascending: true })
  ) as { blob_key: string; page_index: number }[];

  return {
    id: note.id,
    title: note.title ?? "Untitled note",
    ref: note.source_ref ?? "",
    topic: note.topic,
    status: note.status,
    capturedAt: note.created_at,
    images: imgs.map((im) => ({
      blobKey: im.blob_key,
      pageIndex: im.page_index,
      isPdf: im.blob_key.toLowerCase().endsWith(".pdf"),
    })),
    cards: items.map((it) => ({
      id: it.id,
      question: it.question,
      answer: it.answer,
      source_quote: it.source_quote,
      source_highlight: it.source_highlight,
    })),
    corrections: corrections.map((cr) => ({
      id: cr.id,
      original_text: cr.original_text,
      suggested_text: cr.suggested_text,
      rationale: cr.rationale,
      status: cr.status,
    })),
    shareToken: note.share_token,
  };
}

// GET /v1/notes — recent captures, newest first, with a short excerpt pulled
// from the note's first extracted item. `topic` is the note's category.
notes.get("/", async (c) => {
  const db = c.get("db");
  const rows = orThrow(
    await db.database
      .from("notes")
      .select("id, title, source_ref, topic, created_at, items(body)")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(50)
  ) as NoteRow[];

  return c.json(
    rows.map((n): NoteCard => ({
      id: n.id,
      title: n.title ?? "Untitled note",
      ref: n.source_ref ?? "",
      topic: n.topic,
      excerpt: n.items?.[0]?.body ?? "",
      capturedAt: n.created_at,
    }))
  );
});

// GET /v1/notes/:id — one note with its cards + corrections (RLS-scoped).
notes.get("/:id", async (c) => {
  const detail = await loadDetail(c.get("db"), c.req.param("id"));
  if (!detail) return c.json({ error: "not found" }, 404);
  return c.json(detail satisfies NoteDetail);
});

// GET /v1/notes/:id/graph — this note's local knowledge map: its concepts +
// cards + the typed relations between them, plus similarity edges that link its
// cards out to related cards in OTHER notes (those far cards become nodes too,
// so the mini-map shows where this note connects). RLS-scoped to the caller.
notes.get("/:id/graph", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const mentions = orThrow(
    await db.database.from("concept_mentions").select("concept_id").eq("note_id", id)
  ) as { concept_id: string }[];
  const thisCards = orThrow(
    await db.database.from("items").select("id").eq("note_id", id).eq("kind", "card")
  ) as { id: string }[];
  const thisCardIds = thisCards.map((r) => r.id);

  // Typed edges authored by this note, plus cross-note similarity edges touching
  // its cards (subj or obj side — disjoint, since similarity is always cross-note).
  const typed = orThrow(
    await db.database.from("relations").select(GRAPH_EDGE_COLS).eq("note_id", id)
  ) as EdgeRow[];
  let sims: EdgeRow[] = [];
  if (thisCardIds.length) {
    const [asSubj, asObj] = await Promise.all([
      db.database.from("relations").select(GRAPH_EDGE_COLS).eq("source", "similarity").in("subj_id", thisCardIds),
      db.database.from("relations").select(GRAPH_EDGE_COLS).eq("source", "similarity").in("obj_id", thisCardIds),
    ]);
    sims = [...(orThrow(asSubj) as EdgeRow[]), ...(orThrow(asObj) as EdgeRow[])];
  }
  const rawEdges = [...typed, ...sims];

  // Gather every endpoint the edges reference (incl. far similarity cards).
  const conceptIds = new Set<string>(mentions.map((m) => m.concept_id));
  const cardIds = new Set<string>(thisCardIds);
  for (const e of rawEdges) {
    (e.subj_kind === "concept" ? conceptIds : cardIds).add(e.subj_id);
    (e.obj_kind === "concept" ? conceptIds : cardIds).add(e.obj_id);
  }

  const concepts = conceptIds.size
    ? (orThrow(
        await db.database.from("concepts").select("id, label, topic, origin, confidence, description").in("id", [...conceptIds])
      ) as ConceptRow[])
    : [];
  const cards = cardIds.size
    ? (orThrow(
        await db.database
          .from("items")
          .select("id, question, answer, topic, origin, note_id, notes!inner(deleted_at)")
          .in("id", [...cardIds])
          .is("notes.deleted_at", null)
      ) as CardRow[])
    : [];

  return c.json(assembleGraph(rawEdges, concepts, cards) satisfies Graph);
});

// PATCH /v1/notes/:id — rename / recategorize a note. `topic` is the category;
// empty strings normalize to null. Recategorizing also moves the note's cards
// (items.topic) so readiness weak-spots follow the user's choice.
notes.patch("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const parsed = NotePatchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid fields" }, 400);
  const patch = parsed.data;
  for (const k of ["title", "topic", "source_ref"] as const) {
    if (patch[k] === "") patch[k] = null; // blank input clears the field
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "no updatable fields" }, 400);

  const updated = orThrow(
    await db.database.from("notes").update(patch).eq("id", id).select("id").maybeSingle()
  ) as { id: string } | null;
  if (!updated) return c.json({ error: "not found" }, 404);

  if (patch.topic !== undefined) {
    await db.database.from("items").update({ topic: patch.topic }).eq("note_id", id);
  }

  const detail = await loadDetail(db, id);
  if (!detail) return c.json({ error: "not found" }, 404);
  return c.json(detail satisfies NoteDetail);
});

// DELETE /v1/notes/:id — SOFT delete. The note + items + images stay (recoverable
// via deleted_at), but it's hidden from every notes view and its cards are pulled
// from the study set (card_srs rows removed) so review/readiness stay consistent.
notes.delete("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  // Verify it exists and isn't already deleted (404 otherwise). We flip
  // deleted_at LAST, after the side-effects below succeed — so a mid-way failure
  // returns 500 with the note still live, and the client's retry re-runs the
  // whole (idempotent) cleanup instead of hitting a 404 with orphaned graph rows.
  const existing = orThrow(
    await db.database.from("notes").select("id").eq("id", id).is("deleted_at", null).maybeSingle()
  ) as { id: string } | null;
  if (!existing) return c.json({ error: "not found" }, 404);

  // Drop this note's cards from the daily set / readiness (both query card_srs).
  const items = orThrow(
    await db.database.from("items").select("id").eq("note_id", id)
  ) as { id: string }[];
  const itemIds = items.map((it) => it.id);
  if (itemIds.length) {
    orThrow(await db.database.from("card_srs").delete().in("item_id", itemIds));
  }

  // Purge this note's knowledge-graph footprint. The DB reap triggers fire only
  // on a HARD delete of a card/concept — a note soft-delete leaves items intact,
  // so we clean up by hand (admin client; graph tables are admin-write only):
  // drop this note's mentions, every edge it authored or that touches its cards,
  // then reap concepts left with no mention anywhere (keeping ones still cited by
  // another note). Scoped to userId even though admin bypasses RLS. orThrow each
  // so a failed delete surfaces as 500 rather than silently leaving stale rows.
  const userId = c.get("userId");
  const mentioned = orThrow(
    await admin.database.from("concept_mentions").select("concept_id").eq("user_id", userId).eq("note_id", id)
  ) as { concept_id: string }[];
  const conceptIds = [...new Set(mentioned.map((m) => m.concept_id))];

  orThrow(await admin.database.from("concept_mentions").delete().eq("user_id", userId).eq("note_id", id));
  orThrow(await admin.database.from("relations").delete().eq("user_id", userId).eq("note_id", id));
  if (itemIds.length) {
    // Similarity edges carry note_id=null, so reach them via this note's cards.
    orThrow(await admin.database.from("relations").delete().eq("user_id", userId).eq("source", "similarity").in("subj_id", itemIds));
    orThrow(await admin.database.from("relations").delete().eq("user_id", userId).eq("source", "similarity").in("obj_id", itemIds));
  }
  if (conceptIds.length) {
    const still = orThrow(
      await admin.database.from("concept_mentions").select("concept_id").eq("user_id", userId).in("concept_id", conceptIds)
    ) as { concept_id: string }[];
    const alive = new Set(still.map((m) => m.concept_id));
    const orphans = conceptIds.filter((cid) => !alive.has(cid));
    if (orphans.length) {
      orThrow(await admin.database.from("concepts").delete().eq("user_id", userId).in("id", orphans));
    }
  }

  // Everything cleaned up — now hide the note.
  const updated = orThrow(
    await db.database
      .from("notes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle()
  ) as { id: string } | null;
  if (!updated) return c.json({ error: "not found" }, 404);

  return c.body(null, 204);
});

// POST /v1/notes/:id/share — make the note publicly viewable; returns the token
// (idempotent: reuses the existing token if already shared).
notes.post("/:id/share", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const existing = orThrow(
    await db.database.from("notes").select("share_token").eq("id", id).is("deleted_at", null).maybeSingle()
  ) as { share_token: string | null } | null;
  if (!existing) return c.json({ error: "not found" }, 404);

  let token = existing.share_token;
  if (!token) {
    token = randomUUID();
    orThrow(await db.database.from("notes").update({ share_token: token }).eq("id", id).select("id").single());
  }
  return c.json({ shareToken: token });
});

// DELETE /v1/notes/:id/share — revoke the public link.
notes.delete("/:id/share", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  orThrow(await db.database.from("notes").update({ share_token: null }).eq("id", id).select("id").maybeSingle());
  return c.body(null, 204);
});
