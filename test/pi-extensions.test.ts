import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePiSource,
  repoId,
  collectPiSources,
  buildPkg,
  detectPiExtensions,
  extensionsStatusLine,
  createPiSettleGate,
  updatePiExtensions,
} from '../src/pi-extensions.js';
import { runCommand, runWithEnoentRetry } from '../src/update.js';

// Mock the subprocess runner so updatePiExtensions can be exercised without
// spawning anything. Retry semantics themselves are covered in update.test.ts
// (runWithEnoentRetry); here we assert delegation. detectPiExtensions tests
// inject their own npmView anyway.
vi.mock('../src/update.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/update.js')>();
  return { ...mod, runCommand: vi.fn(), runWithEnoentRetry: vi.fn() };
});

function tempHome(packages: string[]): { dir: string; settings: string } {
  const dir = mkdtempSync(join(tmpdir(), 'auway-ext-test-'));
  const settingsDir = join(dir, '.pi', 'agent');
  mkdirSync(join(settingsDir, 'npm', 'node_modules'), { recursive: true });
  const settings = join(settingsDir, 'settings.json');
  writeFileSync(settings, JSON.stringify({ packages }));
  return { dir, settings };
}

function writePkg(home: string, name: string, version: string): void {
  const dir = join(home, '.pi', 'agent', 'npm', 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe('parsePiSource', () => {
  it('parses plain npm packages', () => {
    expect(parsePiSource('npm:pi-subagents')).toEqual({
      type: 'npm',
      name: 'pi-subagents',
      pinned: false,
    });
  });

  it('parses scoped npm packages', () => {
    expect(parsePiSource('npm:@feniix/pi-notion')).toEqual({
      type: 'npm',
      name: '@feniix/pi-notion',
      pinned: false,
    });
  });

  it('detects pinned npm versions', () => {
    expect(parsePiSource('npm:@juicesharp/rpiv-todo@1.2.3')).toEqual({
      type: 'npm',
      name: '@juicesharp/rpiv-todo',
      pinned: true,
    });
    expect(parsePiSource('npm:pkg@1.0.0')?.pinned).toBe(true);
  });

  it('parses git sources with scp-like ssh urls', () => {
    const r = parsePiSource('git:git@gitee.com:Onelap/pi-agent-dispenser.git@master');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('git');
    expect(r!.name).toBe('gitee.com/Onelap/pi-agent-dispenser');
    expect(r!.pinned).toBe(true);
  });

  it('parses git sources without ref (not pinned)', () => {
    const r = parsePiSource('git:github.com/user/repo');
    expect(r!.type).toBe('git');
    expect(r!.name).toBe('github.com/user/repo');
    expect(r!.pinned).toBe(false);
  });

  it('parses https and ssh git urls', () => {
    expect(parsePiSource('https://github.com/user/repo@v1.0.0')!.pinned).toBe(true);
    const ssh = parsePiSource('ssh://git@github.com/user/repo');
    expect(ssh!.type).toBe('git');
    expect(ssh!.name).toBe('github.com/user/repo');
    expect(ssh!.pinned).toBe(false);
  });

  it('parses local paths', () => {
    expect(parsePiSource('/abs/path/to/pkg')!.type).toBe('local');
    expect(parsePiSource('./rel/path')!.type).toBe('local');
  });
});

describe('repoId', () => {
  it('normalizes scp-like and protocol urls', () => {
    expect(repoId('git@github.com:user/repo')).toEqual({ host: 'github.com', path: 'user/repo' });
    expect(repoId('https://github.com/user/repo.git')).toEqual({
      host: 'github.com',
      path: 'user/repo',
    });
    expect(repoId('ssh://git@gitee.com/Onelap/x.git')).toEqual({
      host: 'gitee.com',
      path: 'Onelap/x',
    });
  });
});

describe('collectPiSources', () => {
  it('reads global settings packages and dedupes', () => {
    const { dir, settings } = tempHome(['npm:pi-subagents', 'npm:pi-web-access']);
    // project settings adds one more and duplicates a global one
    mkdirSync(join(dir, '.pi'), { recursive: true });
    writeFileSync(
      join(dir, '.pi', 'settings.json'),
      JSON.stringify({ packages: ['npm:pi-subagents', 'npm:pi-tps-meter'] }),
    );
    const sources = collectPiSources(dir, dir);
    expect(sources.map((s) => s.source)).toEqual([
      'npm:pi-subagents',
      'npm:pi-web-access',
      'npm:pi-tps-meter',
    ]);
    expect(sources[0]!.base).toBe(join(dir, '.pi', 'agent'));
    expect(sources[2]!.base).toBe(join(dir, '.pi'));
    rmSync(settings);
    cleanup(dir);
  });

  it('returns empty when no settings file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auway-ext-test-'));
    expect(collectPiSources(dir, dir)).toEqual([]);
    cleanup(dir);
  });
});

