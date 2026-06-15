import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import { ConceptBriefSaveSchema, type ConceptBrief, type ChatSource } from "@entri/types";
import { admin } from "../lib/insforge.js";
import { orThrow } from "../utils/index.js";
import { newCard } from "../services/fsrs.js";

export const concepts = new Hono<AppEnv>();

// GET /v1/concepts/:id/brief — the saved "Tell me more" brief for a concept (RLS
// scopes to the owner). Empty `text` = no brief saved yet.
concepts.get("/:id/brief", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const row = orThrow(
    await db.database.from("concepts").select("brief_text, brief_sources, brief_at").eq("id", id).maybeSingle()
  ) as { brief_text: string | null; brief_sources: ChatSource[] | null; brief_at: string | null } | null;
  if (!row) return c.json({ error: "concept not found" }, 404);
  return c.json({
    text: row.brief_text ?? "",
    sources: row.brief_sources ?? [],
    savedAt: row.brief_at,
  } satisfies ConceptBrief);
});

// POST /v1/concepts/:id/brief — persist a generated brief. `concepts` is
// user-read-only, so we write through the admin client, scoped EXPLICITLY to the
// caller (admin bypasses RLS) so one user can't overwrite another's concept.
concepts.post("/:id/brief", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const parsed = ConceptBriefSaveSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);

  const updated = orThrow(
    await admin.database
      .from("concepts")
      .update({
        brief_text: parsed.data.text,
        brief_sources: parsed.data.sources,
        brief_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle()
  ) as { id: string } | null;
  if (!updated) return c.json({ error: "concept not found" }, 404);
  return c.json({ ok: true });
});

// POST /v1/concepts/:id/study — promote a concept into a studyable card and seed
// its FSRS state so it joins the review queue. origin='inferred' so the review UI
// renders it visibly tentative (it's AI-derived, not a verbatim note). Idempotent:
// a concept gets at most one map card (tagged concept:<id>). User client — items
// and card_srs are owner-writable.
concepts.post("/:id/study", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");

  const concept = orThrow(
    await db.database.from("concepts").select("label, topic, description, brief_text").eq("id", id).maybeSingle()
  ) as { label: string; topic: string | null; description: string | null; brief_text: string | null } | null;
  if (!concept) return c.json({ error: "concept not found" }, 404);

  // Prefer the saved brief; fall back to the one-clause gloss. Nothing to study
  // without either — the UI gates on this too, but guard server-side as well.
  const answer = (concept.brief_text || concept.description || "").trim();
  if (!answer) return c.json({ error: "Generate a brief first, then add it to your reviews." }, 400);

  const tag = `concept:${id}`;
  const existing = orThrow(
    await db.database.from("items").select("id").eq("user_id", userId).contains("tags", [tag]).limit(1)
  ) as { id: string }[];
  if (existing.length) return c.json({ itemId: existing[0].id, already: true });

  const item = orThrow(
    await db.database
      .from("items")
      .insert([
        {
          user_id: userId,
          kind: "card",
          origin: "inferred",
          topic: concept.topic,
          question: `What is ${concept.label}?`,
          answer,
          source_ref: "From your knowledge map",
          tags: ["map", tag],
          review_status: "active",
        },
      ])
      .select("id")
      .single()
  ) as { id: string };

  const card = newCard(new Date());
  orThrow(
    await db.database.from("card_srs").insert([
      {
        item_id: item.id,
        user_id: userId,
        due: card.due,
        stability: card.stability,
        difficulty: card.difficulty,
        elapsed_days: card.elapsed_days,
        scheduled_days: card.scheduled_days,
        reps: card.reps,
        lapses: card.lapses,
        state: card.state,
        last_review: card.last_review ?? null,
      },
    ])
  );

  return c.json({ itemId: item.id });
});
