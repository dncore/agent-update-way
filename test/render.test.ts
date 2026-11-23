import { describe, it, expect } from 'vitest';
import { buildPanelLines, summaryLine, formatDuration, createRenderer } from '../src/render.js';
import type { RenderTask } from '../src/render.js';

// buildPanelLines / taskLines are pure; strip ANSI codes before asserting.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

type TaskState = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

function task(partial: {
  label: string;
  state: TaskState;
  before?: string | null;
  after?: string | null;
  error?: string;
  elapsedMs?: number;
  silent?: boolean;
}): RenderTask {
  return {
    label: partial.label,
    state: partial.state,
    before: partial.before ?? null,
    after: partial.after ?? null,
    error: partial.error,
    elapsedMs: partial.elapsedMs,
    silent: partial.silent,
  };
}

describe('formatDuration', () => {
  it('formats sub-second and second durations', () => {
    expect(formatDuration(500)).toBe('0.5s');
    expect(formatDuration(12300)).toBe('12.3s');
    expect(formatDuration(45000)).toBe('45s');
    expect(formatDuration(65_000)).toBe('1m05s');
  });
});

describe('buildPanelLines', () => {
  it('renders running tasks with spinner frame and elapsed time', () => {
    const lines = buildPanelLines(
      [task({ label: 'Pi Coding Agent', state: 'running', elapsedMs: 12_300 })],
      0,
    );
    expect(stripAnsi(lines[0]!)).toBe('⠋ Pi Coding Agent  12.3s');
  });

  it('renders updated tasks with version diff and duration', () => {
    const lines = buildPanelLines(
      [task({ label: 'Claude Code', state: 'success', before: '2.1.227', after: '2.1.228', elapsedMs: 3_200 })],
      0,
    );
    expect(stripAnsi(lines[0]!)).toBe('✔ Claude Code  2.1.227 → 2.1.228  3.2s');
  });

  it('renders up-to-date tasks', () => {
    const lines = buildPanelLines(
      [task({ label: 'Pi', state: 'success', before: '0.84.1', after: '0.84.1' })],
      0,
    );
    expect(stripAnsi(lines[0]!)).toBe('✔ Pi  up to date (0.84.1)');
  });

  it('renders skipped tasks with reason', () => {
    const lines = buildPanelLines(
      [task({ label: 'Pi', state: 'skipped', error: 'project-local install' })],
      0,
    );
    expect(stripAnsi(lines[0]!)).toBe('⏭ Pi  skipped: project-local install');
  });

  it('appends an aggregate progress bar as the last line', () => {
    const lines = buildPanelLines(
      [
        task({ label: 'A', state: 'running' }),
        task({ label: 'B', state: 'success', before: '1', after: '2' }),
        task({ label: 'C', state: 'pending' }),
      ],
      0,
    );
    const bar = stripAnsi(lines[lines.length - 1]!);
    expect(bar).toMatch(/^\[[░█]{25}\] \d+% \(\d+\/\d+\)/);
    expect(bar).toContain('(1/3)'); // B is done
  });

  it('renders no row for a silent (nothing installed) task', () => {
    const lines = buildPanelLines(
      [
        task({ label: 'Grok Plugins', state: 'skipped', error: 'no grok plugins installed', silent: true }),
        task({ label: 'Claude Code', state: 'success', before: '1', after: '1' }),
      ],
      0,
    );
    expect(lines.some((l) => stripAnsi(l).includes('Grok Plugins'))).toBe(false);
    // still counts toward the progress bar: it is a finished task
    expect(stripAnsi(lines[lines.length - 1]!)).toContain('(2/2)');
  });

  it('shows a full bar with done when all tasks are terminal', () => {
    const lines = buildPanelLines(
      [
        task({ label: 'A', state: 'success', before: '1', after: '2' }),
        task({ label: 'B', state: 'skipped' }),
      ],
      0,
    );
    const bar = stripAnsi(lines[lines.length - 1]!);
    expect(bar).toContain('100% (2/2)');
    expect(bar).toContain('done');
  });
});

describe('summaryLine', () => {
  it('summarizes final counts', () => {
    const s = stripAnsi(
      summaryLine([
        task({ label: 'A', state: 'success', before: '1', after: '2' }),
        task({ label: 'B', state: 'success', before: '1', after: '1' }),
        task({ label: 'C', state: 'skipped' }),
        task({ label: 'D', state: 'failed' }),
      ]),
    );
    expect(s).toBe('Done: 1 updated, 1 up to date, 1 skipped, 1 failed.');
  });

  it('excludes silent tasks from every count', () => {
    const s = stripAnsi(
      summaryLine([
        task({ label: 'A', state: 'success', before: '1', after: '2' }),
        task({ label: 'Grok Plugins', state: 'skipped', silent: true }),
      ]),
    );
    expect(s).toBe('Done: 1 updated, 0 up to date, 0 skipped, 0 failed.');
  });
});

describe('createRenderer (non-TTY)', () => {
  it('emits a result line as each task completes', () => {
    const emitted: string[] = [];
    const renderer = createRenderer({
      tty: false,
      onLine: (line) => emitted.push(stripAnsi(line)),
    });

    renderer.add('A');
    renderer.add('B');

    renderer.update(0, { state: 'running', before: '1.0' });
    renderer.update(1, { state: 'running', before: '2.0' });

    renderer.update(0, { state: 'success', before: '1.0', after: '1.0' });
    renderer.update(1, { state: 'success', before: '2.0', after: '2.1' });

    const summary = stripAnsi(renderer.stop());

    const results = emitted.filter((l) => l.startsWith('✔'));
    expect(results).toHaveLength(2);
    expect(results[0]).toContain('✔ A');
    expect(results[1]).toContain('✔ B  2.0 → 2.1');
    expect(summary).toBe('Done: 1 updated, 1 up to date, 0 skipped, 0 failed.');
  });

  it('prints nothing for a silent task', () => {
    const emitted: string[] = [];
    const renderer = createRenderer({ tty: false, onLine: (line) => emitted.push(stripAnsi(line)) });
    renderer.add('Grok Plugins');
    renderer.update(0, { state: 'skipped', error: 'no grok plugins installed', silent: true });
    const summary = stripAnsi(renderer.stop());
    expect(emitted).toEqual([]);
    expect(summary).toBe('Done: 0 updated, 0 up to date, 0 skipped, 0 failed.');
  });
});
