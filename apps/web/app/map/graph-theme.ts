"use client";

import { useEffect, useState } from "react";

// Canvas can't read CSS custom properties (ctx.fillStyle won't resolve var(--x)),
// so we resolve the Marginalia tokens to concrete hex at runtime and re-read them
// whenever the user flips data-theme. One source of truth (globals.css) still wins.
export type GraphTheme = {
  ink: string;
  inkSoft: string;
  muted: string;
  line: string;
  marigold: string;
  marigoldDeep: string;
  teal: string;
  taupe: string;
  taupeInk: string;
  hi: string; // highlighter fill — the "has a saved story" ring
  paper2: string;
  font: string; // resolved body font-family (Instrument Sans) for canvas labels
};

const VARS: Record<Exclude<keyof GraphTheme, "font">, string> = {
  ink: "--ink",
  inkSoft: "--ink-soft",
  muted: "--muted",
  line: "--line",
  marigold: "--marigold",
  marigoldDeep: "--marigold-deep",
  teal: "--teal",
  taupe: "--taupe",
  taupeInk: "--taupe-ink",
  hi: "--hi",
  paper2: "--paper-2",
};

function read(): GraphTheme {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as GraphTheme;
  for (const k of Object.keys(VARS) as (keyof typeof VARS)[]) {
    out[k] = cs.getPropertyValue(VARS[k]).trim() || "#000";
  }
  // Resolved (var()-expanded) body font so canvas labels match the rest of the UI
  // — ctx.font can't parse var(), but the computed fontFamily is already resolved.
  out.font = getComputedStyle(document.body).fontFamily || "ui-sans-serif, system-ui, sans-serif";
  return out;
}

/** The resolved palette, kept in sync with the active theme. Null until mounted. */
export function useGraphTheme(): GraphTheme | null {
  const [theme, setTheme] = useState<GraphTheme | null>(null);
  useEffect(() => {
    setTheme(read());
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

// #rrggbb (+ optional alpha 0-1) → rgba() string for canvas strokes/fills.
export function rgba(hex: string, alpha = 1): string {
  const h = hex.replace("#", "");
  if (h.length < 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Node radius grows gently with degree so hubs read as anchors without dwarfing
// leaves. Cards (verified anchors) start a touch smaller than concepts (the map's
// vocabulary). World units; the engine scales with zoom.
export function nodeRadius(kind: "concept" | "card", degree: number): number {
  const base = kind === "card" ? 3.2 : 3.8;
  return base + Math.sqrt(Math.max(0, degree)) * 1.6;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}
