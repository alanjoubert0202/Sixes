# Sixes

A match-three game played with sports balls — rugby, soccer, cricket, tennis,
golf and basketball. Installable PWA, plays offline, built with Vite and
TypeScript and no framework. Every ball is drawn with canvas primitives; the
project contains no image assets.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine, animator, renderer and level tests
npm run build    # dist/ + a generated service worker
npm start        # serve dist/ with Express
```

## How it plays

Swap two neighbouring balls to line up three or more. Bigger matches earn
power-ups:

| Match | Power-up | What it does |
| --- | --- | --- |
| Four in a line | **Striker** | Sweeps the whole row or column it points along |
| Five in a line | **MatchBall** | Takes every ball of one type off the pitch |
| An L or T of five | **Scrum** | Blows out the surrounding 3×3 |
| Six or more across two runs | **HatTrick** | Sweeps the row *and* the column |

Power-ups combine. Two Strikers make a cross, two Scrums make a 5×5, and a
MatchBall next to any power-up turns every ball of that colour into that
power-up and sets the lot off at once. A MatchBall is legal against any
neighbour, so it never blocks the board.

Clear the level's target score before the moves run out. Progress is kept in
`localStorage`.

## Layout

```
src/match3/     headless engine — no DOM, no canvas, no window
  types.ts      cells, events, results
  rng.ts        seeded mulberry32
  board.ts      generation, matching, cascades, power-ups, deadlock reshuffle
src/game/
  balls.ts      the six balls and their power-up dressing, in canvas primitives
  animator.ts   turns engine events into tweened sprites (also DOM-free)
  renderer.ts   draws the board
  game.ts       frame loop, pointer input, level definitions
src/main.ts     HUD wiring, level progression, service worker registration
test/           node:test, run straight off the TypeScript sources
scripts/        icon and service-worker generation
```

`src/match3` never imports anything from `src/game`, and holds no reference to
the DOM. That is what lets the engine tests run in plain Node, and it is what
makes the next section possible.

## Determinism

The engine is a pure function of `(seed, move sequence)`. All randomness — board
generation, refills, reshuffles — comes from one seeded PRNG, and every tie
(which cell is promoted to a power-up, which colour a stray MatchBall takes) is
broken by a fixed scan order rather than by chance. The RNG uses only `Math.imul`
and `>>>`, so there is no floating-point drift between clients.

Two boards given the same seed and the same swaps produce identical grids,
identical scores, **and identical event streams**:

```ts
const p1 = new Board({ seed: 'match-42' });
const p2 = new Board({ seed: 'match-42' });

const r1 = p1.swap({ x: 2, y: 3 }, { x: 3, y: 3 });
const r2 = p2.swap({ x: 2, y: 3 }, { x: 3, y: 3 });
// r1.events deep-equals r2.events
```

That is the hook a 1v1 mode would ride on: hand both players the same seed and
send only their moves over the wire, and the two boards stay in lockstep without
sending any board state at all. `board.serialize()` / `Board.deserialize()`
round-trip the RNG cursor too, so a match can be resumed mid-game without
changing its future. The determinism tests in `test/engine.test.ts` cover all of
this, including an 80-move head-to-head replay.

Events are plain JSON — no class instances, no functions — so they can go
straight down a socket.

## Levels

Twelve levels. The two levers are the number of ball types in play (a sixth type
roughly halves how often a swap connects) and how many moves you get.

Goals were set from simulated play rather than guessed. A scripted player was run
over each configuration at several skill levels; a casual run — taking the
best-scoring swap half the time — averages about 2,400 points a move at five ball
types and about 900 at six. Early levels sit well under that, the last few sit
slightly above it, so they need power-ups to be built deliberately rather than
stumbled into. `test/levels.test.ts` guards the shape of the curve.

The simulation has one blind spot worth knowing about: its "casual" player is
already *better* than a real first-timer, because taking the best available swap
half the time beats not yet knowing that Strikers exist. The opening levels are
therefore measured against weaker yardsticks — random legal moves for level 1,
and a "novice" who takes the best swap about a third of the time thereafter.
Clear rates over 60 seeded runs per cell, 95% confidence:

| Level | Goal | Moves | Novice | Learner | Pressure |
| --- | --- | --- | --- | --- | --- |
| 1 Kick Off | 12,000 | 18 | 92% ±7 | 100% | 37 |
| 2 First Half | 18,000 | 18 | 77% ±11 | 97% ±5 | 56 |
| 3 Line Out | 16,000 | 16 | 73% ±11 | 100% | 63 |
| 4 Set Piece | 16,000 | 14 | 75% ±11 | 92% ±7 | 82 |
| 5 Sixes | 14,000 | 22 | 72% ±11 | 93% ±6 | 29 |

"Pressure" is `goal / moves²`, the quantity `test/levels.test.ts` requires to
increase within a run of levels sharing a ball count. It rises steadily while
the measured clear rate stays roughly flat, which is the intent: past level 1
the early game separates players by the score they post, not by whether they
pass. Note the confidence intervals — at this sample size a 73% and a 77% are
not meaningfully different, so treat the ordering of adjacent levels as flat
rather than as a ladder.

One caveat on the model: the bot's "skill" is how often it takes the highest
scoring swap available, which is not the same as playing well. Grabbing points
immediately tends to spend a Striker that a person would have saved and
combined, so a greedier bot is not reliably a stronger one. The bands are
useful for pitching a goal, not for ranking players.

## PWA

`public/manifest.webmanifest` plus a generated service worker. `scripts/gen-sw.mjs`
runs after `vite build`, walks `dist/`, and writes `dist/sw.js` with the real
hashed asset list precached and a content-derived cache version, so a deploy
invalidates the old cache by itself.

Navigations are network-first falling back to the cached shell; hashed assets are
cache-first. Once the app has been opened it plays with no network at all.

Icons are generated too — `scripts/gen-icons.mjs` draws the mark pixel by pixel
and encodes PNGs with the built-in zlib, so there are still no image assets in
the repository. It produces the 192/512 icons, a maskable 512 with the art inside
a safe radius, and a 180px `apple-touch-icon` for iOS. `public/icons/` is
gitignored and rebuilt by `prebuild`.

Installing: **Share → Add to Home Screen** on iOS, or the install prompt on
Android and desktop Chrome.

## Deploying to Railway

`railway.json` builds with Nixpacks (`npm run build`) and starts `npm start`.
`server.js` serves `dist/`, reads `process.env.PORT`, and exposes `/healthz` for
Railway's healthcheck — the endpoint answers even if the build is missing, and
reports whether `dist/index.html` is present.

Cache headers are set per asset class: `immutable` for fingerprinted files in
`assets/`, `no-cache` for `index.html`, the manifest and `sw.js`. Unknown GET
paths fall through to the shell.

```bash
railway up
```

## Testing

`npm test` runs `node --test` directly against the TypeScript sources using
Node's built-in type stripping — no build step and no test framework.

- `test/engine.test.ts` — generation invariants, swap legality and clean
  reverts, cascade integrity over long sessions, power-up rules, deadlock
  reshuffles, and determinism.
- `test/animator.test.ts` — the event-to-sprite timeline, including that it is
  frame-rate independent and that it never drifts out of agreement with the
  engine.
- `test/render.test.ts` — drives the renderer through a recording canvas that
  rejects malformed colours and non-finite geometry.
- `test/levels.test.ts` — the level table and the shape of the difficulty curve.
