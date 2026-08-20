export interface ContextCandidate {
  source: string;
  content: string;
  score: number;
  key?: string;
}

export interface CuratedContext {
  entries: ContextCandidate[];
  totalCharacters: number;
}

export function curateContext(
  candidates: ContextCandidate[],
  characterBudget = 40000,
): CuratedContext {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const seen = new Set<string>();

  const entries: ContextCandidate[] = [];
  let totalCharacters = 0;

  for (const candidate of sorted) {
    const key =
      candidate.key ??
      `${candidate.source}:${candidate.content.slice(0, 200)}`;

    if (seen.has(key)) continue;
    seen.add(key);

    if (totalCharacters + candidate.content.length > characterBudget) {
      continue;
    }

    entries.push(candidate);
    totalCharacters += candidate.content.length;
  }

  return {
    entries,
    totalCharacters,
  };
}
