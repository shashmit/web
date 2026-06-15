-- entri: persist "Tell me more" briefs generated on the knowledge map, keyed to
-- the concept. Lets the inspector show the saved story instead of regenerating,
-- and drives the warm "has a story" ring on the graph node. `concepts` stays
-- user-read-only (all writes go through the API's admin client), so no new RLS
-- or grants are needed — the existing owner SELECT covers reading these columns.
ALTER TABLE public.concepts
  ADD COLUMN IF NOT EXISTS brief_text    TEXT,
  ADD COLUMN IF NOT EXISTS brief_sources JSONB,
  ADD COLUMN IF NOT EXISTS brief_at      TIMESTAMPTZ;
