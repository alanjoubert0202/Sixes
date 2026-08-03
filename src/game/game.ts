import { Board } from '../match3/board.ts';
import type { CreatedSpecial, Pos } from '../match3/types.ts';
import { Animator } from './animator.ts';
import { Renderer } from './renderer.ts';

export interface Level {
  id: number;
  name: string;
  /** Points needed to clear the level. */
  goal: number;
  moves: number;
  width: number;
  height: number;
  types: number;
}

/**
 * Twelve levels.
 *
 * The two levers are how many ball types are in play — a sixth type roughly
 * halves how often a swap connects — and how many moves you get for the goal.
 * The numbers below are tuned against simulated play (see the notes in
 * README.md): the early levels sit well under what a casual run scores, the
 * last few sit slightly above it.
 *
 * The first two levels are the exception, and are pitched below what the curve
 * alone would suggest, because the simulation flatters a beginner. Its "casual"
 * player takes the best available swap half the time, which is *stronger* than
 * someone opening the game for the first time — they have not seen the board,
 * do not line up cascades on purpose, and are slow to spot a Striker.
 *
 * So the opening four are measured against weaker yardsticks. Kick Off is set
 * below what arbitrary legal moves average (~14,000 over its 18 moves), so a
 * first attempt clears it. Levels 2 to 4 are set against a player who takes the
 * best swap about a third of the time — roughly someone a level or two in — and
 * ease off from four clears in five down to about two in three, which is where
 * Sixes picks up when the sixth ball arrives.
 *
 * Difficulty still climbs across all four: goal per move squared runs
 * 37 -> 56 -> 63 -> 82. What changed is that it climbs from a reachable
 * starting point instead of starting above one, and that the climb now shows
 * up in the score a player posts rather than in whether they pass at all.
 *
 * The six-ball run from Sixes to Golden Point is set the same way, but its
 * goals are read straight off measured score distributions: each one is the
 * quantile that lands a novice on a target clear rate, tapering from roughly
 * two thirds down to about half so that a player who is improving still meets
 * resistance. Its pressure climbs 29 -> 43 across the eight levels.
 */
export const LEVELS: Level[] = [
  { id: 1, name: 'Kick Off', goal: 12_000, moves: 18, width: 8, height: 8, types: 5 },
  { id: 2, name: 'First Half', goal: 18_000, moves: 18, width: 8, height: 8, types: 5 },
  { id: 3, name: 'Line Out', goal: 16_000, moves: 16, width: 8, height: 8, types: 5 },
  { id: 4, name: 'Set Piece', goal: 16_000, moves: 14, width: 8, height: 8, types: 5 },
  // The sixth ball arrives — moves go back up while the player adjusts.
  { id: 5, name: 'Sixes', goal: 14_000, moves: 22, width: 8, height: 8, types: 6 },
  { id: 6, name: 'Counter Attack', goal: 14_500, moves: 22, width: 8, height: 8, types: 6 },
  { id: 7, name: 'Second Half', goal: 12_500, moves: 20, width: 8, height: 8, types: 6 },
  { id: 8, name: 'Quarter Final', goal: 13_000, moves: 20, width: 8, height: 8, types: 6 },
  { id: 9, name: 'Semi Final', goal: 11_500, moves: 18, width: 8, height: 8, types: 6 },
  { id: 10, name: 'The Final', goal: 12_000, moves: 18, width: 8, height: 8, types: 6 },
  { id: 11, name: 'Extra Time', goal: 10_500, moves: 16, width: 8, height: 8, types: 6 },
  { id: 12, name: 'Golden Point', goal: 11_000, moves: 16, width: 8, height: 8, types: 6 },
];

export interface GameCallbacks {
  onScore?(score: number, goal: number): void;
  onMoves?(left: number): void;
  onLevel?(level: Level): void;
  onSpecial?(created: CreatedSpecial[]): void;
  onFinish?(outcome: { won: boolean; score: number; level: Level; movesLeft: number }): void;
}

const HINT_DELAY = 6_000;
const DRAG_FRACTION = 0.32;

/**
 * Wires the engine, the animator and the renderer into a playable board:
 * owns the frame loop, pointer input, and when a level is won or lost.
 */
export class Game {
  private canvas: HTMLCanvasElement;
  private callbacks: GameCallbacks;

  private board: Board;
  private animator: Animator;
  private renderer: Renderer;
  private level: Level;
  private seed: string;

  private movesLeft = 0;
  private finished = false;
  private awaitingSettle = false;
  private idleFor = 0;
  private lastFrame = 0;
  private raf = 0;
  private running = false;

