import test from 'node:test';
import assert from 'node:assert/strict';

import { Board } from '../src/match3/board.ts';
import { Animator } from '../src/game/animator.ts';
import type { EngineEvent } from '../src/match3/types.ts';

function fresh(seed = 'anim') {
  const board = new Board({ seed });
  const anim = new Animator(board.width, board.height);
  anim.sync(board.grid());
  return { board, anim };
}

/** Run the animator to completion in fixed steps, with a hard cap so a stuck timeline fails loudly. */
function runOut(anim: Animator, step = 16): number {
  let frames = 0;
  while (anim.busy) {
    anim.update(step);
    if (++frames > 2000) assert.fail('animator never settled');
  }
  return frames;
}

function spriteState(anim: Animator): string {
  return anim
    .list()
    .map((s) => `${s.id}:${s.x.toFixed(4)},${s.y.toFixed(4)},${s.scale.toFixed(4)},${s.alpha.toFixed(4)},${s.special}`)
    .sort()
    .join('|');
}

// ---------------------------------------------------------------------------

test('syncing places one sprite per cell on its grid square', () => {
  const { board, anim } = fresh();
  const sprites = anim.list();
  assert.equal(sprites.length, board.width * board.height);
  assert.equal(anim.busy, false, 'a synced animator is idle');

  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      const cell = board.get(x, y);
      const s = anim.sprite(cell.id);
      assert.ok(s, `no sprite for cell ${x},${y}`);
      assert.equal(s.x, x);
      assert.equal(s.y, y);
      assert.equal(s.scale, 1);
      assert.equal(s.alpha, 1);
      assert.equal(s.type, cell.type);
    }
  }
});

