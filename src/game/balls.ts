import type { BallType, Orient, Special } from '../match3/types.ts';

/**
 * Every ball is drawn from canvas primitives — no image assets anywhere in the
 * project. Each (type, special, size) combination is rendered once into an
 * offscreen canvas and reused, so a full board costs a handful of blits.
 */

export const PALETTE = {
  pitch: '#031F1E',
  pitchDeep: '#02100F',
  chalk: '#EEF3EC',
  chalkDim: 'rgba(238, 243, 236, 0.45)',
  gold: '#F3C24B',
  goldDeep: '#C8942A',
  goldGlow: 'rgba(243, 194, 75, 0.55)',
} as const;

interface Skin {
  name: string;
  /** Used for selection rings, popups and the goal chips. */
  accent: string;
}

export const BALL_SKINS: Record<BallType, Skin> = {
  0: { name: 'Rugby', accent: '#C4703A' },
  1: { name: 'Soccer', accent: '#F2F2EC' },
  2: { name: 'Cricket', accent: '#B02A26' },
  3: { name: 'Tennis', accent: '#CBE356' },
  4: { name: 'Golf', accent: '#F7F7F0' },
  5: { name: 'Basketball', accent: '#E5822B' },
};

type Ctx = CanvasRenderingContext2D;

// ---------------------------------------------------------------------------
// Shared shading
// ---------------------------------------------------------------------------

/** Lit from the top-left, with a dark rim so balls read as spheres. */
function sphereShade(ctx: Ctx, r: number, light: string, mid: string, dark: string): void {
  const g = ctx.createRadialGradient(-r * 0.34, -r * 0.38, r * 0.06, 0, 0, r * 1.08);
  g.addColorStop(0, light);
  g.addColorStop(0.42, mid);
  g.addColorStop(1, dark);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Specular dot plus a soft bounce light along the bottom edge. */
function gloss(ctx: Ctx, r: number, strength = 0.5): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();

  const hi = ctx.createRadialGradient(-r * 0.36, -r * 0.42, 0, -r * 0.36, -r * 0.42, r * 0.62);
  hi.addColorStop(0, `rgba(255,255,255,${strength})`);
  hi.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hi;
  ctx.fillRect(-r, -r, r * 2, r * 2);

  const bounce = ctx.createRadialGradient(r * 0.2, r * 0.55, 0, r * 0.2, r * 0.55, r * 0.7);
  bounce.addColorStop(0, 'rgba(255,255,255,0.16)');
  bounce.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = bounce;
  ctx.fillRect(-r, -r, r * 2, r * 2);

  ctx.restore();
}

function occlusion(ctx: Ctx, r: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();
  const g = ctx.createRadialGradient(0, 0, r * 0.62, 0, 0, r);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.34)');
  ctx.fillStyle = g;
  ctx.fillRect(-r, -r, r * 2, r * 2);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// The six balls
// ---------------------------------------------------------------------------

function drawRugby(ctx: Ctx, r: number): void {
  ctx.save();
  ctx.rotate(-0.42);
  const rx = r * 1.0;
  const ry = r * 0.66;

  const g = ctx.createRadialGradient(-rx * 0.32, -ry * 0.44, ry * 0.08, 0, 0, rx * 1.05);
  g.addColorStop(0, '#D98B4E');
  g.addColorStop(0.45, '#A85A2B');
  g.addColorStop(1, '#5E2C12');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  // Panel seams running the length of the ball.
  ctx.strokeStyle = 'rgba(60,24,8,0.5)';
  ctx.lineWidth = Math.max(1, r * 0.05);
  for (const offset of [-0.34, 0.34]) {
    ctx.beginPath();
    ctx.ellipse(0, ry * offset, rx * 0.96, ry * 0.52, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Lacing.
  ctx.strokeStyle = '#F6F1E2';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.1, r * 0.075);
  ctx.beginPath();
  ctx.moveTo(-rx * 0.42, 0);
  ctx.lineTo(rx * 0.42, 0);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, r * 0.062);
  for (let i = -2; i <= 2; i++) {
    const x = i * rx * 0.19;
    ctx.beginPath();
    ctx.moveTo(x, -ry * 0.2);
    ctx.lineTo(x, ry * 0.2);
    ctx.stroke();
  }

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();
  const hi = ctx.createRadialGradient(-rx * 0.38, -ry * 0.5, 0, -rx * 0.38, -ry * 0.5, rx * 0.7);
  hi.addColorStop(0, 'rgba(255,255,255,0.4)');
  hi.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hi;
  ctx.fillRect(-rx, -ry, rx * 2, ry * 2);
  ctx.restore();

  ctx.restore();
}

