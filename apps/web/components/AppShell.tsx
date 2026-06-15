"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useGet } from "@/lib/use-api";
import { daysUntil, nextExam, ExamListSchema, type Exam } from "@/lib/api-types";

/* ---------- icons (stroke, 1.8px — quiet, not cartoonish) ---------- */
const ic = {
  today: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
      <path d="M8 14.5l2.5 2.5L16.5 12" />
    </svg>
  ),
  notes: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5h9.5L20 8v12.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z" />
      <path d="M15 3.5V8h4.5M8.5 12.5h7M8.5 16h5" />
    </svg>
  ),
  capture: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8.5a2 2 0 0 1 2-2h1.5l1.5-2.5h6L16.5 6.5H18a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8.5Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4V6Z" />
      <path d="M8.5 9.5h7M8.5 13h4" />
    </svg>
  ),
  readiness: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10M10 20V4M16 20v-8M21 20H3" />
    </svg>
  ),
  map: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6.5" r="2.3" />
      <circle cx="18" cy="8" r="2.3" />
      <circle cx="9.5" cy="18" r="2.3" />
      <path d="M8 7.4l7.8 0.4M8.2 8.3l1 7.3M11.2 16.8 16 9.8" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.5-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5a7.6 7.6 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5Z" />
    </svg>
  ),
  collapse: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  ),
  expand: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  ),
};

const tabs = [
  { href: "/today", label: "Today", icon: ic.today },
  { href: "/notes", label: "Notes", icon: ic.notes },
  { href: "/capture", label: "Capture", icon: ic.capture, isCapture: true },
  { href: "/chat", label: "Chat", icon: ic.chat },
  { href: "/readiness", label: "Readiness", icon: ic.readiness },
];

// The desktop sidebar carries one extra destination — the knowledge Map. The
// mobile bottom bar stays at 5 tabs (grid-cols-5); Map is reached from the mobile
// header instead.
const desktopNav = [...tabs.filter((t) => !t.isCapture), { href: "/map", label: "Map", icon: ic.map }];

