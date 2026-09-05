import { describe, it, expect } from 'vitest';
import { compareVersions, runCommand, needsStagedInstall } from '../src/update.js';

describe('runCommand', () => {
  it('reports errno ENOENT when the binary cannot be spawned', async () => {
    // .exe marks a directly-spawned binary: missing → spawn ENOENT.
    const r = await runCommand(['auway-test-no-such-binary-xyz.exe']);
    expect(r.code).toBe(1);
    expect(r.errno).toBe('ENOENT');
    expect(r.output).toContain('ENOENT');
  });

  it('reports a shell-level failure for extensionless names on Windows', async () => {
    // Extensionless names (npm/pi shims) route through the shell on win32;
    // cmd.exe fails with exit code 1, not a spawn ENOENT.
    const r = await runCommand(['auway-test-no-such-binary-xyz']);
    expect(r.code).not.toBe(0);
    expect(r.errno).toBeUndefined();
    expect(r.output.length).toBeGreaterThan(0);
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

describe('needsStagedInstall', () => {
  const mkAgent = (manager: string) =>
    ({
      def: { name: 'pi', label: 'Pi Coding Agent', nativeUpdate: [], versionCmd: ['pi', '--version'], npmPackage: '@earendil-works/pi-coding-agent' },
      binPath: '/x/pi',
      realPath: '/x/pi',
      manager,
      version: '1.0.0',
    }) as unknown as Parameters<typeof needsStagedInstall>[1];

  it('stages npm installs on win32 (locked native modules)', () => {
    expect(needsStagedInstall('win32', mkAgent('npm'))).toBe(true);
  });
  it('does not stage on posix', () => {
    expect(needsStagedInstall('darwin', mkAgent('npm'))).toBe(false);
    expect(needsStagedInstall('linux', mkAgent('npm'))).toBe(false);
  });
  it('does not stage non-npm managers on win32', () => {
    expect(needsStagedInstall('win32', mkAgent('native'))).toBe(false);
    expect(needsStagedInstall('win32', mkAgent('brew'))).toBe(false);
    expect(needsStagedInstall('win32', mkAgent('local'))).toBe(false);
  });
});
