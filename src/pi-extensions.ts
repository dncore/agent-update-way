import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, runCommand } from './update.js';
import type { PiExtensionsInfo, PiPackageInfo } from './types.js';

/**
 * Pi extension / skill package support.
 *
 * pi stores installed packages in settings.json under the `packages` key
 * (global: `~/.pi/agent/settings.json`, project: `.pi/settings.json`) and
 * installs them into `~/.pi/agent/npm/node_modules/<pkg>` (npm) or
 * `~/.pi/agent/git/<host>/<path>` (git).
 *
 * auway only *detects* extensions itself (read-only: settings.json + installed
 * package.json + `npm view` for the latest version). The actual update is
 * delegated to pi's native `pi update --extensions`, which handles npm +
 * git packages, pinned-version skips and git ref reconciliation exactly as pi
 * manages them (separate module roots, production installs, peer deps).
 */

export interface PiExtensionsOptions {
  /** Override home dir (tests). */
  home?: string;
  /** Override project dir (tests). */
  cwd?: string;
  /** Override the `npm view <pkg> version` check (tests). */
  npmView?: (pkg: string) => Promise<string | null>;
}

interface CollectedSource {
  source: string;
  /** Base dir this package belongs to (global `~/.pi/agent` or project `.pi`). */
  base: string;
}

interface ParsedSource {
  type: 'npm' | 'git' | 'local';
  name: string;
  pinned: boolean;
  /** For git: the clean URL with any `@ref` already stripped. */
  url?: string;
}

/* ---------- settings reading ---------- */

/**
 * Collect package sources from the global (`~/.pi/agent/settings.json`) and
 * project (`.pi/settings.json`) settings files, in that order. Entries may be
 * plain strings or `{ source }` objects (the object form is used for resource
 * filtering). Duplicates are dropped (global wins).
 */
export function collectPiSources(home: string = homedir(), cwd: string = process.cwd()): CollectedSource[] {
  const entries: CollectedSource[] = [];
  const read = (path: string, base: string): void => {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { packages?: unknown };
      if (!Array.isArray(raw.packages)) return;
      for (const entry of raw.packages) {
        const src = typeof entry === 'string' ? entry : (entry as { source?: unknown })?.source;
        if (typeof src === 'string' && src.trim()) entries.push({ source: src.trim(), base });
      }
    } catch {
      // missing or unreadable settings → no packages
    }
  };
  read(join(home, '.pi', 'agent', 'settings.json'), join(home, '.pi', 'agent'));
  read(join(cwd, '.pi', 'settings.json'), join(cwd, '.pi'));

  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.source)) return false;
    seen.add(e.source);
    return true;
  });
}

/* ---------- source parsing ---------- */

/** Parse a `packages` entry into {type, name, pinned}. Returns null if invalid. */
export function parsePiSource(source: string): ParsedSource | null {
  const s = source.trim();
  if (!s) return null;

  // npm:<pkg>[@version] — scoped names are @scope/pkg; a trailing @version pins.
  if (s.startsWith('npm:')) {
    const spec = s.slice(4);
    if (spec.startsWith('@')) {
      // '@scope/pkg' or '@scope/pkg@1.0.0' → version delimiter is the last '@'
      // that is not the leading scope marker.
      const at = spec.lastIndexOf('@');
      if (at > 0) return { type: 'npm', name: spec.slice(0, at), pinned: true };
      return { type: 'npm', name: spec, pinned: false };
    }
    const at = spec.lastIndexOf('@');
    if (at > 0) return { type: 'npm', name: spec.slice(0, at), pinned: true };
    return { type: 'npm', name: spec, pinned: false };
  }

  // git / protocol URLs / scp-like ssh
  if (
    s.startsWith('git:') ||
    s.startsWith('https://') ||
    s.startsWith('http://') ||
    s.startsWith('ssh://') ||
    s.startsWith('git@')
  ) {
    let url = s.startsWith('git:') ? s.slice(4) : s;
    // A trailing @ref (no '/' or ':' after it) is a pinned tag/commit/branch.
    const at = url.lastIndexOf('@');
    if (at > 0 && !url.slice(at + 1).includes('/') && !url.slice(at + 1).includes(':')) {
      url = url.slice(0, at);
      const { host, path } = repoId(url);
      return { type: 'git', name: `${host}/${path}`, pinned: true, url };
    }
    const { host, path } = repoId(url);
    return { type: 'git', name: `${host}/${path}`, pinned: false, url };
  }

  // local path (absolute or relative)
  return { type: 'local', name: s, pinned: true };
}

/** Normalize any git URL to {host, path}, e.g. git@github.com:user/repo → github.com/user/repo. */
export function repoId(url: string): { host: string; path: string } {
  let u = url;
  for (const proto of ['ssh://', 'https://', 'http://']) {
    if (u.startsWith(proto)) {
      u = u.slice(proto.length);
      break;
    }
  }
  const at = u.indexOf('@');
  if (at !== -1) u = u.slice(at + 1); // strip user@ (git@host:path, ssh://git@host)
  const colon = u.indexOf(':');
  if (colon !== -1) u = u.slice(0, colon) + '/' + u.slice(colon + 1); // scp-like host:path
  if (u.endsWith('.git')) u = u.slice(0, -4);
  const [host, ...rest] = u.split('/');
  return { host: host ?? '', path: rest.join('/') };
}

