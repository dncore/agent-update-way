import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  runCommand,
  needsStagedInstall,
  runWithEnoentRetry,
  createSettleGate,
  updateAgents,
  versionFromGithubReleaseJson,
  nativeFallbackCommand,
} from '../src/update.js';
import type { AgentDef, DetectedAgent } from '../src/types.js';

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
    // cmd.exe fails with exit code 1, not a spawn ENOENT. On POSIX an
    // extensionless name direct-spawns, so this is a win32-only behavior.
    if (process.platform !== 'win32') return;
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

describe('runWithEnoentRetry', () => {
  // Real spawn ENOENT — no mock needed; retries are bounded and delays 1ms.
  // (.exe-suffixed names direct-spawn on every platform; extensionless names
  // route through the shell on win32 and fail without an errno.)
  it('gives up once retries are exhausted on persistent ENOENT', async () => {
    const r = await runWithEnoentRetry(['auway-test-no-such-binary-xyz.exe'], {
      retries: 2,
      retryDelayMs: 1,
    });
    expect(r.code).toBe(1);
    expect(r.errno).toBe('ENOENT');
  });

  it('returns success output without retrying', async () => {
    const r = await runWithEnoentRetry(['node', '-e', 'console.log("ok")'], {
      retries: 3,
      retryDelayMs: 1,
    });
    expect(r.code).toBe(0);
    expect(r.output).toBe('ok');
  });
});

