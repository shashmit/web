import { Hono } from "hono";
import { ExamUpsertSchema, type Exam } from "@entri/types";
import type { AppEnv } from "../middleware/auth.js";
import { orThrow } from "../utils/index.js";

export const exams = new Hono<AppEnv>();

// All writes go through the user's RLS-scoped client; user_id is set/checked by
// the owner policies, so a user can only ever touch their own exams.
const COLS = "id, name, exam_date";

// GET /v1/exams — the student's tracked exams, soonest date first.
exams.get("/", async (c) => {
  const db = c.get("db");
  const rows = orThrow(
    await db.database.from("exams").select(COLS).order("exam_date", { ascending: true })
  );
  return c.json(rows as Exam[]);
});

// POST /v1/exams — add an exam (name + date).
exams.post("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");

  const parsed = ExamUpsertSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid exam" }, 400);

  const created = orThrow(
    await db.database
      .from("exams")
      .insert([{ ...parsed.data, user_id: userId }])
      .select(COLS)
      .single()
  );
  return c.json(created as Exam, 201);
});

// PATCH /v1/exams/:id — rename or reschedule.
exams.patch("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const parsed = ExamUpsertSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid exam" }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: "no updatable fields" }, 400);

  const updated = orThrow(
    await db.database.from("exams").update(parsed.data).eq("id", id).select(COLS).maybeSingle()
  );
  if (!updated) return c.json({ error: "not found" }, 404);
  return c.json(updated as Exam);
});

// DELETE /v1/exams/:id — stop tracking an exam.
exams.delete("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  orThrow(await db.database.from("exams").delete().eq("id", id));
  return c.body(null, 204);
});