function drawSoccer(ctx: Ctx, r: number): void {
  sphereShade(ctx, r, '#FFFFFF', '#EDEDE4', '#9EA096');

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();

  const patch = '#16211F';
  ctx.fillStyle = patch;

  // Centre pentagon.
  polygon(ctx, 0, 0, r * 0.34, 5, -Math.PI / 2);
  ctx.fill();

  // Five more around the equator, foreshortened towards the rim.
  for (let i = 0; i < 5; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    const dist = r * 0.78;
    const px = Math.cos(angle) * dist;
    const py = Math.sin(angle) * dist;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle + Math.PI / 2);
    ctx.scale(1, 0.72);
    polygon(ctx, 0, 0, r * 0.3, 5, Math.PI / 2);
    ctx.fill();
    ctx.restore();
  }

  // Seams linking the patches.
  ctx.strokeStyle = 'rgba(22,33,31,0.45)';
  ctx.lineWidth = Math.max(1, r * 0.045);
  for (let i = 0; i < 5; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / 5 + Math.PI / 5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * r * 0.36, Math.sin(angle) * r * 0.36);
    ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    ctx.stroke();
  }

  ctx.restore();
  gloss(ctx, r, 0.42);
  occlusion(ctx, r);
}

function drawCricket(ctx: Ctx, r: number): void {
  sphereShade(ctx, r, '#D4453F', '#9E1E1C', '#4A0B0A');

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.rotate(-0.3);

  // The seam: a raised band with six rows of stitching.
  ctx.strokeStyle = 'rgba(255,240,225,0.22)';
  ctx.lineWidth = r * 0.3;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.34, r * 1.02, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = '#F7EFE0';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, r * 0.062);
  for (const side of [-1, 1]) {
    for (let i = -3; i <= 3; i++) {
      const t = (i / 3.4) * r * 0.86;
      const w = r * 0.3 * Math.sqrt(Math.max(0, 1 - (t / (r * 1.02)) ** 2));
      ctx.beginPath();
      ctx.moveTo(side * (w * 0.15), t);
      ctx.lineTo(side * (w + r * 0.14), t + r * 0.05);
      ctx.stroke();
    }
  }

  ctx.restore();
  gloss(ctx, r, 0.5);
  occlusion(ctx, r);
}

function drawTennis(ctx: Ctx, r: number): void {
  sphereShade(ctx, r, '#EAF77A', '#C2DB3F', '#6E8317');

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();

  // Felt speckle.
  ctx.fillStyle = 'rgba(255,255,255,0.09)';
  for (let i = 0; i < 40; i++) {
    const a = (i * 2.39996) % (Math.PI * 2);
    const d = r * Math.sqrt(((i * 37) % 100) / 100) * 0.94;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r * 0.028, 0, Math.PI * 2);
    ctx.fill();
  }

  // The two classic seams.
  ctx.strokeStyle = '#FBFBF2';
  ctx.lineWidth = Math.max(1.4, r * 0.11);
  ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * r * 1.02, -r * 0.92);
    ctx.bezierCurveTo(side * r * 0.18, -r * 0.5, side * r * 0.18, r * 0.5, side * r * 1.02, r * 0.92);
    ctx.stroke();
  }

  ctx.restore();
  gloss(ctx, r, 0.3);
  occlusion(ctx, r);
}

