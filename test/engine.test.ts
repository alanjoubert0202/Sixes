import test from 'node:test';
import assert from 'node:assert/strict';

import { Board } from '../src/match3/board.ts';
import { Rng } from '../src/match3/rng.ts';
import type { EngineEvent, Pos } from '../src/match3/types.ts';

const SEEDS = ['sixes', 'rugby-world-cup', 'a', '12345', 'deadlock', 'zzz'];

function boardFor(seed: string | number, opts: Partial<{ width: number; height: number; types: number }> = {}) {
  return new Board({ seed, ...opts });
}

/** Every legal swap on the board, in deterministic scan order. */
function allSwaps(width: number, height: number): Array<[Pos, Pos]> {
  const out: Array<[Pos, Pos]> = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x + 1 < width) out.push([{ x, y }, { x: x + 1, y }]);
      if (y + 1 < height) out.push([{ x, y }, { x, y: y + 1 }]);
    }
  }
  return out;
}

/** A structural fingerprint of the board — ids excluded, since ids are bookkeeping. */
function fingerprint(b: Board): string {
  return b.snapshot();
}

// ---------------------------------------------------------------------------
// Board generation
// ---------------------------------------------------------------------------

test('generated board contains no free matches', () => {
  for (const seed of SEEDS) {
    const b = boardFor(seed);
    assert.equal(b.findMatches().length, 0, `seed ${seed} generated with a free match`);
  }
});

test('generated board always has at least one valid move', () => {
  for (const seed of SEEDS) {
    const b = boardFor(seed);
    assert.equal(b.hasValidMove(), true, `seed ${seed} generated in deadlock`);
    assert.notEqual(b.findMove(), null, `seed ${seed} reports a move but cannot name one`);
  }
});

test('findMove returns a swap that actually matches', () => {
  for (const seed of SEEDS) {
    const b = boardFor(seed);
    const move = b.findMove();
    assert.ok(move, 'expected a hint move');
    const res = b.swap(move.a, move.b);
    assert.equal(res.valid, true, `hint move on seed ${seed} was rejected`);
  }
});

test('board dimensions and cell contents are within bounds', () => {
  const b = boardFor('bounds', { width: 7, height: 9, types: 5 });
  assert.equal(b.width, 7);
  assert.equal(b.height, 9);
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const c = b.get(x, y);
      assert.ok(c.type >= 0 && c.type < 5, 'ball type out of configured range');
      assert.equal(c.special, 'none', 'fresh board should have no specials');
    }
  }
});

test('a fresh board of the same seed is identical every time', () => {
  for (const seed of SEEDS) {
    assert.equal(fingerprint(boardFor(seed)), fingerprint(boardFor(seed)));
  }
});

test('different seeds give different boards', () => {
  const prints = new Set(SEEDS.map((s) => fingerprint(boardFor(s))));
  assert.equal(prints.size, SEEDS.length, 'seeds collided — rng is not spreading');
});

// ---------------------------------------------------------------------------
// Swap legality
// ---------------------------------------------------------------------------

test('illegal swaps revert cleanly and leave the board untouched', () => {
  const b = boardFor('revert');
  let rejected = 0;

  for (const [a, c] of allSwaps(b.width, b.height)) {
    const before = fingerprint(b);
    const scoreBefore = b.score;
    const res = b.swap(a, c);
    if (res.valid) continue;

    rejected++;
    assert.equal(fingerprint(b), before, 'rejected swap mutated the board');
    assert.equal(b.score, scoreBefore, 'rejected swap changed the score');
    assert.equal(res.score, 0);
    assert.equal(res.cascades, 0);
    assert.equal(res.cleared, 0);

    // The caller still gets something to animate: a swap out and a swap back.
    const kinds = res.events.map((e) => e.kind);
    assert.deepEqual(kinds, ['swap', 'swapBack']);
  }

  assert.ok(rejected > 0, 'expected at least one illegal swap on a fresh board');
});