function Brand({ className = "" }: { className?: string }) {
  return (
    <Link href="/today" className={`font-display font-bold tracking-tight ${className}`}>
      entri<span className="text-marigold-deep">.</span>
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading } = useAuth();
  const exams = useGet<Exam[]>(user ? "/v1/exams" : null, ExamListSchema);
  const days = daysUntil(nextExam(exams.data)?.exam_date ?? null);
  const active = (href: string) => pathname.startsWith(href);

  // Desktop sidebar collapse, persisted. Starts expanded on the server/first
  // paint (avoids a hydration mismatch), then restores the saved choice.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(localStorage.getItem("entri-sidebar") === "collapsed");
  }, []);
  const toggleSidebar = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("entri-sidebar", next ? "collapsed" : "expanded");
      } catch {}
      return next;
    });

  // Public routes: "/" is the marketing landing, "/signin" is auth, "/share/*"
  // is a publicly-shared note. Everything else requires a session.
  const isPublic = pathname === "/" || pathname.startsWith("/signin") || pathname.startsWith("/share");
  // Bare chrome: public pages bring their own layout; /review is full-screen.
  const bare = isPublic || pathname.startsWith("/review");
  // /map is a full-bleed canvas: the main column runs edge-to-edge, no padding,
  // and the page overlays its own title (still inside the sidebar shell).
  const isMap = pathname.startsWith("/map");

  // Gate the app: bounce unauthenticated users to sign-in.
  useEffect(() => {
    if (!loading && !user && !isPublic) router.replace("/signin");
  }, [loading, user, isPublic, router]);

  if (bare) {
    return <div className="relative z-[2] min-h-dvh">{children}</div>;
  }

  if (loading || !user) {
    return (
      <div className="relative z-[2] min-h-dvh grid place-items-center">
        <span className="font-mono text-xs text-muted">loading…</span>
      </div>
    );
  }

  return (
    <div
      className={`relative z-[2] min-h-dvh md:grid transition-[grid-template-columns] duration-200 ${
        collapsed ? "md:grid-cols-[68px_1fr]" : "md:grid-cols-[232px_1fr]"
      }`}
    >
      {/* ===== desktop sidebar (collapsible) ===== */}
      <aside
        className={`hidden md:flex flex-col sticky top-0 h-dvh border-r-[1.5px] border-line bg-paper2 pt-5 pb-5 overflow-hidden ${
          collapsed ? "px-2" : "px-4"
        }`}
      >
        {/* brand + collapse toggle */}
        <div className={`flex items-center pb-6 ${collapsed ? "justify-center" : "justify-between px-1"}`}>
          {!collapsed && <Brand className="text-2xl" />}
          <button
            onClick={toggleSidebar}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="w-9 h-9 grid place-items-center rounded-sm border-[1.5px] border-line text-ink-soft hover:border-marigold transition-colors cursor-pointer [&>svg]:w-[18px] [&>svg]:h-[18px]"
          >
            {collapsed ? ic.expand : ic.collapse}
          </button>
        </div>

        <nav className="flex flex-col gap-0.5 flex-1">
          {desktopNav.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                title={collapsed ? t.label : undefined}
                className={`flex items-center py-2.5 rounded-md text-[14.5px] font-medium transition-colors border-[1.5px] ${
                  collapsed ? "justify-center px-0" : "gap-3 px-3"
                } ${
                  active(t.href)
                    ? "bg-surface text-ink border-line [&>svg]:text-marigold-deep"
                    : "text-ink-soft border-transparent hover:bg-surface hover:text-ink"
                }`}
              >
                <span className="w-[19px] h-[19px] shrink-0">{t.icon}</span>
                {!collapsed && t.label}
              </Link>
            ))}
          {collapsed ? (
            <Link
              href="/capture"
              title="Capture notes"
              className="mt-4 h-11 grid place-items-center rounded-sm bg-marigold text-on-marigold hover:bg-marigold-deep transition-colors cursor-pointer [&>svg]:w-5 [&>svg]:h-5"
            >
              {ic.capture}
            </Link>
          ) : (
            <Link href="/capture" className="btn-p mt-4 text-[14.5px] py-3">
              <span className="w-[18px] h-[18px]">{ic.capture}</span>
              Capture notes
            </Link>
          )}
        </nav>

        <div
          className={`border-t border-line pt-4 flex items-center gap-2 ${
            collapsed ? "justify-center" : "justify-between"
          }`}
        >
          {!collapsed && (
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">Exam in</span>
              <span className="text-[13px] font-semibold text-brick tabnum">{days ?? "—"} days</span>
            </div>
          )}
          <Link
            href="/settings"
            title="Settings"
            aria-label="Settings"
            className={`w-[34px] h-[34px] grid place-items-center border-[1.5px] rounded-sm transition-colors [&>svg]:w-[18px] [&>svg]:h-[18px] ${
              active("/settings")
                ? "border-marigold text-marigold-deep"
                : "border-line text-ink-soft hover:border-marigold"
            }`}
          >
            {ic.settings}
          </Link>
        </div>
      </aside>

      {/* ===== main column ===== */}
      <div className="min-w-0">
        {/* mobile header */}
        <header className="md:hidden sticky top-0 z-40 border-b-[1.5px] border-line backdrop-blur-md bg-[color-mix(in_srgb,var(--paper)_86%,transparent)]">
          <div className="flex items-center justify-between h-[58px] px-[18px] max-w-[640px] mx-auto">
            <Brand className="text-[21px]" />
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-[11px] tabnum text-brick border border-[color-mix(in_srgb,var(--brick)_35%,transparent)] bg-[color-mix(in_srgb,var(--brick)_7%,transparent)] px-2.5 py-1 rounded-sm whitespace-nowrap">
                exam in {days ?? "—"}d
              </span>
              <Link
                href="/map"
                title="Knowledge map"
                aria-label="Knowledge map"
                className={`w-11 h-11 grid place-items-center border-[1.5px] rounded-sm [&>svg]:w-[18px] [&>svg]:h-[18px] ${
                  active("/map")
                    ? "border-marigold text-marigold-deep"
                    : "border-line text-ink-soft"
                }`}
              >
                {ic.map}
              </Link>
              <Link
                href="/settings"
                title="Settings"
                aria-label="Settings"
                className={`w-11 h-11 grid place-items-center border-[1.5px] rounded-sm [&>svg]:w-[18px] [&>svg]:h-[18px] ${
                  active("/settings")
                    ? "border-marigold text-marigold-deep"
                    : "border-line text-ink-soft"
                }`}
              >
                {ic.settings}
              </Link>
            </div>
          </div>
        </header>

        <main
          className={
            isMap
              ? // mobile header is 58px inner + 1.5px bottom border = 59.5px
                "relative h-[calc(100dvh-59.5px)] md:h-dvh overflow-hidden"
              : `px-[18px] pt-5 max-w-[640px] mx-auto md:max-w-[1040px] md:px-10 md:pt-9 ${
                  pathname.startsWith("/chat") ? "pb-[90px] md:pb-6" : "pb-[110px] md:pb-14"
                }`
          }
        >
          {children}
        </main>
      </div>

      {/* ===== mobile bottom tab bar ===== */}
      <nav className="md:hidden fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 border-t-[1.5px] border-line backdrop-blur-lg bg-[color-mix(in_srgb,var(--paper-2)_92%,transparent)] h-[calc(64px+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)]">
        {tabs.map((t) =>
          t.isCapture ? (
            <Link
              key={t.href}
              href={t.href}
              className="flex flex-col items-center justify-center -translate-y-3.5"
            >
              <span className="w-[52px] h-[52px] rounded-full bg-marigold text-on-marigold grid place-items-center border-[3px] border-paper shadow-[0_6px_16px_-6px_color-mix(in_srgb,var(--marigold)_70%,transparent)] transition-transform hover:-translate-y-0.5 [&>svg]:w-6 [&>svg]:h-6">
                {t.icon}
              </span>
              <span className="text-[10.5px] font-semibold text-ink-soft mt-0.5">
                {t.label}
              </span>
            </Link>
          ) : (
            <Link
              key={t.href}
              href={t.href}
              className={`flex flex-col items-center justify-center gap-[3px] text-[10.5px] font-medium transition-colors ${
                active(t.href) ? "text-ink" : "text-muted"
              }`}
            >
              <span className="w-[22px] h-[22px]">{t.icon}</span>
              {t.label}
              <span
                className={`w-1 h-1 rounded-full bg-marigold transition-opacity ${
                  active(t.href) ? "opacity-100" : "opacity-0"
                }`}
              />
            </Link>
          )
        )}
      </nav>
    </div>
  );
}