function drawGolf(ctx: Ctx, r: number): void {
  sphereShade(ctx, r, '#FFFFFF', '#F0F0E8', '#A8AA9F');

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();

  // Hex-packed dimples, shaded so they read as pits rather than dots.
  const step = r * 0.29;
  const dimple = r * 0.105;
  for (let row = -4; row <= 4; row++) {
    for (let col = -4; col <= 4; col++) {
      const x = col * step + (row % 2 === 0 ? 0 : step / 2);
      const y = row * step * 0.88;
      const d = Math.hypot(x, y);
      if (d > r * 0.94) continue;
      const fade = 1 - (d / r) * 0.5;
      ctx.fillStyle = `rgba(150,152,142,${0.5 * fade})`;
      ctx.beginPath();
      ctx.arc(x, y, dimple, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.55 * fade})`;
      ctx.beginPath();
      ctx.arc(x - dimple * 0.28, y - dimple * 0.3, dimple * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
  gloss(ctx, r, 0.45);
  occlusion(ctx, r);
}

function drawBasketball(ctx: Ctx, r: number): void {
  sphereShade(ctx, r, '#F5A24E', '#D4711F', '#7A3608');

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();

  ctx.strokeStyle = '#1A1410';
  ctx.lineWidth = Math.max(1.2, r * 0.085);
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(0, r);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-r, 0);
  ctx.lineTo(r, 0);
  ctx.stroke();

  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * r * 1.02, 0, r * 0.62, r * 1.0, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
  gloss(ctx, r, 0.32);
  occlusion(ctx, r);
}

function polygon(ctx: Ctx, cx: number, cy: number, radius: number, sides: number, rotation: number): void {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i * Math.PI * 2) / sides;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

const DRAWERS: Record<BallType, (ctx: Ctx, r: number) => void> = {
  0: drawRugby,
  1: drawSoccer,
  2: drawCricket,
  3: drawTennis,
  4: drawGolf,
  5: drawBasketball,
};

// ---------------------------------------------------------------------------
// Power-up dressing
// ---------------------------------------------------------------------------

function goldRing(ctx: Ctx, r: number, width: number): void {
  ctx.strokeStyle = PALETTE.gold;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.96, 0, Math.PI * 2);
  ctx.stroke();
}

function drawStriker(ctx: Ctx, r: number, orient: Orient | null): void {
  ctx.save();
  if (orient === 'v') ctx.rotate(Math.PI / 2);

  // Speed bar across the ball, chevrons pointing both ways.
  const g = ctx.createLinearGradient(-r, 0, r, 0);
  g.addColorStop(0, 'rgba(243,194,75,0)');
  g.addColorStop(0.5, 'rgba(243,194,75,0.92)');
  g.addColorStop(1, 'rgba(243,194,75,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-r, -r * 0.17, r * 2, r * 0.34);

  ctx.strokeStyle = PALETTE.pitchDeep;
  ctx.lineWidth = Math.max(1.4, r * 0.09);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const side of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const x = side * (r * 0.24 + i * r * 0.3);
      ctx.beginPath();
      ctx.moveTo(x - side * r * 0.13, -r * 0.15);
      ctx.lineTo(x, 0);
      ctx.lineTo(x - side * r * 0.13, r * 0.15);
      ctx.stroke();
    }
  }
  ctx.restore();
  goldRing(ctx, r, Math.max(1.4, r * 0.09));
}

function drawScrum(ctx: Ctx, r: number): void {
  // A burst: eight gold spokes plus a heavy ring, like a pack breaking open.
  ctx.save();
  ctx.strokeStyle = PALETTE.gold;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.5, r * 0.1);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 + Math.PI / 8;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5);
    ctx.lineTo(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95);
    ctx.stroke();
  }
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.46);
  core.addColorStop(0, 'rgba(255,240,200,0.95)');
  core.addColorStop(1, 'rgba(243,194,75,0.15)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  goldRing(ctx, r, Math.max(1.4, r * 0.09));
}

function drawHatTrick(ctx: Ctx, r: number): void {
  // Three chalk-gold stars, and a cross showing the row-and-column sweep.
  ctx.save();
  ctx.strokeStyle = 'rgba(243,194,75,0.85)';
  ctx.lineWidth = Math.max(1.2, r * 0.075);
  ctx.beginPath();
  ctx.moveTo(-r * 0.95, 0);
  ctx.lineTo(r * 0.95, 0);
  ctx.moveTo(0, -r * 0.95);
  ctx.lineTo(0, r * 0.95);
  ctx.stroke();

  ctx.fillStyle = PALETTE.gold;
  ctx.strokeStyle = PALETTE.pitchDeep;
  ctx.lineWidth = Math.max(1, r * 0.05);
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
    star(ctx, Math.cos(a) * r * 0.48, Math.sin(a) * r * 0.48, r * 0.3, r * 0.13);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
  goldRing(ctx, r, Math.max(1.4, r * 0.09));
}

function drawMatchBall(ctx: Ctx, r: number): void {
  // Every ball at once: six arcs in the six ball colours around a white core.
  ctx.save();
  ctx.lineWidth = r * 0.3;
  ctx.lineCap = 'butt';
  for (let i = 0; i < 6; i++) {
    ctx.strokeStyle = BALL_SKINS[i as BallType].accent;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.78, (i * Math.PI) / 3, ((i + 1) * Math.PI) / 3);
    ctx.stroke();
  }
  const core = ctx.createRadialGradient(-r * 0.15, -r * 0.2, 0, 0, 0, r * 0.62);
  core.addColorStop(0, '#FFFFFF');
  core.addColorStop(0.7, '#F6F2E4');
  core.addColorStop(1, 'rgba(246,242,228,0.1)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  goldRing(ctx, r, Math.max(1.6, r * 0.1));
}

function star(ctx: Ctx, cx: number, cy: number, outer: number, inner: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, HTMLCanvasElement>();
const MAX_CACHE = 96;

/**
 * A pre-rendered ball, sized in device pixels. The sprite is drawn with a small
 * margin so glows and rings are not clipped.
 */
export function ballCanvas(type: BallType, special: Special, orient: Orient | null, size: number): HTMLCanvasElement {
  const px = Math.max(8, Math.round(size));
  const key = `${type}|${special}|${orient ?? '-'}|${px}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const pad = Math.ceil(px * 0.14);
  const canvas = document.createElement('canvas');
  canvas.width = px + pad * 2;
  canvas.height = px + pad * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.translate(canvas.width / 2, canvas.height / 2);
  const r = px / 2;

  if (special !== 'none') {
    ctx.save();
    ctx.shadowColor = PALETTE.goldGlow;
    ctx.shadowBlur = px * 0.24;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.001)';
    ctx.fill();
    ctx.restore();
  }

  if (special === 'matchball') {
    drawMatchBall(ctx, r);
  } else {
    DRAWERS[type](ctx, r);
    switch (special) {
      case 'striker':
        drawStriker(ctx, r, orient);
        break;
      case 'scrum':
        drawScrum(ctx, r);
        break;
      case 'hattrick':
        drawHatTrick(ctx, r);
        break;
      default:
        break;
    }
  }

  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, canvas);
  return canvas;
}

/** Drop cached art — call on resize, when every sprite changes size anyway. */
export function clearBallCache(): void {
  cache.clear();
}
