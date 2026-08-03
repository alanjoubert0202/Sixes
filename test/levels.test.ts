import test from 'node:test';
import assert from 'node:assert/strict';

import { LEVELS } from '../src/game/game.ts';
import { Board } from '../src/match3/board.ts';
import { BALL_COUNT } from '../src/match3/types.ts';

/**
 * The level table is tuned against simulated play; the full simulation is too
 * slow for CI, so these guard the shape of the curve instead of its exact
 * numbers. If a goal is ever edited into something unreachable, the ratio
 * checks here catch it.
 */

test('levels are well formed and numbered in order', () => {
  assert.ok(LEVELS.length > 0);
  LEVELS.forEach((level, i) => {
    assert.equal(level.id, i + 1, 'level ids must run 1..n with no gaps');
    assert.ok(level.name.trim().length > 0, `level ${level.id} needs a name`);
    assert.ok(level.goal > 0, `level ${level.id} needs a goal`);
    assert.ok(level.moves >= 10, `level ${level.id} gives too few moves to be fair`);
    assert.ok(level.width >= 6 && level.height >= 6, `level ${level.id} board is too small to cascade`);
    assert.ok(level.types >= 3 && level.types <= BALL_COUNT, `level ${level.id} has an impossible type count`);
  });
});

test('level names are distinct', () => {
  const names = new Set(LEVELS.map((l) => l.name));
  assert.equal(names.size, LEVELS.length, 'duplicate level names would confuse the HUD');
});

test('every level generates a playable board', () => {
  for (const level of LEVELS) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const board = new Board({
        seed: `sixes-v1-L${level.id}-${attempt}`,
        width: level.width,
        height: level.height,
        types: level.types,
      });
      assert.equal(board.findMatches().length, 0, `level ${level.id} started with a free match`);
      assert.equal(board.hasValidMove(), true, `level ${level.id} started deadlocked`);
    }
  }
});

test('goals stay inside the range simulated play can reach', () => {
  // Measured with a scripted player: roughly 2,400 points per move at five ball
  // types and 900 at six. A goal beyond the upper bound would be unwinnable;
  // one below the lower bound clears itself.
  const perMove: Record<number, number> = { 3: 4200, 4: 3600, 5: 2400, 6: 900 };
  for (const level of LEVELS) {
    const expected = perMove[level.types] * level.moves;
    const ratio = level.goal / expected;
    assert.ok(ratio > 0.2, `level ${level.id} goal is so low it clears itself (${ratio.toFixed(2)}x)`);
    assert.ok(ratio < 1.6, `level ${level.id} goal looks unreachable (${ratio.toFixed(2)}x)`);
  }
});

test('the difficulty curve does not go backwards within a ball count', () => {
  // Difficulty rides on two things at once: the points you must average per
  // move, and how few moves you get to build a Scrum or a MatchBall in. A short
  // level can therefore be harder than a long one at a *lower* points-per-move
  // — level 4 asks 1,714 a move against level 3's 1,750, but simulated casual
  // play clears it 58% of the time against 83%. `goal / moves²` folds both in,
  // and tracks those measured win rates across the whole table.
  const pressure = (level: (typeof LEVELS)[number]): number => level.goal / (level.moves * level.moves);

  let previousTypes = 0;
  let previous = 0;
  for (const level of LEVELS) {
    const current = pressure(level);
    if (level.types === previousTypes) {
      assert.ok(
        current > previous,
        `level ${level.id} is no harder than level ${level.id - 1} at the same ball count ` +
          `(${current.toFixed(1)} vs ${previous.toFixed(1)})`,
      );
    }
    previousTypes = level.types;
    previous = current;
  }
});

test('adding a ball type eases the goal so the new mix can be learned', () => {
  for (let i = 1; i < LEVELS.length; i++) {
    const previous = LEVELS[i - 1];
    const level = LEVELS[i];
    if (level.types <= previous.types) continue;
    assert.ok(
      level.goal / level.moves < previous.goal / previous.moves,
      `level ${level.id} introduces a ball type and gets harder per move at the same time`,
    );
  }
});