test('a swap moves both sprites and finishes on the target squares', () => {
  const { board, anim } = fresh();
  const a = board.get(0, 0);
  const b = board.get(1, 0);

  anim.enqueue([{ kind: 'swap', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
  assert.equal(anim.busy, true, 'enqueueing work makes the animator busy');

  anim.update(8);
  const mid = anim.sprite(a.id)!;
  assert.ok(mid.x > 0 && mid.x < 1, 'sprite should be mid-flight, not teleported');

  runOut(anim);
  assert.equal(anim.sprite(a.id)!.x, 1);
  assert.equal(anim.sprite(b.id)!.x, 0);
  assert.equal(anim.sprite(a.id)!.y, 0);
  assert.equal(anim.busy, false);
});

test('a rejected swap returns both sprites to where they started', () => {
  const { board, anim } = fresh();
  const a = board.get(2, 3);
  const b = board.get(3, 3);

  anim.enqueue([
    { kind: 'swap', a: { x: 2, y: 3 }, b: { x: 3, y: 3 } },
    { kind: 'swapBack', a: { x: 2, y: 3 }, b: { x: 3, y: 3 } },
  ]);
  runOut(anim);

  assert.deepEqual([anim.sprite(a.id)!.x, anim.sprite(a.id)!.y], [2, 3]);
  assert.deepEqual([anim.sprite(b.id)!.x, anim.sprite(b.id)!.y], [3, 3]);
});

test('cleared sprites shrink away and are then removed', () => {
  const { board, anim } = fresh();
  const doomed = [board.get(0, 0), board.get(1, 0), board.get(2, 0)];

  anim.enqueue([
    {
      kind: 'clear',
      cascade: 1,
      score: 180,
      cells: doomed.map((c, i) => ({ id: c.id, x: i, y: 0, type: c.type, special: c.special })),
    },
  ]);

  anim.update(60);
  for (const c of doomed) {
    const s = anim.sprite(c.id);
    assert.ok(s, 'sprite should still be visible while it plays its clear');
    assert.ok(s.scale < 1, 'clearing sprites shrink');
  }

  runOut(anim);
  for (const c of doomed) assert.equal(anim.sprite(c.id), undefined, 'cleared sprite was not removed');
  assert.equal(anim.list().length, board.width * board.height - 3);
});

test('falls and spawns land the board back on whole grid squares', () => {
  const { board, anim } = fresh();
  const mover = board.get(4, 4);
  const newId = 999_001;

  const ev: EngineEvent = {
    kind: 'fall',
    moves: [{ id: mover.id, x: 4, fromY: 4, toY: 7 }],
    spawns: [{ id: newId, x: 4, fromY: -1, toY: 0, type: 2, special: 'none', orient: null }],
  };
  anim.enqueue([ev]);

  anim.update(16);
  const spawned = anim.sprite(newId);
  assert.ok(spawned, 'spawned ball should exist as soon as the fall starts');
  assert.ok(spawned.y < 0.5, 'spawned ball starts above the board');

  runOut(anim);
  assert.equal(anim.sprite(mover.id)!.y, 7);
  assert.equal(anim.sprite(newId)!.y, 0);
  assert.equal(anim.sprite(newId)!.x, 4);
  assert.equal(anim.busy, false);
});

test('a created special is applied to the surviving sprite', () => {
  const { board, anim } = fresh();
  const host = board.get(3, 3);

  anim.enqueue([
    { kind: 'create', pos: { x: 3, y: 3 }, special: 'striker', orient: 'h', type: host.type, id: host.id },
    {
      kind: 'clear',
      cascade: 1,
      score: 240,
      cells: [{ id: board.get(4, 3).id, x: 4, y: 3, type: 1, special: 'none' }],
    },
  ]);
  runOut(anim);

  const s = anim.sprite(host.id)!;
  assert.equal(s.special, 'striker');
  assert.equal(s.orient, 'h');
  assert.equal(s.scale, 1, 'the pop-in should settle back to full size');
});

test('an activation flashes the cells it consumes without stranding them', () => {
  const { board, anim } = fresh();
  const cells = [
    { x: 0, y: 2 },
    { x: 1, y: 2 },
    { x: 2, y: 2 },
  ];
  anim.enqueue([
    { kind: 'activate', pos: { x: 0, y: 2 }, special: 'striker', cells },
    {
      kind: 'clear',
      cascade: 1,
      score: 100,
      cells: cells.map((p) => {
        const c = board.get(p.x, p.y);
        return { id: c.id, x: p.x, y: p.y, type: c.type, special: c.special };
      }),
    },
  ]);

  assert.ok(anim.flashes.length > 0, 'an activation should produce a visible flash');
  runOut(anim);
  assert.equal(anim.flashes.length, 0, 'flashes should expire');
  for (const p of cells) assert.equal(anim.sprite(board.get(p.x, p.y).id), undefined);
});

test('a reshuffle rebuilds the whole sprite set from the new layout', () => {
  const { board, anim } = fresh();
  const before = anim.list().map((s) => `${s.id}:${s.type}`).sort();

  const replacement = new Board({ seed: 'other-board' });
  anim.enqueue([{ kind: 'reshuffle', cells: replacement.grid().map((c) => ({ ...c })) }]);
  runOut(anim);

  assert.equal(anim.list().length, board.width * board.height);
  const after = anim.list().map((s) => `${s.id}:${s.type}`).sort();
  assert.notDeepEqual(after, before, 'reshuffle should have moved the balls around');

  // Every sprite now mirrors the reshuffled board, on its square and fully faded in.
  for (let y = 0; y < replacement.height; y++) {
    for (let x = 0; x < replacement.width; x++) {
      const cell = replacement.get(x, y);
      const s = anim.sprite(cell.id);
      assert.ok(s, `no sprite for reshuffled cell ${x},${y}`);
      assert.equal(s.x, x);
      assert.equal(s.y, y);
      assert.equal(s.type, cell.type);
      assert.equal(s.alpha, 1, 'reshuffled balls should fade fully in');
      assert.equal(s.scale, 1);
    }
  }
});

// ---------------------------------------------------------------------------

test('a whole move animates to completion and settles', () => {
  const board = new Board({ seed: 'full-move' });
  const anim = new Animator(board.width, board.height);
  anim.sync(board.grid());

  const move = board.findMove()!;
  const res = board.swap(move.a, move.b);
  anim.enqueue(res.events);
  assert.equal(anim.busy, true);
  runOut(anim);

  assert.equal(anim.list().length, board.width * board.height, 'sprite count must match the board again');

  // Every sprite should now sit on the square the engine says it does.
  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      const cell = board.get(x, y);
      const s = anim.sprite(cell.id);
      assert.ok(s, `board cell ${x},${y} has no sprite after animating`);
      assert.equal(s.x, x, `sprite for ${x},${y} settled on the wrong column`);
      assert.equal(s.y, y, `sprite for ${x},${y} settled on the wrong row`);
      assert.equal(s.special, cell.special);
      assert.equal(s.alpha, 1);
      assert.equal(s.scale, 1);
    }
  }
});

test('the animator agrees with the engine over a long session', () => {
  const board = new Board({ seed: 'long-session' });
  const anim = new Animator(board.width, board.height);
  anim.sync(board.grid());

  for (let turn = 0; turn < 30; turn++) {
    const move = board.findMove()!;
    anim.enqueue(board.swap(move.a, move.b).events);
    const dead = board.checkDeadlock();
    if (dead) anim.enqueue([dead]);
    runOut(anim);

    assert.equal(anim.list().length, board.width * board.height, `sprite leak on turn ${turn}`);
    for (let y = 0; y < board.height; y++) {
      for (let x = 0; x < board.width; x++) {
        const s = anim.sprite(board.get(x, y).id);
        assert.ok(s && s.x === x && s.y === y, `desync at ${x},${y} on turn ${turn}`);
      }
    }
  }
});

test('the timeline is frame-rate independent', () => {
  const board = new Board({ seed: 'frame-rate' });
  const move = board.findMove()!;
  const events = board.swap(move.a, move.b).events;

  const coarse = new Animator(board.width, board.height);
  const fine = new Animator(board.width, board.height);
  coarse.sync(board.grid());
  fine.sync(board.grid());

  // The engine already ran, so re-sync both from the pre-move state via a fresh board.
  const pre = new Board({ seed: 'frame-rate' });
  coarse.sync(pre.grid());
  fine.sync(pre.grid());

  coarse.enqueue(events);
  fine.enqueue(events);

  while (coarse.busy) coarse.update(50);
  while (fine.busy) fine.update(4);

  assert.equal(spriteState(coarse), spriteState(fine), 'different step sizes gave different end states');
});

test('enqueuing while busy queues the work rather than dropping it', () => {
  const { board, anim } = fresh('queueing');
  anim.enqueue([{ kind: 'swap', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
  anim.update(20);
  const firstEnd = anim.remaining;

  anim.enqueue([{ kind: 'swap', a: { x: 0, y: 1 }, b: { x: 1, y: 1 } }]);
  assert.ok(anim.remaining > firstEnd, 'the second swap should extend the timeline');

  runOut(anim);
  assert.equal(anim.sprite(board.get(0, 0).id)!.x, 1);
  assert.equal(anim.sprite(board.get(0, 1).id)!.x, 1);
});

test('an idle animator ignores update and stays put', () => {
  const { anim } = fresh('idle');
  const before = spriteState(anim);
  for (let i = 0; i < 10; i++) anim.update(16);
  assert.equal(spriteState(anim), before);
  assert.equal(anim.busy, false);
  assert.equal(anim.remaining, 0);
});
