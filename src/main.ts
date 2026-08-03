import { Game, LEVELS } from './game/game.ts';
import type { Level } from './game/game.ts';
import type { CreatedSpecial, Special } from './match3/types.ts';

/**
 * HUD wiring and level progression. Everything below the DOM layer lives in
 * `src/game`, and the rules live in `src/match3`.
 */

const STORAGE_KEY = 'sixes.progress.v1';

interface Progress {
  level: number;
  best: number;
  cleared: number[];
}

function loadProgress(): Progress {
  const fallback: Progress = { level: 1, best: 0, cleared: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Progress>;
    return {
      level: clampLevel(Number(parsed.level) || 1),
      best: Math.max(0, Number(parsed.best) || 0),
      cleared: Array.isArray(parsed.cleared) ? parsed.cleared.filter((n) => typeof n === 'number') : [],
    };
  } catch {
    // A private-mode browser or corrupt entry should never block a game.
    return fallback;
  }
}

function saveProgress(progress: Progress): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    /* storage is a nicety, not a requirement */
  }
}

function clampLevel(id: number): number {
  return Math.min(Math.max(Math.round(id), 1), LEVELS.length);
}

function levelById(id: number): Level {
  return LEVELS[clampLevel(id) - 1];
}

// ---------------------------------------------------------------------------

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Sixes: missing #${id}`);
  return found as T;
};

const canvas = el<HTMLCanvasElement>('canvas');
const levelValue = el('level-value');
const levelName = el('level-name');
const scoreValue = el('score-value');
const goalValue = el('goal-value');
const movesValue = el('moves-value');
const bestValue = el('best-value');
const progressBar = el('progress');
const progressFill = el('progress-fill');
const toast = el('toast');
const hintBtn = el<HTMLButtonElement>('hint-btn');
const restartBtn = el<HTMLButtonElement>('restart-btn');
const overlay = el('overlay');
const overlayKicker = el('overlay-kicker');
const overlayTitle = el('overlay-title');
const overlayScore = el('overlay-score');
const overlayBody = el('overlay-body');
const overlayPrimary = el<HTMLButtonElement>('overlay-primary');
const overlaySecondary = el<HTMLButtonElement>('overlay-secondary');

const numbers = new Intl.NumberFormat('en-GB');
let progress = loadProgress();
let game: Game | null = null;
let toastTimer = 0;

const SPECIAL_SHOUT: Record<Special, string> = {
  none: '',
  striker: 'Striker!',
  matchball: 'Match ball!',
  scrum: 'Scrum!',
  hattrick: 'Hat-trick!',
};

// ---------------------------------------------------------------------------

function bump(node: HTMLElement): void {
  node.classList.remove('is-bumped');
  // Force a reflow so the animation restarts on every change.
  void node.offsetWidth;
  node.classList.add('is-bumped');
}

function shout(message: string, gold = false): void {
  toast.textContent = message;
  toast.classList.toggle('is-shout', gold);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.textContent = 'Match three or more';
    toast.classList.remove('is-shout');
  }, 1800);
}

function renderScore(score: number, goal: number): void {
  scoreValue.textContent = numbers.format(score);
  goalValue.textContent = `of ${numbers.format(goal)}`;
  const pct = Math.min(100, Math.round((score / goal) * 100));
  progressFill.style.width = `${pct}%`;
  progressBar.setAttribute('aria-valuenow', String(pct));
  bump(scoreValue);
}

function renderMoves(left: number): void {
  movesValue.textContent = String(left);
  movesValue.classList.toggle('is-low', left <= 3);
  bump(movesValue);
}

function renderLevel(level: Level): void {
  levelValue.textContent = String(level.id);
  levelName.textContent = level.name;
  bestValue.textContent = `Best ${numbers.format(progress.best)}`;
}

function renderSpecials(created: CreatedSpecial[]): void {
  // Shout about the best thing that just happened, not all of them.
  const rank: Special[] = ['striker', 'scrum', 'hattrick', 'matchball'];
  let best: Special = 'none';
  for (const item of created) {
    if (rank.indexOf(item.special) > rank.indexOf(best)) best = item.special;
  }
  if (best !== 'none') shout(SPECIAL_SHOUT[best], true);
}

// ---------------------------------------------------------------------------

/**
 * The seed decides the board. Level and attempt go into it so a replay is a
 * fresh board, while two clients handed the same seed get the same game — the
 * hook a 1v1 mode would use.
 */
function seedFor(level: Level, attempt: number): string {
  return `sixes-v1-L${level.id}-${attempt}`;
}

function startLevel(id: number, attempt = Date.now() % 100_000): void {
  const level = levelById(id);
  overlay.hidden = true;
  game?.destroy();

  game = new Game(canvas, level, seedFor(level, attempt), {
    onLevel: renderLevel,
    onScore: renderScore,
    onMoves: renderMoves,
    onSpecial: renderSpecials,
    onFinish: finish,
  });
  game.start();
  shout(`${level.name} — reach ${numbers.format(level.goal)}`);
}

function finish(outcome: { won: boolean; score: number; level: Level; movesLeft: number }): void {
  if (outcome.score > progress.best) {
    progress = { ...progress, best: outcome.score };
    saveProgress(progress);
    bestValue.textContent = `Best ${numbers.format(progress.best)}`;
  }

  const last = outcome.level.id >= LEVELS.length;

  if (outcome.won) {
    const cleared = new Set(progress.cleared);
    cleared.add(outcome.level.id);
    progress = {
      level: clampLevel(Math.max(progress.level, outcome.level.id + (last ? 0 : 1))),
      best: progress.best,
      cleared: [...cleared].sort((a, b) => a - b),
    };
    saveProgress(progress);

    overlayKicker.textContent = last ? 'Full time' : `Level ${outcome.level.id} cleared`;
    overlayTitle.textContent = last ? 'You win the lot' : outcome.level.name;
    overlayBody.textContent = last
      ? 'Every level cleared. Go again for a bigger score.'
      : `${outcome.movesLeft} ${outcome.movesLeft === 1 ? 'move' : 'moves'} to spare.`;
    overlayPrimary.textContent = last ? 'Play again' : 'Next level';
    overlayPrimary.onclick = () => startLevel(last ? 1 : outcome.level.id + 1);
  } else {
    overlayKicker.textContent = 'No moves left';
    overlayTitle.textContent = 'So close';
    overlayBody.textContent = `You needed ${numbers.format(outcome.level.goal - outcome.score)} more.`;
    overlayPrimary.textContent = 'Try again';
    overlayPrimary.onclick = () => startLevel(outcome.level.id);
  }

  overlayScore.textContent = numbers.format(outcome.score);
  overlaySecondary.textContent = 'Replay level';
  overlaySecondary.onclick = () => startLevel(outcome.level.id);
  overlay.hidden = false;
}

// ---------------------------------------------------------------------------

hintBtn.addEventListener('click', () => game?.showHint());
restartBtn.addEventListener('click', () => {
  if (game) startLevel(game.currentLevel.id);
});

// A rotation or an iOS toolbar collapse changes the board box.
window.addEventListener('orientationchange', () => window.setTimeout(() => game?.fit(), 120));
window.addEventListener('resize', () => game?.fit());

// Stop iOS double-tap zoom from stealing quick consecutive taps.
document.addEventListener(
  'gesturestart',
  (event) => event.preventDefault(),
  { passive: false },
);

startLevel(progress.level);

// ---------------------------------------------------------------------------
// PWA
// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline play is a bonus; a failed registration must not break the game.
    });
  });
}
