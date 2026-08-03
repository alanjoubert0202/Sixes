import type { BallType, Cell, EngineEvent, Orient, Special } from '../match3/types.ts';

/**
 * Turns the engine's event log into tweened sprites.
 *
 * Deliberately free of canvas and DOM: the animator owns *where* things are,
 * the renderer owns how they look. That keeps it unit-testable and keeps the
 * timeline frame-rate independent — stepping 4ms at a time and stepping 50ms
 * at a time land on exactly the same final state.
 */
export interface Sprite {
  id: number;
  type: BallType;
  special: Special;
  orient: Orient | null;
  /** Board coordinates, fractional while in flight. */
  x: number;
  y: number;
  scale: number;
  alpha: number;
  /** 0..1 highlight used for promotion pops and blast flashes. */
  glow: number;
}

/** A short-lived visual burst at a board square. */
export interface Flash {
  x: number;
  y: number;
  special: Special;
  /** 0..1, counts up over the flash's life. */
  progress: number;
  /** Milliseconds since the flash started, for the renderer's own easing. */
  age: number;
  duration: number;
}

/** Floating score text thrown off by a clear. */
export interface ScorePopup {
  x: number;
  y: number;
  score: number;
  cascade: number;
  progress: number;
  age: number;
  duration: number;
}

type Key = 'x' | 'y' | 'scale' | 'alpha' | 'glow';

interface Tween {
  sprite: Sprite;
  key: Key;
  from: number;
  to: number;
  start: number;
  end: number;
  ease: (t: number) => number;
  done: boolean;
}

interface Cue {
  at: number;
  /** Receives its own scheduled time, never the wall clock — a cue that fires
   *  late must still schedule follow-up work from when it was *meant* to run,
   *  or the timeline would drift with the frame rate. */
  run: (at: number) => void;
  done: boolean;
}

export const TIMING = {
  swap: 150,
  swapBack: 150,
  clear: 230,
  promote: 260,
  flash: 320,
  fallBase: 110,
  fallPerTile: 42,
  reshuffleOut: 200,
  reshuffleIn: 260,
  popup: 900,
} as const;

const linear = (t: number): number => t;
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeInQuad = (t: number): number => t * t;
const easeOutBack = (t: number): number => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
/** A short overshoot then settle, so falling balls land with some weight. */
const easeOutBounceish = (t: number): number => {
  const p = easeOutCubic(t);
  return p + Math.sin(t * Math.PI) * 0.06 * (1 - t);
};

export class Animator {
  readonly width: number;
  readonly height: number;

  flashes: Flash[] = [];
  popups: ScorePopup[] = [];

  private sprites = new Map<number, Sprite>();
  private tweens: Tween[] = [];
  private cues: Cue[] = [];
  private clock = 0;
  private endsAt = 0;

