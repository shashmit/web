import type { ChatSource } from "@/lib/api-types";

// The grounded chat cites note pages inline as "(→ <label>)". The model can
// occasionally cite a label we never gave it (a hallucinated source) — a direct
// hit on entri's trust pillar. After a reply finishes, reconcile it against the
// labels we actually provided:
//   - strip any "(→ X)" whose X isn't a real provided note label, and
//   - show note chips only for labels the answer actually cited.
// If the model cited nothing (it sometimes omits the inline tag), we keep all
// provided note sources rather than hiding everything — best effort, never
// over-claiming. AI ("general knowledge") sources pass through untouched.
const CITE = /\(→\s*([^)]+?)\s*\)/g;

export function reconcileCitations(
  text: string,
  sources: ChatSource[]
): { text: string; sources: ChatSource[] } {
  const noteLabels = new Set(sources.filter((s) => s.kind === "note").map((s) => s.label));
  const cited = new Set<string>();

  const cleaned = text
    .replace(CITE, (whole, raw: string) => {
      const label = raw.trim();
      if (noteLabels.has(label)) {
        cited.add(label);
        return whole; // a real citation — keep it
      }
      return ""; // fabricated citation — drop it
    })
    .replace(/[ \t]{2,}/g, " ") // tidy any double space the strip left behind
    .replace(/ +([.,;:])/g, "$1");

  const ai = sources.filter((s) => s.kind === "ai");
  const usedNotes =
    cited.size > 0
      ? sources.filter((s) => s.kind === "note" && cited.has(s.label))
      : sources.filter((s) => s.kind === "note");

  return { text: cleaned, sources: [...usedNotes, ...ai] };
}