describe('createSettleGate', () => {
  it('stays locked on running events, releases on the first terminal event for the host', async () => {
    const gate = createSettleGate('claude');
    let released = false;
    void gate.settled.then(() => {
      released = true;
    });
    gate.observe(0, 'claude', { state: 'running', before: '1.0.0' });
    await Promise.resolve();
    expect(released).toBe(false);
    gate.observe(0, 'claude', { state: 'success', before: '1.0.0', after: '1.0.1' });
    await gate.settled;
    expect(released).toBe(true);
  });

  it('ignores progress from other agents', async () => {
    const gate = createSettleGate('claude');
    let released = false;
    void gate.settled.then(() => {
      released = true;
    });
    gate.observe(0, 'codex', { state: 'failed', error: 'boom' });
    await Promise.resolve();
    expect(released).toBe(false);
  });

  it('resolves immediately when the host is absent', async () => {
    const gate = createSettleGate(undefined);
    await gate.settled; // must not hang
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

describe('versionFromGithubReleaseJson', () => {
  it('extracts the version from a release tag', () => {
    expect(versionFromGithubReleaseJson('{"tag_name":"rust-v0.161.0"}')).toBe('0.161.0');
    expect(versionFromGithubReleaseJson('{"tag_name":"v1.2.3"}')).toBe('1.2.3');
  });
  it('returns null on invalid JSON, missing tag, or non-semver tag', () => {
    expect(versionFromGithubReleaseJson('not json')).toBeNull();
    expect(versionFromGithubReleaseJson('{}')).toBeNull();
    expect(versionFromGithubReleaseJson('{"tag_name":"nightly"}')).toBeNull();
  });
});

describe('nativeFallbackCommand', () => {
  const def: AgentDef = {
    name: 'codex',
    label: 'OpenAI Codex',
    nativeUpdate: ['codex', 'update'],
    versionCmd: ['codex', '--version'],
    nativeUpdateFallback: { unix: ['sh', '-c', 'x'], windows: ['powershell', '-c', 'y'] },
  };
  it('picks the unix command on posix platforms', () => {
    expect(nativeFallbackCommand(def, 'linux')).toEqual(['sh', '-c', 'x']);
    expect(nativeFallbackCommand(def, 'darwin')).toEqual(['sh', '-c', 'x']);
  });
  it('picks the windows command on win32', () => {
    expect(nativeFallbackCommand(def, 'win32')).toEqual(['powershell', '-c', 'y']);
  });
  it('returns null when no fallback is defined', () => {
    const plain: AgentDef = { name: 'a', label: 'a', nativeUpdate: [], versionCmd: [] };
    expect(nativeFallbackCommand(plain, 'linux')).toBeNull();
  });
});

describe('updateAgents native fallback', () => {
  // Fake agents run `node -e` instead of real updaters; getVersion/getLatest
  // are injected, so no network is involved.
  function mkNativeAgent(defOverrides: Partial<AgentDef>, version: string | null): DetectedAgent {
    const def: AgentDef = {
      name: 'codex',
      label: 'OpenAI Codex',
      nativeUpdate: ['node', '-e', 'process.exit(0)'],
      versionCmd: ['node', '--version'],
      ...defOverrides,
    };
    return {
      def,
      binPath: '/x/codex',
      realPath: '/x/codex',
      manager: 'native',
      version,
    } as DetectedAgent;
  }
  const okFallback = {
    unix: ['node', '-e', 'process.exit(0)'],
    windows: ['node', '-e', 'process.exit(0)'],
  };

  it('runs the fallback when the self-update command fails', async () => {
    const agent = mkNativeAgent(
      { nativeUpdate: ['node', '-e', 'process.exit(3)'], nativeUpdateFallback: okFallback },
      '1.0.0',
    );
    const [r] = await updateAgents([agent], { getVersion: async () => '1.0.1' });
    expect(r!.status).toBe('updated');
    expect(r!.before).toBe('1.0.0');
    expect(r!.after).toBe('1.0.1');
  });

  it('runs the fallback on a fake success (exit 0 but still behind latest)', async () => {
    const agent = mkNativeAgent(
      {
        nativeUpdate: ['node', '-e', 'process.exit(0)'], // blocked `curl | sh` exits 0 doing nothing
        nativeUpdateFallback: okFallback,
        githubReleaseRepo: 'openai/codex',
      },
      '1.0.0',
    );
    let versionCalls = 0;
    const [r] = await updateAgents([agent], {
      getLatest: async () => '2.0.0',
      // stale after the primary run, current after the fallback ran
      getVersion: async () => (++versionCalls === 1 ? '1.0.0' : '2.0.0'),
    });
    expect(versionCalls).toBe(2); // proves the fallback executed
    expect(r!.status).toBe('updated');
    expect(r!.after).toBe('2.0.0');
  });

  it('skips the update entirely when already at the latest release', async () => {
    const agent = mkNativeAgent(
      {
        nativeUpdate: ['node', '-e', 'process.exit(3)'], // would fail if it ran
        nativeUpdateFallback: okFallback,
        githubReleaseRepo: 'openai/codex',
      },
      '2.0.0',
    );
    const [r] = await updateAgents([agent], {
      getLatest: async () => '2.0.0',
      getVersion: async () => '2.0.0',
    });
    expect(r!.status).toBe('up-to-date');
  });

  it('fails when both the self-update and the fallback fail, surfacing the fallback output', async () => {
    const agent = mkNativeAgent(
      {
        nativeUpdate: ['node', '-e', 'process.exit(3)'],
        nativeUpdateFallback: {
          unix: ['node', '-e', 'console.error("fb-boom"); process.exit(1)'],
          windows: ['node', '-e', 'console.error("fb-boom"); process.exit(1)'],
        },
      },
      '1.0.0',
    );
    const [r] = await updateAgents([agent], { getVersion: async () => '1.0.0' });
    expect(r!.status).toBe('failed');
    expect(r!.error).toContain('fb-boom');
  });

  it('fails when the fallback exits 0 but the version never reaches latest', async () => {
    const agent = mkNativeAgent(
      {
        nativeUpdate: ['node', '-e', 'process.exit(0)'],
        nativeUpdateFallback: okFallback,
        githubReleaseRepo: 'openai/codex',
      },
      '1.0.0',
    );
    const [r] = await updateAgents([agent], {
      getLatest: async () => '2.0.0',
      getVersion: async () => '1.0.0', // never updates
    });
    expect(r!.status).toBe('failed');
    expect(r!.error).toContain('did not take effect');
  });

  it('keeps the old behavior (plain failure) when no fallback is defined', async () => {
    const agent = mkNativeAgent(
      { nativeUpdate: ['node', '-e', 'console.error("boom"); process.exit(3)'] },
      '1.0.0',
    );
    const [r] = await updateAgents([agent], { getVersion: async () => '1.0.0' });
    expect(r!.status).toBe('failed');
    expect(r!.error).toContain('boom');
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
