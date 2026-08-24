import { describe, it, expect } from 'vitest';
import { compareVersions, runCommand } from '../src/update.js';

describe('runCommand', () => {
  it('reports errno ENOENT when the binary cannot be spawned', async () => {
    const r = await runCommand(['auway-test-no-such-binary-xyz']);
    expect(r.code).toBe(1);
    expect(r.errno).toBe('ENOENT');
    expect(r.output).toContain('ENOENT');
  });

  it('leaves errno undefined for a successful run', async () => {
    const r = await runCommand(['node', '-e', 'process.exit(0)']);
    expect(r.code).toBe(0);
    expect(r.errno).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('compares equal versions', () => {
    expect(compareVersions('17.2.15', '17.2.15')).toBe(0);
  });

  it('compares patch bumps', () => {
    expect(compareVersions('17.2.15', '17.2.16')).toBe(-1);
    expect(compareVersions('17.2.16', '17.2.15')).toBe(1);
  });

  it('compares minor and major bumps', () => {
    expect(compareVersions('17.2.15', '17.3.0')).toBe(-1);
    expect(compareVersions('17.2.15', '18.0.0')).toBe(-1);
    expect(compareVersions('18.0.0', '17.99.99')).toBe(1);
  });

  it('handles missing segments as zero (1.0 vs 1.0.0)', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0')).toBe(1);
  });
});
