import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_KEY,
  canResume,
  clampLevel,
  clearProgress,
  emptyProgress,
  hasProgress,
  isCleared,
  isUnlocked,
  loadProgress,
  parseProgress,
  recordScore,
  recordWin,
  saveProgress,
} from '../src/progress.ts';
import type { StorageLike } from '../src/progress.ts';
import { LEVELS } from '../src/game/game.ts';

const COUNT = LEVELS.length;

class FakeStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** Safari in private mode throws on every access rather than returning null. */
class HostileStorage implements StorageLike {
  getItem(): string | null {
    throw new Error('denied');
  }
  setItem(): void {
    throw new Error('denied');
  }
  removeItem(): void {
    throw new Error('denied');
  }
}

// ---------------------------------------------------------------------------

test('a fresh player starts on match one with nothing recorded', () => {
  const progress = loadProgress(new FakeStorage(), COUNT);
  assert.deepEqual(progress, { level: 1, best: 0, cleared: [] });
  assert.equal(hasProgress(progress), false);
  assert.equal(canResume(progress), false);
});

test('progress round-trips through storage', () => {
  const storage = new FakeStorage();
  const saved = { level: 4, best: 21_500, cleared: [1, 2, 3] };
  saveProgress(storage, saved);
  assert.deepEqual(loadProgress(storage, COUNT), saved);
});

test('corrupt or hostile storage never blocks a game', () => {
  const storage = new FakeStorage();
  for (const junk of ['', '{', 'null', '[]', '"nope"', '{"level":"x"}']) {
    storage.setItem(STORAGE_KEY, junk);
    const progress = loadProgress(storage, COUNT);
    assert.ok(progress.level >= 1 && progress.level <= COUNT, `bad level from ${junk}`);
    assert.ok(progress.best >= 0);
    assert.ok(Array.isArray(progress.cleared));
  }

  assert.deepEqual(loadProgress(new HostileStorage(), COUNT), emptyProgress());
  assert.deepEqual(loadProgress(null, COUNT), emptyProgress());
  // These must not throw.
  saveProgress(new HostileStorage(), emptyProgress());
  saveProgress(null, emptyProgress());
  clearProgress(new HostileStorage());
  clearProgress(null);
});

test('stored values are clamped to the levels that exist', () => {
  assert.equal(parseProgress(JSON.stringify({ level: 999 }), COUNT).level, COUNT);
  assert.equal(parseProgress(JSON.stringify({ level: -5 }), COUNT).level, 1);
  assert.equal(parseProgress(JSON.stringify({ level: 1.6 }), COUNT).level, 2);
  assert.equal(parseProgress(JSON.stringify({ best: -20 }), COUNT).best, 0);

  // A save from a future build listing more levels must not unlock phantoms.
  const wild = parseProgress(JSON.stringify({ level: 3, cleared: [1, 2, 99, 0, 3, 3] }), COUNT);
  assert.deepEqual(wild.cleared, [1, 2, 3], 'out-of-range and duplicate entries should be dropped');
});

test('clampLevel copes with nonsense', () => {
  assert.equal(clampLevel(Number.NaN, COUNT), 1);
  assert.equal(clampLevel(Number.POSITIVE_INFINITY, COUNT), 1);
  assert.equal(clampLevel(0, COUNT), 1);
  assert.equal(clampLevel(COUNT + 10, COUNT), COUNT);
});

// ---------------------------------------------------------------------------
// What the menu shows
// ---------------------------------------------------------------------------

test('Resume is hidden on a fresh save and shown once past match one', () => {
  assert.equal(canResume({ level: 1, best: 0, cleared: [] }), false);
  assert.equal(canResume({ level: 1, best: 9_000, cleared: [] }), false, 'a score alone is not a resume point');
  assert.equal(canResume({ level: 2, best: 0, cleared: [1] }), true);
});

test('New Game only warns when there is something to lose', () => {
  assert.equal(hasProgress({ level: 1, best: 0, cleared: [] }), false);
  assert.equal(hasProgress({ level: 2, best: 0, cleared: [] }), true);
  assert.equal(hasProgress({ level: 1, best: 500, cleared: [] }), true, 'a best score is worth warning about');
  assert.equal(hasProgress({ level: 1, best: 0, cleared: [1] }), true);
});

test('the picker unlocks everything up to the match reached, and no further', () => {
  const progress = { level: 5, best: 30_000, cleared: [1, 2, 3, 4] };
  for (const level of LEVELS) {
    assert.equal(
      isUnlocked(progress, level.id),
      level.id <= 5,
      `match ${level.id} unlock state is wrong`,
    );
  }
  assert.equal(isCleared(progress, 4), true);
  assert.equal(isCleared(progress, 5), false, 'the match you are on is not yet cleared');
});

test('a fresh player can only pick match one', () => {
  const progress = emptyProgress();
  const open = LEVELS.filter((l) => isUnlocked(progress, l.id));
  assert.deepEqual(open.map((l) => l.id), [1]);
});

// ---------------------------------------------------------------------------
// Recording results
// ---------------------------------------------------------------------------

test('winning unlocks the next match and records the score', () => {
  let progress = emptyProgress();
  progress = recordWin(progress, 1, 14_000, COUNT);
  assert.equal(progress.level, 2);
  assert.deepEqual(progress.cleared, [1]);
  assert.equal(progress.best, 14_000);
  assert.equal(canResume(progress), true);
});

test('winning the last match does not push past the end of the table', () => {
  const progress = recordWin({ level: COUNT, best: 0, cleared: [] }, COUNT, 50_000, COUNT);
  assert.equal(progress.level, COUNT);
  assert.deepEqual(progress.cleared, [COUNT]);
});

test('replaying an old match never rolls progress backwards', () => {
  const start = { level: 8, best: 40_000, cleared: [1, 2, 3, 4, 5, 6, 7] };
  const after = recordWin(start, 2, 9_000, COUNT);
  assert.equal(after.level, 8, 'beating an early match must not demote the player');
  assert.equal(after.best, 40_000, 'a worse score must not replace the best');
  assert.deepEqual(after.cleared, [1, 2, 3, 4, 5, 6, 7]);
});

test('losing keeps a personal best but unlocks nothing', () => {
  const start = { level: 3, best: 10_000, cleared: [1, 2] };
  const better = recordScore(start, 15_000);
  assert.equal(better.best, 15_000);
  assert.equal(better.level, 3, 'losing must not unlock the next match');
  assert.deepEqual(better.cleared, [1, 2]);

  assert.equal(recordScore(start, 500), start, 'a worse score changes nothing');
});

test('clearing progress puts the player back to the start', () => {
  const storage = new FakeStorage();
  saveProgress(storage, { level: 9, best: 60_000, cleared: [1, 2, 3] });
  clearProgress(storage);
  const progress = loadProgress(storage, COUNT);
  assert.deepEqual(progress, emptyProgress());
  assert.equal(canResume(progress), false);
  assert.equal(hasProgress(progress), false);
});

test('a full playthrough leaves every match unlocked', () => {
  let progress = emptyProgress();
  for (const level of LEVELS) {
    assert.equal(isUnlocked(progress, level.id), true, `match ${level.id} should be reachable in order`);
    progress = recordWin(progress, level.id, level.goal, COUNT);
  }
  assert.equal(progress.level, COUNT);
  assert.deepEqual(progress.cleared, LEVELS.map((l) => l.id));
  for (const level of LEVELS) assert.equal(isUnlocked(progress, level.id), true);
});
