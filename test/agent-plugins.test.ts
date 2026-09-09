import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseClaudePlugins,
  parseCodexPlugins,
  parseGrokPlugins,
  parseJsonLoose,
  detectClaudePlugins,
  detectCodexPlugins,
  detectGrokPlugins,
  updateClaudePlugins,
  updateCodexPlugins,
  updateGrokPlugins,
  pluginsStatusLine,
  countUpdated,
} from '../src/agent-plugins.js';
import { runWithEnoentRetry } from '../src/update.js';
import type { AgentPluginsInfo } from '../src/types.js';

// Mock the subprocess runner so detect/update run without spawning anything.
vi.mock('../src/update.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/update.js')>();
  return { ...mod, runWithEnoentRetry: vi.fn() };
});

const ok = (output: string) => ({ code: 0, output });

const CLAUDE_JSON = JSON.stringify([
  { id: 'code-review@claude-plugins-official', version: 'unknown', scope: 'user', enabled: true },
  { id: 'superpowers@claude-plugins-official', version: '6.3.0', scope: 'user', enabled: true },
  { id: 'disabled-one@claude-plugins-official', version: '1.0.0', scope: 'user', enabled: false },
]);

const CODEX_JSON = JSON.stringify({
  installed: [
    {
      pluginId: 'documents@openai-primary-runtime',
      version: '26.905.11957',
      installed: true,
      enabled: true,
    },
    {
      pluginId: 'chrome@openai-bundled',
      version: '26.901.51231',
      installed: false,
      enabled: false,
    },
  ],
});

const GROK_JSON = JSON.stringify([{ name: 'grok-plugin-x', version: '0.2.0', enabled: true }]);

beforeEach(() => {
  vi.mocked(runWithEnoentRetry).mockReset();
});

describe('parseJsonLoose', () => {
  it('parses plain JSON', () => {
    expect(parseJsonLoose('[]')).toEqual([]);
    expect(parseJsonLoose('  {"a":1}\n')).toEqual({ a: 1 });
  });

  it('slices JSON out of surrounding CLI noise', () => {
    expect(parseJsonLoose('warn: something\n[{"id":"x"}]\n')).toEqual([{ id: 'x' }]);
  });

  it('returns undefined for garbage', () => {
    expect(parseJsonLoose('not json at all')).toBeUndefined();
    expect(parseJsonLoose('')).toBeUndefined();
  });
});

describe('parseClaudePlugins', () => {
  it('parses ids, maps "unknown" versions to null, keeps enabled flag', () => {
    const plugins = parseClaudePlugins(CLAUDE_JSON);
    expect(plugins).toHaveLength(3);
    expect(plugins[0]).toEqual({
      id: 'code-review@claude-plugins-official',
      version: null,
      enabled: true,
    });
    expect(plugins[1]!.version).toBe('6.3.0');
    expect(plugins[2]!.enabled).toBe(false);
  });

  it('returns empty for non-array output', () => {
    expect(parseClaudePlugins('error: not logged in')).toEqual([]);
  });
});

describe('parseCodexPlugins', () => {
  it('keeps installed plugins only', () => {
    const plugins = parseCodexPlugins(CODEX_JSON);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toEqual({
      id: 'documents@openai-primary-runtime',
      version: '26.905.11957',
      enabled: true,
    });
  });

  it('returns empty when JSON shape is unexpected', () => {
    expect(parseCodexPlugins('[]')).toEqual([]);
  });
});

describe('parseGrokPlugins', () => {
  it('accepts name or id, empty array means none installed', () => {
    expect(parseGrokPlugins('[]')).toEqual([]);
    const plugins = parseGrokPlugins(GROK_JSON);
    expect(plugins).toEqual([{ id: 'grok-plugin-x', version: '0.2.0', enabled: true }]);
  });
});