describe('buildPkg', () => {
  it('reads installed npm version from disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'auway-ext-test-'));
    writePkg(home, '@feniix/pi-notion', '3.0.2');
    const pkg = buildPkg('npm:@feniix/pi-notion', join(home, '.pi', 'agent'));
    expect(pkg.type).toBe('npm');
    expect(pkg.installed).toBe('3.0.2');
    expect(pkg.path).toBe(join(home, '.pi', 'agent', 'npm', 'node_modules', '@feniix', 'pi-notion'));
    cleanup(home);
  });

  it('derives git clone dir and returns null rev when not cloned', () => {
    const home = mkdtempSync(join(tmpdir(), 'auway-ext-test-'));
    const pkg = buildPkg(
      'git:git@gitee.com:Onelap/pi-agent-dispenser.git@master',
      join(home, '.pi', 'agent'),
    );
    expect(pkg.type).toBe('git');
    expect(pkg.name).toBe('gitee.com/Onelap/pi-agent-dispenser');
    expect(pkg.installed).toBeNull();
    expect(pkg.path).toBe(
      join(home, '.pi', 'agent', 'git', 'gitee.com', 'Onelap', 'pi-agent-dispenser'),
    );
    cleanup(home);
  });
});

describe('detectPiExtensions', () => {
  it('flags outdated npm packages, respects pinned, counts types', async () => {
    const home = mkdtempSync(join(tmpdir(), 'auway-ext-test-'));
    const settings = join(home, '.pi', 'agent', 'settings.json');
    mkdirSync(join(home, '.pi', 'agent', 'npm', 'node_modules'), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        packages: [
          'npm:pi-subagents', // 0.50.0 installed, 0.51.0 latest → outdated
          'npm:@feniix/pi-notion', // 3.0.2 = latest → ok
          'npm:@juicesharp/rpiv-todo@2.6.1', // pinned, 2.7.0 latest → skipped
          'git:git@gitee.com:Onelap/pi-agent-dispenser.git@master', // git → never outdated here
        ],
      }),
    );
    writePkg(home, 'pi-subagents', '0.50.0');
    writePkg(home, '@feniix/pi-notion', '3.0.2');
    writePkg(home, '@juicesharp/rpiv-todo', '2.6.1');

    const latest: Record<string, string> = {
      'pi-subagents': '0.51.0',
      '@feniix/pi-notion': '3.0.2',
      '@juicesharp/rpiv-todo': '2.7.0',
    };
    const info = await detectPiExtensions({
      home,
      cwd: home,
      npmView: async (pkg) => latest[pkg] ?? null,
    });

    expect(info.total).toBe(4);
    expect(info.npmCount).toBe(3);
    expect(info.gitCount).toBe(1);
    expect(info.outdated).toEqual(['pi-subagents']);
    expect(info.outdatedCount).toBe(1);
    expect(info.summary).toBe('4 packages · 1 update available');
    expect(info.packages.find((p) => p.name === 'pi-subagents')!.outdated).toBe(true);
    expect(info.packages.find((p) => p.name === '@juicesharp/rpiv-todo')!.outdated).toBe(false);
    expect(info.packages.find((p) => p.name === 'pi-subagents')!.latest).toBe('0.51.0');

    cleanup(home);
  });

  it('returns empty info when no packages configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'auway-ext-test-'));
    const info = await detectPiExtensions({ home, cwd: home });
    expect(info.enabled).toBe(false);
    expect(info.total).toBe(0);
    expect(info.summary).toBe('no pi extensions installed');
    cleanup(home);
  });
});

