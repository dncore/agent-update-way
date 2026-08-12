import { describe, it, expect } from 'vitest';
import { summaryLine } from '../src/render.js';

// drawBar is private; we test its contract indirectly via createRenderer.
// summaryLine is the only public pure function worth unit-testing.

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('summaryLine', () => {
  it('summarises final counts', () => {
    const s = stripAnsi(summaryLine(1, 1, 1, 1));
    expect(s).toBe('Done: 1 updated, 1 up to date, 1 skipped, 1 failed.');
  });

  it('handles zeros', () => {
    const s = stripAnsi(summaryLine(0, 0, 0, 0));
    expect(s).toBe('Done: 0 updated, 0 up to date, 0 skipped, 0 failed.');
  });

  it('only updated', () => {
    const s = stripAnsi(summaryLine(3, 0, 0, 0));
    expect(s).toBe('Done: 3 updated, 0 up to date, 0 skipped, 0 failed.');
  });

  it('only failed', () => {
    const s = stripAnsi(summaryLine(0, 0, 0, 2));
    expect(s).toBe('Done: 0 updated, 0 up to date, 0 skipped, 2 failed.');
  });
});

// Integration-style test for the Renderer (createRenderer + drawBar logic).
//
// We test the public Renderer interface (add / update / stop) because drawBar
// is a private helper.  This also validates the progress-bar state machine:
//   ... (not started) → ⠋ N running → percentage fills → done
//
// In non-TTY mode the renderer emits lines via `onLine`; we capture those
// and assert the sequence.

import { createRenderer } from '../src/render.js';

describe('createRenderer (non-TTY)', () => {
  function collectLines(onLine: (line: string) => void): string[] {
    const lines: string[] = [];
    const renderer = createRenderer({ tty: false, onLine: (l) => { lines.push(l); onLine(l); } });

    // wrap so we can capture *and* check on-the-fly
    return lines;
  }

  it('emits result lines as tasks complete and bar on percentage change', () => {
    const emitted: string[] = [];
    const renderer = createRenderer({
      tty: false,
      onLine: (line) => emitted.push(stripAnsi(line)),
    });

    renderer.add('A');
    renderer.add('B');
    renderer.add('C');

    // start all
    renderer.update(0, { state: 'running', before: '1.0' });
    renderer.update(1, { state: 'running', before: '2.0' });
    renderer.update(2, { state: 'running', before: '3.0' });

    // complete A (33%)
    renderer.update(0, { state: 'success', before: '1.0', after: '1.0' });
    // complete B (67% — percentage changed)
    renderer.update(1, { state: 'success', before: '2.0', after: '2.1' });
    // complete C (100%)
    renderer.update(2, { state: 'failed', error: 'boom' });

    const summary = stripAnsi(renderer.stop());

    // Expected: result lines printed on completion, bar when percentage changes
    expect(emitted.length).toBeGreaterThanOrEqual(4); // 3 results + at least 1 bar

    const resultLines = emitted.filter((l) => l.startsWith('✔') || l.startsWith('✖') || l.startsWith('⏭'));
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
    const summary = stripAnsi(renderer.stop());
    expect(summary).toBe('Done: 0 updated, 0 up to date, 0 skipped, 0 failed.');
  });
});
