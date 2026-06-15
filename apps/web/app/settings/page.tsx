"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme, type ThemeMode } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { useGet } from "@/lib/use-api";
import { api } from "@/lib/api";
import type { Profile } from "@/lib/api-types";
import { ProfileSchema } from "@/lib/api-types";

const MODES: { value: ThemeMode; icon: string; label: string; hint: string }[] = [
  { value: "light", icon: "◐", label: "Light", hint: "Warm paper, always" },
  { value: "dark", icon: "◑", label: "Dark", hint: "Warm near-black, always" },
  { value: "system", icon: "◓", label: "Auto", hint: "Follows your device" },
];

type Form = { display_name: string; study_hour_local: number; timezone: string };

export default function Settings() {
  const { mode, setMode } = useTheme();
  const { user, signOut } = useAuth();
  const router = useRouter();
  const profile = useGet<Profile>("/v1/me", ProfileSchema);

  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Seed the form once the profile loads.
  useEffect(() => {
    if (profile.data && form === null) {
      setForm({
        display_name: profile.data.display_name ?? "",
        study_hour_local: profile.data.study_hour_local ?? 8,
        timezone: profile.data.timezone ?? "UTC",
      });
    }
  }, [profile.data, form]);

  function set<K extends keyof Form>(k: K, v: Form[K]) {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    setSaved(false);
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      await api.patch("/v1/me", {
        display_name: form.display_name || null,
        study_hour_local: Number(form.study_hour_local),
        timezone: form.timezone,
      });
      await profile.refetch();
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    router.push("/signin");
  }

  return (
    <div className="max-w-[640px]">
      <div className="mb-5 px-0.5">
        <h1 className="font-display font-semibold text-[clamp(26px,6vw,34px)] tracking-tight leading-[1.1]">
          Settings.
        </h1>
        <p className="text-muted text-[13.5px] mt-1">Your study setup.</p>
      </div>

      {/* appearance */}
      <div className="kicker mb-3 px-0.5">Appearance</div>
      <section className="card p-5">
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
          {MODES.map((m, i) => (
            <button
              key={m.value}
              role="radio"
              aria-checked={mode === m.value}
              tabIndex={mode === m.value ? 0 : -1}
              onClick={() => setMode(m.value)}
              onKeyDown={(e) => {
                const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                if (!dir) return;
                e.preventDefault();
                const next = (i + dir + MODES.length) % MODES.length;
                setMode(MODES[next].value);
                (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
              }}
              className={`rounded-sm border-[1.5px] px-2 py-3 text-center transition cursor-pointer hover:-translate-y-0.5 active:translate-y-0 ${
                mode === m.value
                  ? "border-marigold bg-[color-mix(in_srgb,var(--marigold)_10%,transparent)]"
                  : "border-line hover:border-marigold"
              }`}
            >
              <span className="block text-[17px]" aria-hidden="true">{m.icon}</span>
              <span className="block font-semibold text-[13.5px] mt-1">{m.label}</span>
              <span className="block text-muted text-[10.5px] mt-0.5">{m.hint}</span>
            </button>
          ))}
        </div>
      </section>

      {/* study */}
      <div className="kicker mt-7 mb-3 px-0.5">Study</div>
      <p className="text-muted text-[12.5px] -mt-1 mb-3 px-0.5">
        Manage the exams you&apos;re tracking on the{" "}
        <a href="/readiness" className="font-semibold text-marigold-deep hover:underline">
          Readiness page
        </a>
        .
      </p>
      <section className="card p-5 flex flex-col gap-4">
        {form === null ? (
          <p className="text-muted text-[13.5px]">Loading…</p>
        ) : (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-[14px]">Daily reminder (hour)</span>
              <input
                type="number"
                min={0}
                max={23}
                className="field"
                value={form.study_hour_local}
                onChange={(e) => set("study_hour_local", Number(e.target.value) as Form["study_hour_local"])}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-[14px]">Timezone</span>
              <input
                className="field"
                value={form.timezone}
                placeholder="e.g. Europe/London"
                onChange={(e) => set("timezone", e.target.value)}
              />
              <span className="text-muted text-[11.5px]">IANA name — keeps your daily set on your clock.</span>
            </label>
            <div className="flex items-center gap-3">
              <button onClick={save} disabled={saving} className="btn-p disabled:opacity-60">
                {saving ? "Saving…" : "Save"}
              </button>
              {saved && (
                <span role="status" className="text-teal text-[13px] font-medium">
                  Saved.
                </span>
              )}
            </div>
          </>
        )}
      </section>

      {/* account */}
      <div className="kicker mt-7 mb-3 px-0.5">Account</div>
      <section className="card p-5 flex items-center justify-between gap-4">
        <div>
          <p className="font-medium text-[14.5px]">{form?.display_name || "—"}</p>
          <p className="text-muted text-[12.5px] mt-0.5 font-mono">{user?.email ?? ""}</p>
        </div>
        <button
          onClick={handleSignOut}
          className="text-[13.5px] font-semibold text-ink-soft border-[1.5px] border-line px-4 py-2 rounded-sm cursor-pointer hover:border-brick hover:text-brick transition-colors"
        >
          Sign out
        </button>
      </section>

      <p className="text-muted text-[12px] mt-6 px-0.5">
        Deleting your account purges everything — photos, cards, and history. That flow
        arrives with the backend.
      </p>
    </div>
  );
}
