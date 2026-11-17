import { describe, it, expect } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyManager,
  extractVersion,
  packageNameFromPath,
  nodeRootFromPath,
  brewFormulaFromPath,
  npmShimTarget,
  managedInstallRoot,
  managedVersion,
} from '../src/detect.js';
import { buildUpdateCommand } from '../src/update.js';
import type { DetectedAgent } from '../src/types.js';
import { findAgent } from '../src/agents.js';

function mkAgent(overrides: Partial<DetectedAgent>): DetectedAgent {
  return {
    def: findAgent('pi')!,
    binPath: '/x/pi',
    realPath: '/x/pi',
    manager: 'native',
    version: null,
    ...overrides,
  };
}

describe('extractVersion', () => {
  it('extracts x.y.z from plain output', () => {
    expect(extractVersion('2.1.228')).toBe('2.1.228');
  });
  it('extracts x.y.z from noisy output', () => {
    expect(extractVersion('codex-cli 0.147.0')).toBe('0.147.0');
    expect(extractVersion('GitHub Copilot CLI 1.0.79.\nRun copilot update')).toBe('1.0.79');
    expect(extractVersion('no version here')).toBeNull();
  });
});

describe('packageNameFromPath', () => {
  it('extracts scoped package names', () => {
    expect(
      packageNameFromPath(
        '/Users/x/.local/share/fnm/node-versions/v24/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      ),
    ).toBe('@earendil-works/pi-coding-agent');
  });
  it('extracts unscoped package names', () => {
    expect(packageNameFromPath('/usr/local/lib/node_modules/opencode-ai/bin/opencode')).toBe(
      'opencode-ai',
    );
  });
  it('returns null when not under node_modules', () => {
    expect(packageNameFromPath('/opt/homebrew/bin/codex')).toBeNull();
  });
});

describe('nodeRootFromPath', () => {
  it('extracts the owning node root (fnm multi-version safe)', () => {
    expect(
      nodeRootFromPath(
        '/Users/x/.local/share/fnm/node-versions/v24.13.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      ),
    ).toBe('/Users/x/.local/share/fnm/node-versions/v24.13.0/installation');
  });
});

describe('brewFormulaFromPath', () => {
  it('extracts formula from Cellar path', () => {
    expect(brewFormulaFromPath('/opt/homebrew/Cellar/codex/0.147.0/bin/codex')).toBe('codex');
  });
  it('extracts cask from Caskroom path', () => {
    expect(brewFormulaFromPath('/opt/homebrew/Caskroom/copilot-cli/1.0.43/copilot')).toBe(
      'copilot-cli',
    );
  });
});

describe('classifyManager', () => {
  it('classifies npm global installs (any node root)', () => {
    const r = classifyManager(
      '/Users/x/.local/share/fnm/node-versions/v24.13.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    );
    expect(r.manager).toBe('npm');
    expect(r.target).toBe('@earendil-works/pi-coding-agent');
    expect(r.nodeRoot).toBe('/Users/x/.local/share/fnm/node-versions/v24.13.0/installation');
  });

  it('classifies brew cask installs', () => {
    const r = classifyManager('/opt/homebrew/Caskroom/codex/0.147.0/bin/codex');
    expect(r.manager).toBe('brew');
    expect(r.brewCask).toBe(true);
    expect(r.target).toBe('codex');
  });

  it('classifies grok-build cask installs (cask name differs from binary name)', () => {
    const r = classifyManager('/opt/homebrew/Caskroom/grok-build/1.0.13/grok-1.0.13-macos-aarch64');
    expect(r.manager).toBe('brew');
    expect(r.brewCask).toBe(true);
    expect(r.target).toBe('grok-build'); // → brew upgrade --cask grok-build
  });

  it('classifies brew formula installs', () => {
    const r = classifyManager('/opt/homebrew/Cellar/codex/0.147.0/bin/codex');
    expect(r.manager).toBe('brew');
    expect(r.brewCask).toBe(false);
  });

  it('classifies native installs', () => {
    expect(classifyManager('/Users/x/.local/share/claude/versions/2.1.228').manager).toBe('native');
    expect(classifyManager('/Users/x/.opencode/bin/opencode').manager).toBe('native');
  });

  it('classifies project-local installs (never touch)', () => {
    const r = classifyManager('/Users/x/proj/node_modules/.bin/pi');
    expect(r.manager).toBe('local');
  });

  it('classifies project-local installs by real path (the npx case)', () => {
    // npx prepends <proj>/node_modules/.bin to PATH; realpath resolves the
    // symlink to node_modules/<pkg>/... — which is NOT a global store.
    const r = classifyManager(
      '/Users/x/proj/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    );
    expect(r.manager).toBe('local');
  });

  it('distinguishes project-local from global npm store (lib/node_modules)', () => {
    const global = classifyManager(
      '/Users/x/.local/share/fnm/node-versions/v24.13.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    );
    expect(global.manager).toBe('npm');
    const local = classifyManager('/Users/x/proj/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
    expect(local.manager).toBe('local');
  });

  it('classifies pnpm and bun global stores', () => {
    expect(classifyManager('/Users/x/.local/share/pnpm/global/5/node_modules/opencode-ai/bin/opencode').manager).toBe('pnpm');
    expect(classifyManager('/Users/x/.bun/install/global/node_modules/opencode-ai/bin/opencode').manager).toBe('bun');
  });

  it('classifies user-level installs under ~/node_modules', () => {
    const r = classifyManager('/Users/x/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js', '/Users/x');
    expect(r.manager).toBe('user');
    expect(r.target).toBe('@oh-my-pi/pi-coding-agent');
  });
});

describe('pi managed installs', () => {
  const MARKER = { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' };

  /** Build <tmp>/agent/bin/pi + <tmp>/agent/install/{marker,current-version,releases}. */
  function mkManaged(marker: object | string = MARKER) {
    const agentDir = join(mkdtempSync(join(tmpdir(), 'auway-managed-')), 'agent');
    const installDir = join(agentDir, 'install');
    mkdirSync(join(agentDir, 'bin'), { recursive: true });
    mkdirSync(join(installDir, 'releases', '1.5.2'), { recursive: true });
    writeFileSync(join(agentDir, 'bin', 'pi'), '#!/bin/sh\n');
    writeFileSync(
      join(installDir, 'managed-install.json'),
      typeof marker === 'string' ? marker : JSON.stringify(marker),
    );
    writeFileSync(join(installDir, 'current-version'), '1.5.2\n');
    return { installDir, launcher: join(agentDir, 'bin', 'pi') };
  }

  it('classifies the launcher as managed, not native', () => {
    const { installDir, launcher } = mkManaged();
    expect(classifyManager(launcher, homedir(), null)).toEqual({ manager: 'managed', managedRoot: installDir });
  });

  it('classifies a direct link into a release tree as managed, not project-local', () => {
    const { installDir } = mkManaged();
    const releaseFile = join(
      installDir,
      'releases',
      '1.5.2',
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'bundle',
      'cli.js',
    );
    expect(classifyManager(releaseFile, homedir(), null)).toEqual({
      manager: 'managed',
      managedRoot: installDir,
    });
  });

  it('stays native when the marker is not pi managed-install', () => {
    const { launcher } = mkManaged({ ...MARKER, kind: 'something-else' });
    expect(classifyManager(launcher, homedir(), null)).toEqual({ manager: 'native' });
  });

  it('accepts a marker written with a UTF-8 BOM (PowerShell rewrite)', () => {
    const { installDir, launcher } = mkManaged(String.fromCharCode(0xfeff) + JSON.stringify(MARKER));
    expect(managedInstallRoot(launcher)).toBe(installDir);
  });

  it('reads the active version from current-version', () => {
    const { installDir } = mkManaged();
    expect(managedVersion(installDir)).toBe('1.5.2');
  });

  it('updates through pi\'s own managed self-update', () => {
    const agent = mkAgent({ manager: 'managed', managedRoot: '/x/install' });
    expect(buildUpdateCommand(agent)).toEqual(['pi', 'update', 'pi']);
  });
});

describe('buildUpdateCommand', () => {
  it('npm global → npm update -g --prefix <nodeRoot> <pkg>', () => {
    const a = mkAgent({
      manager: 'npm',
      managerTarget: '@earendil-works/pi-coding-agent',
      nodeRoot: '/Users/x/.local/share/fnm/node-versions/v24.13.0/installation',
    });
    expect(buildUpdateCommand(a)).toEqual([
      'npm',
      'update',
      '-g',
      '--prefix',
      '/Users/x/.local/share/fnm/node-versions/v24.13.0/installation',
      '@earendil-works/pi-coding-agent',
    ]);
  });

  it('brew cask → brew upgrade --cask <formula>', () => {
    const a = mkAgent({ manager: 'brew', managerTarget: 'codex', brewCask: true });
    expect(buildUpdateCommand(a)).toEqual(['brew', 'upgrade', '--cask', 'codex']);
  });

  it('brew formula → brew upgrade <formula>', () => {
    const a = mkAgent({ manager: 'brew', managerTarget: 'opencode', brewCask: false });
    expect(buildUpdateCommand(a)).toEqual(['brew', 'upgrade', 'opencode']);
  });

  it('native → official self-update command', () => {
    const a = mkAgent({ manager: 'native' });
    expect(buildUpdateCommand(a)).toEqual(['pi', 'update', 'pi']);
  });

  it('project-local → null (never update)', () => {
    const a = mkAgent({ manager: 'local' });
    expect(buildUpdateCommand(a)).toBeNull();
  });

  it('user-level → precise isolated update (handled by updateAgents, not skipped)', () => {
    const a = mkAgent({
      def: findAgent('omp')!,
      manager: 'user',
      managerTarget: '@oh-my-pi/pi-coding-agent',
      binPath: `${homedir()}/.bun/bin/omp`,
      realPath: `${homedir()}/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`,
    });
    // buildUpdateCommand has no single-command path for user installs;
    // updateAgents handles them via the multi-step isolated update instead.
    expect(buildUpdateCommand(a)).toBeNull();
  });
});

describe('agent registry', () => {
  it('agy uses `agy --version` (bare `agy version` is not a subcommand)', () => {
    expect(findAgent('agy')!.versionCmd).toEqual(['agy', '--version']);
  });

  it('codex native fallback bootstraps from GitHub, never vendor domains', () => {
    const codex = findAgent('codex')!;
    expect(codex.githubReleaseRepo).toBe('openai/codex');
    const unix = codex.nativeUpdateFallback!.unix.join(' ');
    expect(unix).toContain('raw.githubusercontent.com/openai/codex/main/scripts/install/install.sh');
    expect(unix).toContain('CODEX_NON_INTERACTIVE=1');
    expect(unix).toContain('CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false');
    expect(unix).not.toContain('chatgpt.com');
    expect(unix).not.toContain('releases.openai.com');
    const win = codex.nativeUpdateFallback!.windows.join(' ');
    expect(win).toContain('raw.githubusercontent.com/openai/codex/main/scripts/install/install.ps1');
    expect(win).toContain("CODEX_INSTALLER_USE_RELEASES_OPENAI_COM='false'");
    expect(win).not.toContain('chatgpt.com');
  });
});

describe('Windows install layouts', () => {
  it('classifies Windows npm global store under `npm root -g` (no lib/)', () => {
    const r = classifyManager(
      'C:\\ProgramData\\nvm\\v24.16.0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js',
      'C:\\Users\\dean',
      'C:/ProgramData/nvm/v24.16.0/node_modules',
    );
    expect(r.manager).toBe('npm');
    expect(r.target).toBe('@earendil-works/pi-coding-agent');
    expect(r.nodeRoot).toBe('C:/ProgramData/nvm/v24.16.0');
  });

  it('does not mistake a project-local install for a global one', () => {
    const r = classifyManager(
      'C:\\Users\\dean\\proj\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js',
      'C:\\Users\\dean',
      'C:/ProgramData/nvm/v24.16.0/node_modules',
    );
    expect(r.manager).toBe('local');
  });

  it('classifies Windows user-level installs (~/node_modules)', () => {
    const r = classifyManager(
      'C:\\Users\\dean\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js',
      'C:\\Users\\dean',
      'C:/ProgramData/nvm/v24.16.0/node_modules',
    );
    expect(r.manager).toBe('user');
  });
});

describe('npmShimTarget (Windows npm shims embed the real entry)', () => {
  it('parses the node_modules entry out of an npm .cmd shim', () => {
    const { mkdtempSync, writeFileSync, rmSync, existsSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'auway-shim-'));
    try {
      const shim = join(dir, 'pi.cmd');
      writeFileSync(
        shim,
        '@ECHO off\r\n' +
          '"%~dp0node.exe" "%~dp0node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\r\n',
      );
      const target = npmShimTarget(shim)!;
      expect(target.replace(/\\/g, '/')).toBe(
        join(dir, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js').replace(/\\/g, '/'),
      );
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for non-shim text', () => {
    const { mkdtempSync, writeFileSync, rmSync, existsSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'auway-shim2-'));
    try {
      const f = join(dir, 'tool');
      writeFileSync(f, 'just some text without node_modules refs');
      expect(npmShimTarget(f)).toBeNull();
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
