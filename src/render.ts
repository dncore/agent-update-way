import type { TaskUpdate } from './types.js';

/* ---------- ANSI helpers (zero-dependency) ---------- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
export const color = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Single-line spinner for short phases (e.g. detection) before the main panel.
 * TTY: animated inline; non-TTY: static "..." line.
 */
export function createSpinner(text: string): {
  /** Replace the spinner line with a final status (or clear it). */
  done(finalText?: string): void;
} {
  const tty = process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CI;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const render = () => {
    process.stdout.write(
      `\r\x1b[2K${color.cyan((SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? ' ') + ' ' + text)}`,
    );
  };
  const renderStatic = () => {
    process.stdout.write(`${text}...`);
  };

  if (tty) {
    render();
    timer = setInterval(() => {
      frame++;
      render();
    }, 80);
  } else {
    renderStatic();
  }

  return {
    done(finalText?: string) {
      if (timer) clearInterval(timer);
      if (tty) {
        process.stdout.write(
          `\r\x1b[2K${finalText ? color.green(`✔ ${finalText}`) : ''}\n`,
        );
      } else {
        process.stdout.write(finalText ? ` ✔ ${finalText}\n` : '\n');
      }
    },
  };
}

/* ---------- progress bar ---------- */

/** Compute the summary line printed once everything is done. */
export function summaryLine(
  updated: number,
  upToDate: number,
  skipped: number,
  failed: number,
): string {
  return color.bold(
    `Done: ${updated} updated, ${upToDate} up to date, ${skipped} skipped, ${failed} failed.`,
  );
}

const BAR_WIDTH = 25;
const BAR_FILLED = '█';
const BAR_EMPTY = '░';

function drawBar(done: number, total: number, running: number, frame: string, started: boolean): string {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const filled = total > 0 ? Math.round((done / total) * BAR_WIDTH) : 0;
  const bar = BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled);

  let status: string;
  if (!started) {
    status = '  ' + color.dim('...');
  } else if (running > 0) {
    status = '  ' + color.cyan(frame + ' ' + running + ' running');
  } else {
    status = '  ' + color.green('done');
  }

  return `[${bar}] ${pct}% (${done}/${total})${status}`;
}

/* ---------- renderer ---------- */

export interface Renderer {
  /** Register a task (in display order). */
  add(label: string): number;
  /** Update a task's state and repaint. */
  update(index: number, u: TaskUpdate): void;
  /** Finish: stop animation, return summary line. */
  stop(): string;
}

/**
 * Progress bar for the concurrent update phase.
 *
 * - TTY: a single-line progress bar re-renders in place via \\r,
 *   with a spinner frame when tasks are running. Completed
 *   / failed / skipped task results stack above the bar as they
 *   finish (homebrew style).
 * - non-TTY: prints each result as it completes; prints the bar
 *   on each percentage change so the user sees progress without
 *   spam.
 */
export function createRenderer(opts: { tty: boolean; onLine?: (line: string) => void }): Renderer {
  const { tty, onLine } = opts;
  const labels: string[] = [];
  const resultLines: string[] = []; // completed / failed / skipped results, in order

  let total = 0;
  let done = 0; // completed + failed + skipped (for bar percentage)
  let running = 0;
  let updated = 0;
  let upToDate = 0;
  let skipped = 0;
  let failed = 0;

  let lastPct = -1; // track non-TTY bar printing
  let started = false;

  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let drawn = 0;
  let stopped = false;

  const emit = (line: string) => {
    if (onLine) onLine(line);
    else process.stdout.write(line + '\n');
  };

  const paint = () => {
    if (!tty || stopped) return;

    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? ' ';
    const bar = drawBar(done, total, running, frame, started);
    const lines = [...resultLines, bar];

    if (drawn > 0) process.stdout.write(`\x1b[${drawn}A`);
    process.stdout.write('\x1b[?25l');
    for (const line of lines) {
      process.stdout.write('\r\x1b[2K' + line + '\n');
    }
    for (let i = lines.length; i < drawn; i++) {
      process.stdout.write('\r\x1b[2K\n');
    }
    drawn = lines.length;
    process.stdout.write('\x1b[?25h');
  };

  const startTimer = () => {
    if (!tty || timer) return;
    timer = setInterval(() => {
      frameIndex++;
      paint();
    }, 100);
  };

  const checkDone = () => {
    if (running <= 0 && total > 0 && done >= total) {
      stopTimer();
      if (tty) paint();
    }
  };

  return {
    add(label: string): number {
      const index = total;
      labels.push(label);
      total++;
      // Don't paint here — wait for the first update({state:'running'})
      // so the initial bar shows the correct total at once.
      return index;
    },
    update(index: number, u: TaskUpdate): void {
      if (u.state === 'running') {
        started = true;
        running++;
        startTimer();
        paint();
        return;
      }

      running = Math.max(0, running - 1);
      done++;
      const label = labels[index] ?? '?';

      let line: string;
      switch (u.state) {
        case 'success': {
          const changed = u.before !== null && u.after !== null && u.before !== u.after;
          const suffix = changed
            ? `${u.before} → ${u.after}`
            : `up to date (${u.after ?? u.before ?? '?'})`;
          line = color.green(`✔ ${label}  ${suffix}`);
          if (changed) updated++;
          else upToDate++;
          break;
        }
        case 'skipped': {
          line = color.yellow(`⏭ ${label}  skipped: ${(u.error ?? 'no update command').split('\n')[0] ?? ''}`);
          skipped++;
          break;
        }
        case 'failed': {
          line = color.red(`✖ ${label}  failed: ${(u.error ?? 'unknown').split('\n')[0] ?? ''}`);
          failed++;
          break;
        }
      }

      resultLines.push(line);

      if (tty) {
        paint();
      } else {
        emit(line);
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        if (pct !== lastPct) {
          const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? ' ';
          emit(drawBar(done, total, running, frame, started));
          lastPct = pct;
        }
      }

      checkDone();
    },
    stop(): string {
      stopped = true;
      stopTimer();
      return summaryLine(updated, upToDate, skipped, failed);
    },
  };

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
}
