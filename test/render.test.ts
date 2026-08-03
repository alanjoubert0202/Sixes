import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The renderer and the ball art are the one part of Sixes that cannot be
 * checked by reading state back — they just issue canvas calls. So we hand them
 * a recording 2D context that rejects malformed colours and non-finite
 * geometry, and drive a real board through it.
 */

const COLOUR = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-z]+)$/;

interface Call {
  name: string;
  args: unknown[];
}

class MockGradient {
  stops: string[] = [];
  addColorStop(offset: number, colour: string): void {
    assert.ok(Number.isFinite(offset), 'gradient stop offset must be finite');
    assert.ok(offset >= 0 && offset <= 1, `gradient stop out of range: ${offset}`);
    assert.match(colour, COLOUR, `bad gradient colour: ${JSON.stringify(colour)}`);
    this.stops.push(colour);
  }
}

class MockContext {
  calls: Call[] = [];
  colours: string[] = [];
  gradients: MockGradient[] = [];

  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  lineWidth = 1;
  lineCap = 'butt';
  lineJoin = 'miter';
  font = '';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  shadowBlur = 0;
  shadowColor = '';
  shadowOffsetY = 0;

  private fill_ = '#000';
  private stroke_ = '#000';

  set fillStyle(value: string | MockGradient) {
    if (typeof value === 'string') {
      assert.match(value, COLOUR, `bad fillStyle: ${JSON.stringify(value)}`);
      this.colours.push(value);
    }
    this.fill_ = value as string;
  }
  get fillStyle(): string | MockGradient {
    return this.fill_;
  }

  set strokeStyle(value: string | MockGradient) {
    if (typeof value === 'string') {
      assert.match(value, COLOUR, `bad strokeStyle: ${JSON.stringify(value)}`);
      this.colours.push(value);
    }
    this.stroke_ = value as string;
  }
  get strokeStyle(): string | MockGradient {
    return this.stroke_;
  }

  private record(name: string, args: unknown[]): void {
    for (const arg of args) {
      if (typeof arg === 'number') {
        assert.ok(Number.isFinite(arg), `${name} received a non-finite number: ${arg}`);
      }
    }
    this.calls.push({ name, args });
  }

  createLinearGradient(...args: number[]): MockGradient {
    this.record('createLinearGradient', args);
    const g = new MockGradient();
    this.gradients.push(g);
    return g;
  }

  createRadialGradient(...args: number[]): MockGradient {
    this.record('createRadialGradient', args);
    assert.ok(args[2] >= 0 && args[5] >= 0, 'radial gradient radii must not be negative');
    const g = new MockGradient();
    this.gradients.push(g);
    return g;
  }

  arc(...args: number[]): void {
    this.record('arc', args);
    assert.ok(args[2] >= 0, 'arc radius must not be negative');
  }

  ellipse(...args: number[]): void {
    this.record('ellipse', args);
    assert.ok(args[2] >= 0 && args[3] >= 0, 'ellipse radii must not be negative');
  }

  drawImage(...args: unknown[]): void {
    this.record('drawImage', args);
    assert.ok(args[0], 'drawImage needs a source');
  }

  setLineDash(pattern: number[]): void {
    this.record('setLineDash', pattern);
    for (const n of pattern) assert.ok(Number.isFinite(n) && n >= 0, 'dash lengths must be positive');
  }

  measureText(text: string): { width: number } {
    this.record('measureText', [text]);
    return { width: text.length * 6 };
  }
}

// Methods with no interesting behaviour beyond argument checking.
for (const name of [
  'save',
  'restore',
  'translate',
  'rotate',
  'scale',
  'setTransform',
  'beginPath',
  'closePath',
  'moveTo',
  'lineTo',
  'bezierCurveTo',
  'quadraticCurveTo',
  'arcTo',
  'rect',
  'fill',
  'stroke',
  'fillRect',
  'clearRect',
  'clip',
  'fillText',
  'strokeText',
] as const) {
  (MockContext.prototype as unknown as Record<string, unknown>)[name] = function record(
    this: MockContext,
    ...args: unknown[]
  ) {
    for (const arg of args) {
      if (typeof arg === 'number') {
        assert.ok(Number.isFinite(arg), `${name} received a non-finite number: ${arg}`);
      }
    }
    this.calls.push({ name, args });
  };
}

class MockCanvas {
  width = 0;
  height = 0;
  style: Record<string, string> = {};
  ctx = new MockContext();
  parentElement: { getBoundingClientRect(): DOMRect } | null = null;

  getContext(): MockContext {
    return this.ctx;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 390, height: 620 };
  }
}

// Minimal DOM for `balls.ts`, which creates offscreen canvases for its cache.
const globals = globalThis as unknown as Record<string, unknown>;
globals.document = { createElement: () => new MockCanvas() };
globals.window = { devicePixelRatio: 2 };

