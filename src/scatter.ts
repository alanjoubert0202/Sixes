import { ballCanvas } from './game/balls.ts';
import type { BallType } from './match3/types.ts';

/**
 * The menu's one flourish: six balls roll in from off-screen and settle
 * scattered across the pitch, as if they had spilled out of a kit bag.
 *
 * Purely decorative — it sits behind the menu, never takes pointer events, and
 * is skipped entirely under `prefers-reduced-motion`.
 */

type Edge = 'left' | 'right' | 'top' | 'bottom';

interface Placement {
  type: BallType;
  /** Resting position as a share of the container, 0..1. */
  x: number;
  y: number;
  /** Diameter in CSS pixels at the reference width. */
  size: number;
  from: Edge;
  /** Resting tilt in degrees — a scatter should not look aligned. */
  rest: number;
  /** How far it rolls, in degrees. */
  spin: number;
}

/**
 * Hand-placed rather than randomised: the balls have to frame the title and
 * buttons without crowding them, and the vertical middle is kept clear so the
 * menu text always has open pitch behind it.
 */
const PLACEMENTS: Placement[] = [
  { type: 0, x: 0.11, y: 0.13, size: 74, from: 'left', rest: -14, spin: 430 },
  { type: 1, x: 0.79, y: 0.09, size: 56, from: 'top', rest: 9, spin: 380 },
  { type: 5, x: 0.88, y: 0.27, size: 62, from: 'right', rest: -7, spin: -460 },
  { type: 2, x: 0.13, y: 0.79, size: 64, from: 'left', rest: 12, spin: 500 },
  { type: 3, x: 0.75, y: 0.85, size: 50, from: 'bottom', rest: -10, spin: -400 },
  { type: 4, x: 0.45, y: 0.93, size: 42, from: 'bottom', rest: 6, spin: 350 },
];

/** Width the sizes above were chosen against; smaller screens scale down. */
const REFERENCE_WIDTH = 420;
const STAGGER = 90;
const DURATION = 900;

interface Ball {
  el: HTMLCanvasElement;
  place: Placement;
}

export class Scatter {
  private host: HTMLElement;
  private balls: Ball[] = [];
  private reduced: boolean;
  private timers: number[] = [];
  private onResize: () => void;

  constructor(host: HTMLElement) {
    this.host = host;
    this.reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.onResize = () => this.layout();
  }

  /** Build the balls and play the roll-in. Safe to call repeatedly. */
  play(): void {
    // Re-entering the menu replays the roll-in; drop any timers still pending
    // from the last visit so two runs cannot fight over the same ball.
    for (const id of this.timers) window.clearTimeout(id);
    this.timers = [];

    this.build();
    this.layout();

    if (this.reduced) {
      for (const ball of this.balls) this.settle(ball, false);
      return;
    }

    for (const [i, ball] of this.balls.entries()) {
      this.park(ball);
      // One frame parked off-screen, then release, so the transition runs.
      const id = window.setTimeout(() => this.settle(ball, true), 30 + i * STAGGER);
      this.timers.push(id);
    }
  }

  destroy(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers = [];
    window.removeEventListener('resize', this.onResize);
    this.host.replaceChildren();
    this.balls = [];
  }

  // -------------------------------------------------------------------------

  private build(): void {
    if (this.balls.length > 0) return;
    window.addEventListener('resize', this.onResize);

    for (const place of PLACEMENTS) {
      const el = document.createElement('canvas');
      el.className = 'scatter-ball';
      this.balls.push({ el, place });
      this.host.append(el);
    }
  }

  private scale(): number {
    const width = this.host.clientWidth || REFERENCE_WIDTH;
    return Math.min(1.15, Math.max(0.6, width / REFERENCE_WIDTH));
  }

  /** Position and (re)draw every ball for the current container size. */
  private layout(): void {
    const scale = this.scale();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    for (const { el, place } of this.balls) {
      const size = Math.round(place.size * scale);

      // `ballCanvas` returns a *cached* element, so it cannot be parked in the
      // DOM directly — two balls sharing a key would fight over one node.
      // Copy its pixels into this ball's own canvas instead.
      const art = ballCanvas(place.type, 'none', null, size * dpr);
      el.width = art.width;
      el.height = art.height;
      const ctx = el.getContext('2d');
      if (ctx) ctx.drawImage(art, 0, 0);

      const css = art.width / dpr;
      el.style.width = `${css}px`;
      el.style.height = `${css}px`;
      el.style.left = `${place.x * 100}%`;
      el.style.top = `${place.y * 100}%`;
    }
  }

  /** Push a ball to just beyond its nearest edge, unrotated. */
  private park({ el, place }: Ball): void {
    el.style.transition = 'none';
    el.style.opacity = '0';
    el.style.transform = this.transform(offscreen(place), -place.spin + place.rest);
  }

  private settle({ el, place }: Ball, animate: boolean): void {
    if (animate) {
      // A short overshoot, so the ball arrives with some weight behind it.
      el.style.transition = `transform ${DURATION}ms cubic-bezier(0.16, 1.06, 0.3, 1), opacity 220ms linear`;
    } else {
      el.style.transition = 'none';
    }
    el.style.opacity = '1';
    el.style.transform = this.transform({ x: 0, y: 0 }, place.rest);
  }

  private transform(offset: { x: number; y: number }, rotation: number): string {
    // The -50% centres the ball on its left/top percentage anchor.
    return `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) rotate(${rotation}deg)`;
  }
}

/** How far off-screen a ball starts, relative to its resting spot. */
function offscreen(place: Placement): { x: number; y: number } {
  const reach = 140;
  switch (place.from) {
    case 'left':
      return { x: -(place.x * 100 + reach) * 4, y: 0 };
    case 'right':
      return { x: ((1 - place.x) * 100 + reach) * 4, y: 0 };
    case 'top':
      return { x: 0, y: -(place.y * 100 + reach) * 4 };
    case 'bottom':
    default:
      return { x: 0, y: ((1 - place.y) * 100 + reach) * 4 };
  }
}
