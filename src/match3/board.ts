import { Rng } from './rng.ts';
import { BALL_COUNT } from './types.ts';
import type {
  BallType,
  Cell,
  ClearedCell,
  CreatedSpecial,
  EngineEvent,
  FallMove,
  MatchGroup,
  MatchRun,
  MoveResult,
  Orient,
  Pos,
  SerializedBoard,
  SpawnCell,
  Special,
} from './types.ts';

export interface BoardOptions {
  seed: string | number;
  width?: number;
  height?: number;
  /** How many ball types are in play. Fewer types means easier matches. */
  types?: number;
  /** Internal — skip generation when restoring a saved board. */
  generate?: boolean;
}

/** One special going off. `affected` is pre-computed for combos. */
interface Activation {
  idx: number;
  special: Special;
  orient: Orient | null;
  affected: number[] | null;
}

const DEFAULT_WIDTH = 8;
const DEFAULT_HEIGHT = 8;

/** Points per ball, multiplied by the cascade depth. */
const SCORE_PER_BALL = 60;
const SCORE_PER_ACTIVATION = 50;
const SCORE_FOR_SPECIAL: Record<Special, number> = {
  none: 0,
  striker: 120,
  scrum: 200,
  hattrick: 300,
  matchball: 400,
};

/** Runaway-cascade backstop; real games never come close. */
const MAX_CASCADES = 200;

const SPECIAL_MARK: Record<Special, string> = {
  none: '.',
  striker: '-',
  matchball: '*',
  scrum: 'o',
  hattrick: '+',
};

/**
 * The Sixes board.
 *
 * Everything that could vary between two clients — refills, reshuffles, which
 * cell is promoted to a special — is driven by the seeded {@link Rng} or by a
 * fixed scan order. Given the same seed and the same swaps, two boards produce
 * identical state *and* identical event streams.
 */
export class Board {
  readonly width: number;
  readonly height: number;
  readonly typeCount: number;

  score = 0;

  private prng: Rng;
  private cells: Array<Cell | null>;
  private nextId = 1;
  /** Cells the player just touched; they win ties for where a special lands. */
  private lastMoved: number[] = [];

  constructor(options: BoardOptions) {
    this.width = options.width ?? DEFAULT_WIDTH;
    this.height = options.height ?? DEFAULT_HEIGHT;
    this.typeCount = Math.min(Math.max(options.types ?? BALL_COUNT, 3), BALL_COUNT);
    this.prng = new Rng(options.seed);
    this.cells = new Array<Cell | null>(this.width * this.height).fill(null);
    if (options.generate !== false) this.generate();
  }

  // -------------------------------------------------------------------------
  // Reading the board
  // -------------------------------------------------------------------------

  get rng(): Rng {
    return this.prng;
  }

  get size(): number {
    return this.width * this.height;
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  pos(i: number): Pos {
    return { x: i % this.width, y: Math.floor(i / this.width) };
  }

  inBounds(p: Pos): boolean {
    return p.x >= 0 && p.y >= 0 && p.x < this.width && p.y < this.height;
  }

  get(x: number, y: number): Cell {
    return this.cells[this.index(x, y)] as Cell;
  }

  /** The whole board in row-major order. Treat it as read-only. */
  grid(): readonly Cell[] {
    return this.cells as Cell[];
  }

  countOfType(type: number): number {
    let n = 0;
    for (const cell of this.cells) if (cell && cell.type === type) n++;
    return n;
  }

  /**
   * A compact, comparable rendering of the board — two chars per cell, rows
   * separated by `/`. Tests and 1v1 sync checks compare these.
   */
  snapshot(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let row = '';
      for (let x = 0; x < this.width; x++) {
        const cell = this.get(x, y);
        row += String.fromCharCode(65 + cell.type);
        row += cell.special === 'striker' ? (cell.orient === 'v' ? '|' : '-') : SPECIAL_MARK[cell.special];
      }
      rows.push(row);
    }
    return rows.join('/');
  }

  toString(): string {
    return this.snapshot().split('/').join('\n');
  }

  // -------------------------------------------------------------------------
  // Serialisation
  // -------------------------------------------------------------------------