describe('createPiSettleGate', () => {
  it('stays locked on running events, releases on the first terminal event for pi', async () => {
    const gate = createPiSettleGate(true);
    let released = false;
    void gate.settled.then(() => {
      released = true;
    });
    gate.observe(0, 'pi', { state: 'running', before: '0.84.1' });
    await Promise.resolve();
    expect(released).toBe(false);
    gate.observe(0, 'pi', { state: 'success', before: '0.84.2', after: '0.84.2' });
    await gate.settled;
    expect(released).toBe(true);
  });

  it('ignores progress from other agents', async () => {
    const gate = createPiSettleGate(true);
    let released = false;
    void gate.settled.then(() => {
      released = true;
    });
    gate.observe(0, 'claude', { state: 'failed', error: 'boom' });
    gate.observe(1, 'codex', { state: 'success', before: '1.0', after: '1.1' });
    await Promise.resolve();
    expect(released).toBe(false);
  });

  it('resolves immediately when pi is not installed', async () => {
    const gate = createPiSettleGate(false);
    await gate.settled; // must not hang
    expect(true).toBe(true);
  });

  it('releases only once; late terminal events are ignored', async () => {
    const gate = createPiSettleGate(true);
    gate.observe(0, 'pi', { state: 'skipped', error: 'project-local' });
    await gate.settled;
    // a second terminal event after release must be a no-op (no throw)
    gate.observe(0, 'pi', { state: 'failed', error: 'late' });
    expect(true).toBe(true);
  });
});

describe('updatePiExtensions', () => {
  beforeEach(() => {
    vi.mocked(runWithEnoentRetry).mockReset();
  });

  it('delegates to runWithEnoentRetry with pi update --extensions', async () => {
    vi.mocked(runWithEnoentRetry).mockResolvedValue({
      code: 0,
      output: 'all extensions up to date',
    });
    const r = await updatePiExtensions({ retries: 3, retryDelayMs: 1 });
    expect(r.code).toBe(0);
    expect(vi.mocked(runWithEnoentRetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runWithEnoentRetry).mock.calls[0]![0]).toEqual([
      'pi',
      'update',
      '--extensions',
    ]);
    expect(vi.mocked(runWithEnoentRetry).mock.calls[0]![1]).toMatchObject({
      retries: 3,
      retryDelayMs: 1,
    });
  });

  it('propagates failures from the retry runner', async () => {
    vi.mocked(runWithEnoentRetry).mockResolvedValue({
      code: 1,
      output: 'spawn pi ENOENT',
    });
    const r = await updatePiExtensions({ retries: 2, retryDelayMs: 1 });
    expect(r.code).toBe(1);
    expect(r.output).toContain('ENOENT');
  });
});

describe('extensionsStatusLine', () => {
  it('formats one-line status', async () => {
    const home = mkdtempSync(join(tmpdir(), 'auway-ext-test-'));
    const settings = join(home, '.pi', 'agent', 'settings.json');
    mkdirSync(join(home, '.pi', 'agent', 'npm', 'node_modules'), { recursive: true });
    writeFileSync(settings, JSON.stringify({ packages: ['npm:pi-subagents'] }));
    writePkg(home, 'pi-subagents', '0.50.0');
    const info = await detectPiExtensions({
      home,
      cwd: home,
      npmView: async () => '0.51.0',
    });
    expect(extensionsStatusLine(info)).toBe('1 package · 1 outdated');
    cleanup(home);
  });
});
