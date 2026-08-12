import { execFileSync, execFile } from 'node:child_process';
import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KNOWN_AGENTS } from './agents.js';
import type { AgentDef, DetectedAgent, InstallManager } from './types.js';

/** Path markers used to classify where a binary lives. */
const MARKERS = {
  // npm global install roots: <nodeRoot>/lib/node_modules/<pkg> (any node version, incl. fnm/nvm)
  npmGlobal: '/lib/node_modules/',
  pnpmGlobal: '/global/5/', // pnpm global store: ~/.local/share/pnpm/global/5/node_modules
  bunGlobal: '/.bun/install/global/', // bun global: ~/.bun/install/global/node_modules
  bunBin: '/.bun/bin/',
  // homebrew
  brewBin: '/opt/homebrew/bin/',
  brewCellar: '/opt/homebrew/Cellar/',
  brewCaskroom: '/opt/homebrew/Caskroom/',
  brewLinuxBin: '/home/linuxbrew/.linuxbrew/bin/',
  brewLinuxCellar: '/home/linuxbrew/.linuxbrew/Cellar/',
  brewLinuxCaskroom: '/home/linuxbrew/.linuxbrew/Caskroom/',
};

/** Run a command, returning trimmed stdout, or null on failure. */
function tryRun(cmd: string[], timeoutMs = 15_000): string | null {
  const [bin, ...args] = cmd;
  if (!bin) return null;
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** `which`-style lookup honoring PATH, like a shell would. */
export function which(cmd: string): string | null {
  const pathEnv = process.env.PATH ?? '';
  const pathExt =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '').split(';').filter(Boolean) : [];
  for (const dir of pathEnv.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    const full = join(dir, cmd);
    if (existsSync(full)) return full;
    if (pathExt.length) {
      for (const ext of pathExt) {
        const withExt = `${full}${ext}`;
        if (existsSync(withExt)) return withExt;
      }
    }
  }
  return null;
}

/** Resolve a symlink chain to the real file (fall back to input on error). */
export function resolveRealPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // realpathSync already resolves links; fall back to manual single-level resolve
    try {
      const link = readlinkSync(p);
      return link.startsWith('/') ? link : join(process.cwd(), link);
    } catch {
      return p;
    }
  }
}

/** Find the global npm root (`npm root -g`), cached. */
let cachedNpmRoot: string | null | undefined;
export function npmGlobalRoot(): string | null {
  if (cachedNpmRoot !== undefined) return cachedNpmRoot;
  const root = tryRun(['npm', 'root', '-g']);
  cachedNpmRoot = root && existsSync(root) ? root : null;
  return cachedNpmRoot;
}

/**
 * For a path under <nodeRoot>/lib/node_modules/<pkg>, extract the node
 * installation root that owns the package. Works with fnm/nvm where multiple
 * node versions coexist (we must update via the node root that owns the pkg,
 * not the node currently first in PATH).
 */
export function nodeRootFromPath(realPath: string): string | null {
  const idx = realPath.indexOf(MARKERS.npmGlobal);
  if (idx === -1) return null;
  return realPath.slice(0, idx);
}

/** Extract the package name from a path like .../node_modules/@scope/pkg/dist/cli.js. */
export function packageNameFromPath(realPath: string): string | null {
  const idx = realPath.indexOf('/node_modules/');
  if (idx === -1) return null;
  const rest = realPath.slice(idx + '/node_modules/'.length);
  const [first, second] = rest.split('/');
  if (!first) return null;
  if (first.startsWith('@') && second) return `${first}/${second}`;
  return first;
}

/**
 * Classify the install manager based on the real path.
 *
 * All `/node_modules/` paths are handled here: global stores (npm/pnpm/bun)
 * are updated via their manager; everything else under node_modules is a
 * project-local dependency and must never be auto-updated (this is what
 * happens when `npx auway` runs inside a project that depends on pi/claude
 * locally — the real path resolves to node_modules/<pkg>, not .bin/).
 */
