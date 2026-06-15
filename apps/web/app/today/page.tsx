"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useGet } from "@/lib/use-api";
import { api } from "@/lib/api";
import {
  daysUntil,
  nextExam,
  ProfileSchema,
  ExamListSchema,
  TodaySummarySchema,
  StreakSchema,
  ReadinessSchema,
  NoteCardListSchema,
  InferredItemListSchema,
  type Profile,
  type Exam,
  type TodaySummary,
  type Streak,
  type Readiness,
  type NoteCard,
  type InferredItem,
} from "@/lib/api-types";

function ReadinessRing({ percent }: { percent: number }) {
  const r = 36;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative w-[86px] h-[86px] shrink-0">
      <svg viewBox="0 0 86 86" className="w-full h-full -rotate-90">
        <circle cx="43" cy="43" r={r} fill="none" strokeWidth="8" className="stroke-line" />
        <circle
          cx="43"
          cy="43"
          r={r}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          className="stroke-teal"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - percent / 100)}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center font-display font-bold text-[21px] tabnum">
        {percent}%
      </span>
    </div>
  );
}

function barColor(p: number) {
  if (p < 50) return "bg-brick";
  if (p < 75) return "bg-marigold";
  return "bg-teal";
}

function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default function Today() {
  const { user } = useAuth();
  const profile = useGet<Profile>("/v1/me", ProfileSchema);
  const exams = useGet<Exam[]>("/v1/exams", ExamListSchema);
  const today = useGet<TodaySummary>("/v1/today", TodaySummarySchema);
  const streak = useGet<Streak>("/v1/streak", StreakSchema);
  const readiness = useGet<Readiness>("/v1/readiness", ReadinessSchema);
  const notes = useGet<NoteCard[]>("/v1/notes", NoteCardListSchema);
  const inferred = useGet<InferredItem[]>("/v1/inferred", InferredItemListSchema);

  const [actingId, setActingId] = useState<string | null>(null);

  const name = profile.data?.display_name || user?.email?.split("@")[0] || "there";
  const upcomingExam = nextExam(exams.data);
  const examName = upcomingExam?.name;
  const days = daysUntil(upcomingExam?.exam_date ?? null);
  const dueCards = today.data?.dueCards ?? 0;
  const completed = today.data?.completed ?? 0;
  const estMinutes = today.data?.estMinutes ?? 0;
  const streakDays = streak.data?.days ?? 0;
  const weakest = (readiness.data?.topics ?? []).slice(0, 3);
  const pending = inferred.data ?? [];

  async function resolveInferred(id: string, action: "accept" | "dismiss") {
    setActingId(id);
    try {
      await api.post(`/v1/inferred/${id}/${action}`);
      await Promise.all([inferred.refetch(), today.refetch(), readiness.refetch()]);
    } finally {
      setActingId(null);
    }
  }

  return (
    <div>
      {/* greeting */}
      <div className="mb-5 px-0.5">
        <h1 className="font-display font-semibold text-[clamp(26px,6vw,34px)] tracking-tight leading-[1.1]">
          {greeting()}, {name}.
        </h1>
        <p className="text-muted text-[13.5px] mt-1">
          {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
          {examName && days !== null && (
            <>
              {" · "}
              {examName} in <span className="text-brick font-semibold tabnum">{days} days</span>
            </>
          )}
        </p>
      </div>

      <div className="lg:grid lg:grid-cols-[1.15fr_0.85fr] lg:gap-[22px] lg:items-start">
        {/* ============ left column ============ */}
        <div className="min-w-0">
          {/* today's set */}
          <section className="card p-5 md:p-6">
            <div className="flex justify-between items-start gap-3">
              <div>
                <h2 className="font-display font-semibold text-[21px] tracking-tight">
                  Today&apos;s set
                </h2>
                <p className="text-muted text-[13.5px] mt-0.5">
                  {dueCards} cards · about {estMinutes} minutes
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 font-mono text-xs tabnum text-marigold-deep bg-[color-mix(in_srgb,var(--marigold)_14%,transparent)] px-2.5 py-1 rounded-sm whitespace-nowrap">
                <span aria-hidden="true">▲</span> {streakDays}-day streak
              </span>
            </div>

            <div className="mt-4">
              <div
                className="h-[7px] rounded-[2px] bg-line overflow-hidden"
                role="progressbar"
                aria-label="Today's review progress"
                aria-valuenow={completed}
                aria-valuemin={0}
                aria-valuemax={dueCards}
              >
                <i
                  className="block h-full bg-marigold rounded-[2px]"
                  style={{ width: `${dueCards ? (completed / dueCards) * 100 : 0}%` }}
                />
              </div>
              <p className="font-mono text-[11px] text-muted mt-1.5 tabnum">
                {completed} of {dueCards} done
              </p>
            </div>

            {dueCards > 0 ? (
              <Link href="/review" className="btn-p mt-4 w-full md:w-auto">
                Start today&apos;s review
              </Link>
            ) : (
              <p className="text-[13.5px] text-ink-soft mt-4">
                Nothing due right now.{" "}
                <Link href="/capture" className="font-semibold text-marigold-deep hover:underline">
                  Capture a note
                </Link>{" "}
                to build your first cards.
              </p>
            )}
          </section>

          {/* weak spots */}
          <div className="flex items-baseline justify-between mt-7 mb-3 px-0.5">
            <span className="kicker">Weak spots</span>
            <Link
              href="/readiness"
              className="text-[12.5px] font-semibold text-marigold-deep hover:underline"
            >
              Full readiness <span aria-hidden="true">→</span>
            </Link>
          </div>
          <section className="card px-5 py-1.5">
            {weakest.length === 0 ? (
              <p className="py-4 text-[13.5px] text-muted">No cards scheduled yet.</p>
            ) : (
              weakest.map((t, i) => (
                <div
                  key={t.topic}
                  className={`grid grid-cols-[minmax(86px,130px)_1fr_40px] gap-3 items-center py-3 ${
                    i > 0 ? "border-t border-dotted border-line" : ""
                  }`}
                >
                  <span className="font-medium text-sm truncate">{t.topic}</span>
                  <span className="h-2 bg-line rounded-[2px] overflow-hidden">
                    <i
                      className={`block h-full rounded-[2px] ${barColor(t.percent)}`}
                      style={{ width: `${t.percent}%` }}
                    />
                  </span>
                  <span className="tabnum font-semibold text-[13px] text-right text-ink-soft">
                    {t.percent}%
                  </span>
                </div>
              ))
            )}
          </section>

          {/* recent captures */}
          <div className="flex items-baseline justify-between mt-7 mb-3 px-0.5">
            <span className="kicker">Recent captures</span>
            <Link
              href="/notes"
              className="text-[12.5px] font-semibold text-marigold-deep hover:underline"
            >
              All notes <span aria-hidden="true">→</span>
            </Link>
          </div>
          {(notes.data ?? []).length === 0 ? (
            <p className="text-[13.5px] text-muted px-0.5">No notes captured yet.</p>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-2.5 -mx-0.5 px-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {(notes.data ?? []).map((n) => (
                <Link
                  key={n.id}
                  href={`/notes/${n.id}`}
                  className="card shrink-0 w-[168px] p-3.5 hover:-translate-y-0.5 transition-transform"
                >
                  <p
                    className="font-display italic text-[12.5px] leading-[1.6] text-ink-soft h-[60px] overflow-hidden"
                    style={{
                      backgroundImage: "linear-gradient(var(--rule) 1px, transparent 1px)",
                      backgroundSize: "100% 20px",
                      backgroundPosition: "0 14px",
                    }}
                  >
                    {n.excerpt}
                  </p>
                  <p className="font-semibold text-[13px] mt-2.5">{n.title}</p>
                  <p className="font-mono text-[10px] text-muted mt-0.5">{n.ref}</p>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* ============ right column ============ */}
        <div className="min-w-0">
          {/* readiness */}
          <div className="kicker mt-7 lg:mt-0 mb-3 px-0.5">Exam readiness</div>
          <section className="card flex items-center gap-[18px] p-[18px]">
            <ReadinessRing percent={readiness.data?.percent ?? 0} />
            <div>
              <h3 className="font-display font-semibold text-[17px]">
                {(readiness.data?.percent ?? 0) >= 75
                  ? "On track."
                  : (readiness.data?.percent ?? 0) >= 50
                    ? "On track, barely."
                    : "Needs work."}
              </h3>
              <p className="text-[12.5px] text-muted mt-0.5 max-w-[30ch]">
                Predicted recall on exam day if you keep your current pace.
              </p>
              {readiness.data?.deltaWeek != null && (
                <p className="font-mono text-[10.5px] tabnum mt-1.5 text-teal">
                  <span aria-hidden="true">▲</span> {readiness.data.deltaWeek}% this week
                </p>
              )}
            </div>
          </section>

          {/* streak week */}
          <div className="kicker mt-7 mb-3 px-0.5">This week</div>
          <section className="card p-[18px]">
            <div className="flex items-baseline justify-between">
              <span className="font-display font-semibold text-[28px] leading-none tabnum">
                {streakDays} <span className="text-[17px] text-marigold-deep" aria-hidden="true">▲</span>
              </span>
              <span className="text-xs text-muted">days in a row</span>
            </div>
            <div className="flex gap-1.5 mt-3.5">
              {(streak.data?.week ?? Array(7).fill(false)).map((d, i) => (
                <i
                  key={i}
                  className={`w-4 h-4 rounded-[4px] ${
                    d === null
                      ? "bg-marigold-deep outline-2 outline-[color-mix(in_srgb,var(--marigold)_35%,transparent)] outline-offset-1"
                      : d
                        ? "bg-marigold"
                        : "bg-line"
                  }`}
                />
              ))}
            </div>
            <p className="text-[12px] text-muted mt-3">
              Finish today&apos;s set to make it {streakDays + 1}.
            </p>
          </section>

          {/* AI-inferred pending — always visibly tentative */}
          {pending.length > 0 && (
            <>
              <div className="kicker mt-7 mb-3 px-0.5">Waiting for your OK · {pending.length}</div>
              {pending.map((s) => (
                <section key={s.id} className="inferred-card mb-3">
                  <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-taupe-ink mb-2">
                    AI-inferred · pending
                  </p>
                  <p className="text-sm text-ink-soft">{s.text}</p>
                  <p className="font-mono text-[10.5px] text-muted mt-2">{s.ref}</p>
                  <div className="flex gap-2 mt-3">
                    <button
                      disabled={actingId === s.id}
                      onClick={() => resolveInferred(s.id, "accept")}
                      className="bg-teal text-paper2 text-[13px] font-semibold px-4 py-2.5 rounded-sm cursor-pointer hover:opacity-90 disabled:opacity-50"
                    >
                      Accept
                    </button>
                    <button
                      disabled={actingId === s.id}
                      onClick={() => resolveInferred(s.id, "dismiss")}
                      className="border border-taupe text-ink-soft text-[13px] font-semibold px-4 py-2.5 rounded-sm cursor-pointer hover:bg-surface disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </div>
                </section>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
