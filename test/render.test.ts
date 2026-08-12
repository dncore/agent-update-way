import { describe, it, expect } from 'vitest';
import { summaryLine, createRenderer } from '../src/render.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('summaryLine', () => {
  it('summarises final counts', () => {
    expect(stripAnsi(summaryLine(1, 1, 1, 1))).toBe(
      'Done: 1 updated, 1 up to date, 1 skipped, 1 failed.',
    );
  });

  it('handles zeros', () => {
    expect(stripAnsi(summaryLine(0, 0, 0, 0))).toBe(
      'Done: 0 updated, 0 up to date, 0 skipped, 0 failed.',
    );
  });
});

describe('createRenderer (non-TTY)', () => {
  it('emits result lines as tasks complete and bar on percentage change', () => {
    const emitted: string[] = [];
    const renderer = createRenderer({
      tty: false,
      onLine: (line) => emitted.push(stripAnsi(line)),
    });

    renderer.add('A');
    renderer.add('B');
    renderer.add('C');

    renderer.update(0, { state: 'running', before: '1.0' });
    renderer.update(1, { state: 'running', before: '2.0' });
    renderer.update(2, { state: 'running', before: '3.0' });

    renderer.update(0, { state: 'success', before: '1.0', after: '1.0' }); // 33%
    renderer.update(1, { state: 'success', before: '2.0', after: '2.1' }); // 67%
    renderer.update(2, { state: 'failed', error: 'boom' }); // 100%

    const summary = stripAnsi(renderer.stop());

    const resultLines = emitted.filter((l) => l.startsWith('✔') || l.startsWith('✖'));
    expect(resultLines).toHaveLength(3);
    expect(resultLines[0]).toContain('✔ A');
    expect(resultLines[1]).toContain('✔ B  2.0 → 2.1');
    expect(resultLines[2]).toContain('✖ C');

    const barLines = emitted.filter((l) => l.startsWith('['));
    expect(barLines.length).toBeGreaterThanOrEqual(2); // at 33% and 67%

    expect(summary).toBe('Done: 1 updated, 1 up to date, 0 skipped, 1 failed.');
  });

  it('handles all-skipped tasks', () => {
    const emitted: string[] = [];
    const renderer = createRenderer({
      tty: false,
      onLine: (line) => emitted.push(stripAnsi(line)),
    });

    renderer.add('A');
    renderer.add('B');

    renderer.update(0, { state: 'skipped', error: 'local install' });
    renderer.update(1, { state: 'skipped', error: 'no command' });

    const summary = stripAnsi(renderer.stop());

    expect(emitted.filter((l) => l.startsWith('⏭'))).toHaveLength(2);
    expect(summary).toBe('Done: 0 updated, 0 up to date, 2 skipped, 0 failed.');
  });

  it('stops correctly with empty task list', () => {
    const renderer = createRenderer({ tty: false });
    expect(stripAnsi(renderer.stop())).toBe(
      'Done: 0 updated, 0 up to date, 0 skipped, 0 failed.',
    );
  });
});
