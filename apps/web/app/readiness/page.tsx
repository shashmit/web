"use client";

import { useMemo, useState } from "react";
import { useGet } from "@/lib/use-api";
import { api } from "@/lib/api";
import {
  daysUntil,
  nextExam,
  ReadinessSchema,
  TodaySummarySchema,
  StreakSchema,
  ExamListSchema,
  type Readiness,
  type TodaySummary,
  type Streak,
  type Exam,
} from "@/lib/api-types";

function barColor(p: number) {
  if (p < 50) return "bg-brick";
  if (p < 75) return "bg-marigold";
  return "bg-teal";
}

type Editing = { id: string | null }; // id = exam being edited; null = adding a new one

export default function ReadinessPage() {
  const exams = useGet<Exam[]>("/v1/exams", ExamListSchema);
  const today = useGet<TodaySummary>("/v1/today", TodaySummarySchema);
  const streak = useGet<Streak>("/v1/streak", StreakSchema);

  const list = useMemo(() => exams.data ?? [], [exams.data]);

  // The selection is derived, not synced: `picked` is the user's explicit choice
  // (null = none yet), and `selectedId` falls back to the soonest upcoming exam.
  // This stays correct for free when an exam is added or the picked one deleted.
  const [picked, setPicked] = useState<string | null>(null);
  const selectedId =
    picked && list.some((e) => e.id === picked) ? picked : nextExam(list)?.id ?? null;

  // Readiness recomputes against the selected exam's date (server falls back to
  // the soonest upcoming exam when no id is passed).
  const readiness = useGet<Readiness>(
    selectedId ? `/v1/readiness?examId=${selectedId}` : "/v1/readiness",
    ReadinessSchema
  );

  const percent = readiness.data?.percent ?? 0;
  const topics = readiness.data?.topics ?? []; // already sorted weakest-first by the API
  const dueCards = today.data?.dueCards ?? 0;
  const streakDays = streak.data?.days ?? 0;

  const selected = list.find((e) => e.id === selectedId) ?? null;
  const days = daysUntil(selected?.exam_date ?? readiness.data?.examDate ?? null);
  const examName = selected?.name ?? "Your exam";

  // ── exam add/edit form state ──
  const [editing, setEditing] = useState<Editing | null>(null);
  const [form, setForm] = useState({ name: "", exam_date: "" });
  const [busy, setBusy] = useState(false);

  function openAdd() {
    setForm({ name: "", exam_date: "" });
    setEditing({ id: null });
  }
  function openEdit(e: Exam) {
    setForm({ name: e.name, exam_date: e.exam_date });
    setEditing({ id: e.id });
  }
  function cancel() {
    setEditing(null);
  }

  async function refresh(selectId?: string) {
    await exams.refetch();
    if (selectId) setPicked(selectId);
    await readiness.refetch();
  }

  async function save() {
    if (!editing || !form.name.trim() || !form.exam_date) return;
    setBusy(true);
    try {
      if (editing.id === null) {
        const created = await api.post<Exam>("/v1/exams", form);
        await refresh(created.id);
      } else {
        await api.patch<Exam>(`/v1/exams/${editing.id}`, form);
        await refresh();
      }
      setEditing(null);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await api.del(`/v1/exams/${id}`);
      if (editing?.id === id) setEditing(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-5 px-0.5">
        <h1 className="font-display font-semibold text-[clamp(26px,6vw,34px)] tracking-tight leading-[1.1]">
          Readiness.
        </h1>
        <p className="text-muted text-[13.5px] mt-1">
          Predicted recall on exam day — computed from every review, never a vanity metric.
        </p>
      </div>

      {/* ── exam tracker: pick which exam readiness targets, or add one ── */}
      <div className="max-w-[720px]">
        <div className="kicker mb-2.5 px-0.5">Your exams</div>
        <div className="flex flex-wrap gap-2">
          {list.map((e) => {
            const d = daysUntil(e.exam_date);
            const isActive = e.id === selectedId;
            return (
              <button
                key={e.id}
                onClick={() => setPicked(e.id)}
                aria-pressed={isActive}
                className={`group flex items-baseline gap-2 rounded-sm border-[1.5px] px-3 py-2 text-left transition cursor-pointer ${
                  isActive
                    ? "border-marigold bg-[color-mix(in_srgb,var(--marigold)_10%,transparent)]"
                    : "border-line hover:border-marigold"
                }`}
              >
                <span className="font-medium text-[14px] truncate max-w-[180px]">{e.name}</span>
                <span className="font-mono text-[11px] tabnum text-muted whitespace-nowrap">
                  {d !== null ? `${d}d` : "—"}
                </span>
              </button>
            );
          })}
          <button
            onClick={openAdd}
            className="rounded-sm border-[1.5px] border-dashed border-line px-3 py-2 text-[14px] font-medium text-ink-soft hover:border-marigold hover:text-ink transition cursor-pointer"
          >
            + Add exam
          </button>
        </div>

        {/* add / edit form */}
        {editing && (
          <div className="card p-4 mt-3">
            <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
              <label className="flex flex-col gap-1.5 flex-1">
                <span className="font-medium text-[13.5px]">Exam</span>
                <input
                  className="field"
                  autoFocus
                  value={form.name}
                  placeholder="e.g. Physics A-level"
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="font-medium text-[13.5px]">Date</span>
                <input
                  type="date"
                  className="field"
                  value={form.exam_date}
                  onChange={(e) => setForm((f) => ({ ...f, exam_date: e.target.value }))}
                />
              </label>
            </div>
            <div className="flex items-center gap-3 mt-3.5">
              <button
                onClick={save}
                disabled={busy || !form.name.trim() || !form.exam_date}
                className="btn-p disabled:opacity-60"
              >
                {busy ? "Saving…" : editing.id === null ? "Add exam" : "Save"}
              </button>
              <button
                onClick={cancel}
                className="text-[13.5px] font-semibold text-ink-soft hover:text-ink cursor-pointer"
              >
                Cancel
              </button>
              {editing.id !== null && (
                <button
                  onClick={() => remove(editing.id!)}
                  disabled={busy}
                  className="ml-auto text-[13px] font-semibold text-ink-soft hover:text-brick cursor-pointer disabled:opacity-60"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {list.length === 0 && !editing && (
        <p className="text-[13.5px] text-muted mt-3 max-w-[58ch] px-0.5">
          Add the exams you&apos;re preparing for to track readiness against each date.
        </p>
      )}

      {/* field report — black masthead per the Marginalia direction */}
      <div className="rounded-md border-[1.5px] border-ink overflow-hidden card max-w-[720px] mt-5">
        <div className="bg-ink text-paper px-6 py-4 flex justify-between items-baseline gap-4 flex-wrap">
          <div>
            <p className="font-mono text-[11px] tracking-[0.1em] uppercase opacity-70">
              {examName}
              {days !== null ? ` · in ${days} days` : ""}
            </p>
            <p className="font-display font-bold text-[48px] leading-none tabnum text-marigold">
              {percent}%
            </p>
          </div>
          <div className="text-right flex items-baseline gap-5">
            {selected && (
              <button
                onClick={() => openEdit(selected)}
                className="font-mono text-[10.5px] tracking-[0.08em] uppercase opacity-70 hover:opacity-100 underline underline-offset-2 cursor-pointer"
              >
                Edit
              </button>
            )}
            <div>
              <p className="font-mono text-[11px] tracking-[0.1em] uppercase opacity-70">Due today</p>
              <p className="font-display font-bold text-[34px] leading-none tabnum">{dueCards}</p>
            </div>
          </div>
        </div>
        <div className="px-6 py-5">
          {topics.length === 0 ? (
            <p className="py-4 text-[14px] text-muted">
              No cards scheduled yet — capture a note to start tracking readiness.
            </p>
          ) : (
            topics.map((t, i) => (
              <div
                key={t.topic}
                className={`grid grid-cols-[minmax(104px,150px)_1fr_48px] gap-3.5 items-center py-3 ${
                  i > 0 ? "border-t border-dotted border-line" : ""
                }`}
              >
                <span className="font-medium text-[15px] truncate">{t.topic}</span>
                <span className="h-[9px] bg-line rounded-[2px] overflow-hidden">
                  <i
                    className={`block h-full rounded-[2px] ${barColor(t.percent)}`}
                    style={{ width: `${t.percent}%` }}
                  />
                </span>
                <span className="tabnum font-semibold text-sm text-right text-ink-soft">
                  {t.percent}%
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <p className="text-[13px] text-muted mt-5 max-w-[58ch] px-0.5">
        Readiness assumes you stop studying today — a conservative reading. Finish your
        daily set ({streakDays}-day streak) and this number climbs.
      </p>
    </div>
  );
}
