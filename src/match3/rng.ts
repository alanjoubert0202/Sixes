/**
 * Seeded PRNG (mulberry32).
 *
 * Small, fast, and — crucially — exactly reproducible across machines: it only
 * ever touches uint32 arithmetic via `Math.imul` and `>>>`, so there is no
 * floating-point drift between two clients replaying the same match.
 */
export class Rng {
  /** The seed as given, kept so a board can be serialised and resumed. */
  readonly seed: string;
  private state: number;

  constructor(seed: string | number, state?: number) {
    this.seed = String(seed);
    this.state = state !== undefined ? state >>> 0 : hashSeed(this.seed);
  }

  /** Raw generator state — snapshot this to resume a session mid-game. */
  get cursor(): number {
    return this.state >>> 0;
  }

  /** Next 32-bit unsigned integer. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.next() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    if (n <= 0) return 0;
    return this.next() % n;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  /** In-place Fisher–Yates. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }

  clone(): Rng {
    return new Rng(this.seed, this.state);
  }
}

/** FNV-1a, so string seeds like "rugby-world-cup" spread out properly. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  // A zero state would still work, but avoid it so trivially different seeds
  // do not collide on the very first draw.
  return h === 0 ? 0x9e3779b9 : h;
}