  private pointerId: number | null = null;
  private pressOrigin: { x: number; y: number } | null = null;
  private pressCell: Pos | null = null;
  private dragged = false;
  private observer: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement, level: Level, seed: string, callbacks: GameCallbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.level = level;
    this.seed = seed;
    this.board = new Board({ seed, width: level.width, height: level.height, types: level.types });
    this.animator = new Animator(level.width, level.height);
    this.renderer = new Renderer(canvas, level.width, level.height);
    this.animator.sync(this.board.grid());
    this.movesLeft = level.moves;

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.frame = this.frame.bind(this);
  }

  // -------------------------------------------------------------------------

  get currentLevel(): Level {
    return this.level;
  }

  get score(): number {
    return this.board.score;
  }

  get moves(): number {
    return this.movesLeft;
  }

  get busy(): boolean {
    return this.animator.busy;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);

    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.canvas.parentElement ?? this.canvas);
    this.fit();

    this.callbacks.onLevel?.(this.level);
    this.callbacks.onScore?.(this.board.score, this.level.goal);
    this.callbacks.onMoves?.(this.movesLeft);

    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Re-measure after a rotation or a keyboard opening. */
  fit(): void {
    const host = this.canvas.parentElement;
    const rect = host ? host.getBoundingClientRect() : this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    this.renderer.resize(rect.width, rect.height);
  }

  /** Light up a playable swap. Also fires automatically when the player stalls. */
  showHint(): void {
    if (this.finished || this.animator.busy) return;
    this.renderer.hint = this.board.findMove();
  }

  /** The seed that produced this board — hand it to a second player for 1v1. */
  get boardSeed(): string {
    return this.seed;
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  private frame(now: number): void {
    if (!this.running) return;
    // Clamp so a backgrounded tab does not fast-forward the whole board.
    const dt = Math.min(now - this.lastFrame, 64);
    this.lastFrame = now;

    this.animator.update(dt);

    if (this.awaitingSettle && !this.animator.busy) {
      this.awaitingSettle = false;
      this.checkFinish();
    }

    if (!this.animator.busy && !this.finished) {
      this.idleFor += dt;
      if (this.idleFor > HINT_DELAY && !this.renderer.hint) this.showHint();
    }

    this.renderer.draw(this.animator, dt);
    this.raf = requestAnimationFrame(this.frame);
  }

  private checkFinish(): void {
    if (this.finished) return;
    const won = this.board.score >= this.level.goal;
    if (!won && this.movesLeft > 0) return;
    this.finished = true;
    this.renderer.hint = null;
    this.renderer.selected = null;
    this.callbacks.onFinish?.({
      won,
      score: this.board.score,
      level: this.level,
      movesLeft: this.movesLeft,
    });
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private localPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.finished || this.animator.busy) return;
    const point = this.localPoint(event);
    const cell = this.renderer.pick(point.x, point.y);
    if (!cell) return;

    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    this.pointerId = event.pointerId;
    this.pressOrigin = point;
    this.dragged = false;
    this.idleFor = 0;
    this.renderer.hint = null;

    const selected = this.renderer.selected;
    if (selected && adjacent(selected, cell)) {
      const played = this.tryMove(selected, cell);
      // A rejected pairing should leave the new ball selected rather than
      // dropping the player back to nothing.
      this.renderer.selected = played ? null : cell;
      this.pressCell = played ? null : cell;
      if (played) this.pressOrigin = null;
      return;
    }

    this.pressCell = cell;
    this.renderer.selected = cell;
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return;
    if (!this.pressOrigin || !this.pressCell || this.dragged) return;
    if (this.finished || this.animator.busy) return;

    const point = this.localPoint(event);
    const dx = point.x - this.pressOrigin.x;
    const dy = point.y - this.pressOrigin.y;
    const threshold = this.renderer.layout.cell * DRAG_FRACTION;
    if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;

    // Commit to the dominant axis so a sloppy diagonal still does the obvious thing.
    const target =
      Math.abs(dx) > Math.abs(dy)
        ? { x: this.pressCell.x + Math.sign(dx), y: this.pressCell.y }
        : { x: this.pressCell.x, y: this.pressCell.y + Math.sign(dy) };

    this.dragged = true;
    this.renderer.selected = null;
    this.tryMove(this.pressCell, target);
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.pointerId = null;
    this.pressOrigin = null;
    this.pressCell = null;
    this.dragged = false;
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  /** Returns whether the swap was legal and consumed a move. */
  private tryMove(a: Pos, b: Pos): boolean {
    if (this.finished || this.animator.busy) return false;
    if (!this.board.inBounds(a) || !this.board.inBounds(b)) return false;

    const result = this.board.swap(a, b);
    this.idleFor = 0;
    this.renderer.hint = null;

    if (!result.valid) {
      // Still animate the nudge-and-return so the tap does not feel ignored.
      this.animator.enqueue(result.events);
      return false;
    }

    this.movesLeft = Math.max(0, this.movesLeft - 1);
    this.animator.enqueue(result.events);

    const reshuffle = this.board.checkDeadlock();
    if (reshuffle) this.animator.enqueue([reshuffle]);

    this.awaitingSettle = true;
    this.callbacks.onScore?.(this.board.score, this.level.goal);
    this.callbacks.onMoves?.(this.movesLeft);
    if (result.created.length > 0) this.callbacks.onSpecial?.(result.created);
    return true;
  }
}

function adjacent(a: Pos, b: Pos): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}
