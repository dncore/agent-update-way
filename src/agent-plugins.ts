import { runWithEnoentRetry } from './update.js';
import type { AgentPluginInfo, AgentPluginsInfo } from './types.js';

/**
 * Agent plugin support for Claude Code, OpenAI Codex and Grok Build.
 *
 * All three agents have their own plugin/marketplace system, and each one is
 * updated through its own official mechanism — never by poking at caches on
 * disk:
 *
 * - Claude Code: `claude plugin list --json` for detection;
 *   `claude plugin marketplace update` (refresh all sources) followed by
 *   `claude plugin update <id> -y` per plugin. `-y` is required because
 *   auway runs non-interactively (stdout is not a TTY) — it accepts the
 *   marketplace-declared install command, which is Claude Code's official
 *   non-interactive update path.
 * - Codex: no per-plugin update command exists. `codex plugin list --json`
 *   for detection; `codex plugin marketplace upgrade --json` refreshes
 *   user-configured Git marketplaces, then `codex plugin add <id>` re-installs
 *   each plugin at the marketplace's current version (idempotent, versioned
 *   cache under ~/.codex/plugins/cache, config untouched).
 * - Grok Build: `grok plugin list --json` for detection; `grok plugin update`
 *   (omitting the name updates all installed plugins).
 *
 * All plugin-list mutations run serially per agent (they share config/cache
 * state) and behind the host agent's settle gate (see createSettleGate) —
 * an agent's own update may be swapping its binary while we spawn it.
 */

/** Info for an unreadable plugin list (agent missing or command failed). */
function pluginsUnavailable(summary: string): AgentPluginsInfo {
  return { enabled: false, plugins: [], total: 0, summary };
}

/**
 * Parse JSON that may be surrounded by CLI noise (warnings on stderr are
 * joined into the captured output). Falls back to slicing from the first
 * '['/'{' to the last ']'/'}'; undefined when nothing parses.
 */
