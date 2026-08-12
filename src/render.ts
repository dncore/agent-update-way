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
    case 'skipped':
      return [color.yellow(`⏭ ${t.label}  skipped: ${t.error ?? 'no update command'}`)];
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

/** Build the display lines for the whole panel, including the sticky footer. */
export function buildPanelLines(tasks: RenderTask[], frame: string): string[] {
  const taskLinesOut = tasks.flatMap((t) => taskLines(t, frame));

  const running = tasks.filter((t) => t.state === 'running').length;
  const pending = tasks.filter((t) => t.state === 'pending').length;
  const updated = tasks.filter(
    (t) => t.state === 'success' && t.before !== null && t.after !== null && t.before !== t.after,
  ).length;
  const upToDate = tasks.filter((t) => t.state === 'success').length - updated;
  const skipped = tasks.filter((t) => t.state === 'skipped').length;
  const failed = tasks.filter((t) => t.state === 'failed').length;

  const anyRunning = running + pending > 0;
  if (!anyRunning) return taskLinesOut; // all terminal: no footer needed

  const parts: string[] = [];
  if (running > 0) parts.push(color.cyan(`${frame} ${running} running`));
  if (pending > 0) parts.push(color.dim(`${pending} queued`));
  if (updated > 0) parts.push(color.green(`✔ ${updated}`));
  if (upToDate > 0) parts.push(color.green(`✔ ${upToDate} up to date`));
  if (skipped > 0) parts.push(color.yellow(`⏭ ${skipped}`));
  if (failed > 0) parts.push(color.red(`✖ ${failed}`));
  const line = '  ' + parts.join(' · ');
  return [...taskLinesOut, line];
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
 * Modern multi-task progress panel (turborepo / pnpm style):
 * every concurrent task gets its own live-updating line with elapsed time,
 * and a sticky summary footer shows the overall progress while any task runs.
 *
 * - TTY: repaints a fixed panel using ANSI cursor movement + spinner frames.
 *   Cursor discipline: after each paint the cursor sits BELOW the panel, so
 *   the next paint moves up exactly `drawn` lines and rewrites in place.
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
    const lines = buildPanelLines(tasks, SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? ' ');

    // Move the cursor up to the top of the panel we drew last time.
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
    // Cursor now sits below the panel; leave it there for the next paint.
    process.stdout.write('\x1b[?25h');
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
      // Cursor already sits below the panel; nothing to clean up.
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