export function classifyManager(realPath: string, home: string = homedir()): {
  manager: InstallManager;
  target?: string;
  nodeRoot?: string;
  brewCask?: boolean;
} {
  if (realPath.includes('/node_modules/')) {
    // user-level install: <home>/node_modules/<pkg> (npm install --prefix ~)
    const homeNodeModules = join(home, 'node_modules');
    if (realPath.startsWith(homeNodeModules + '/')) {
      return { manager: 'user', target: packageNameFromPath(realPath) ?? undefined };
    }
    // global npm store: <nodeRoot>/lib/node_modules/<pkg> (fnm/nvm/system)
    const npmIdx = realPath.indexOf(MARKERS.npmGlobal);
    if (npmIdx !== -1) {
      const nodeRoot = realPath.slice(0, npmIdx);
      const pkg = packageNameFromPath(realPath);
      if (nodeRoot && pkg) {
        return { manager: 'npm', target: pkg, nodeRoot };
      }
    }
    // pnpm global store
    if (realPath.includes(MARKERS.pnpmGlobal)) {
      return { manager: 'pnpm', target: packageNameFromPath(realPath) ?? undefined };
    }
    // bun global store
    if (realPath.includes(MARKERS.bunGlobal)) {
      return { manager: 'bun', target: packageNameFromPath(realPath) ?? undefined };
    }
    // anything else under node_modules → project-local dependency
    return { manager: 'local' };
  }
  // bun bin shim (~/.bun/bin/<cmd>)
  if (realPath.includes(MARKERS.bunBin)) {
    return { manager: 'bun', target: packageNameFromPath(realPath) ?? undefined };
  }
  // homebrew cask (macOS arm64)
  if (
    realPath.startsWith(MARKERS.brewCaskroom) ||
    realPath.startsWith(MARKERS.brewLinuxCaskroom)
  ) {
    const formula = brewFormulaFromPath(realPath);
    return { manager: 'brew', target: formula ?? undefined, brewCask: true };
  }
  // homebrew formula
  if (
    realPath.startsWith(MARKERS.brewBin) ||
    realPath.startsWith(MARKERS.brewCellar) ||
    realPath.startsWith(MARKERS.brewLinuxBin) ||
    realPath.startsWith(MARKERS.brewLinuxCellar)
  ) {
    const formula = brewFormulaFromPath(realPath);
    return { manager: 'brew', target: formula ?? undefined, brewCask: false };
  }
  return { manager: 'native' };
}

/** Derive the brew formula/cask name from a Cellar or Caskroom path. */
export function brewFormulaFromPath(realPath: string): string | null {
  for (const marker of [MARKERS.brewCellar, MARKERS.brewLinuxCellar, MARKERS.brewCaskroom, MARKERS.brewLinuxCaskroom]) {
    const idx = realPath.indexOf(marker);
    if (idx !== -1) {
      const rest = realPath.slice(idx + marker.length);
      const formula = rest.split('/')[0];
      return formula || null;
    }
  }
  // /opt/homebrew/bin/<name> → look up the formula that owns this bin
  const base = realPath.split('/').pop();
  if (base) {
    const out = tryRun(['brew', 'list', '--formula'], 30_000);
    if (out) {
      for (const line of out.split('\n')) {
        const name = line.trim();
        if (name === base || name === base.replace(/^@/, '')) return name;
      }
    }
  }
  return null;
}

/** Fetch a version string for an agent (best effort). */
export function getVersion(def: AgentDef): string | null {
  const raw = tryRun(def.versionCmd, 10_000);
  return raw ? extractVersion(raw) : null;
}

/** Async version check (parallel-friendly). */
export function getVersionAsync(def: AgentDef): Promise<string | null> {
  const [bin, ...args] = def.versionCmd;
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve(null);
      } else {
        resolve(extractVersion(`${stdout}\n${stderr}`));
      }
    });
  });
}

/**
 * Detect all installed known agents, checking versions in parallel.
 * (Sync serial version checks cost ~3s for 5 agents; parallel ~0.7s.)
 */