test('non-adjacent and out-of-bounds swaps are rejected without events', () => {
  const b = boardFor('adjacency');
  const before = fingerprint(b);

  const bad: Array<[Pos, Pos]> = [
    [{ x: 0, y: 0 }, { x: 2, y: 0 }],
    [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 0, y: 0 }],
    [{ x: -1, y: 0 }, { x: 0, y: 0 }],
    [{ x: 0, y: 0 }, { x: b.width, y: 0 }],
    [{ x: 0, y: b.height }, { x: 0, y: b.height - 1 }],
  ];

  for (const [a, c] of bad) {
    const res = b.swap(a, c);
    assert.equal(res.valid, false);
    assert.equal(res.events.length, 0, 'an impossible swap should not emit animation events');
  }
  assert.equal(fingerprint(b), before);
});

test('a legal swap scores and reports the cells it cleared', () => {
  const b = boardFor('scoring');
  const move = b.findMove()!;
  const res = b.swap(move.a, move.b);

  assert.equal(res.valid, true);
  assert.ok(res.cleared >= 3, 'a valid match clears at least three balls');
  assert.ok(res.score > 0, 'a valid match scores');
  assert.equal(b.score, res.score, 'board score should track the move');
  assert.ok(res.cascades >= 1);
});

// ---------------------------------------------------------------------------
// Cascades / board integrity
// ---------------------------------------------------------------------------

test('cascades resolve without corrupting the board', () => {
  for (const seed of SEEDS) {
    const b = boardFor(seed);
    const rng = new Rng(`play-${seed}`);

    for (let turn = 0; turn < 120; turn++) {
      const move = b.findMove();
      assert.ok(move, `board deadlocked without reshuffling on seed ${seed}`);

      // Mix hinted moves with random pokes so we exercise rejections too.
      const useHint = rng.float() < 0.75;
      if (useHint) b.swap(move.a, move.b);
      else {
        const swaps = allSwaps(b.width, b.height);
        const [a, c] = swaps[rng.int(swaps.length)];
        b.swap(a, c);
      }

      // Invariants that must hold after every settle.
      assert.equal(b.findMatches().length, 0, `unresolved match left on board (seed ${seed}, turn ${turn})`);
      assert.equal(b.hasValidMove(), true, `board left in deadlock (seed ${seed}, turn ${turn})`);

      const ids = new Set<number>();
      for (let y = 0; y < b.height; y++) {
        for (let x = 0; x < b.width; x++) {
          const c = b.get(x, y);
          assert.ok(c, `hole left in the board at ${x},${y} (seed ${seed}, turn ${turn})`);
          assert.ok(c.type >= 0 && c.type < 6, 'ball type went out of range');
          assert.equal(ids.has(c.id), false, 'duplicate cell id — a sprite would be orphaned');
          ids.add(c.id);
        }
      }
      assert.equal(ids.size, b.width * b.height, 'cell count changed');
    }

    assert.ok(b.score > 0, 'a long session should have scored');
  }
});

test('every clear event is followed by a fall event that refills the board', () => {
  const b = boardFor('gravity');
  for (let turn = 0; turn < 40; turn++) {
    const move = b.findMove()!;
    const res = b.swap(move.a, move.b);
    if (!res.valid) continue;

    const clears = res.events.filter((e) => e.kind === 'clear');
    const falls = res.events.filter((e) => e.kind === 'fall');
    assert.equal(clears.length, falls.length, 'every clear needs matching gravity');

    for (const ev of res.events) {
      if (ev.kind !== 'fall') continue;
      for (const m of ev.moves) assert.ok(m.toY > m.fromY, 'balls only fall downward');
      for (const s of ev.spawns) assert.ok(s.fromY < 0, 'new balls enter from above the board');
    }
    assert.equal(res.events.at(-1)!.kind, 'settle', 'a resolved move ends settled');
  }
});

test('cleared cells always describe real balls', () => {
  const b = boardFor('cleared-cells');
  for (let turn = 0; turn < 40; turn++) {
    const move = b.findMove()!;
    const res = b.swap(move.a, move.b);
    for (const ev of res.events) {
      if (ev.kind !== 'clear') continue;
      assert.ok(ev.cells.length > 0, 'empty clear event');
      const seen = new Set<string>();
      for (const c of ev.cells) {
        assert.ok(c.x >= 0 && c.x < b.width && c.y >= 0 && c.y < b.height, 'cleared cell out of bounds');
        const key = `${c.x},${c.y}`;
        assert.equal(seen.has(key), false, 'the same cell was cleared twice in one step');
        seen.add(key);
      }
      assert.ok(ev.score > 0);
      assert.ok(ev.cascade >= 1);
    }
  }
});

