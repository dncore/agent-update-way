import { describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  compareVersions,
  runCommand,
  needsStagedInstall,
  npmGlobalPackageDir,
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

describe('updateAgents managed installs', () => {
  // pi's managed self-update exits 1 when it cannot reach pi.dev to learn the
  // latest version — including when nothing needed updating.
  function mkManagedAgent(version: string | null, exit = 3): DetectedAgent {
    return {
      def: {
        name: 'pi',
        label: 'Pi Coding Agent',
        nativeUpdate: ['node', '-e', `process.exit(${exit})`],
        versionCmd: ['node', '--version'],
        npmPackage: '@earendil-works/pi-coding-agent',
      },
      binPath: '/x/pi',
      realPath: '/x/pi',
      manager: 'managed',
      managedRoot: '/x/install',
      version,
    } as DetectedAgent;
  }

  it('reports up-to-date when the self-update fails but the registry says current', async () => {
    const [r] = await updateAgents([mkManagedAgent('1.5.2')], {
      getVersion: async () => '1.5.2',
      getNpmLatest: async () => '1.5.2',
    });
    expect(r!.status).toBe('up-to-date');
    expect(r!.error).toBeUndefined();
  });

  it('still fails when the registry has a newer version', async () => {
    const [r] = await updateAgents([mkManagedAgent('1.5.1')], {
      getVersion: async () => '1.5.1',
      getNpmLatest: async () => '1.5.2',
    });
    expect(r!.status).toBe('failed');
    expect(r!.error).toContain('process.exit(3)');
  });

  it('fails when the registry cannot be reached either', async () => {
    const [r] = await updateAgents([mkManagedAgent('1.5.1')], {
      getVersion: async () => '1.5.1',
      getNpmLatest: async () => null,
    });
    expect(r!.status).toBe('failed');
  });

  it('reports an update from the managed self-update', async () => {
    const [r] = await updateAgents([mkManagedAgent('1.5.1', 0)], {
      getVersion: async () => '1.5.2',
      getNpmLatest: async () => '1.5.2',
    });
    expect(r!.status).toBe('updated');
    expect(r!.after).toBe('1.5.2');
  });
});

describe('updateAgents npm fallback', () => {
  // The fake `npm` is a #!/bin/sh script, so this only runs on POSIX.
  const posix = process.platform === 'win32' ? it.skip : it;

  /**
   * Prepend a fake `npm` to PATH: `npm install -g …` fails exactly like a
   * global tree containing a `link:` dependency does, while `view` / `pack` /
   * the isolated `install --prefix` are served locally (no registry access).
   */
  async function withFakeNpm<T>(viewVersion: string | null, fn: () => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'auway-fake-npm-'));
    const shim = join(dir, 'npm');
    writeFileSync(
      shim,
      `#!/bin/sh
if [ "$1" = "install" ] && [ "$2" = "-g" ]; then
  echo 'npm error code EUNSUPPORTEDPROTOCOL' >&2
  echo 'npm error Unsupported URL Type "link:": link:' >&2
  exit 1
fi
case "$1" in
  view) ${viewVersion ? `echo "${viewVersion}"` : 'exit 1'} ;;
  pack)
    mkdir -p "$4/pkg/package"
    printf '{"name":"is-number","version":"${viewVersion ?? '0.0.0'}"}' > "$4/pkg/package/package.json"
    tar -czf "$4/is-number.tgz" -C "$4/pkg" package
    printf '[{"filename":"is-number.tgz"}]'
    ;;
  *) exit 0 ;;
esac
`,
    );
    chmodSync(shim, 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${savedPath}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function mkNpmAgent(prefix: string): DetectedAgent {
    return {
      def: {
        name: 'pi',
        label: 'Pi Coding Agent',
        nativeUpdate: ['pi', 'update', 'pi'],
        versionCmd: ['pi', '--version'],
        npmPackage: '@earendil-works/pi-coding-agent',
      },
      binPath: join(prefix, 'bin', 'pi'),
      realPath: join(prefix, 'lib', 'node_modules', 'is-number', 'index.js'),
      manager: 'npm',
      managerTarget: 'is-number',
      nodeRoot: prefix,
      version: '5.0.0',
    } as DetectedAgent;
  }

  posix('installs in isolation when npm rejects the global tree', async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'auway-npm-prefix-'));
    const targetDir = npmGlobalPackageDir(prefix, 'is-number');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, 'package.json'),
      JSON.stringify({ name: 'is-number', version: '5.0.0' }),
    );
    try {
      const [r] = await withFakeNpm('7.0.0', () =>
        updateAgents([mkNpmAgent(prefix)], { getVersion: async () => '7.0.0' }),
      );
      expect(r!.status).toBe('updated');
      expect(r!.before).toBe('5.0.0');
      expect(r!.after).toBe('7.0.0');
      const swapped = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'));
      expect(swapped.version).toBe('7.0.0');
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  posix('reports the npm error and the failed isolated install when both fail', async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'auway-npm-prefix-'));
    mkdirSync(npmGlobalPackageDir(prefix, 'is-number'), { recursive: true });
    try {
      const [r] = await withFakeNpm(null, () =>
        updateAgents([mkNpmAgent(prefix)], { getVersion: async () => '5.0.0' }),
      );
      expect(r!.status).toBe('failed');
      expect(r!.error).toContain('EUNSUPPORTEDPROTOCOL');
      expect(r!.error).toContain('isolated install failed');
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
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
