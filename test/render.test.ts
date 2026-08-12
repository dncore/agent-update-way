import { describe, it, expect } from 'vitest';
import { buildTaskLines } from '../src/render.js';

// buildTaskLines is pure; strip ANSI codes before asserting.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

type TaskState = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

function task(partial: {
  label: string;
  state: TaskState;
  before?: string | null;
  after?: string | null;
  error?: string;
}) {
  return {
    label: partial.label,
    state: partial.state,
    before: partial.before ?? null,
    after: partial.after ?? null,
    error: partial.error,
  };
}

describe('buildTaskLines', () => {
  it('renders running tasks with a spinner frame', () => {
    const lines = buildTaskLines([task({ label: 'Pi Coding Agent', state: 'running' })], '⠹');
    expect(stripAnsi(lines[0]!)).toBe('⠹ Pi Coding Agent');
  });

  it('renders updated tasks with version diff', () => {
    const lines = buildTaskLines(
      [task({ label: 'Claude Code', state: 'success', before: '2.1.227', after: '2.1.228' })],
      ' ',
    );
    expect(stripAnsi(lines[0]!)).toBe('✔ Claude Code  2.1.227 → 2.1.228');
  });

  it('renders up-to-date tasks', () => {
    const lines = buildTaskLines(
      [task({ label: 'Pi', state: 'success', before: '0.84.1', after: '0.84.1' })],
      ' ',
    );
    expect(stripAnsi(lines[0]!)).toBe('✔ Pi  up to date (0.84.1)');
  });

  it('renders skipped tasks with reason', () => {
    const lines = buildTaskLines(
      [task({ label: 'Pi', state: 'skipped', error: 'project-local install' })],
      ' ',
    );
    expect(stripAnsi(lines[0]!)).toBe('⏭ Pi  skipped: project-local install');
  });

  it('renders failed tasks and expands error lines below', () => {
    const lines = buildTaskLines(
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
    const lines = buildTaskLines(
      [
        task({ label: 'A', state: 'running' }),
        task({ label: 'B', state: 'success', before: '1', after: '2' }),
        task({ label: 'C', state: 'pending' }),
      ],
      '⠋',
    );
    expect(lines.length).toBe(3);
    expect(stripAnsi(lines[0]!)).toBe('⠋ A');
    expect(stripAnsi(lines[1]!)).toBe('✔ B  1 → 2');
    expect(stripAnsi(lines[2]!)).toContain('C');
  });
});
