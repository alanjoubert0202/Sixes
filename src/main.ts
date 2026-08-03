import { Game, LEVELS } from './game/game.ts';
import type { Level } from './game/game.ts';
import type { CreatedSpecial, Special } from './match3/types.ts';
import { Menu } from './menu.ts';
import {
  clampLevel,
  clearProgress,
  emptyProgress,
  loadProgress,
  recordScore,
  recordWin,
  saveProgress,
} from './progress.ts';
import type { StorageLike } from './progress.ts';

/**
 * Entry point: shows the menu, and runs a match when one is chosen.
 *
 * The pre-game screens are plain DOM (see `menu.ts`); the canvas is only ever
 * used for gameplay. Rules live in `src/match3`, presentation in `src/game`.
 */

const storage: StorageLike | null = (() => {
  try {
    // Touching localStorage at all throws in some privacy modes.
    const probe = window.localStorage;
    probe.getItem('sixes.probe');
    return probe;
  } catch {
    return null;
  }
})();

function levelById(id: number): Level {
  return LEVELS[clampLevel(id, LEVELS.length) - 1];
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
const overlayMenu = el<HTMLButtonElement>('overlay-menu');

const numbers = new Intl.NumberFormat('en-GB');
let progress = loadProgress(storage, LEVELS.length);
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
// HUD
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
// Screens
// ---------------------------------------------------------------------------

const menu = new Menu(progress, {
  onResume: (level) => startLevel(level),
  onNewGame: () => {
    clearProgress(storage);
    progress = emptyProgress();
    menu.update(progress);
    startLevel(1);
  },
  onPick: (level) => startLevel(level),
});

function showMenu(): void {
  overlay.hidden = true;
  game?.destroy();
  game = null;
  menu.update(progress);
  menu.show('menu');
}

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

  // Hand the view back to the canvas *before* starting, so the board can
  // measure its container — a hidden parent has no size to fit to.
  menu.show('game');

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
  progress = outcome.won
    ? recordWin(progress, outcome.level.id, outcome.score, LEVELS.length)
    : recordScore(progress, outcome.score);
  saveProgress(storage, progress);
  menu.update(progress);
  bestValue.textContent = `Best ${numbers.format(progress.best)}`;

  const last = outcome.level.id >= LEVELS.length;

  if (outcome.won) {
    overlayKicker.textContent = last ? 'Full time' : `Match ${outcome.level.id} cleared`;
    overlayTitle.textContent = last ? 'You win the lot' : outcome.level.name;
    overlayBody.textContent = last
      ? 'Every match cleared. Go again for a bigger score.'
      : `${outcome.movesLeft} ${outcome.movesLeft === 1 ? 'move' : 'moves'} to spare.`;
    overlayPrimary.textContent = last ? 'Play again' : 'Next match';
    overlayPrimary.onclick = () => startLevel(last ? 1 : outcome.level.id + 1);
  } else {
    overlayKicker.textContent = 'No moves left';
    overlayTitle.textContent = 'So close';
    overlayBody.textContent = `You needed ${numbers.format(outcome.level.goal - outcome.score)} more.`;
    overlayPrimary.textContent = 'Try again';
    overlayPrimary.onclick = () => startLevel(outcome.level.id);
  }

  overlayScore.textContent = numbers.format(outcome.score);
  overlaySecondary.textContent = 'Replay';
  overlaySecondary.onclick = () => startLevel(outcome.level.id);
  overlayMenu.onclick = () => showMenu();
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
document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false });

menu.show('menu');

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