/* ---------- installed metadata ---------- */

/** Read the `version` from <dir>/package.json, or null. */
export function readPackageVersion(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Short HEAD rev of a git clone, or null. */
export function gitShortRev(dir: string): string | null {
  if (!existsSync(join(dir, '.git'))) return null;
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Resolve a PiPackageInfo from a collected source (sync, no network). */
export function buildPkg(source: string, base: string): PiPackageInfo {
  const parsed = parsePiSource(source);
  if (!parsed) {
    return { source, name: source, type: 'local', pinned: false, installed: null, latest: null, outdated: false, path: source };
  }
  if (parsed.type === 'npm') {
    const dir = join(base, 'npm', 'node_modules', ...parsed.name.split('/'));
    return {
      source,
      name: parsed.name,
      type: 'npm',
      pinned: parsed.pinned,
      installed: readPackageVersion(dir),
      latest: null,
      outdated: false,
      path: dir,
    };
  }
  if (parsed.type === 'git' && parsed.url) {
    const { host, path } = repoId(parsed.url);
    const dir = join(base, 'git', host, path);
    return {
      source,
      name: `${host}/${path}`,
      type: 'git',
      pinned: parsed.pinned,
      installed: gitShortRev(dir),
      latest: null,
      outdated: false,
      path: dir,
    };
  }
  // local path (relative → resolved against the settings file directory = base)
  const dir = source.startsWith('/') ? source : join(base, source);
  return {
    source,
    name: dir.split('/').pop() ?? source,
    type: 'local',
    pinned: true,
    installed: readPackageVersion(dir),
    latest: null,
    outdated: false,
    path: dir,
  };
}

/* ---------- npm latest ---------- */

const npmViewCache = new Map<string, Promise<string | null>>();

/** Query the latest published version of an npm package (parallel-friendly). */
export function npmViewLatest(pkg: string): Promise<string | null> {
  const cached = npmViewCache.get(pkg);
  if (cached) return cached;
  const p = (async () => {
    const r = await runCommand(['npm', 'view', pkg, 'version'], 20_000);
    if (r.code !== 0) return null;
    const v = r.stdout.trim().split('\n').pop()?.trim();
    return v && /^\d+\.\d+/.test(v) ? v : null;
  })();
  npmViewCache.set(pkg, p);
  return p;
}

/* ---------- detection ---------- */

/**
 * Detect installed pi extension packages (read-only).
 *
 * - npm packages: installed version from disk, latest via `npm view` (parallel),
 *   `outdated` = installed < latest and not pinned.
 * - git / local packages: reported as installed; update-availability is unknown
 *   without network git ops, so `outdated` stays false (pi reconciles git refs
 *   during `pi update --extensions`).
 */
export async function detectPiExtensions(opts: PiExtensionsOptions = {}): Promise<PiExtensionsInfo> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const sources = collectPiSources(home, cwd);
  if (!sources.length) {
    return {
      enabled: false,
      packages: [],
      total: 0,
      npmCount: 0,
      gitCount: 0,
      outdated: [],
      outdatedCount: 0,
      summary: 'no pi extensions installed',
    };
  }

  const packages: PiPackageInfo[] = sources.map(({ source, base }) => buildPkg(source, base));

  // parallel latest-version checks for npm packages (network)
  const npmPkgs = packages.filter((p) => p.type === 'npm');
  const npmView = opts.npmView ?? npmViewLatest;
  const latestByPkg = new Map<string, string | null>();
  await Promise.all(
    npmPkgs.map(async (p) => {
      latestByPkg.set(p.name, await npmView(p.name));
    }),
  );
  for (const p of packages) {
    if (p.type !== 'npm') continue;
    p.latest = latestByPkg.get(p.name) ?? null;
    p.outdated =
      !p.pinned &&
      p.installed !== null &&
      p.latest !== null &&
      compareVersions(p.latest, p.installed) > 0;
  }

  const outdated = packages.filter((p) => p.outdated).map((p) => p.name);
  const total = packages.length;
  const npmCount = packages.filter((p) => p.type === 'npm').length;
  const gitCount = packages.filter((p) => p.type === 'git').length;
  const outdatedCount = outdated.length;

  const summary =
    outdatedCount === 0
      ? `${total} package${total === 1 ? '' : 's'} up to date`
      : `${total} package${total === 1 ? '' : 's'} · ${outdatedCount} update${outdatedCount === 1 ? '' : 's'} available`;

  return { enabled: true, packages, total, npmCount, gitCount, outdated, outdatedCount, summary };
}

/* ---------- update ---------- */

/** Run pi's native extension update (`pi update --extensions`). */
export async function updatePiExtensions(opts: { piCmd?: string; timeoutMs?: number } = {}): Promise<{
  code: number;
  output: string;
}> {
  const cmd = [opts.piCmd ?? 'pi', 'update', '--extensions'];
  const r = await runCommand(cmd, opts.timeoutMs ?? 300_000);
  return { code: r.code, output: r.output };
}

/** One-line status for the aggregate renderer row, e.g. "8 packages · 2 outdated". */
export function extensionsStatusLine(info: PiExtensionsInfo): string {
  if (!info.total) return '0 packages';
  return info.outdatedCount > 0
    ? `${info.total} package${info.total === 1 ? '' : 's'} · ${info.outdatedCount} outdated`
    : `${info.total} package${info.total === 1 ? '' : 's'}`;
}