  /**
   * Where every ball *will* be once the queued events have played out, and
   * every sprite the schedule knows about — including ones that have not
   * appeared on screen yet. Events are scheduled ahead of the clock, so a ball
   * spawned by one cascade and dropped again by the next has to be resolvable
   * before it is ever drawn.
   */
  private slots: number[] = [];
  private booked = new Map<number, Sprite>();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.slots = new Array<number>(width * height).fill(-1);
  }

  // -------------------------------------------------------------------------

  /** Milliseconds of animation still to play. */
  get remaining(): number {
    return Math.max(0, this.endsAt - this.clock);
  }

  get busy(): boolean {
    return this.remaining > 0;
  }

  sprite(id: number): Sprite | undefined {
    return this.sprites.get(id);
  }

  list(): Sprite[] {
    return [...this.sprites.values()];
  }

  /** Drop everything and mirror the board exactly. Used on load and restart. */
  sync(cells: readonly Cell[]): void {
    this.sprites.clear();
    this.booked.clear();
    this.tweens.length = 0;
    this.cues.length = 0;
    this.flashes.length = 0;
    this.popups.length = 0;
    this.clock = 0;
    this.endsAt = 0;
    this.slots.fill(-1);
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const sprite: Sprite = {
        id: cell.id,
        type: cell.type,
        special: cell.special,
        orient: cell.orient,
        x: i % this.width,
        y: Math.floor(i / this.width),
        scale: 1,
        alpha: 1,
        glow: 0,
      };
      this.sprites.set(cell.id, sprite);
      this.booked.set(cell.id, sprite);
      this.slots[i] = cell.id;
    }
  }

  /** Which ball will be sitting on this square once the queue has drained. */
  private idAt(x: number, y: number): number {
    return this.slots[y * this.width + x] ?? -1;
  }

  /** Sprites already on screen *and* sprites the queue is about to introduce. */
  private booking(id: number): Sprite | undefined {
    return this.booked.get(id);
  }

  // -------------------------------------------------------------------------

  /** Schedule a turn. Queued behind whatever is still playing. */
  enqueue(events: EngineEvent[]): void {
    let t = Math.max(this.clock, this.endsAt);

    for (const event of events) {
      switch (event.kind) {
        case 'swap':
        case 'swapBack': {
          const ida = this.idAt(event.a.x, event.a.y);
          const idb = this.idAt(event.b.x, event.b.y);
          const a = this.booking(ida);
          const b = this.booking(idb);
          const duration = event.kind === 'swap' ? TIMING.swap : TIMING.swapBack;
          if (a) {
            this.tween(a, 'x', event.b.x, t, duration, easeOutCubic);
            this.tween(a, 'y', event.b.y, t, duration, easeOutCubic);
          }
          if (b) {
            this.tween(b, 'x', event.a.x, t, duration, easeOutCubic);
            this.tween(b, 'y', event.a.y, t, duration, easeOutCubic);
          }
          this.slots[event.a.y * this.width + event.a.x] = idb;
          this.slots[event.b.y * this.width + event.b.x] = ida;
          t += duration;
          break;
        }

        case 'create': {
          // The promoted ball survives the clear it came from, so let the pop
          // land while its neighbours are still shrinking away.
          const id = event.id;
          const special = event.special;
          const orient = event.orient;
          const start = t + TIMING.clear * 0.35;
          this.cue(start, (now) => {
            const sprite = this.booking(id);
            if (!sprite) return;
            sprite.special = special;
            sprite.orient = orient;
            sprite.scale = 1;
            this.tween(sprite, 'scale', 1.45, now, TIMING.promote * 0.4, easeOutCubic);
            this.tween(sprite, 'scale', 1, now + TIMING.promote * 0.4, TIMING.promote * 0.6, easeOutBack);
            this.tween(sprite, 'glow', 1, now, TIMING.promote * 0.3, linear);
            this.tween(sprite, 'glow', 0, now + TIMING.promote * 0.3, TIMING.promote * 0.7, linear);
          });
          this.extend(start + TIMING.promote);
          break;
        }

        case 'activate': {
          for (const cell of event.cells) {
            this.flash(t, cell.x, cell.y, event.special);
          }
          this.extend(t + TIMING.flash);
          break;
        }

        case 'clear': {
          for (const cell of event.cells) {
            const slot = cell.y * this.width + cell.x;
            if (this.slots[slot] === cell.id) this.slots[slot] = -1;
            const sprite = this.booking(cell.id);
            if (!sprite) continue;
            this.tween(sprite, 'glow', 1, t, TIMING.clear * 0.25, linear);
            this.tween(sprite, 'glow', 0, t + TIMING.clear * 0.25, TIMING.clear * 0.75, linear);
            this.tween(sprite, 'scale', 0, t, TIMING.clear, easeInQuad);
            this.tween(sprite, 'alpha', 0, t + TIMING.clear * 0.35, TIMING.clear * 0.65, linear);
            const id = cell.id;
            this.cue(t + TIMING.clear, () => this.sprites.delete(id));
          }
          this.popup(t, event);
          t += TIMING.clear;
          break;
        }

        case 'fall': {
          let longest = 0;
          for (const move of event.moves) {
            const from = move.fromY * this.width + move.x;
            if (this.slots[from] === move.id) this.slots[from] = -1;
          }
          for (const move of event.moves) {
            this.slots[move.toY * this.width + move.x] = move.id;
            const sprite = this.booking(move.id);
            if (!sprite) continue;
            const duration = TIMING.fallBase + (move.toY - move.fromY) * TIMING.fallPerTile;
            this.tween(sprite, 'y', move.toY, t, duration, easeOutBounceish);
            this.tween(sprite, 'x', move.x, t, duration, easeOutCubic);
            longest = Math.max(longest, duration);
          }
          for (const spawn of event.spawns) {
            const duration = TIMING.fallBase + (spawn.toY - spawn.fromY) * TIMING.fallPerTile;
            const sprite: Sprite = {
              id: spawn.id,
              type: spawn.type,
              special: spawn.special,
              orient: spawn.orient,
              x: spawn.x,
              y: spawn.fromY,
              scale: 1,
              alpha: 1,
              glow: 0,
            };
            this.slots[spawn.toY * this.width + spawn.x] = spawn.id;
            this.booked.set(sprite.id, sprite);
            this.cue(t, () => this.sprites.set(sprite.id, sprite));
            this.tween(sprite, 'y', spawn.toY, t, duration, easeOutBounceish);
            longest = Math.max(longest, duration);
          }
          t += longest;
          break;
        }

        case 'reshuffle': {
          const cells = event.cells;
          const fadeOut = t;
          for (const sprite of this.sprites.values()) {
            this.tween(sprite, 'alpha', 0, fadeOut, TIMING.reshuffleOut, linear);
            this.tween(sprite, 'scale', 0.6, fadeOut, TIMING.reshuffleOut, easeInQuad);
          }
          const swapAt = fadeOut + TIMING.reshuffleOut;
          const rebuilt: Sprite[] = cells.map((cell, i) => ({
            id: cell.id,
            type: cell.type,
            special: cell.special,
            orient: cell.orient,
            x: i % this.width,
            y: Math.floor(i / this.width),
            scale: 0.6,
            alpha: 0,
            glow: 0,
          }));
          this.booked.clear();
          for (let i = 0; i < rebuilt.length; i++) {
            this.booked.set(rebuilt[i].id, rebuilt[i]);
            this.slots[i] = rebuilt[i].id;
          }
          this.cue(swapAt, (now) => {
            this.sprites.clear();
            for (const sprite of rebuilt) {
              this.sprites.set(sprite.id, sprite);
              this.tween(sprite, 'alpha', 1, now, TIMING.reshuffleIn, linear);
              this.tween(sprite, 'scale', 1, now, TIMING.reshuffleIn, easeOutBack);
            }
          });
          t = swapAt + TIMING.reshuffleIn;
          break;
        }

        case 'settle':
          break;
      }
      this.extend(t);
    }
  }

  // -------------------------------------------------------------------------

  /** Advance the timeline. `dt` is milliseconds since the last frame. */
  update(dt: number): void {
    if (dt <= 0) return;
    this.clock += dt;

    if (this.cues.length > 0) {
      // Cues can schedule more work (a reshuffle rebuilds every sprite), so
      // walk by index rather than iterating a snapshot.
      for (let i = 0; i < this.cues.length; i++) {
        const cue = this.cues[i];
        if (cue.done || cue.at > this.clock) continue;
        cue.done = true;
        cue.run(cue.at);
      }
      if (this.cues.every((c) => c.done)) this.cues.length = 0;
    }

    if (this.tweens.length > 0) {
      let live = false;
      for (const tween of this.tweens) {
        if (tween.done || this.clock < tween.start) {
          live = live || !tween.done;
          continue;
        }
        const span = tween.end - tween.start;
        const p = span <= 0 ? 1 : Math.min(1, (this.clock - tween.start) / span);
        tween.sprite[tween.key] = tween.from + (tween.to - tween.from) * tween.ease(p);
        if (p >= 1) {
          tween.sprite[tween.key] = tween.to;
          tween.done = true;
        } else {
          live = true;
        }
      }
      if (!live) this.tweens.length = 0;
    }

    this.advanceEffects(this.flashes, dt);
    this.advanceEffects(this.popups, dt);

    if (!this.busy) this.settle();
  }

  private advanceEffects(list: Array<Flash | ScorePopup>, dt: number): void {
    for (let i = list.length - 1; i >= 0; i--) {
      const effect = list[i];
      effect.age += dt;
      effect.progress = Math.min(1, effect.age / effect.duration);
      if (effect.age >= effect.duration) list.splice(i, 1);
    }
  }

  /** Timeline finished: park the bookkeeping so an idle animator does nothing. */
  private settle(): void {
    this.tweens.length = 0;
    this.cues.length = 0;
    this.clock = 0;
    this.endsAt = 0;
    this.booked.clear();
    for (const sprite of this.sprites.values()) {
      sprite.glow = 0;
      this.booked.set(sprite.id, sprite);
    }
  }

  // -------------------------------------------------------------------------

  private extend(until: number): void {
    if (until > this.endsAt) this.endsAt = until;
  }

  private tween(sprite: Sprite, key: Key, to: number, start: number, duration: number, ease: (t: number) => number): void {
    // Chain from whatever the previous tween on this key will finish at, so
    // back-to-back tweens (grow then shrink) do not fight each other.
    let from = sprite[key];
    for (const existing of this.tweens) {
      if (existing.sprite === sprite && existing.key === key && !existing.done && existing.end <= start) {
        from = existing.to;
      }
    }
    this.tweens.push({ sprite, key, from, to, start, end: start + duration, ease, done: false });
    this.extend(start + duration);
  }

  private cue(at: number, run: (at: number) => void): void {
    this.extend(at);
    // Anything scheduled for right now runs immediately, so a caller that
    // enqueues and then draws before the next tick sees a complete first frame.
    if (at <= this.clock) {
      this.cues.push({ at, run, done: true });
      run(at);
      return;
    }
    this.cues.push({ at, run, done: false });
  }

  private flash(at: number, x: number, y: number, special: Special): void {
    const effect: Flash = { x, y, special, progress: 0, age: 0, duration: TIMING.flash };
    this.cue(at, () => this.flashes.push(effect));
  }

  private popup(at: number, event: Extract<EngineEvent, { kind: 'clear' }>): void {
    if (event.cells.length === 0) return;
    let x = 0;
    let y = 0;
    for (const cell of event.cells) {
      x += cell.x;
      y += cell.y;
    }
    const effect: ScorePopup = {
      x: x / event.cells.length,
      y: y / event.cells.length,
      score: event.score,
      cascade: event.cascade,
      progress: 0,
      age: 0,
      duration: TIMING.popup,
    };
    this.cue(at, () => this.popups.push(effect));
  }
}
