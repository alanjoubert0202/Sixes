import type { Pos } from '../match3/types.ts';
import { ballCanvas, clearBallCache, PALETTE } from './balls.ts';
import type { Animator, Sprite } from './animator.ts';

export interface Layout {
  /** CSS pixels. */
  cell: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/**
 * Draws the board. Owns nothing about game rules — it is handed an
 * {@link Animator} and paints whatever state that animator is currently in.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cols: number;
  private rows: number;
  private dpr = 1;

  layout: Layout = { cell: 0, originX: 0, originY: 0, width: 0, height: 0 };

  /** Set by the game: the square under the finger, and the current hint. */
  selected: Pos | null = null;
  hint: { a: Pos; b: Pos } | null = null;

  private hintPhase = 0;

  constructor(canvas: HTMLCanvasElement, cols: number, rows: number) {
    this.canvas = canvas;
    this.cols = cols;
    this.rows = rows;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Sixes needs a 2D canvas context');
    this.ctx = ctx;
  }

  /** Fit the board to the element's box, accounting for device pixel ratio. */
  resize(cssWidth: number, cssHeight: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssHeight * this.dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    const pad = Math.round(Math.min(cssWidth, cssHeight) * 0.02);
    const cell = Math.floor(Math.min((cssWidth - pad * 2) / this.cols, (cssHeight - pad * 2) / this.rows));
    const boardW = cell * this.cols;
    const boardH = cell * this.rows;
    this.layout = {
      cell,
      originX: Math.round((cssWidth - boardW) / 2),
      originY: Math.round((cssHeight - boardH) / 2),
      width: boardW,
      height: boardH,
    };
    clearBallCache();
  }

  /** Board square under a point in CSS pixels, or null if outside. */
  pick(px: number, py: number): Pos | null {
    const { cell, originX, originY } = this.layout;
    if (cell <= 0) return null;
    const x = Math.floor((px - originX) / cell);
    const y = Math.floor((py - originY) / cell);
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return null;
    return { x, y };
  }

  private cx(x: number): number {
    return this.layout.originX + (x + 0.5) * this.layout.cell;
  }

  private cy(y: number): number {
    return this.layout.originY + (y + 0.5) * this.layout.cell;
  }

  // -------------------------------------------------------------------------

  draw(animator: Animator, dt: number): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    this.hintPhase += dt / 1000;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const cssW = width / this.dpr;
    const cssH = height / this.dpr;

    this.drawPitch(ctx, cssW, cssH);
    this.drawGrid(ctx);

    // Clip to the board so balls falling in from above stay hidden.
    const { originX, originY, width: bw, height: bh, cell } = this.layout;
    ctx.save();
    roundRect(ctx, originX, originY, bw, bh, cell * 0.18);
    ctx.clip();
    this.drawSprites(ctx, animator);
    this.drawFlashes(ctx, animator);
    ctx.restore();