  serialize(): SerializedBoard {
    return {
      v: 1,
      width: this.width,
      height: this.height,
      typeCount: this.typeCount,
      seed: this.prng.seed,
      rng: this.prng.cursor,
      nextId: this.nextId,
      score: this.score,
      cells: (this.cells as Cell[]).map((c) => [c.id, c.type, c.special, c.orient]),
    };
  }

  static deserialize(data: SerializedBoard): Board {
    const board = new Board({
      seed: data.seed,
      width: data.width,
      height: data.height,
      types: data.typeCount,
      generate: false,
    });
    board.prng = new Rng(data.seed, data.rng);
    board.nextId = data.nextId;
    board.score = data.score;
    board.cells = data.cells.map(([id, type, special, orient]) => ({
      id,
      type: type as BallType,
      special,
      orient,
    }));
    return board;
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  private newCell(type?: BallType): Cell {
    return {
      id: this.nextId++,
      type: type ?? (this.prng.int(this.typeCount) as BallType),
      special: 'none',
      orient: null,
    };
  }

  /** Fill the board so that no run of three exists, then guarantee a move. */
  private generate(): void {
    this.fillFresh();
    if (!this.hasValidMove()) this.reshuffleCells();
    this.lastMoved = [];
  }

  private fillFresh(): void {
    this.cells.fill(null);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = this.index(x, y);
        const cell = this.newCell();
        this.cells[i] = cell;
        cell.type = this.safeTypeAt(i, cell.type);
      }
    }
  }

  /** The first type, scanning up from `preferred`, that does not make a run. */
  private safeTypeAt(i: number, preferred: BallType): BallType {
    for (let step = 0; step < this.typeCount; step++) {
      const type = ((preferred + step) % this.typeCount) as BallType;
      const cell = this.cells[i];
      if (!cell) continue;
      const previous = cell.type;
      cell.type = type;
      if (!this.hasRunAt(i)) return type;
      cell.type = previous;
    }
    return preferred;
  }

  /**
   * Shuffle the balls already on the board until the layout is both match-free
   * and playable. Balls are moved, never invented — the mix of types is kept.
   */
  private reshuffleCells(): boolean {
    const pool = (this.cells as Cell[]).slice();
    for (let attempt = 0; attempt < 400; attempt++) {
      this.prng.shuffle(pool);
      for (let i = 0; i < pool.length; i++) this.cells[i] = pool[i];
      if (this.findRuns().length === 0 && this.hasValidMove()) return true;
    }
    // Pathological mixes (say, only two types left) can be unshufflable.
    // Falling back to a fresh fill keeps the game playable.
    this.fillFresh();
    return this.hasValidMove();
  }

  // -------------------------------------------------------------------------
  // Matching
  // -------------------------------------------------------------------------

  /**
   * The type a cell matches on, or -1 if it matches nothing. MatchBalls have no
   * colour of their own, so they never take part in a run.
   */
  private matchType(i: number): number {
    const cell = this.cells[i];
    if (!cell || cell.special === 'matchball') return -1;
    return cell.type;
  }

  /** Does a run of three or more pass through this cell? */
  hasRunAt(i: number): boolean {
    const type = this.matchType(i);
    if (type < 0) return false;
    const { x, y } = this.pos(i);

    let run = 1;
    for (let k = x - 1; k >= 0 && this.matchType(this.index(k, y)) === type; k--) run++;
    for (let k = x + 1; k < this.width && this.matchType(this.index(k, y)) === type; k++) run++;
    if (run >= 3) return true;

    run = 1;
    for (let k = y - 1; k >= 0 && this.matchType(this.index(x, k)) === type; k--) run++;
    for (let k = y + 1; k < this.height && this.matchType(this.index(x, k)) === type; k++) run++;
    return run >= 3;
  }

  /** Every maximal run of three or more, horizontal then vertical. */
  findRuns(): MatchRun[] {
    const runs: MatchRun[] = [];

    for (let y = 0; y < this.height; y++) {
      let start = 0;
      for (let x = 1; x <= this.width; x++) {
        const same =
          x < this.width &&
          this.matchType(this.index(x, y)) >= 0 &&
          this.matchType(this.index(x, y)) === this.matchType(this.index(x - 1, y));
        if (same) continue;
        if (x - start >= 3) {
          const cells: number[] = [];
          for (let k = start; k < x; k++) cells.push(this.index(k, y));
          runs.push({ dir: 'h', cells });
        }
        start = x;
      }
    }

    for (let x = 0; x < this.width; x++) {
      let start = 0;
      for (let y = 1; y <= this.height; y++) {
        const same =
          y < this.height &&
          this.matchType(this.index(x, y)) >= 0 &&
          this.matchType(this.index(x, y)) === this.matchType(this.index(x, y - 1));
        if (same) continue;
        if (y - start >= 3) {
          const cells: number[] = [];
          for (let k = start; k < y; k++) cells.push(this.index(x, k));
          runs.push({ dir: 'v', cells });
        }
        start = y;
      }
    }

    return runs;
  }

  /** Runs merged into groups — an L or T is one group made of two runs. */
  findMatches(): MatchGroup[] {
    const runs = this.findRuns();
    if (runs.length === 0) return [];

    const parent = runs.map((_, i) => i);
    const find = (i: number): number => {
      let root = i;
      while (parent[root] !== root) root = parent[root];
      while (parent[i] !== root) {
        const next = parent[i];
        parent[i] = root;
        i = next;
      }
      return root;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };

    const owner = new Map<number, number>();
    for (let r = 0; r < runs.length; r++) {
      for (const cell of runs[r].cells) {
        const seen = owner.get(cell);
        if (seen === undefined) owner.set(cell, r);
        else union(seen, r);
      }
    }

    const byRoot = new Map<number, MatchGroup>();
    for (let r = 0; r < runs.length; r++) {
      const root = find(r);
      let group = byRoot.get(root);
      if (!group) {
        group = { cells: [], runs: [], type: this.matchType(runs[r].cells[0]) as BallType };
        byRoot.set(root, group);
      }
      group.runs.push(runs[r]);
    }

    const groups: MatchGroup[] = [];
    for (const group of byRoot.values()) {
      const cells = new Set<number>();
      for (const run of group.runs) for (const cell of run.cells) cells.add(cell);
      group.cells = [...cells].sort((a, b) => a - b);
      groups.push(group);
    }
    return groups;
  }

  /** Which power-up, if any, a group earns. */
  private awardFor(group: MatchGroup): { special: Special; orient: Orient | null } {
    const horizontal = group.runs.filter((r) => r.dir === 'h');
    const vertical = group.runs.filter((r) => r.dir === 'v');

    if (horizontal.length > 0 && vertical.length > 0) {
      return group.cells.length >= 6
        ? { special: 'hattrick', orient: null }
        : { special: 'scrum', orient: null };
    }

    const line = horizontal.length > 0 ? horizontal : vertical;
    const longest = line.reduce((n, r) => Math.max(n, r.cells.length), 0);
    if (longest >= 5) return { special: 'matchball', orient: null };
    if (longest === 4) return { special: 'striker', orient: horizontal.length > 0 ? 'h' : 'v' };
    return { special: 'none', orient: null };
  }

  /** Where a group's power-up appears: under the player's finger if possible. */
  private placementFor(group: MatchGroup): number {
    for (const moved of this.lastMoved) {
      if (group.cells.includes(moved)) return moved;
    }
    const horizontal = group.runs.filter((r) => r.dir === 'h');
    const vertical = group.runs.filter((r) => r.dir === 'v');
    if (horizontal.length > 0 && vertical.length > 0) {
      for (const h of horizontal) {
        for (const cell of h.cells) {
          if (vertical.some((v) => v.cells.includes(cell))) return cell;
        }
      }
    }
    const longest = group.runs.reduce((a, b) => (b.cells.length > a.cells.length ? b : a));
    return longest.cells[Math.floor(longest.cells.length / 2)];
  }

  // -------------------------------------------------------------------------
  // Specials
  // -------------------------------------------------------------------------

  private row(y: number): number[] {
    const out: number[] = [];
    for (let x = 0; x < this.width; x++) out.push(this.index(x, y));
    return out;
  }

  private column(x: number): number[] {
    const out: number[] = [];
    for (let y = 0; y < this.height; y++) out.push(this.index(x, y));
    return out;
  }

  private block(cx: number, cy: number, radius: number): number[] {
    const out: number[] = [];
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x >= 0 && y >= 0 && x < this.width && y < this.height) out.push(this.index(x, y));
      }
    }
    return out;
  }

  /** A cross `thickness` cells wide in each direction. */
  private cross(cx: number, cy: number, thickness: number): number[] {
    const out: number[] = [];
    const reach = Math.floor(thickness / 2);
    for (let y = cy - reach; y <= cy + reach; y++) {
      if (y >= 0 && y < this.height) out.push(...this.row(y));
    }
    for (let x = cx - reach; x <= cx + reach; x++) {
      if (x >= 0 && x < this.width) out.push(...this.column(x));
    }
    return out;
  }

  /**
   * The type a MatchBall takes out when nobody told it what to aim at (it got
   * caught in someone else's blast). The most common type on the board, ties
   * broken by the lower index — no randomness, so both clients agree.
   */
  private commonestType(): BallType {
    const counts = new Array<number>(this.typeCount).fill(0);
    for (const cell of this.cells) {
      if (cell && cell.special !== 'matchball') counts[cell.type]++;
    }
    let best = 0;
    for (let t = 1; t < counts.length; t++) if (counts[t] > counts[best]) best = t;
    return best as BallType;
  }

  private cellsOfType(type: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      if (cell && cell.special !== 'matchball' && cell.type === type) out.push(i);
    }
    return out;
  }

  /** Everything a special takes with it when it goes off. */
  private affectedFor(i: number, special: Special, orient: Orient | null, targetType?: number): number[] {
    const { x, y } = this.pos(i);
    switch (special) {
      case 'striker':
        return orient === 'v' ? this.column(x) : this.row(y);
      case 'hattrick':
        return [...this.row(y), ...this.column(x)];
      case 'scrum':
        return this.block(x, y, 1);
      case 'matchball': {
        const type = targetType ?? this.commonestType();
        return [i, ...this.cellsOfType(type)];
      }
      case 'none':
      default:
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // Moves
  // -------------------------------------------------------------------------

  private swapCells(a: number, b: number): void {
    const tmp = this.cells[a];
    this.cells[a] = this.cells[b];
    this.cells[b] = tmp;
  }

  private static readonly EMPTY_RESULT: MoveResult = Object.freeze({
    valid: false,
    events: [],
    score: 0,
    cascades: 0,
    cleared: 0,
    created: [],
  });

  private rejected(a: Pos, b: Pos): MoveResult {
    return {
      valid: false,
      events: [
        { kind: 'swap', a, b },
        { kind: 'swapBack', a, b },
      ],
      score: 0,
      cascades: 0,
      cleared: 0,
      created: [],
    };
  }

  /**
   * Swap two adjacent balls.
   *
   * A swap is legal when it forms a run of three, or when it is a special
   * combination (anything paired with a MatchBall, or two power-ups together).
   * Illegal swaps leave the board exactly as it was.
   */
  swap(a: Pos, b: Pos): MoveResult {
    if (!this.inBounds(a) || !this.inBounds(b)) return { ...Board.EMPTY_RESULT, events: [] };
    const distance = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (distance !== 1) return { ...Board.EMPTY_RESULT, events: [] };

    const ai = this.index(a.x, a.y);
    const bi = this.index(b.x, b.y);
    const events: EngineEvent[] = [];
    const created: CreatedSpecial[] = [];

    const isCombo = this.isCombo(ai, bi);
    this.swapCells(ai, bi);

    if (!isCombo && !this.hasRunAt(ai) && !this.hasRunAt(bi)) {
      this.swapCells(ai, bi);
      return this.rejected(a, b);
    }

    events.push({ kind: 'swap', a, b });
    this.lastMoved = [bi, ai];

    const seeds = isCombo ? this.buildCombo(ai, bi) : [];
    const preActivated = isCombo ? [ai, bi] : [];
    const outcome = this.resolve(seeds, preActivated, events, created);
    events.push({ kind: 'settle' });

    this.score += outcome.score;
    return {
      valid: true,
      events,
      score: outcome.score,
      cascades: outcome.cascades,
      cleared: outcome.cleared,
      created,
    };
  }

  /**
   * Set a power-up off where it stands. Used by the engine tests and available
   * to callers that want a tap-to-fire control scheme.
   */
  detonate(p: Pos, targetType?: number): MoveResult {
    if (!this.inBounds(p)) return { ...Board.EMPTY_RESULT, events: [] };
    const i = this.index(p.x, p.y);
    const cell = this.get(p.x, p.y);
    if (cell.special === 'none') return { ...Board.EMPTY_RESULT, events: [] };

    const events: EngineEvent[] = [];
    const created: CreatedSpecial[] = [];
    this.lastMoved = [i];

    const affected = this.affectedFor(i, cell.special, cell.orient, targetType);
    const outcome = this.resolve(
      [{ idx: i, special: cell.special, orient: cell.orient, affected }],
      [],
      events,
      created,
    );
    events.push({ kind: 'settle' });

    this.score += outcome.score;
    return {
      valid: true,
      events,
      score: outcome.score,
      cascades: outcome.cascades,
      cleared: outcome.cleared,
      created,
    };
  }

  /** Two power-ups, or anything at all next to a MatchBall. */
  private isCombo(ai: number, bi: number): boolean {
    const a = this.c(ai).special;
    const b = this.c(bi).special;
    if (a === 'matchball' || b === 'matchball') return true;
    return a !== 'none' && b !== 'none';
  }

  /** Work out what a special pairing does. Called after the swap has happened. */
  private buildCombo(ai: number, bi: number): Activation[] {
    const a = this.c(ai);
    const b = this.c(bi);
    const here = this.pos(bi);
    const affected = new Set<number>([ai, bi]);
    let label: Special = 'hattrick';

    const add = (list: number[]): void => {
      for (const i of list) affected.add(i);
    };

    if (a.special === 'matchball' && b.special === 'matchball') {
      // Clear the park.
      label = 'matchball';
      for (let i = 0; i < this.cells.length; i++) affected.add(i);
    } else if (a.special === 'matchball' || b.special === 'matchball') {
      label = 'matchball';
      const other = a.special === 'matchball' ? b : a;
      const targets = this.cellsOfType(other.type);
      if (other.special === 'none') {
        add(targets);
      } else {
        // Every ball of that type becomes the partner power-up, then fires.
        for (const t of targets) add(this.affectedFor(t, other.special, other.orient));
        add(targets);
      }
    } else {
      const pair = [a.special, b.special].sort().join('+');
      switch (pair) {
        case 'striker+striker':
          label = 'hattrick';
          add(this.cross(here.x, here.y, 1));
          break;
        case 'scrum+striker':
        case 'hattrick+striker':
          label = 'hattrick';
          add(this.cross(here.x, here.y, 3));
          break;
        case 'scrum+scrum':
          label = 'scrum';
          add(this.block(here.x, here.y, 2));
          break;
        case 'hattrick+scrum':
          label = 'hattrick';
          add(this.cross(here.x, here.y, 3));
          add(this.block(here.x, here.y, 2));
          break;
        case 'hattrick+hattrick':
          label = 'hattrick';
          add(this.cross(here.x, here.y, 5));
          break;
        default:
          add(this.cross(here.x, here.y, 1));
          break;
      }
    }

    return [
      {
        idx: bi,
        special: label,
        orient: null,
        affected: [...affected].sort((p, q) => p - q),
      },
    ];
  }

  private c(i: number): Cell {
    return this.cells[i] as Cell;
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Clear, promote, detonate, drop, repeat — until the board is quiet.
   * Appends to `events`/`created` so a caller can build one flat turn log.
   */
  private resolve(
    seeds: Activation[],
    preActivated: number[],
    events: EngineEvent[],
    created: CreatedSpecial[],
  ): { score: number; cascades: number; cleared: number } {
    let cascades = 0;
    let score = 0;
    let cleared = 0;
    let pending = seeds;
    let suppressed = preActivated;

    while (cascades < MAX_CASCADES) {
      const groups = this.findMatches();
      if (groups.length === 0 && pending.length === 0) break;
      const depth = cascades + 1;

      const promote = new Map<number, { special: Special; orient: Orient | null }>();
      const toClear = new Set<number>();
      const addClear = (i: number): void => {
        if (!promote.has(i)) toClear.add(i);
      };

      for (const group of groups) {
        const award = this.awardFor(group);
        let host = -1;
        if (award.special !== 'none') {
          host = this.placementFor(group);
          promote.set(host, award);
        }
        for (const i of group.cells) if (i !== host) toClear.add(i);
      }
      // A ball promoted this turn survives, even if a blast lands on it.
      for (const host of promote.keys()) toClear.delete(host);

      // --- chain reaction -----------------------------------------------
      const activated = new Set<number>(suppressed);
      const queue: Activation[] = [...pending];
      for (const i of toClear) {
        const cell = this.c(i);
        if (cell.special !== 'none') {
          queue.push({ idx: i, special: cell.special, orient: cell.orient, affected: null });
        }
      }

      const activations: EngineEvent[] = [];
      let activationBonus = 0;
      while (queue.length > 0) {
        const shot = queue.shift() as Activation;
        if (activated.has(shot.idx) || promote.has(shot.idx)) continue;
        activated.add(shot.idx);

        const affected = shot.affected ?? this.affectedFor(shot.idx, shot.special, shot.orient);
        addClear(shot.idx);
        activations.push({
          kind: 'activate',
          pos: this.pos(shot.idx),
          special: shot.special,
          cells: affected.map((i) => this.pos(i)),
        });
        activationBonus += SCORE_PER_ACTIVATION;

        for (const j of affected) {
          if (promote.has(j)) continue;
          addClear(j);
          const neighbour = this.c(j);
          if (neighbour.special !== 'none' && !activated.has(j)) {
            queue.push({ idx: j, special: neighbour.special, orient: neighbour.orient, affected: null });
          }
        }
      }

      const cleanup = [...toClear].sort((a, b) => a - b);
      if (cleanup.length === 0 && promote.size === 0) break;

      // --- promotions ----------------------------------------------------
      let promotionBonus = 0;
      for (const [i, award] of promote) {
        const cell = this.c(i);
        cell.special = award.special;
        cell.orient = award.orient;
        promotionBonus += SCORE_FOR_SPECIAL[award.special];
        const create: EngineEvent = {
          kind: 'create',
          pos: this.pos(i),
          special: award.special,
          orient: award.orient,
          type: cell.type,
          id: cell.id,
        };
        events.push(create);
        created.push({
          pos: this.pos(i),
          special: award.special,
          orient: award.orient,
          type: cell.type,
          id: cell.id,
        });
      }

      events.push(...activations);

      // --- clear ----------------------------------------------------------
      const wiped: ClearedCell[] = cleanup.map((i) => {
        const cell = this.c(i);
        const p = this.pos(i);
        return { id: cell.id, x: p.x, y: p.y, type: cell.type, special: cell.special };
      });
      const stepScore = cleanup.length * SCORE_PER_BALL * depth + activationBonus * depth + promotionBonus;
      events.push({ kind: 'clear', cascade: depth, cells: wiped, score: stepScore });

      for (const i of cleanup) this.cells[i] = null;

      // --- gravity --------------------------------------------------------
      events.push(this.applyGravity());

      score += stepScore;
      cleared += cleanup.length;
      cascades = depth;
      pending = [];
      suppressed = [];
      this.lastMoved = [];
    }

    if (this.findRuns().length > 0) this.forceQuiet();
    return { score, cascades, cleared };
  }

  /** Compact each column downward, then top it up from the seeded stream. */
  private applyGravity(): EngineEvent {
    const moves: FallMove[] = [];
    const spawns: SpawnCell[] = [];

    for (let x = 0; x < this.width; x++) {
      let write = this.height - 1;
      for (let y = this.height - 1; y >= 0; y--) {
        const cell = this.cells[this.index(x, y)];
        if (!cell) continue;
        if (write !== y) {
          moves.push({ id: cell.id, x, fromY: y, toY: write });
          this.cells[this.index(x, write)] = cell;
          this.cells[this.index(x, y)] = null;
        }
        write--;
      }
      const missing = write + 1;
      for (let k = 0; k < missing; k++) {
        const y = write - k;
        const cell = this.newCell();
        this.cells[this.index(x, y)] = cell;
        spawns.push({
          id: cell.id,
          x,
          fromY: -1 - k,
          toY: y,
          type: cell.type,
          special: 'none',
          orient: null,
        });
      }
    }

    return { kind: 'fall', moves, spawns };
  }

  /** Backstop for the cascade cap: nudge types until nothing is matching. */
  private forceQuiet(): void {
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      if (!cell) continue;
      if (this.hasRunAt(i)) cell.type = this.safeTypeAt(i, cell.type);
    }
  }

  // -------------------------------------------------------------------------
  // Playability
  // -------------------------------------------------------------------------

  /** Is there anything the player could do? */
  hasValidMove(): boolean {
    return this.findMove() !== null;
  }

  /**
   * The first playable swap in scan order — used for hints, for the deadlock
   * check, and by the tests. Deterministic, so two clients agree on the hint.
   */
  findMove(): { a: Pos; b: Pos } | null {
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      if (!cell || cell.special === 'none') continue;
      const { x, y } = this.pos(i);
      // A MatchBall works against any neighbour; two power-ups always combine.
      if (x + 1 < this.width) {
        const right = this.c(this.index(x + 1, y));
        if (cell.special === 'matchball' || right.special === 'matchball' || right.special !== 'none') {
          return { a: { x, y }, b: { x: x + 1, y } };
        }
      }
      if (y + 1 < this.height) {
        const down = this.c(this.index(x, y + 1));
        if (cell.special === 'matchball' || down.special === 'matchball' || down.special !== 'none') {
          return { a: { x, y }, b: { x, y: y + 1 } };
        }
      }
    }

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = this.index(x, y);
        if (x + 1 < this.width) {
          const j = this.index(x + 1, y);
          if (this.swapMakesRun(i, j)) return { a: { x, y }, b: { x: x + 1, y } };
        }
        if (y + 1 < this.height) {
          const j = this.index(x, y + 1);
          if (this.swapMakesRun(i, j)) return { a: { x, y }, b: { x, y: y + 1 } };
        }
      }
    }
    return null;
  }

  private swapMakesRun(a: number, b: number): boolean {
    this.swapCells(a, b);
    const hit = this.hasRunAt(a) || this.hasRunAt(b);
    this.swapCells(a, b);
    return hit;
  }

  /**
   * Call after every settled move. If the board has no moves left it is
   * reshuffled in place and a `reshuffle` event is returned to animate.
   */
  checkDeadlock(): EngineEvent | null {
    if (this.hasValidMove()) return null;
    this.reshuffleCells();
    return { kind: 'reshuffle', cells: (this.cells as Cell[]).map((c) => ({ ...c })) };
  }

  // -------------------------------------------------------------------------
  // Test / tooling helpers
  // -------------------------------------------------------------------------

  /**
   * Lay out a board from letters (`A` is ball type 0). A `.` is filled with
   * whatever type keeps the board match-free, so fixtures only have to spell
   * out the part under test.
   */
  debugSet(rows: string[]): void {
    this.cells.fill(null);
    const blanks: number[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = this.index(x, y);
        const ch = rows[y]?.[x] ?? '.';
        if (ch === '.') {
          blanks.push(i);
          continue;
        }
        this.cells[i] = this.newCell((ch.charCodeAt(0) - 65) as BallType);
      }
    }
    for (const i of blanks) {
      const cell = this.newCell();
      this.cells[i] = cell;
      cell.type = this.safeTypeAt(i, cell.type);
    }
    this.lastMoved = [];
  }

  debugSetSpecial(p: Pos, special: Special, orient: Orient | null = null): void {
    const cell = this.get(p.x, p.y);
    cell.special = special;
    cell.orient = orient;
  }
}