export async function detectAllAsync(): Promise<DetectedAgent[]> {
  const found: { def: AgentDef; binPath: string }[] = [];
  for (const def of KNOWN_AGENTS) {
    const binPath = which(def.name);
    if (binPath) found.push({ def, binPath });
  }
  const versions = await Promise.all(found.map((f) => getVersionAsync(f.def)));

  return found.map((f, i): DetectedAgent => {
    const realPath = resolveRealPath(f.binPath);
    const { manager, target, nodeRoot, brewCask } = classifyManager(realPath);
    const agent: DetectedAgent = {
      def: f.def,
      binPath: f.binPath,
      realPath,
      manager,
      managerTarget: target,
      nodeRoot,
      brewCask,
      version: versions[i] ?? null,
    };
    if (manager === 'local') {
      agent.skipReason =
        'project-local dependency (under node_modules) - not a global install, skipping';
    } else if (manager === 'user') {
      // Structured hint: short first line, then a copy-paste update command.
      const pkg = target ?? f.def.npmPackage;
      const hint =
        f.binPath === join(homedir(), '.bun', 'bin', f.def.name) && pkg
          ? `bun add -g ${pkg}`
          : pkg
            ? `npm update --prefix ~ ${pkg}`
            : 'update it via the tool that installed it';
      agent.skipReason = `user-level install under ~/node_modules\nTo update manually: ${hint}\n(auway only auto-updates standard global installs)`;
    } else if (manager === 'native' && !f.def.nativeUpdate.length) {
      agent.skipReason = `no known update command for native install of ${f.def.label}`;
    }
    return agent;
  });
}

/** Extract the first semver-like token (x.y.z) from arbitrary command output. */
export function extractVersion(raw: string): string | null {
  const m = raw.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

/**
 * Detect all installed known agents.
 *
 * The critical improvement over naive tools:
 * - we resolve the real path (readlink), so we are not fooled by PATH shims or
 *   project-local `node_modules/.bin` entries that `npx` prepends;
 * - we classify the install manager and only ever update via that manager.
 */
export function detectAll(): DetectedAgent[] {
  const results: DetectedAgent[] = [];
  for (const def of KNOWN_AGENTS) {
    const binPath = which(def.name);
    if (!binPath) continue;

    const realPath = resolveRealPath(binPath);
    const { manager, target, nodeRoot, brewCask } = classifyManager(realPath);
    const version = getVersion(def);

    const agent: DetectedAgent = {
      def,
      binPath,
      realPath,
      manager,
      managerTarget: target,
      nodeRoot,
      brewCask,
      version,
    };

    if (manager === 'local') {
      agent.skipReason =
        'project-local dependency (under node_modules) - not a global install, skipping';
    } else if (manager === 'user') {
      const pkg = target ?? def.npmPackage;
      const hint =
        binPath === join(homedir(), '.bun', 'bin', def.name) && pkg
          ? `bun add -g ${pkg}`
          : pkg
            ? `npm update --prefix ~ ${pkg}`
            : 'update it via the tool that installed it';
      agent.skipReason = `user-level install under ~/node_modules\nTo update manually: ${hint}\n(auway only auto-updates standard global installs)`;
    } else if (manager === 'native' && !def.nativeUpdate.length) {
      agent.skipReason = `no known update command for native install of ${def.label}`;
    }
    results.push(agent);
  }
  return results;
}

/** Human-readable manager name. */
export function managerLabel(m: InstallManager): string {
  switch (m) {
    case 'npm':
      return 'npm global';
    case 'pnpm':
      return 'pnpm global';
    case 'bun':
      return 'bun global';
    case 'brew':
      return 'homebrew';
    case 'user':
      return 'user-level (~/node_modules)';
    case 'native':
      return 'native';
    case 'local':
      return 'project-local';
  }
}

/** npm global home for display purposes. */
export function globalInstallHint(): string {
  const root = npmGlobalRoot();
  return root ? root : 'npm root -g';
}