    this.drawSelection(ctx);
    this.drawHint(ctx);
    this.drawPopups(ctx, animator);
    ctx.restore();
  }

  /** Dark teal ground with faint chalk pitch markings behind the play area. */
  private drawPitch(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#062A28');
    g.addColorStop(0.55, PALETTE.pitch);
    g.addColorStop(1, PALETTE.pitchDeep);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.strokeStyle = 'rgba(238,243,236,0.055)';
    ctx.lineWidth = 2;
    const cx = w / 2;
    const cy = h / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(w, h) * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.stroke();
    for (let i = 1; i < 5; i++) {
      const y = (h / 5) * i;
      ctx.setLineDash([6, 14]);
      ctx.beginPath();
      ctx.moveTo(w * 0.06, y);
      ctx.lineTo(w * 0.94, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const { originX, originY, width, height, cell } = this.layout;
    if (cell <= 0) return;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = cell * 0.5;
    ctx.shadowOffsetY = cell * 0.12;
    ctx.fillStyle = 'rgba(3, 30, 29, 0.85)';
    roundRect(ctx, originX, originY, width, height, cell * 0.18);
    ctx.fill();
    ctx.restore();

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const dark = (x + y) % 2 === 0;
        ctx.fillStyle = dark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.012)';
        roundRect(ctx, originX + x * cell + 1, originY + y * cell + 1, cell - 2, cell - 2, cell * 0.16);
        ctx.fill();
      }
    }

    ctx.strokeStyle = 'rgba(238,243,236,0.14)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, originX, originY, width, height, cell * 0.18);
    ctx.stroke();
  }

  private drawSprites(ctx: CanvasRenderingContext2D, animator: Animator): void {
    const cell = this.layout.cell;
    const size = cell * 0.86;
    const sprites = animator.list();
    // Painter's order: top rows first, so a falling ball tucks behind the one
    // below it rather than punching through.
    sprites.sort((a, b) => a.y - b.y || a.x - b.x);

    for (const sprite of sprites) {
      if (sprite.alpha <= 0.01 || sprite.scale <= 0.01) continue;
      this.drawSprite(ctx, sprite, size);
    }
  }

  private drawSprite(ctx: CanvasRenderingContext2D, sprite: Sprite, size: number): void {
    const art = ballCanvas(sprite.type, sprite.special, sprite.orient, size * this.dpr);
    const w = art.width / this.dpr;
    const h = art.height / this.dpr;
    const x = this.cx(sprite.x);
    const y = this.cy(sprite.y);

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, sprite.alpha));
    ctx.translate(x, y);
    if (sprite.scale !== 1) ctx.scale(sprite.scale, sprite.scale);

    // Contact shadow — sold cheaply, and it stops balls floating on the grid.
    ctx.save();
    ctx.globalAlpha *= 0.35;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, h * 0.4, w * 0.32, h * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.drawImage(art, -w / 2, -h / 2, w, h);

    if (sprite.glow > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = sprite.glow * 0.75;
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.55);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.5, PALETTE.goldGlow);
      g.addColorStop(1, 'rgba(243,194,75,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, w * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawFlashes(ctx: CanvasRenderingContext2D, animator: Animator): void {
    const cell = this.layout.cell;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const flash of animator.flashes) {
      const p = flash.progress;
      const fade = 1 - p;
      const radius = cell * (0.3 + p * 0.55);
      const g = ctx.createRadialGradient(this.cx(flash.x), this.cy(flash.y), 0, this.cx(flash.x), this.cy(flash.y), radius);
      g.addColorStop(0, `rgba(255,255,255,${0.55 * fade})`);
      g.addColorStop(0.45, `rgba(243,194,75,${0.4 * fade})`);
      g.addColorStop(1, 'rgba(243,194,75,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(this.cx(flash.x), this.cy(flash.y), radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawSelection(ctx: CanvasRenderingContext2D): void {
    if (!this.selected) return;
    const cell = this.layout.cell;
    const pulse = 0.5 + Math.sin(this.hintPhase * 6) * 0.5;
    ctx.save();
    ctx.strokeStyle = PALETTE.gold;
    ctx.lineWidth = 2 + pulse * 1.5;
    ctx.shadowColor = PALETTE.goldGlow;
    ctx.shadowBlur = cell * 0.35;
    roundRect(
      ctx,
      this.layout.originX + this.selected.x * cell + 3,
      this.layout.originY + this.selected.y * cell + 3,
      cell - 6,
      cell - 6,
      cell * 0.2,
    );
    ctx.stroke();
    ctx.restore();
  }

  private drawHint(ctx: CanvasRenderingContext2D): void {
    if (!this.hint) return;
    const cell = this.layout.cell;
    const pulse = 0.35 + Math.abs(Math.sin(this.hintPhase * 2.4)) * 0.65;
    ctx.save();
    ctx.globalAlpha = pulse * 0.85;
    ctx.strokeStyle = PALETTE.chalk;
    ctx.setLineDash([cell * 0.12, cell * 0.1]);
    ctx.lineWidth = 2;
    for (const p of [this.hint.a, this.hint.b]) {
      roundRect(
        ctx,
        this.layout.originX + p.x * cell + 4,
        this.layout.originY + p.y * cell + 4,
        cell - 8,
        cell - 8,
        cell * 0.2,
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawPopups(ctx: CanvasRenderingContext2D, animator: Animator): void {
    const cell = this.layout.cell;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const popup of animator.popups) {
      const p = popup.progress;
      const rise = cell * 1.1 * easeOut(p);
      const alpha = p < 0.15 ? p / 0.15 : 1 - Math.max(0, (p - 0.55) / 0.45);
      const size = cell * (popup.cascade > 1 ? 0.44 : 0.36);
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.font = `700 ${size}px "Haettenschweiler", "Arial Narrow", "Roboto Condensed", Impact, system-ui, sans-serif`;
      ctx.lineWidth = Math.max(2, size * 0.16);
      ctx.strokeStyle = 'rgba(2,16,15,0.85)';
      ctx.fillStyle = popup.cascade > 1 ? PALETTE.gold : PALETTE.chalk;
      const text = popup.cascade > 1 ? `x${popup.cascade}  +${popup.score}` : `+${popup.score}`;
      const x = this.cx(popup.x);
      const y = this.cy(popup.y) - rise;
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
    ctx.restore();
  }
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
