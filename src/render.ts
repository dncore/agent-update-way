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

/* ---------- internal task state ---------- */

interface RenderTask {
  label: string;
  state: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  before: string | null;
  after: string | null;
  error?: string;
}

function taskLines(t: RenderTask, frame: string): string[] {
  switch (t.state) {
    case 'pending':
      return [color.dim(`${frame} ${t.label}`)];
    case 'running':
      return [color.cyan(`${frame} ${t.label}`)];
    case 'success': {
      const changed = t.before !== null && t.after !== null && t.before !== t.after;
      const suffix = changed ? `${t.before} → ${t.after}` : `up to date (${t.after ?? t.before ?? '?'})`;
      return [color.green(`✔ ${t.label}  ${suffix}`)];
    }
    case 'skipped':
      return [color.yellow(`⏭ ${t.label}  skipped: ${t.error ?? 'no update command'}`)];
    case 'failed': {
      const errLines = (t.error ?? 'unknown error').split('\n');
      const out = [color.red(`✖ ${t.label}  failed: ${errLines[0] ?? ''}`)];
      for (const extra of errLines.slice(1, 4)) {
        out.push(color.dim('  ' + extra.trimStart()));
      }
      return out;
    }
  }
}

/** Build the display lines for a list of tasks (pure, testable). */
export function buildTaskLines(tasks: RenderTask[], frame: string): string[] {
  return tasks.flatMap((t) => taskLines(t, frame));
}

/* ---------- renderer ---------- */

export interface Renderer {
  /** Register a task (in display order). */
  add(label: string): number;
  /** Update a task's state and repaint. */
  update(index: number, u: TaskUpdate): void;
  /** Finish: stop animation, restore cursor, return summary line. */
  stop(): string;
}

/**
 * Multi-task progress renderer, in the style of listr2 / pnpm / turborepo:
 * every concurrent task gets its own live-updating line, completed tasks show
 * their result inline, failures expand their error below the line.
 *
 * - TTY: repaints a fixed panel using ANSI cursor movement + spinner frames.
 * - non-TTY: prints each task's result as it completes (no animation).
 */
export function createRenderer(opts: { tty: boolean; onLine?: (line: string) => void }): Renderer {
  const { tty, onLine } = opts;
  const tasks: RenderTask[] = [];
  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let drawn = 0; // how many lines we currently occupy on screen
  let stopped = false;

  const emit = (line: string) => {
    if (onLine) onLine(line);
    else process.stdout.write(line + '\n');
  };

  const paint = () => {
    if (!tty || stopped) return;
    const lines = buildTaskLines(tasks, SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? ' ');
    if (!lines.length) return;

    // Move cursor up to the first task line we drew, clearing as we go.
    if (drawn > 0) process.stdout.write(`\x1b[${drawn}A`);
    process.stdout.write('\x1b[?25l');
    for (const line of lines) {
      process.stdout.write('\r\x1b[2K' + line + '\n');
    }
    // Clear any stale trailing lines from a previous, longer paint.
    for (let i = lines.length; i < drawn; i++) {
      process.stdout.write('\r\x1b[2K\n');
    }
    drawn = lines.length;
    // Cursor is now below the panel; move back up to the top of the panel.
    process.stdout.write(`\x1b[${drawn}A`);
    process.stdout.write('\x1b[?25h');
  };

  const startTimer = () => {
    if (!tty || timer) return;
    timer = setInterval(() => {
      frameIndex++;
      paint();
    }, 80);
  };

  return {
    add(label: string): number {
      const index = tasks.length;
      tasks.push({ label, state: 'pending', before: null, after: null });
      paint();
      return index;
    },
    update(index: number, u: TaskUpdate): void {
      const t = tasks[index];
      if (!t) return;
      if (u.state === 'running') {
        t.state = 'running';
        startTimer();
        paint();
        return;
      }
      t.state = u.state;
      t.before = u.before ?? t.before;
      t.after = u.after ?? t.after;
      t.error = u.error;
      if (tty) {
        paint();
      } else {
        // non-TTY: print the final line for this task immediately
        for (const line of taskLines(t, ' ')) emit(line);
      }
      // if all tasks are terminal, stop the spinner
      if (tasks.every((x) => x.state !== 'pending' && x.state !== 'running')) {
        stopTimer();
      }
    },
    stop(): string {
      stopped = true;
      stopTimer();
      if (tty && drawn > 0) {
        // Move down past the panel so subsequent output starts on a fresh line.
        process.stdout.write(`\x1b[${drawn}B`);
      }
      const updated = tasks.filter((t) => t.state === 'success' && t.before !== null && t.after !== null && t.before !== t.after).length;
      const upToDate = tasks.filter((t) => t.state === 'success').length - updated;
      const skipped = tasks.filter((t) => t.state === 'skipped').length;
      const failed = tasks.filter((t) => t.state === 'failed').length;
      return color.bold(
        `Done: ${updated} updated, ${upToDate} up to date, ${skipped} skipped, ${failed} failed.`,
      );
    },
  };

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
}
