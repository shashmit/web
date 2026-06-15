import { embedMany } from "ai";
import { admin } from "../lib/insforge.js";
import { aiConfigured, extractionConfigured, embedModel, EMBED_MODEL } from "../lib/ai.js";
import { structureNotes } from "./extract.js";
import { ocr, type OcrFile } from "../lib/sarvam.js";
import { extractGraph, writeConceptGraph, buildSimilarityEdges, type GraphCard } from "./graph.js";
import { regenerateSuggestions } from "./suggestions.js";
import { newCard } from "./fsrs.js";

const BUCKET = "note-images";
const POLL_MS = 3000;
const BACKOFF_MS = 30_000;
// A job that has sat in "running" longer than this is presumed orphaned (e.g. a
// serverless invocation timed out mid-ingest) and gets requeued by drainQueue().
const STALE_RUNNING_MS = 2 * 60_000;

// In-process ingest worker. Drains the `jobs` queue (claim-then-isolate: claims
// across tenants via the admin client, then scopes all work to job.user_id).
// On Cloudflare later this same logic becomes a Workflow/Queue consumer.
export function startWorker() {
  if (!aiConfigured() || !extractionConfigured()) {
    console.log(
      "[worker] AI not fully configured — ingest worker idle (needs OPENROUTER_API_KEY + CLOUDFLARE_* + SARVAM_API_KEY)"
    );
    return;
  }
  console.log("[worker] ingest worker started");
  workerReady = true;
  const tick = async () => {
    try {
      await drainOne();
    } catch (e) {
      console.error("[worker] tick error", e);
    } finally {
      setTimeout(tick, POLL_MS);
    }
  };
  setTimeout(tick, POLL_MS);
}

// Serverless drain (Vercel). No persistent process polls the queue there, so the
// capture route (waitUntil) and a daily cron call this to drain queued jobs in a
// bounded loop. Returns how many it processed. First requeues any orphaned
// "running" jobs (a prior invocation that timed out mid-ingest) so they retry.
export async function drainQueue({
  maxJobs = 25,
  deadlineMs = 55_000,
}: { maxJobs?: number; deadlineMs?: number } = {}): Promise<{ processed: number; skipped?: string }> {
  if (!aiConfigured() || !extractionConfigured()) return { processed: 0, skipped: "ai-not-configured" };
  await reclaimStaleRunning();

  const start = Date.now();
  let processed = 0;
  while (processed < maxJobs && Date.now() - start < deadlineMs) {
    const didWork = await drainOne();
    if (!didWork) break; // queue empty
    processed += 1;
  }
  return { processed };
}

async function reclaimStaleRunning() {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const reset = await admin.database
    .from("jobs")
    .update({ status: "queued" })
    .eq("type", "ingest")
    .eq("status", "running")
    .lt("claimed_at", cutoff);
  if (reset.error) console.error("[worker] reclaim stale jobs failed", reset.error);
}

let workerReady = false;
let draining = false;

// Wake the worker immediately (e.g. right after a job is enqueued) so ingestion
// starts without waiting for the next poll tick. Fire-and-forget and guarded so
// overlapping nudges collapse into a single drain pass; the poll loop and the
// atomic claim in drainOne() keep this safe even if a tick races it.
export function nudgeWorker() {
  if (!workerReady || draining) return;
  draining = true;
  void (async () => {
    try {
      await drainOne();
    } catch (e) {
      console.error("[worker] nudge error", e);
    } finally {
      draining = false;
    }
  })();
}

type Job = { id: string; user_id: string; payload: { noteId?: string }; attempts: number; max_attempts: number };

// Claims and processes one queued ingest job. Returns true if a job was claimed
// (so callers can loop until the queue is empty), false if there was nothing to do.
async function drainOne(): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const found = await admin.database
    .from("jobs")
    .select("id, user_id, payload, attempts, max_attempts")
    .eq("type", "ingest")
    .eq("status", "queued")
    .lte("run_after", nowIso)
    .order("run_after", { ascending: true })
    .limit(1);
  if (found.error) throw found.error;
  const job = (found.data?.[0] as Job | undefined) ?? null;
  if (!job) return false;

  // Claim it (guard on status so a second worker can't double-take).
  const claim = await admin.database
    .from("jobs")
    .update({ status: "running", claimed_at: nowIso })
    .eq("id", job.id)
    .eq("status", "queued")
    .select("id");
  if (claim.error) throw claim.error;
  if (!claim.data?.length) return false; // someone else claimed it

  console.log(`[worker] ingest job ${job.id} (note ${job.payload?.noteId})`);
  try {
    await processIngest(job);
    await admin.database.from("jobs").update({ status: "done" }).eq("id", job.id);
    console.log(`[worker] job ${job.id} done`);
  } catch (e) {
    const attempts = job.attempts + 1;
    const dead = attempts >= job.max_attempts;
    await admin.database
      .from("jobs")
      .update({
        status: dead ? "dead" : "queued",
        attempts,
        last_error: e instanceof Error ? e.message : String(e),
        run_after: new Date(Date.now() + BACKOFF_MS).toISOString(),
      })
      .eq("id", job.id);
    if (dead && job.payload?.noteId) {
      await admin.database.from("notes").update({ status: "failed" }).eq("id", job.payload.noteId);
    }
    console.error(`[worker] job ${job.id} failed (attempt ${attempts}${dead ? ", DEAD" : ""})`, e);
  }
  return true; // a job was claimed (whether it succeeded or was requeued)
}

