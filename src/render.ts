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

/* ---------- internal task state ---------- */

export interface RenderTask {
  label: string;
  state: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  before: string | null;
  after: string | null;
  error?: string;
  /** ms since the task started running (for elapsed display). */
  elapsedMs?: number;
  /** wall-clock when the task started running. */
  startedAt?: number;
}

/** Format ms as a compact duration, e.g. 12.3s / 1m05s. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100)) / 10}s`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function taskLines(t: RenderTask, frame: string): string[] {
  const dur =
    t.elapsedMs !== undefined && t.elapsedMs > 0 ? color.dim(`  ${formatDuration(t.elapsedMs)}`) : '';
  switch (t.state) {
    case 'pending':
      return [color.dim(`${frame} ${t.label}`)];
    case 'running':
      return [color.cyan(`${frame} ${t.label}`) + dur];
    case 'success': {
      const changed = t.before !== null && t.after !== null && t.before !== t.after;
      const suffix = changed ? `${t.before} → ${t.after}` : `up to date (${t.after ?? t.before ?? '?'})`;
      return [color.green(`✔ ${t.label}  ${suffix}`) + dur];
    }
    case 'skipped': {
      const skipLines = (t.error ?? 'no update command').split('\n');
      const out = [color.yellow(`⏭ ${t.label}  skipped: ${skipLines[0] ?? ''}`)];
      for (const extra of skipLines.slice(1)) {
        out.push(color.dim('  ' + extra.trimStart()));
      }
      return out;
    }
    case 'failed': {
      const errLines = (t.error ?? 'unknown error').split('\n');
      const out = [color.red(`✖ ${t.label}  failed: ${errLines[0] ?? ''}`) + dur];
      for (const extra of errLines.slice(1, 4)) {
        out.push(color.dim('  ' + extra.trimStart()));
      }
      return out;
    }
  }
}

/* ---------- aggregate progress bar ---------- */

const BAR_WIDTH = 25;
const BAR_FILLED = '█';
const BAR_EMPTY = '░';

/**
 * Single aggregate progress bar reflecting the only real, measurable progress:
 * how many of the total agents have finished (done/total). Per-agent progress
 * is not available — each agent is one subprocess command (`npm update -g`,
 * `brew upgrade`, ...) with no reliable incremental output.
 */
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

/**
 * Build the display lines for the whole panel: every agent gets its own
 * spinner line (all installed agents are always visible), and a single
 * aggregate progress bar sits at the bottom.
 */
export function buildPanelLines(tasks: RenderTask[], frameIndex: number): string[] {
  const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? ' ';
  const taskLinesOut = tasks.flatMap((t) => taskLines(t, frame));

  const running = tasks.filter((t) => t.state === 'running').length;
  const done = tasks.filter(
    (t) => t.state === 'success' || t.state === 'failed' || t.state === 'skipped',
  ).length;
  const started = tasks.some((t) => t.state !== 'pending');

  return [...taskLinesOut, drawBar(done, tasks.length, running, frame, started)];
}

/** Compute the summary line printed once everything is done. */
export function summaryLine(tasks: RenderTask[]): string {
  const updated = tasks.filter(
    (t) => t.state === 'success' && t.before !== null && t.after !== null && t.before !== t.after,
  ).length;
  const upToDate = tasks.filter((t) => t.state === 'success').length - updated;
  const skipped = tasks.filter((t) => t.state === 'skipped').length;
  const failed = tasks.filter((t) => t.state === 'failed').length;
  return color.bold(
    `Done: ${updated} updated, ${upToDate} up to date, ${skipped} skipped, ${failed} failed.`,
  );
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
 * Multi-task spinner panel + aggregate progress bar.
 *
 * - Every installed agent is always visible as its own line with a spinner
 *   (running) or status (✔ / ⏭ / ✖). A single aggregate progress bar at the
 *   bottom shows done/total.
 * - TTY: repaints a fixed panel using ANSI cursor movement. The terminal
 *   cursor is hidden once for the whole animation and restored once at
 *   stop() — it never blinks inside the panel.
 * - non-TTY: prints each task's result as it completes (no animation).
 */
export function createRenderer(opts: { tty: boolean; onLine?: (line: string) => void }): Renderer {
  const { tty, onLine } = opts;
  const tasks: RenderTask[] = [];
  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let drawn = 0; // how many lines we currently occupy on screen
  let stopped = false;
  let cursorHidden = false;

  const emit = (line: string) => {
    if (onLine) onLine(line);
    else process.stdout.write(line + '\n');
  };

  const hideCursor = () => {
    if (!tty || cursorHidden) return;
    process.stdout.write('\x1b[?25l');
    cursorHidden = true;
  };

  const showCursor = () => {
    if (!tty || !cursorHidden) return;
    process.stdout.write('\x1b[?25h');
    cursorHidden = false;
  };

  const paint = () => {
    if (!tty || stopped) return;
    const lines = buildPanelLines(tasks, frameIndex);

    // Move the cursor up to the top of the panel we drew last time.
    if (drawn > 0) process.stdout.write(`\x1b[${drawn}A`);
    hideCursor();
    for (const line of lines) {
      process.stdout.write('\r\x1b[2K' + line + '\n');
    }
    // Clear any stale trailing lines from a previous, longer paint.
    for (let i = lines.length; i < drawn; i++) {
      process.stdout.write('\r\x1b[2K\n');
    }
    drawn = lines.length;
  };

  const startTimer = () => {
    if (!tty || timer) return;
    timer = setInterval(() => {
      frameIndex++;
      // refresh elapsed times for running tasks
      const now = Date.now();
      for (const t of tasks) {
        if (t.state === 'running' && t.startedAt !== undefined) t.elapsedMs = now - t.startedAt;
      }
      paint();
    }, 100);
  };

  return {
    add(label: string): number {
      const index = tasks.length;
      tasks.push({ label, state: 'pending', before: null, after: null, elapsedMs: 0 });
      paint();
      return index;
    },
    update(index: number, u: TaskUpdate): void {
      const t = tasks[index];
      if (!t) return;
      if (u.state === 'running') {
        t.state = 'running';
        t.elapsedMs = 0;
        t.startedAt = Date.now();
        startTimer();
        paint();
        return;
      }
      t.state = u.state;
      t.before = u.before ?? t.before;
      t.after = u.after ?? t.after;
      t.error = u.error;
      t.elapsedMs = t.startedAt !== undefined ? Date.now() - t.startedAt : 0;
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
      showCursor();
      return summaryLine(tasks);
    },
  };

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
}