const { Board } = await import('../src/match3/board.ts');
const { Animator } = await import('../src/game/animator.ts');
const { Renderer } = await import('../src/game/renderer.ts');
const { ballCanvas, clearBallCache, BALL_SKINS } = await import('../src/game/balls.ts');
const { BALL_TYPES } = await import('../src/match3/types.ts');

// ---------------------------------------------------------------------------

test('every ball and power-up draws with valid colours and finite geometry', () => {
  clearBallCache();
  const specials = ['none', 'striker', 'scrum', 'hattrick', 'matchball'] as const;

  for (const type of BALL_TYPES) {
    for (const special of specials) {
      for (const orient of ['h', 'v', null] as const) {
        const canvas = ballCanvas(type, special, orient, 96) as unknown as MockCanvas;
        assert.ok(canvas.ctx.calls.length > 0, `${type}/${special} drew nothing`);
        assert.ok(canvas.width > 96 && canvas.height > 96, 'ball art should carry a margin for its glow');
      }
    }
  }
});

test('ball skins declare a usable accent colour for every type', () => {
  for (const type of BALL_TYPES) {
    const skin = BALL_SKINS[type];
    assert.ok(skin, `no skin for ball type ${type}`);
    assert.match(skin.accent, COLOUR, `bad accent for ${skin?.name}`);
    assert.ok(skin.name.length > 0);
  }
});

test('the ball cache reuses art instead of redrawing it', () => {
  clearBallCache();
  const first = ballCanvas(2, 'striker', 'h', 64);
  const second = ballCanvas(2, 'striker', 'h', 64);
  assert.equal(first, second, 'same request should hit the cache');
  assert.notEqual(ballCanvas(2, 'striker', 'v', 64), first, 'orientation is part of the art');
  assert.notEqual(ballCanvas(3, 'striker', 'h', 64), first, 'ball type is part of the art');
});

test('the renderer draws a full board without producing junk', () => {
  const board = new Board({ seed: 'render' });
  const animator = new Animator(board.width, board.height);
  animator.sync(board.grid());

  const canvas = new MockCanvas();
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement, board.width, board.height);
  renderer.resize(390, 620);

  assert.ok(renderer.layout.cell > 0, 'a sized board needs a positive cell size');
  assert.equal(canvas.width, 780, 'canvas backing store should follow devicePixelRatio');

  renderer.draw(animator, 16);
  const drawn = canvas.ctx.calls.filter((c) => c.name === 'drawImage').length;
  assert.equal(drawn, board.width * board.height, 'every ball should be blitted once');
});

test('the renderer survives a whole animated turn, specials and all', () => {
  const board = new Board({ seed: 'render-turn', width: 8, height: 8 });
  const animator = new Animator(board.width, board.height);
  animator.sync(board.grid());

  const canvas = new MockCanvas();
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement, board.width, board.height);
  renderer.resize(390, 620);
  renderer.selected = { x: 2, y: 3 };
  renderer.hint = { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } };

  for (let turn = 0; turn < 12; turn++) {
    const move = board.findMove();
    assert.ok(move);
    animator.enqueue(board.swap(move.a, move.b).events);
    const reshuffle = board.checkDeadlock();
    if (reshuffle) animator.enqueue([reshuffle]);

    let frames = 0;
    while (animator.busy) {
      animator.update(16);
      renderer.draw(animator, 16);
      if (++frames > 2000) assert.fail('renderer loop never settled');
    }
    renderer.draw(animator, 16);
  }

  assert.ok(canvas.ctx.gradients.length > 0, 'expected shaded balls, not flat fills');
  assert.ok(canvas.ctx.calls.some((c) => c.name === 'fillText'), 'score popups should have been drawn');
});

test('picking maps pointer coordinates back to board squares', () => {
  const board = new Board({ seed: 'pick' });
  const canvas = new MockCanvas();
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement, board.width, board.height);
  renderer.resize(390, 620);

  const { cell, originX, originY } = renderer.layout;
  for (const [x, y] of [
    [0, 0],
    [3, 5],
    [board.width - 1, board.height - 1],
  ]) {
    const px = originX + (x + 0.5) * cell;
    const py = originY + (y + 0.5) * cell;
    assert.deepEqual(renderer.pick(px, py), { x, y }, `mis-picked ${x},${y}`);
  }

  assert.equal(renderer.pick(originX - 10, originY + cell), null, 'off the left edge');
  assert.equal(renderer.pick(originX + cell, originY - 10), null, 'above the board');
  assert.equal(renderer.pick(originX + cell * board.width + 5, originY), null, 'off the right edge');
});

test('a zero-sized board is handled rather than dividing by zero', () => {
  const canvas = new MockCanvas();
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement, 8, 8);
  assert.equal(renderer.pick(10, 10), null, 'picking before layout should not crash');
});