async function processIngest(job: Job) {
  const noteId = job.payload?.noteId;
  if (!noteId) throw new Error("ingest job missing noteId");
  const userId = job.user_id;

  // notes.status is constrained to capturing | extracted | failed — per-page
  // progress lives on images.status, so the note stays "capturing" until the
  // terminal update below.
  const note = (await admin.database.from("notes").select("source_ref, title").eq("id", noteId).maybeSingle()).data as
    | { source_ref: string | null; title: string | null }
    | null;
  const sourceRef = note?.source_ref ?? note?.title ?? "Your notes";

  const imgs = await admin.database.from("images").select("id, blob_key").eq("note_id", noteId).order("page_index");
  if (imgs.error) throw imgs.error;
  const images = (imgs.data ?? []) as { id: string; blob_key: string }[];
  if (!images.length) throw new Error("no images for note");

  // Download every file (image or PDF) concurrently, OCR them via Sarvam Vision,
  // then structure. Page order is preserved by mapping over `images` directly.
  const files: OcrFile[] = await Promise.all(
    images.map(async (img) => {
      const dl = await admin.storage.from(BUCKET).download(img.blob_key);
      if (dl.error || !dl.data) throw dl.error ?? new Error("file download failed");
      return {
        bytes: new Uint8Array(await (dl.data as Blob).arrayBuffer()),
        isPdf: img.blob_key.toLowerCase().endsWith(".pdf"),
      };
    })
  );

  const ocrText = await ocr(files); // Sarvam Vision OCR (verbatim)
  const extraction = ocrText.trim() ? await structureNotes(ocrText) : null;

  if (!extraction || extraction.unreadable || extraction.items.length === 0) {
    await admin.database.from("images").update({ status: "failed" }).eq("note_id", noteId);
    await admin.database.from("notes").update({ status: "failed" }).eq("id", noteId);
    return;
  }

  // Cards.
  const ins = await admin.database
    .from("items")
    .insert(
      extraction.items.map((it) => ({
        user_id: userId,
        note_id: noteId,
        kind: "card",
        origin: "note",
        topic: extraction.topic,
        body: it.source_quote,
        question: it.question,
        answer: it.answer,
        source_quote: it.source_quote,
        source_highlight: it.source_highlight,
        source_ref: sourceRef,
        review_status: "active",
      }))
    )
    .select("id, body");
  if (ins.error) throw ins.error;
  const items = (ins.data ?? []) as { id: string; body: string | null }[];

  // FSRS state — each new card due now so it enters the daily set.
  const card = newCard(new Date());
  await admin.database.from("card_srs").insert(
    items.map((it) => ({
      item_id: it.id,
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
    }))
  );

  // Embeddings (RAG corpus) — embed each card's source text (Cloudflare bge-large).
  const values = items.map((it) => it.body ?? "").filter(Boolean);
  if (values.length) {
    const { embeddings } = await embedMany({ model: embedModel(), values });
    await admin.database.from("embeddings").insert(
      items.map((it, i) => ({
        user_id: userId,
        item_id: it.id,
        chunk_index: 0,
        content: it.body ?? "",
        embedding: JSON.stringify(embeddings[i]), // pgvector parses '[...]'
        embed_model: EMBED_MODEL,
      }))
    );
  }

  // Knowledge graph (the "Map"): concepts + typed relations + cross-note
  // similarity edges. Fail-soft and gated — cards + embeddings already landed, so
  // a skipped/failed graph never fails ingest. Skip tiny notes (not worth a pass).
  if (items.length >= 3) {
    try {
      const graphCards: GraphCard[] = items.map((it, i) => ({
        id: it.id,
        question: extraction.items[i]?.question ?? null,
        answer: extraction.items[i]?.answer ?? null,
        source_quote: extraction.items[i]?.source_quote ?? null,
        source_highlight: extraction.items[i]?.source_highlight ?? null,
      }));
      const graph = await extractGraph(graphCards);
      if (graph.concepts.length) {
        await writeConceptGraph(admin, { userId, noteId, topic: extraction.topic, cards: graphCards }, graph);
      }
      await buildSimilarityEdges(admin, userId, items.map((it) => it.id));
    } catch (e) {
      console.error("[worker] graph build failed (non-fatal)", e instanceof Error ? e.message : e);
    }
  }

  // Corrections — surfaced, never applied.
  if (extraction.corrections.length) {
    await admin.database.from("corrections").insert(
      extraction.corrections.map((c) => ({
        user_id: userId,
        note_id: noteId,
        original_text: c.original_text,
        suggested_text: c.suggested_text,
        rationale: c.rationale,
        status: "pending",
      }))
    );
  }

  await admin.database.from("images").update({ status: "extracted" }).eq("note_id", noteId);
  // Stamp the detected topic (the /notes gallery groups by it) and an auto-title,
  // but never overwrite a title the user typed at capture.
  const autoTitle = extraction.title?.trim() || extraction.topic || null;
  const title = note?.title?.trim() ? note.title : autoTitle;
  await admin.database
    .from("notes")
    .update({ status: "extracted", topic: extraction.topic, title })
    .eq("id", noteId);

  // Refresh the "Ask your notes" starter prompts now that this user has new
  // material. Fail-soft and gated — cards/embeddings already landed, so a flaky
  // suggestion pass must never fail the ingest.
  try {
    await regenerateSuggestions(userId);
  } catch (e) {
    console.error("[worker] suggestion refresh failed (non-fatal)", e instanceof Error ? e.message : e);
  }
}