// ---------------------------------------------------------------------------
// Specials
// ---------------------------------------------------------------------------

test('match length decides which special is created', () => {
  const b = new Board({ seed: 'specials', width: 8, height: 8 });

  // Four in a line -> Striker.
  b.debugSet([
    '..A.....',
    'AABA....',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
  ]);
  assert.equal(b.findMatches().length, 0, 'striker fixture starts clean');
  let res = b.swap({ x: 2, y: 0 }, { x: 2, y: 1 });
  assert.equal(res.valid, true);
  assert.ok(res.created.some((c) => c.special === 'striker'), 'a four-match should mint a Striker');

  // Five in a line -> MatchBall.
  b.debugSet([
    '..A.....',
    'AABAA...',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
  ]);
  assert.equal(b.findMatches().length, 0, 'matchball fixture starts clean');
  res = b.swap({ x: 2, y: 0 }, { x: 2, y: 1 });
  assert.equal(res.valid, true);
  assert.ok(res.created.some((c) => c.special === 'matchball'), 'a five-match should mint a MatchBall');

  // An L of five -> Scrum.
  b.debugSet([
    '..A.....',
    'AAB.....',
    '..A.....',
    '..A.....',
    '........',
    '........',
    '........',
    '........',
  ]);
  assert.equal(b.findMatches().length, 0, 'scrum fixture starts clean');
  res = b.swap({ x: 2, y: 0 }, { x: 2, y: 1 });
  assert.equal(res.valid, true);
  assert.ok(res.created.some((c) => c.special === 'scrum'), 'an L of five should mint a Scrum');

  // Six cells across a four-run and a three-run -> HatTrick.
  b.debugSet([
    '...A....',
    '.AABA...',
    '...A....',
    '...A....',
    '........',
    '........',
    '........',
    '........',
  ]);
  assert.equal(b.findMatches().length, 0, 'hattrick fixture starts clean');
  res = b.swap({ x: 3, y: 1 }, { x: 4, y: 1 });
  assert.equal(res.valid, true);
  assert.ok(res.created.some((c) => c.special === 'hattrick'), 'six cells across two runs should mint a HatTrick');
});

test('a Striker clears its whole line when triggered', () => {
  const b = new Board({ seed: 'striker-fire', width: 8, height: 8, types: 4 });
  b.debugSet([
    'ABCDABCD',
    'BCDABCDA',
    'CDABCDAB',
    'DABCDABC',
    'ABCDABCD',
    'BCDABCDA',
    'CDABCDAB',
    'DABCDABC',
  ]);
  b.debugSetSpecial({ x: 0, y: 3 }, 'striker', 'h');
  const res = b.detonate({ x: 0, y: 3 });
  assert.equal(res.valid, true);
  assert.ok(res.cleared >= b.width, 'a Striker sweeps a full row');

  const swept = res.events.find((e) => e.kind === 'activate');
  assert.ok(swept && swept.kind === 'activate');
  assert.equal(swept.cells.length, b.width, 'a horizontal Striker takes exactly its row');
  assert.equal(swept.cells.every((p) => p.y === 3), true);
});

test('a MatchBall clears every ball of the chosen type', () => {
  const b = new Board({ seed: 'matchball-fire', width: 8, height: 8, types: 4 });
  b.debugSet([
    'ABCDABCD',
    'BCDABCDA',
    'CDABCDAB',
    'DABCDABC',
    'ABCDABCD',
    'BCDABCDA',
    'CDABCDAB',
    'DABCDABC',
  ]);
  const expected = b.countOfType(0);
  b.debugSetSpecial({ x: 0, y: 0 }, 'matchball');

  const res = b.detonate({ x: 0, y: 0 }, 0);
  assert.equal(res.valid, true);
  // The MatchBall itself plus every ball of type A.
  assert.ok(res.cleared >= expected, `expected at least ${expected} clears, got ${res.cleared}`);
});

