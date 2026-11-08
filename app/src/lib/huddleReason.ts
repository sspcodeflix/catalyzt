/**
 * R16: a decision whose reason argues for another option. A simple, explainable heuristic, used only
 * to warn (never to block): each option is described by the words of its title that the other
 * options do not share (for a source conflict these include the source's name); the reason "favours"
 * the option whose distinctive words it uses most. When that is not the chosen option, the decide
 * form says so.
 */
const STOP = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'with', 'this', 'that', 'what', 'when', 'from', 'into', 'than', 'then', 'they', 'there', 'will', 'would', 'should', 'could', 'about', 'until', 'does', 'say', 'says', 'its', 'our', 'has', 'have', 'was', 'were', 'all', 'any', 'can', 'use', 'keep', 'stay', 'stays', 'one']);
const stem = (w: string) => (w.length > 4 ? w.replace(/(ies|es|s)$/, (m) => (m === 'ies' ? 'y' : '')) : w);
export const reasonWords = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);

export interface OptionLike {
  id: string;
  title: string;
}

/** How many of each option's distinctive words the reason uses. */
export function reasonScores(reason: string, options: OptionLike[]): Map<string, number> {
  const words = options.map((o) => new Set(reasonWords(o.title)));
  const said = reasonWords(reason);
  const out = new Map<string, number>();
  options.forEach((o, i) => {
    const distinct = [...words[i]].filter((w) => words.every((other, j) => j === i || !other.has(w)));
    out.set(o.id, said.filter((w) => distinct.includes(w)).length);
  });
  return out;
}

/**
 * The option the reason appears to argue for, when it is not the chosen one: it uses at least two of
 * that option's distinctive words and more than the chosen option's. Null otherwise.
 */
export function reasonFavoursOther<T extends OptionLike>(reason: string, options: T[], chosenId: string): T | null {
  if (!reason.trim() || options.length < 2) return null;
  const scores = reasonScores(reason, options);
  const mine = scores.get(chosenId) ?? 0;
  let best: T | null = null;
  for (const o of options) {
    if (o.id === chosenId) continue;
    const n = scores.get(o.id) ?? 0;
    if (n >= 2 && n > mine && (!best || n > (scores.get(best.id) ?? 0))) best = o;
  }
  return best;
}