export function parseJsonLoose(raw: string): unknown {
  const s = raw.trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    const start = Math.min(
      ...[s.indexOf('['), s.indexOf('{')].filter((i) => i !== -1).concat([Number.MAX_SAFE_INTEGER]),
    );
    const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
    if (start === Number.MAX_SAFE_INTEGER || end <= start) return undefined;
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/** Build an AgentPluginsInfo from generic id/version/enabled records. */
function infoFrom(records: AgentPluginInfo[]): AgentPluginsInfo {
  return {
    enabled: true,
    plugins: records,
    total: records.length,
    summary: `${records.length} plugin${records.length === 1 ? '' : 's'}`,
  };
}

/** One-line status for the aggregate renderer row. */
export function pluginsStatusLine(info: AgentPluginsInfo, updated?: number): string {
  if (!info.total) return '0 plugins';
  const base = `${info.total} plugin${info.total === 1 ? '' : 's'}`;
  return updated && updated > 0 ? `${base} · ${updated} updated` : base;
}

/** Count plugins whose version changed between two detections. */
export function countUpdated(before: AgentPluginsInfo, after: AgentPluginsInfo): number {
  const beforeById = new Map(before.plugins.map((p) => [p.id, p.version]));
  let updated = 0;
  for (const p of after.plugins) {
    const was = beforeById.get(p.id);
    if (was === undefined) continue; // newly appeared/removed — not a version bump
    if ((was ?? null) !== (p.version ?? null)) updated++;
  }
  return updated;
}

interface RunOptions {
  timeoutMs?: number;
  /** How many times to retry after a spawn ENOENT (default 3). */
  retries?: number;
  /** Base backoff between ENOENT retries in ms (default 400, linear growth). */
  retryDelayMs?: number;
}

/* ---------- Claude Code ---------- */

/** Parse `claude plugin list --json` output (array of plugin records). */
export function parseClaudePlugins(raw: string): AgentPluginInfo[] {
  const arr = parseJsonLoose(raw);
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((e): AgentPluginInfo[] => {
    if (typeof e !== 'object' || e === null) return [];
    const rec = e as { id?: unknown; version?: unknown; enabled?: unknown };
    if (typeof rec.id !== 'string' || !rec.id) return [];
    return [
      {
        id: rec.id,
        version: rec.version === 'unknown' || typeof rec.version !== 'string' ? null : rec.version,
        enabled: typeof rec.enabled === 'boolean' ? rec.enabled : true,
      },
    ];
  });
}

export async function detectClaudePlugins(opts: RunOptions = {}): Promise<AgentPluginsInfo> {
  const r = await runWithEnoentRetry(['claude', 'plugin', 'list', '--json'], opts);
  if (r.code !== 0) return pluginsUnavailable('claude plugin list failed');
  return infoFrom(parseClaudePlugins(r.output));
}

/**
 * Update all Claude Code plugins: refresh every marketplace, then update each
 * installed plugin serially. `-y` is required for non-TTY runs (official
 * non-interactive flag accepting the marketplace-declared command).
 */
export async function updateClaudePlugins(
  plugins: AgentPluginInfo[],
  opts: RunOptions = {},
): Promise<{ code: number; output: string }> {
  const errors: string[] = [];
  const mkt = await runWithEnoentRetry(['claude', 'plugin', 'marketplace', 'update'], opts);
  if (mkt.code !== 0) {
    errors.push(`claude plugin marketplace update: ${mkt.output.split('\n')[0] ?? ''}`);
  }
  for (const p of plugins) {
    const r = await runWithEnoentRetry(['claude', 'plugin', 'update', p.id, '-y'], opts);
    if (r.code !== 0) errors.push(`${p.id}: ${r.output.split('\n')[0] ?? `exit code ${r.code}`}`);
  }
  return errors.length
    ? { code: 1, output: errors.join('\n') }
    : { code: 0, output: `${plugins.length} plugin(s) processed` };
}

/* ---------- OpenAI Codex ---------- */

/** Parse `codex plugin list --json` output ({installed: [...]}) — installed only. */
export function parseCodexPlugins(raw: string): AgentPluginInfo[] {
  const obj = parseJsonLoose(raw);
  const installed = (obj as { installed?: unknown } | undefined)?.installed;
  if (!Array.isArray(installed)) return [];
  return installed.flatMap((e): AgentPluginInfo[] => {
    if (typeof e !== 'object' || e === null) return [];
    const rec = e as { pluginId?: unknown; version?: unknown; installed?: unknown; enabled?: unknown };
    if (typeof rec.pluginId !== 'string' || !rec.pluginId) return [];
    if (rec.installed === false) return [];
    return [
      {
        id: rec.pluginId,
        version: typeof rec.version === 'string' && rec.version ? rec.version : null,
        enabled: typeof rec.enabled === 'boolean' ? rec.enabled : true,
      },
    ];
  });
}

export async function detectCodexPlugins(opts: RunOptions = {}): Promise<AgentPluginsInfo> {
  const r = await runWithEnoentRetry(['codex', 'plugin', 'list', '--json'], opts);
  if (r.code !== 0) return pluginsUnavailable('codex plugin list failed');
  return infoFrom(parseCodexPlugins(r.output));
}

/**
 * Update Codex plugins. There is no per-plugin update command, so: refresh all
 * configured Git marketplaces (official `codex plugin marketplace upgrade`),
 * then re-install each installed plugin via `codex plugin add <id>` which
 * pulls the marketplace's current version into the versioned plugin cache.
 */
export async function updateCodexPlugins(
  plugins: AgentPluginInfo[],
  opts: RunOptions = {},
): Promise<{ code: number; output: string }> {
  const errors: string[] = [];
  const mkt = await runWithEnoentRetry(['codex', 'plugin', 'marketplace', 'upgrade', '--json'], opts);
  if (mkt.code !== 0) {
    errors.push(`codex plugin marketplace upgrade: ${mkt.output.split('\n')[0] ?? ''}`);
  }
  for (const p of plugins) {
    const r = await runWithEnoentRetry(['codex', 'plugin', 'add', p.id], opts);
    if (r.code !== 0) errors.push(`${p.id}: ${r.output.split('\n')[0] ?? `exit code ${r.code}`}`);
  }
  return errors.length
    ? { code: 1, output: errors.join('\n') }
    : { code: 0, output: `${plugins.length} plugin(s) processed` };
}

/* ---------- Grok Build ---------- */

/** Parse `grok plugin list --json` output (array; [] when none installed). */
export function parseGrokPlugins(raw: string): AgentPluginInfo[] {
  const arr = parseJsonLoose(raw);
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((e): AgentPluginInfo[] => {
    if (typeof e !== 'object' || e === null) return [];
    const rec = e as { name?: unknown; id?: unknown; version?: unknown; enabled?: unknown };
    const id = typeof rec.id === 'string' && rec.id ? rec.id : rec.name;
    if (typeof id !== 'string' || !id) return [];
    return [
      {
        id,
        version: typeof rec.version === 'string' && rec.version ? rec.version : null,
        enabled: typeof rec.enabled === 'boolean' ? rec.enabled : true,
      },
    ];
  });
}

export async function detectGrokPlugins(opts: RunOptions = {}): Promise<AgentPluginsInfo> {
  const r = await runWithEnoentRetry(['grok', 'plugin', 'list', '--json'], opts);
  if (r.code !== 0) return pluginsUnavailable('grok plugin list failed');
  return infoFrom(parseGrokPlugins(r.output));
}

/** Update all Grok plugins via the official bulk command `grok plugin update`. */
export async function updateGrokPlugins(opts: RunOptions = {}): Promise<{ code: number; output: string }> {
  return runWithEnoentRetry(['grok', 'plugin', 'update'], opts);
}
