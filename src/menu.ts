import { LEVELS } from './game/game.ts';
import type { Level } from './game/game.ts';
import { Scatter } from './scatter.ts';
import { canResume, hasProgress, isCleared, isUnlocked } from './progress.ts';
import type { Progress } from './progress.ts';

/**
 * The pre-game screens: menu, match picker and how-to-play.
 *
 * All plain DOM layered over the canvas — the canvas stays for gameplay only.
 * The menu owns no game state; it reads a {@link Progress} snapshot and reports
 * back through {@link MenuCallbacks}.
 */

export type ScreenName = 'menu' | 'picker' | 'howto' | 'game';

export interface MenuCallbacks {
  onResume(level: number): void;
  onNewGame(): void;
  onPick(level: number): void;
}

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Sixes: missing #${id}`);
  return node as T;
};

const LOCK_ICON = `<svg class="pick-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`;
const TICK_ICON = `<svg class="pick-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg>`;

export class Menu {
  private callbacks: MenuCallbacks;
  private progress: Progress;
  private scatter: Scatter;
  private current: ScreenName = 'menu';

  private app = el('app');
  private screenMenu = el('screen-menu');
  private screenPicker = el('screen-picker');
  private screenHow = el('screen-howto');

  private caption = el('menu-caption');
  private resumeBtn = el<HTMLButtonElement>('menu-resume');
  private newBtn = el<HTMLButtonElement>('menu-new');
  private pickerList = el('picker-list');

  private numbers = new Intl.NumberFormat('en-GB');

  constructor(progress: Progress, callbacks: MenuCallbacks) {
    this.progress = progress;
    this.callbacks = callbacks;
    this.scatter = new Scatter(el('scatter'));

    this.resumeBtn.addEventListener('click', () => this.callbacks.onResume(this.progress.level));
    this.newBtn.addEventListener('click', () => this.startNewGame());
    el('menu-select').addEventListener('click', () => this.show('picker'));
    el('menu-howto').addEventListener('click', () => this.show('howto'));
    el('picker-back').addEventListener('click', () => this.show('menu'));
    el('howto-back').addEventListener('click', () => this.show('menu'));

    // Escape backs out of a sub-screen, matching the Back buttons.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (this.current === 'picker' || this.current === 'howto') this.show('menu');
    });
  }

  // -------------------------------------------------------------------------

  get screen(): ScreenName {
    return this.current;
  }

  /** Refresh the menu against a newer progress snapshot. */
  update(progress: Progress): void {
    this.progress = progress;
    this.render();
  }

  /** Show a screen. `game` hides all of them and hands the view back. */
  show(name: ScreenName): void {
    this.current = name;
    this.screenMenu.hidden = name !== 'menu';
    this.screenPicker.hidden = name !== 'picker';
    this.screenHow.hidden = name !== 'howto';
    this.app.hidden = name !== 'game';

    if (name === 'menu') {
      this.render();
      this.scatter.play();
    }
    if (name === 'picker') this.renderPicker();

    // Move focus somewhere sensible for keyboard and screen-reader users.
    if (name !== 'game') {
      const first = (name === 'menu' ? this.screenMenu : name === 'picker' ? this.screenPicker : this.screenHow)
        .querySelector<HTMLElement>('button:not([disabled])');
      first?.focus({ preventScroll: true });
    }
  }

  // -------------------------------------------------------------------------

  private render(): void {
    const resumable = canResume(this.progress);
    this.resumeBtn.hidden = !resumable;

    // Whichever action is the obvious one gets the solid treatment.
    this.resumeBtn.className = 'btn btn--primary';
    this.newBtn.className = resumable ? 'btn btn--ghost' : 'btn btn--primary';

    if (hasProgress(this.progress)) {
      const level = LEVELS[this.progress.level - 1] ?? LEVELS[0];
      this.caption.textContent = `Match ${level.id} · Score ${this.numbers.format(this.progress.best)}`;
      this.caption.hidden = false;
    } else {
      this.caption.hidden = true;
    }
  }

  private startNewGame(): void {
    if (hasProgress(this.progress)) {
      const ok = window.confirm('This clears your progress on all matches. Start over?');
      if (!ok) return;
    }
    this.callbacks.onNewGame();
  }

  private renderPicker(): void {
    const items = LEVELS.map((level) => this.pickerItem(level));
    this.pickerList.replaceChildren(...items);
  }

  private pickerItem(level: Level): HTMLLIElement {
    const unlocked = isUnlocked(this.progress, level.id);
    const cleared = isCleared(this.progress, level.id);

    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `pick${unlocked ? '' : ' pick--locked'}${cleared ? ' pick--cleared' : ''}`;
    button.disabled = !unlocked;

    const status = cleared ? TICK_ICON : unlocked ? '' : LOCK_ICON;
    button.innerHTML =
      `<span class="pick-no">${String(level.id).padStart(2, '0')}</span>` +
      `<span class="pick-name">${escapeHtml(level.name)}</span>` +
      `<span class="pick-state">${status}</span>`;

    button.setAttribute(
      'aria-label',
      unlocked
        ? `Match ${level.id}, ${level.name}${cleared ? ', cleared' : ''}`
        : `Match ${level.id}, ${level.name}, locked`,
    );

    if (unlocked) button.addEventListener('click', () => this.callbacks.onPick(level.id));
    item.append(button);
    return item;
  }
}

/** Level names are ours, not user input — but building HTML without this is a habit worth not forming. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