test('a Scrum blasts a three-by-three block', () => {
  const b = new Board({ seed: 'scrum-fire', width: 8, height: 8, types: 4 });
  b.debugSet([
    'ABCDABCD',
    'BCDABCDA',
    'CDABCDAB',
    'DABCDABC',
    'ABCDABCD',
    'BCDABCDA',
    'CDABCDAB',
    'DABCDABC',
  ]);
  b.debugSetSpecial({ x: 4, y: 4 }, 'scrum');
  const res = b.detonate({ x: 4, y: 4 });
  assert.ok(res.cleared >= 9, 'a Scrum in open board clears at least its 3x3');
});

test('specials chain-react when one blast catches another', () => {
  const b = new Board({ seed: 'chain', width: 8, height: 8, types: 4 });
  b.debugSet([
    'ABCDABCD',
    'BCDABCDA',
    'CDABCDAB',
    'DABCDABC',
    'ABCDABCD',
    'BCDABCDA',
    'CDABCDAB',
    'DABCDABC',
  ]);
  b.debugSetSpecial({ x: 0, y: 3 }, 'striker', 'h'); // clears row 3
  b.debugSetSpecial({ x: 5, y: 3 }, 'striker', 'v'); // sits in row 3, clears column 5

  const res = b.detonate({ x: 0, y: 3 });
  const activations = res.events.filter((e) => e.kind === 'activate');
  assert.ok(activations.length >= 2, 'the second Striker should have been set off by the first');
  assert.ok(res.cleared > b.width, 'a chained Striker clears more than a single line');
});

// ---------------------------------------------------------------------------
// Deadlock
// ---------------------------------------------------------------------------

test('a deadlocked board reshuffles itself into a playable one', () => {
  const b = new Board({ seed: 'deadlock-forced', width: 6, height: 6, types: 4 });
  // Alternating bands: no run of three exists and no single swap can make one.
  b.debugSet([
    'ABABAB',
    'CDCDCD',
    'ABABAB',
    'CDCDCD',
    'ABABAB',
    'CDCDCD',
  ]);
  assert.equal(b.findMatches().length, 0, 'fixture should start with no matches');
  assert.equal(b.hasValidMove(), false, 'test fixture is supposed to be deadlocked');

  const ev = b.checkDeadlock();
  assert.ok(ev, 'a deadlocked board should report a reshuffle');
  assert.equal(ev.kind, 'reshuffle');
  assert.equal(b.hasValidMove(), true, 'board should be playable after reshuffling');
  assert.equal(b.findMatches().length, 0, 'reshuffle should not hand out free matches');
});

test('reshuffles keep the same multiset of balls where possible', () => {
  const b = new Board({ seed: 'reshuffle-conserve', width: 6, height: 6, types: 4 });
  b.debugSet([
    'ABABAB',
    'CDCDCD',
    'ABABAB',
    'CDCDCD',
    'ABABAB',
    'CDCDCD',
  ]);
  const before = [0, 1, 2, 3].map((t) => b.countOfType(t));
  const ev = b.checkDeadlock();
  assert.ok(ev);
  const after = [0, 1, 2, 3].map((t) => b.countOfType(t));
  assert.deepEqual(after, before, 'a reshuffle should move balls, not invent them');
});

test('a playable board is left alone by the deadlock check', () => {
  const b = boardFor('no-deadlock');
  const before = fingerprint(b);
  assert.equal(b.checkDeadlock(), null);
  assert.equal(fingerprint(b), before);
});

// ---------------------------------------------------------------------------
// Determinism — the one that matters for 1v1
// ---------------------------------------------------------------------------

/** Play a scripted session and return everything an opponent would need to agree on. */
function play(seed: string, moves: number): { print: string; score: number; log: string } {
  const b = new Board({ seed });
  const rng = new Rng(`script-${seed}`);
  const log: string[] = [];

  for (let i = 0; i < moves; i++) {
    const swaps = allSwaps(b.width, b.height);
    const [a, c] = swaps[rng.int(swaps.length)];
    const res = b.swap(a, c);
    log.push(`${a.x},${a.y}->${c.x},${c.y} ${res.valid ? 1 : 0} ${res.score} ${res.cascades} ${res.cleared}`);
    log.push(JSON.stringify(res.events));
    const dead = b.checkDeadlock();
    if (dead) log.push(JSON.stringify(dead));
  }
  return { print: b.snapshot(), score: b.score, log: log.join('\n') };
}

