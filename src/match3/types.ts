/**
 * Shared vocabulary for the Sixes match-3 engine.
 *
 * Nothing in `src/match3` touches the DOM, canvas or `window`. The engine is a
 * pure function of (seed, move sequence) so two clients can run it side by side
 * and stay byte-for-byte in sync — that is what a future 1v1 mode rides on.
 */

/** Balls are identified by index so a board is cheap to serialise. */
export type BallType = 0 | 1 | 2 | 3 | 4 | 5;

export const BALL_COUNT = 6;

export const BALL_TYPES: readonly BallType[] = [0, 1, 2, 3, 4, 5];

export const BALL_NAMES = ['rugby', 'soccer', 'cricket', 'tennis', 'golf', 'basketball'] as const;

export type BallName = (typeof BALL_NAMES)[number];

/**
 * Power-ups, earned by matching more than three.
 *
 * - `striker`   four in a line — sweeps the whole row or column it points along
 * - `matchball` five in a line — takes every ball of one type off the board
 * - `scrum`     an L or T of five — blows out the surrounding 3x3
 * - `hattrick`  six or more across two runs — sweeps the row *and* the column
 */
export type Special = 'none' | 'striker' | 'matchball' | 'scrum' | 'hattrick';

export type Orient = 'h' | 'v';

export interface Cell {
  /** Stable across falls, so the renderer can follow a ball down the board. */
  id: number;
  type: BallType;
  special: Special;
  /** Only meaningful for `striker`. */
  orient: Orient | null;
}

export interface Pos {
  x: number;
  y: number;
}

export interface ClearedCell {
  id: number;
  x: number;
  y: number;
  type: BallType;
  special: Special;
}

export interface FallMove {
  id: number;
  x: number;
  fromY: number;
  toY: number;
}

export interface SpawnCell {
  id: number;
  x: number;
  /** Negative — new balls drop in from above the top row. */
  fromY: number;
  toY: number;
  type: BallType;
  special: Special;
  orient: Orient | null;
}

/**
 * The engine narrates itself. Everything the presentation layer needs to draw a
 * turn arrives as a flat, JSON-safe list of these — no callbacks, no shared
 * mutable state, and replayable over a network.
 */
export type EngineEvent =
  | { kind: 'swap'; a: Pos; b: Pos }
  | { kind: 'swapBack'; a: Pos; b: Pos }
  | { kind: 'create'; pos: Pos; special: Special; orient: Orient | null; type: BallType; id: number }
  | { kind: 'activate'; pos: Pos; special: Special; cells: Pos[] }
  | { kind: 'clear'; cascade: number; cells: ClearedCell[]; score: number }
  | { kind: 'fall'; moves: FallMove[]; spawns: SpawnCell[] }
  | { kind: 'reshuffle'; cells: Cell[] }
  | { kind: 'settle' };

export interface CreatedSpecial {
  pos: Pos;
  special: Special;
  orient: Orient | null;
  type: BallType;
  id: number;
}

export interface MoveResult {
  valid: boolean;
  events: EngineEvent[];
  /** Points earned by this move alone. */
  score: number;
  /** How many times the board resolved before settling. */
  cascades: number;
  cleared: number;
  created: CreatedSpecial[];
}

export interface SerializedBoard {
  v: 1;
  width: number;
  height: number;
  typeCount: number;
  seed: string;
  rng: number;
  nextId: number;
  score: number;
  cells: Array<[number, number, Special, Orient | null]>;
}

/** A run of three or more of the same ball, plus the runs it intersects. */
export interface MatchRun {
  dir: Orient;
  cells: number[];
}

export interface MatchGroup {
  cells: number[];
  runs: MatchRun[];
  type: BallType;
}