describe('detectors', () => {
  it('claude: builds info from list --json', async () => {
    vi.mocked(runWithEnoentRetry).mockResolvedValue(ok(CLAUDE_JSON));
    const info = await detectClaudePlugins();
    expect(vi.mocked(runWithEnoentRetry).mock.calls[0]![0]).toEqual([
      'claude',
      'plugin',
      'list',
      '--json',
    ]);
    expect(info.total).toBe(3);
    expect(info.summary).toBe('3 plugins');
  });

  it('claude: marks info disabled when the list command fails', async () => {
    vi.mocked(runWithEnoentRetry).mockResolvedValue({ code: 1, output: 'boom' });
    const info = await detectClaudePlugins();
    expect(info.enabled).toBe(false);
    expect(info.total).toBe(0);
  });

  it('codex: builds info from list --json (installed only)', async () => {
    vi.mocked(runWithEnoentRetry).mockResolvedValue(ok(CODEX_JSON));
    const info = await detectCodexPlugins();
    expect(info.total).toBe(1);
  });

  it('grok: empty list is a valid zero-plugin state', async () => {
    vi.mocked(runWithEnoentRetry).mockResolvedValue(ok('[]'));
    const info = await detectGrokPlugins();
    expect(info.enabled).toBe(true);
    expect(info.total).toBe(0);
  });
});

describe('updateClaudePlugins', () => {
  it('refreshes marketplaces first, then updates every plugin with -y, serially', async () => {
    vi.mocked(runWithEnoentRetry).mockResolvedValue(ok('done'));
    const r = await updateClaudePlugins([
      { id: 'a@mkt', version: '1.0.0', enabled: true },
      { id: 'b@mkt', version: '1.0.0', enabled: true },
    ]);
    expect(r.code).toBe(0);
    const cmds = vi.mocked(runWithEnoentRetry).mock.calls.map((c) => c[0]);
    expect(cmds).toEqual([
      ['claude', 'plugin', 'marketplace', 'update'],
      ['claude', 'plugin', 'update', 'a@mkt', '-y'],
      ['claude', 'plugin', 'update', 'b@mkt', '-y'],
    ]);
  });

  it('aggregates per-plugin failures instead of aborting the loop', async () => {
    vi.mocked(runWithEnoentRetry)
      .mockResolvedValueOnce(ok('refreshed'))
      .mockResolvedValueOnce({ code: 1, output: 'plugin a failed' })
      .mockResolvedValueOnce(ok('updated'));
    const r = await updateClaudePlugins([
      { id: 'a@mkt', version: null, enabled: true },
      { id: 'b@mkt', version: null, enabled: true },
    ]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('a@mkt: plugin a failed');
    expect(vi.mocked(runWithEnoentRetry)).toHaveBeenCalledTimes(3);
  });
});

describe('updateCodexPlugins', () => {
  it('upgrades marketplaces then re-adds each installed plugin', async () => {
    vi.mocked(runWithEnoentRetry).mockResolvedValue(ok('{}'));
    const r = await updateCodexPlugins([{ id: 'documents@openai-primary-runtime', version: '1', enabled: true }]);
    expect(r.code).toBe(0);
    const cmds = vi.mocked(runWithEnoentRetry).mock.calls.map((c) => c[0]);
    expect(cmds).toEqual([
      ['codex', 'plugin', 'marketplace', 'upgrade', '--json'],
      ['codex', 'plugin', 'add', 'documents@openai-primary-runtime'],
    ]);
  });
});

describe('updateGrokPlugins', () => {
  it('runs the official bulk update command', async () => {
    vi.mocked(runWithEnoentRetry).mockResolvedValue(ok('updated'));
    const r = await updateGrokPlugins();
    expect(r.code).toBe(0);
    expect(vi.mocked(runWithEnoentRetry).mock.calls[0]![0]).toEqual(['grok', 'plugin', 'update']);
  });
});

describe('countUpdated / pluginsStatusLine', () => {
  const info = (vers: (string | null)[]): AgentPluginsInfo => ({
    enabled: true,
    total: vers.length,
    summary: '',
    plugins: vers.map((v, i) => ({ id: `p${i}@m`, version: v, enabled: true })),
  });

  it('counts version changes, ignores new/removed plugins', () => {
    expect(countUpdated(info(['1.0.0', '2.0.0']), info(['1.0.1', '2.0.0']))).toBe(1);
    expect(countUpdated(info(['1.0.0']), info(['1.0.0', '2.0.0']))).toBe(0);
    expect(countUpdated(info([null]), info(['1.0.0']))).toBe(1);
  });

  it('formats the status line', () => {
    expect(pluginsStatusLine(info([]))).toBe('0 plugins');
    expect(pluginsStatusLine(info(['1.0.0']))).toBe('1 plugin');
    expect(pluginsStatusLine(info(['1.0.0', '1.0.0']), 1)).toBe('2 plugins · 1 updated');
  });
});