test('same seed and same move sequence produce identical boards', () => {
  for (const seed of SEEDS) {
    const a = play(seed, 60);
    const c = play(seed, 60);
    assert.equal(a.print, c.print, `final board diverged for seed ${seed}`);
    assert.equal(a.score, c.score, `final score diverged for seed ${seed}`);
  }
});

test('same seed and same move sequence produce identical event streams', () => {
  for (const seed of SEEDS) {
    const a = play(seed, 60);
    const c = play(seed, 60);
    assert.equal(a.log, c.log, `event stream diverged for seed ${seed} — 1v1 would desync`);
  }
});

test('two players on the same seed stay in sync move by move', () => {
  const seed = 'head-to-head';
  const p1 = new Board({ seed });
  const p2 = new Board({ seed });
  const rng = new Rng('h2h-script');

  assert.equal(p1.snapshot(), p2.snapshot(), 'players did not start on the same board');

  for (let i = 0; i < 80; i++) {
    const swaps = allSwaps(p1.width, p1.height);
    const [a, c] = swaps[rng.int(swaps.length)];

    const r1 = p1.swap(a, c);
    const r2 = p2.swap(a, c);

    assert.equal(r1.valid, r2.valid, `move ${i}: players disagreed on legality`);
    assert.equal(r1.score, r2.score, `move ${i}: players scored differently`);
    assert.equal(r1.cleared, r2.cleared, `move ${i}: players cleared differently`);
    assert.deepEqual(r1.events, r2.events, `move ${i}: event streams diverged`);
    assert.equal(p1.snapshot(), p2.snapshot(), `move ${i}: boards diverged`);

    assert.deepEqual(p1.checkDeadlock(), p2.checkDeadlock(), `move ${i}: reshuffles diverged`);
    assert.equal(p1.snapshot(), p2.snapshot(), `move ${i}: boards diverged after reshuffle`);
  }
});

test('a board can be serialised and resumed without changing its future', () => {
  const seed = 'resume';
  const a = new Board({ seed });
  const rng = new Rng('resume-script');
  const swaps = allSwaps(a.width, a.height);

  const script: Array<[Pos, Pos]> = [];
  for (let i = 0; i < 40; i++) script.push(swaps[rng.int(swaps.length)]);

  for (const [p, q] of script.slice(0, 20)) a.swap(p, q);

  const saved = a.serialize();
  const b = Board.deserialize(saved);
  assert.equal(b.snapshot(), a.snapshot());
  assert.equal(b.score, a.score);

  for (const [p, q] of script.slice(20)) {
    const ra = a.swap(p, q);
    const rb = b.swap(p, q);
    assert.deepEqual(rb.events, ra.events, 'a resumed board must replay identically');
  }
  assert.equal(b.snapshot(), a.snapshot());
  assert.equal(b.score, a.score);
});

test('rng is reproducible and stays in range', () => {
  const a = new Rng('rng-seed');
  const b = new Rng('rng-seed');
  for (let i = 0; i < 1000; i++) {
    const x = a.float();
    assert.equal(x, b.float());
    assert.ok(x >= 0 && x < 1, 'float out of range');
    const n = a.int(7);
    assert.equal(n, b.int(7));
    assert.ok(Number.isInteger(n) && n >= 0 && n < 7, 'int out of range');
  }
  assert.notEqual(new Rng('other').float(), new Rng('rng-seed').float());
});

test('events serialise to plain JSON so they can cross a wire', () => {
  const b = boardFor('wire');
  const collected: EngineEvent[] = [];
  for (let i = 0; i < 30; i++) {
    const move = b.findMove()!;
    collected.push(...b.swap(move.a, move.b).events);
  }
  assert.ok(collected.length > 0);
  const round = JSON.parse(JSON.stringify(collected));
  assert.deepEqual(round, collected, 'events must survive a JSON round trip');
});
