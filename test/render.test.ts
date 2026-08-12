import { describe, it, expect } from 'vitest';
import { buildPanelLines, summaryLine, formatDuration } from '../src/render.js';
import type { RenderTask } from '../src/render.js';

// buildPanelLines is pure; strip ANSI codes before asserting.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

type TaskState = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

function task(partial: {
  label: string;
  state: TaskState;
  before?: string | null;
  after?: string | null;
  error?: string;
  elapsedMs?: number;
}): RenderTask {
  return {
    label: partial.label,
    state: partial.state,
    before: partial.before ?? null,
    after: partial.after ?? null,
    error: partial.error,
    elapsedMs: partial.elapsedMs,
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
      '⠹',
    );
    expect(stripAnsi(lines[0]!)).toBe('⠹ Pi Coding Agent  12.3s');
  });

  it('renders updated tasks with version diff and duration', () => {
    const lines = buildPanelLines(
      [task({ label: 'Claude Code', state: 'success', before: '2.1.227', after: '2.1.228', elapsedMs: 3_200 })],
      ' ',
    );
    expect(stripAnsi(lines[0]!)).toBe('✔ Claude Code  2.1.227 → 2.1.228  3.2s');
  });

  it('renders up-to-date tasks', () => {
    const lines = buildPanelLines(
      [task({ label: 'Pi', state: 'success', before: '0.84.1', after: '0.84.1' })],
      ' ',
    );
    expect(stripAnsi(lines[0]!)).toBe('✔ Pi  up to date (0.84.1)');
  });

  it('renders skipped tasks with reason', () => {
    const lines = buildPanelLines(
      [task({ label: 'Pi', state: 'skipped', error: 'project-local install' })],
      ' ',
    );
    expect(stripAnsi(lines[0]!)).toBe('⏭ Pi  skipped: project-local install');
  });

  it('expands multi-line skip reasons below the line', () => {
    const lines = buildPanelLines(
      [
        task({
          label: 'Oh My Pi',
          state: 'skipped',
          error: 'user-level install under ~/node_modules\nTo update manually: bun add -g @oh-my-pi/pi-coding-agent',
        }),
      ],
      ' ',
    );
    expect(stripAnsi(lines[0]!)).toBe('⏭ Oh My Pi  skipped: user-level install under ~/node_modules');
    expect(stripAnsi(lines[1]!)).toBe('  To update manually: bun add -g @oh-my-pi/pi-coding-agent');
  });

  it('renders failed tasks and expands error lines below', () => {
    const lines = buildPanelLines(
      [
        task({
          label: 'OpenCode',
          state: 'failed',
          error: 'boom: something broke\n  at line 2\n  at line 3',
        }),
      ],
      ' ',
    );
    expect(stripAnsi(lines[0]!)).toBe('✖ OpenCode  failed: boom: something broke');
    expect(stripAnsi(lines[1]!)).toBe('  at line 2');
    expect(stripAnsi(lines[2]!)).toBe('  at line 3');
  });

  it('paints multiple tasks as independent lines', () => {
    const lines = buildPanelLines(
      [
        task({ label: 'A', state: 'running' }),
        task({ label: 'B', state: 'success', before: '1', after: '2' }),
        task({ label: 'C', state: 'pending' }),
      ],
      '⠋',
    );
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(stripAnsi(lines[0]!)).toBe('⠋ A');
    expect(stripAnsi(lines[1]!)).toContain('✔ B  1 → 2');
    expect(stripAnsi(lines[2]!)).toContain('C');
  });

  it('appends a sticky footer while tasks are running', () => {
    const lines = buildPanelLines(
      [
        task({ label: 'A', state: 'running' }),
        task({ label: 'B', state: 'success', before: '1', after: '2' }),
        task({ label: 'C', state: 'skipped' }),
        task({ label: 'D', state: 'failed' }),
      ],
      '⠙',
    );
    const footer = stripAnsi(lines[lines.length - 1]!);
    expect(footer).toContain('⠙ 1 running');
    expect(footer).toContain('✔ 1');
    expect(footer).toContain('⏭ 1');
    expect(footer).toContain('✖ 1');
  });

  it('omits the footer once all tasks are terminal', () => {
    const lines = buildPanelLines(
      [
        task({ label: 'A', state: 'success', before: '1', after: '1' }),
        task({ label: 'B', state: 'skipped' }),
      ],
      ' ',
    );
    expect(lines.length).toBe(2); // no footer line
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
});
