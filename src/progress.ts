/**
 * Saved progress, and the rules the menu reads off it.
 *
 * Kept free of the DOM and of `localStorage` itself — the storage object is
 * passed in — so the menu's behaviour can be tested without a browser.
 */

export const STORAGE_KEY = 'sixes.progress.v1';

export interface Progress {
  /** Highest match reached; everything below it is unlocked. */
  level: number;
  /** Best score posted on any match. */
  best: number;
  /** Matches actually won, ascending. */
  cleared: number[];
}

/** The slice of the Storage API this module needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function emptyProgress(): Progress {
  return { level: 1, best: 0, cleared: [] };
}

export function clampLevel(id: number, levelCount: number): number {
  if (!Number.isFinite(id)) return 1;
  return Math.min(Math.max(Math.round(id), 1), Math.max(1, levelCount));
}

/** Parse a stored payload, falling back to a fresh run on anything unexpected. */
export function parseProgress(raw: string | null, levelCount: number): Progress {
  if (!raw) return emptyProgress();
  try {
    const parsed = JSON.parse(raw) as Partial<Progress> | null;
    if (!parsed || typeof parsed !== 'object') return emptyProgress();
    const cleared = Array.isArray(parsed.cleared)
      ? [...new Set(parsed.cleared.filter((n) => Number.isInteger(n) && n >= 1 && n <= levelCount))].sort(
          (a, b) => a - b,
        )
      : [];
    return {
      level: clampLevel(Number(parsed.level) || 1, levelCount),
      best: Math.max(0, Math.floor(Number(parsed.best)) || 0),
      cleared,
    };
  } catch {
    return emptyProgress();
  }
}

export function loadProgress(storage: StorageLike | null, levelCount: number): Progress {
  if (!storage) return emptyProgress();
  try {
    return parseProgress(storage.getItem(STORAGE_KEY), levelCount);
  } catch {
    // Safari in private mode throws on access rather than returning null.
    return emptyProgress();
  }
}

export function saveProgress(storage: StorageLike | null, progress: Progress): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    /* storage is a nicety, not a requirement */
  }
}

export function clearProgress(storage: StorageLike | null): void {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do — the caller resets its in-memory copy regardless */
  }
}

// ---------------------------------------------------------------------------
// What the menu asks
// ---------------------------------------------------------------------------

/** Is there anything worth resuming or warning about before a wipe? */
export function hasProgress(progress: Progress): boolean {
  return progress.level > 1 || progress.best > 0 || progress.cleared.length > 0;
}

/** Resume only appears once the player is past the opening match. */
export function canResume(progress: Progress): boolean {
  return progress.level > 1;
}

export function isUnlocked(progress: Progress, levelId: number): boolean {
  return levelId <= progress.level;
}

export function isCleared(progress: Progress, levelId: number): boolean {
  return progress.cleared.includes(levelId);
}

/** Record a win: unlock the next match, keep the best score. */
export function recordWin(progress: Progress, levelId: number, score: number, levelCount: number): Progress {
  const cleared = new Set(progress.cleared);
  cleared.add(levelId);
  const isLast = levelId >= levelCount;
  return {
    level: clampLevel(Math.max(progress.level, isLast ? levelId : levelId + 1), levelCount),
    best: Math.max(progress.best, score),
    cleared: [...cleared].sort((a, b) => a - b),
  };
}

/** Record a loss: nothing unlocks, but a good score still counts. */
export function recordScore(progress: Progress, score: number): Progress {
  if (score <= progress.best) return progress;
  return { ...progress, best: Math.max(progress.best, score) };
}
