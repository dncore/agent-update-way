import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import {
  classifyManager,
  extractVersion,
  packageNameFromPath,
  nodeRootFromPath,
  brewFormulaFromPath,
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
