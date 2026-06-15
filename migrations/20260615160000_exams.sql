-- entri: multiple exams per user. Replaces the single exam_name/exam_date pair
-- on profiles — a student preps for several papers at once, and readiness is
-- computed against whichever exam they select. Cards stay global (shared across
-- exams); only the target date differs, so a nearer exam reads lower.
-- The profiles.exam_name/exam_date columns are kept as the backfill source and
-- are no longer read or written by the app.
CREATE TABLE public.exams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  exam_date   DATE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX exams_user_id_date_idx ON public.exams (user_id, exam_date);

ALTER TABLE public.exams ENABLE ROW LEVEL SECURITY;

-- Owner-scoped CRUD — the user manages their own exams from the Readiness page.
CREATE POLICY "own exams read" ON public.exams
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY "own exams insert" ON public.exams
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "own exams update" ON public.exams
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "own exams delete" ON public.exams
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.exams TO authenticated;

CREATE TRIGGER exams_updated_at
  BEFORE UPDATE ON public.exams
  FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

-- Backfill: lift each user's existing single exam into the new table.
INSERT INTO public.exams (user_id, name, exam_date)
SELECT user_id, COALESCE(NULLIF(exam_name, ''), 'My exam'), exam_date
FROM public.profiles
WHERE exam_date IS NOT NULL;
