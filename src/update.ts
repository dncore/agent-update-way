import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractVersion } from './detect.js';
import { needsShell, shellCommand, resolveBin } from './shell.js';
import type { AgentDef, DetectedAgent, TaskUpdate, UpdateResult } from './types.js';

/**
 * Run a command, retrying on spawn ENOENT — the binary was momentarily missing
 * (e.g. `npm update -g` / `<agent> update` deleted and is re-creating its bin
 * symlink while we tried to spawn it). Used by the plugin/extension update
 * tasks that spawn an agent binary right after that agent's own update.
 */
export async function runWithEnoentRetry(
  cmd: string[],
  opts: { timeoutMs?: number; retries?: number; retryDelayMs?: number } = {},
): Promise<{ code: number; output: string; errno?: string }> {
  const retries = opts.retries ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 400;
  for (let attempt = 0; ; attempt++) {
    const r = await runCommand(cmd, opts.timeoutMs ?? 300_000);
    if (r.errno === 'ENOENT' && attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
      continue;
    }
    return { code: r.code, output: r.output, errno: r.errno };
  }
}

/**
 * Gate that holds a follow-up task (agent plugins / extensions) until the host
 * agent's own update reaches a terminal state.
 *
 * When an agent is npm-managed, `npm update -g <pkg>` deletes and re-creates
 * its bin symlink; spawning the binary inside that window fails with ENOENT.
 * `updateAgents` emits a task's terminal progress event only *after* the
 * post-update version re-check, so observing that event guarantees the binary
 * is back on PATH before follow-up tasks spawn it. When the host is absent the
 * gate resolves immediately.
 */
export function createSettleGate(hostName: string | undefined): {
  /** Resolves once the host agent's own update task has reached a terminal state. */
  settled: Promise<void>;
  /** Feed every updateAgents progress event into the gate. */
  observe: (index: number, agentName: string | undefined, update: TaskUpdate) => void;
} {
  let release: (() => void) | undefined;
  const settled = hostName
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  return {
    settled,
    observe(index, agentName, update) {
      if (!hostName || agentName !== hostName) return;
      if (update.state === 'running') return;
      // first terminal event for the host releases the gate; ignore the rest
      release?.();
      release = undefined;
    },
  };
}

/**
 * Build the update command for an agent based on its install manager.
 *
 * This is the core difference from tools like aiupdate which always call the
 * agent's self-update command (`pi update pi`) — that fails for non-global
 * installs. We update via the manager that actually provides the binary:
 *
 *   npm/pnpm/bun global  →  <mgr> update -g <package>
 *   brew                 →  brew upgrade <formula>
 *   native               →  <agent> update (official self-update)
 *   project-local        →  skipped, never touched
 */
export function buildUpdateCommand(agent: DetectedAgent): string[] | null {
  const { def, manager, managerTarget, nodeRoot, brewCask, binPath } = agent;
  switch (manager) {
    case 'npm': {
      const pkg = managerTarget ?? def.npmPackage;
      if (!pkg) return null;
      // Update via the node root that owns the package (fnm/nvm may run a
      // different node version than the one that owns this global install).
      if (nodeRoot) return ['npm', 'update', '-g', '--prefix', nodeRoot, pkg];
      return ['npm', 'update', '-g', pkg];
    }
    case 'pnpm': {
      const pkg = managerTarget ?? def.npmPackage;
      return pkg ? ['pnpm', 'add', '-g', pkg] : null;
    }
    case 'bun': {
      const pkg = managerTarget ?? def.npmPackage;
      return pkg ? ['bun', 'add', '-g', pkg] : null;
    }
    case 'brew': {
      const formula = managerTarget ?? def.brewFormula;
      if (!formula) return null;
      return brewCask ? ['brew', 'upgrade', '--cask', formula] : ['brew', 'upgrade', formula];
    }
    case 'user':
      // User-level install under ~/node_modules (npm install --prefix ~).
      // Updating it safely requires the tool that created it — both
      // `npm --prefix ~` and `bun add -g` re-resolve the whole ~/package.json
      // dependency tree (slow, churns unrelated user tools). Skip with a hint.
      return null;
    case 'native':
      return def.nativeUpdate.length ? [...def.nativeUpdate] : null;
    case 'local':
      return null; // never update project dependencies
  }
}

/** Result of running one command. */
export interface CommandResult {
  code: number;
  output: string;
  stdout: string;
  stderr: string;
  /**
   * Node spawn error code when the process failed to *launch* (e.g. 'ENOENT'
   * → the binary is missing). Undefined for normal runs and non-zero exits.
   * Lets callers distinguish "binary not found" from a real failure, so they
   * can e.g. retry after a race window.
   */
  errno?: string;
}

/** Run one command, capturing output. Resolves even on non-zero exit.
 *
 * Windows: commands like `npm`, `pi` (npm shims without a .exe) cannot be
 * spawned directly — they are routed through the shell so cmd.exe resolves
 * them via PATHEXT, exactly like a user typing in a terminal.
 */
export function runCommand(
  cmd: string[],
  timeoutMs = 300_000,
): Promise<CommandResult> {
  const [bin, ...args] = cmd;
  return new Promise((resolve) => {
    if (!bin) {
      resolve({ code: 1, output: 'empty command', stdout: '', stderr: 'empty command' });
      return;
    }
    const cb = (error: ExecFileException | null, stdout: string, stderr: string) => {
      const joined = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (error) {
        // spawn/exec failures (e.g. ENOENT) produce no stdout/stderr; surface
        // the OS error message so callers and the renderer can show it.
        const output = joined || error.message.trim();
        resolve({
          code: typeof error.code === 'number' ? error.code : 1,
          output,
          stdout,
          stderr,
          errno: typeof error.code === 'string' ? error.code : undefined,
        });
      } else {
        resolve({ code: 0, output: joined, stdout, stderr });
      }
    };
    if (needsShell(process.platform, bin)) {
      execFile(shellCommand(resolveBin(bin), args), [], { timeout: timeoutMs, encoding: 'utf8', shell: true }, cb);
    } else {
      execFile(bin, args, { timeout: timeoutMs, encoding: 'utf8' }, cb);
    }
  });
}

export interface UpdateOptions {
  /** Called with the agent index whenever its progress changes (running → terminal state). */
  onProgress?: (index: number, update: TaskUpdate) => void;
  /** Override version re-check after update (mostly for tests). */
  getVersion?: (a: DetectedAgent) => Promise<string | null>;
  /** Override the GitHub latest-release check (mostly for tests). */
  getLatest?: (repo: string) => Promise<string | null>;
  /** Override the per-command timeout (ms). Default 300_000. */
  timeoutMs?: number;
}

/** Compare two dotted version strings; -1/0/1 (semver-style). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/** Query the latest published version of an npm package (best effort). */
export async function npmViewVersion(pkg: string): Promise<string | null> {
  const r = await runCommand(['npm', 'view', pkg, 'version'], 20_000);
  if (r.code !== 0) return null;
  const m = r.output.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

/** Parse the version out of GitHub's releases/latest JSON (`tag_name: "rust-v0.161.0"`). */
export function versionFromGithubReleaseJson(raw: string): string | null {
  try {
    const tag = (JSON.parse(raw) as { tag_name?: unknown }).tag_name;
    return typeof tag === 'string' ? extractVersion(tag) : null;
  } catch {
    return null;
  }
}

/**
 * Query the latest release version of a GitHub repo (best effort). Shells out
 * to curl rather than using fetch so the subprocess inherits proxy env vars —
 * the same reasoning as the staged install. Any failure (no curl, blocked
 * domain, API rate limit) yields null, which degrades the update flow to
 * "latest unknown" instead of breaking it.
 */
export async function githubLatestVersion(repo: string): Promise<string | null> {
  const r = await runCommand(
    ['curl', '-fsSL', '--max-time', '20', `https://api.github.com/repos/${repo}/releases/latest`],
    30_000,
  );
  if (r.code !== 0) return null;
  return versionFromGithubReleaseJson(r.stdout);
}

/** Platform-appropriate native-install fallback command for a def (null if none). */
export function nativeFallbackCommand(def: AgentDef, platform: NodeJS.Platform): string[] | null {
  if (!def.nativeUpdateFallback) return null;
  return platform === 'win32' ? def.nativeUpdateFallback.windows : def.nativeUpdateFallback.unix;
}

/**
 * Whether an agent's update must go through the staged (pack+swap) install
 * instead of `npm update -g`.
 *
 * On Windows, `npm update -g` reifies the package by copying files over the
 * existing install — that fails with EBUSY whenever the running tool has its
 * native modules (.node DLLs) loaded (e.g. pi's clipboard). The staged
 * install never touches the running files: it writes the new version into a
 * fresh directory and atomically swaps the directory name, leaving the old
 * (locked) directory behind until the process exits.
 */
export function needsStagedInstall(platform: NodeJS.Platform, agent: DetectedAgent): boolean {
  return platform === 'win32' && agent.manager === 'npm';
}

/**
 * Precisely update an npm package by downloading the tarball, extracting it
 * into a fresh directory and atomically swapping it into `targetDir`.
 *
 * Rationale: `npm install/update -g` (and `--prefix`) re-resolve or copy over
 * the existing directory, which on Windows fails with EBUSY whenever the
 * package's native modules are loaded by a running process. A directory
 * rename never touches the locked files, so this works while `pi` itself is
 * running — the new version is used by the next process start, and the old
 * (locked) directory is left at `<pkg>.auway.bak` for cleanup after exit.
 *
 *   1. npm view <pkg>@latest version        → compare against installed
 *   2. npm pack <pkg>@latest                 → download tarball (npm verifies
 *                                              the registry integrity hash)
 *   3. tar -xzf → package/                   → extract
 *   4. atomic swap into targetDir (keep a .bak for rollback)
 *   5. npm install --prefix <newdir> --omit=dev --no-save
 *      → installs the package's dependencies nested inside its own dir, so
 *        unrelated packages are never touched
 *
 * All subprocesses inherit the proxy env, so the proxy-only network works.
 *
 * Note: on Windows this still cannot replace a *loaded* native module (the
 * directory rename is also refused by the OS while a file inside is
 * image-locked) — callers surface a clear "exit the running process" hint.
 */
export async function installPackageStaged(
  targetDir: string,
  agent: DetectedAgent,
  getVersion: (a: DetectedAgent) => Promise<string | null>,
  timeoutMs?: number,
): Promise<UpdateResult> {
  const pkg = agent.managerTarget ?? agent.def.npmPackage;
  const before = agent.version;
  const fail = (error: string, status: 'failed' | 'skipped' = 'failed'): UpdateResult => ({
    agent,
    status,
    before,
    after: before,
    error,
  });

  if (!pkg) return fail('no npm package name for staged install', 'skipped');

  // 1. latest version
  const v = await runCommand(['npm', 'view', pkg, 'version'], timeoutMs ?? 300_000);
  if (v.code !== 0) return fail(`npm view failed: ${v.output.split('\n')[0]}`);
  const latest = v.output.trim();
  if (!latest) return fail('npm view returned no version');

  if (before && compareVersions(latest, before) <= 0) {
    return { agent, status: 'up-to-date', before, after: before };
  }

  const tmp = mkdtempSync(join(tmpdir(), 'auway-staged-'));
  const bak = `${targetDir}.auway.bak`;
  // Drop leftovers from earlier runs; those may be locked by a running
  // process, so this is best-effort.
  const rmBestEffort = (path: string): void => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // locked (native module in use) — leave it; removed after process exit
    }
  };
  rmBestEffort(bak);
  try {
    // 2. download tarball via npm pack --json (registry integrity verified by
    //    npm; JSON output keeps the filename clean of stderr noise)
    const pack = await runCommand(['npm', 'pack', `${pkg}@latest`, '--pack-destination', tmp, '--json'], timeoutMs ?? 300_000);
    if (pack.code !== 0) return fail(`npm pack failed: ${pack.output.split('\n')[0]}`);
    let tarballName: string | undefined;
    try {
      const arr = JSON.parse(pack.stdout) as { filename?: string }[];
      tarballName = arr[0]?.filename;
    } catch {
      tarballName = undefined;
    }
    if (!tarballName) return fail('npm pack produced no tarball');

    // 3. extract. Windows paths must be forward-slashed for the MSYS GNU tar.
    const extractDir = join(tmp, 'x');
    mkdirSync(extractDir, { recursive: true });
    const tarballPath = join(tmp, tarballName).replace(/\\/g, '/');
    const x = await runCommand(
      ['tar', '--force-local', '-xzf', tarballPath, '-C', extractDir.replace(/\\/g, '/')],
      timeoutMs ?? 300_000,
    );
    if (x.code !== 0) return fail(`extract failed: ${x.output.split('\n')[0]}`);
    const pkgDir = join(extractDir, 'package');
    if (!existsSync(pkgDir)) return fail('tarball has no package/ directory');

    // 4. atomic swap with backup for rollback (directory rename never
    //    touches locked files inside the old directory)
    if (existsSync(targetDir)) renameSync(targetDir, bak);
    try {
      renameSync(pkgDir, targetDir);
    } catch {
      if (existsSync(bak)) renameSync(bak, targetDir);
      return fail('failed to swap package directory');
    }

    // 5. nested dependencies (isolated from the rest of node_modules)
    const dep = await runCommand(
      ['npm', 'install', '--prefix', targetDir, '--omit=dev', '--no-save', '--package-lock=false'],
      timeoutMs ?? 600_000,
    );
    if (dep.code !== 0) {
      // rollback to previous version
      rmBestEffort(targetDir);
      if (existsSync(bak)) renameSync(bak, targetDir);
      return fail(`dependency install failed: ${dep.output.split('\n')[0]}`);
    }

    // New version writes are all fresh files; the old directory may still
    // hold locked native modules — drop it now, or leave it for cleanup.
    rmBestEffort(bak);
    const after = await getVersion(agent);
    return { agent, status: 'updated', before, after };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    rmBestEffort(tmp);
  }
}

/**
 * Update a user-level install under ~/node_modules without touching the rest
 * of the tree: staged tarball install into the package's directory.
 */
async function updateUserLevelInstall(
  agent: DetectedAgent,
  getVersion: (a: DetectedAgent) => Promise<string | null>,
): Promise<UpdateResult> {
  const pkg = agent.managerTarget ?? agent.def.npmPackage;
  const fail = (error: string, status: 'failed' | 'skipped' = 'failed'): UpdateResult => ({
    agent,
    status,
    before: agent.version,
    after: agent.version,
    error,
  });

  if (!pkg) return fail('no npm package name for user-level install', 'skipped');
  const nmIdx = agent.realPath.indexOf('/node_modules/');
  if (nmIdx === -1) return fail('cannot locate node_modules root', 'skipped');
  const targetDir = join(agent.realPath.slice(0, nmIdx), 'node_modules', ...pkg.split('/'));
  return installPackageStaged(targetDir, agent, getVersion);
}

/**
 * Detect whether a process whose command line contains `match` is running
 * (Windows only; POSIX does not lock files this way).
 */
async function isProcessRunning(match: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const r = await runCommand(
      [
        'powershell',
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${match.replace(/'/g, '')}' }).Count`,
      ],
      15_000,
    );
    return r.code === 0 && Number.parseInt(r.stdout, 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Update agents concurrently. Each agent's update is independent; failures in
 * one do not block others. Progress is streamed via `onProgress` so renderers
 * can paint live per-task status.
 */
export async function updateAgents(agents: DetectedAgent[], opts: UpdateOptions = {}): Promise<UpdateResult[]> {
  const { onProgress, getVersion } = opts;
  const getLatest = opts.getLatest ?? githubLatestVersion;
  const getVersionAfter = getVersion ?? (async (a: DetectedAgent) => {
    // re-run version command after update
    const [bin, ...rest] = a.def.versionCmd;
    if (!bin) return null;
    try {
      const { execFileSync } = await import('node:child_process');
      const raw = needsShell(process.platform, bin)
        ? execFileSync(shellCommand(resolveBin(bin), rest), {
            encoding: 'utf8',
            timeout: 10_000,
            shell: true,
          }).trim()
        : execFileSync(bin, rest, {
            encoding: 'utf8',
            timeout: 10_000,
          }).trim();
      return extractVersion(raw);
    } catch {
      return null;
    }
  });

  const results = await Promise.all(
    agents.map(async (agent, index): Promise<UpdateResult> => {
      const before = agent.version;
      const fail = (status: 'failed' | 'skipped', error: string): UpdateResult => {
        onProgress?.(index, { state: status, before, after: before, error });
        return { agent, status, before, after: before, error };
      };

      if (agent.manager === 'local') {
        return fail('skipped', agent.skipReason ?? 'project-local install');
      }

      // user-level installs under ~/node_modules get a precise, isolated update
      if (agent.manager === 'user') {
        onProgress?.(index, { state: 'running', before });
        const result = await updateUserLevelInstall(agent, getVersionAfter);
        const terminal: TaskUpdate =
          result.status === 'updated' || result.status === 'up-to-date'
            ? { state: 'success', before: result.before, after: result.after }
            : { state: result.status, before: result.before, after: result.after, error: result.error };
        onProgress?.(index, terminal);
        return result;
      }

      // npm global installs: staged (pack+swap) on Windows — `npm update -g`
      // copies over the running install and fails with EBUSY on loaded native
      // modules; a directory rename bypasses that. On POSIX, skip when already
      // at the latest version to avoid a pointless `npm update -g` reify.
      if (agent.manager === 'npm') {
        const pkg = agent.managerTarget ?? agent.def.npmPackage;
        if (!pkg) return fail('skipped', 'no npm package name for npm install');
        onProgress?.(index, { state: 'running', before });

        if (needsStagedInstall(process.platform, agent)) {
          const nodeRoot = agent.nodeRoot;
          if (!nodeRoot) return fail('failed', 'cannot locate node root for staged install');
          const targetDir = join(nodeRoot, 'node_modules', ...pkg.split('/'));
          const result = await installPackageStaged(targetDir, agent, getVersionAfter, opts.timeoutMs);
          // Windows refuses to swap a directory while one of its native
          // modules is loaded by a running process — give a precise hint.
          if (result.status === 'failed' && /EBUSY|EPERM|EACCES/i.test(result.error ?? '')) {
            const seg = pkg.split('/').pop() ?? pkg;
            if (await isProcessRunning(seg)) {
              const others = agents.filter((a) => a.def.name !== agent.def.name).map((a) => a.def.name).join(' ');
              result.error = `${result.error}\n\nA ${seg} process is still running and its native modules are locked. Exit it, then re-run (or update the others now: \`auway update ${others}\`).`;
            }
          }
          const terminal: TaskUpdate =
            result.status === 'updated' || result.status === 'up-to-date'
              ? { state: 'success', before: result.before, after: result.after }
              : { state: result.status, before: result.before, after: result.after, error: result.error };
          onProgress?.(index, terminal);
          return result;
        }

        if (agent.version) {
          const latest = await npmViewVersion(pkg);
          if (latest && compareVersions(latest, agent.version) <= 0) {
            onProgress?.(index, { state: 'success', before, after: before });
            return { agent, status: 'up-to-date', before, after: before };
          }
        }
        const cmd = buildUpdateCommand(agent);
        if (!cmd) return fail('skipped', agent.skipReason ?? 'no update command available');
        const { code, output } = await runCommand(cmd, opts.timeoutMs);
        if (code !== 0) {
          return fail('failed', output.split('\n').slice(0, 8).join('\n') || `exit code ${code}`);
        }
        const afterNpm = await getVersionAfter(agent);
        const changedNpm = afterNpm !== null && before !== afterNpm;
        onProgress?.(index, { state: 'success', before, after: afterNpm });
        return { agent, status: changedNpm ? 'updated' : 'up-to-date', before, after: afterNpm };
      }

      const cmd = buildUpdateCommand(agent);
      if (!cmd) {
        return fail('skipped', agent.skipReason ?? 'no update command available');
      }

      onProgress?.(index, { state: 'running', before });

      // Native installs with a GitHub release source (codex): pre-check the
      // latest version, same idea as the npm path's npmViewVersion check. The
      // official self-update bootstraps from vendor domains (chatgpt.com) that
      // are unreachable on some networks, and `curl … | sh` exits 0 with an
      // empty pipe (fake success) — the version comparison is the only
      // reliable signal there.
      const latest = agent.def.githubReleaseRepo
        ? await getLatest(agent.def.githubReleaseRepo)
        : null;
      if (latest && before && compareVersions(before, latest) >= 0) {
        onProgress?.(index, { state: 'success', before, after: before });
        return { agent, status: 'up-to-date', before, after: before };
      }

      let { code, output } = await runCommand(cmd, opts.timeoutMs);
      let after = await getVersionAfter(agent);

      // Self-update failed, or silently no-oped (exit 0 but still behind
      // latest) → retry through the GitHub Releases bootstrap.
      const behind = latest !== null && (after === null || compareVersions(after, latest) < 0);
      const fallback = nativeFallbackCommand(agent.def, process.platform);
      if (fallback && (code !== 0 || behind)) {
        const fb = await runCommand(fallback, opts.timeoutMs);
        code = fb.code;
        output = fb.output;
        after = await getVersionAfter(agent);
      }

      if (code !== 0) {
        return fail('failed', output.split('\n').slice(0, 8).join('\n') || `exit code ${code}`);
      }
      // Exit 0 alone is not proof of an update (blocked bootstrap pipes exit
      // 0 without doing anything); when latest is known, require the binary
      // to actually be at it.
      if (latest !== null && (after === null || compareVersions(after, latest) < 0)) {
        return fail(
          'failed',
          `update did not take effect: still ${after ?? before ?? '?'} (latest ${latest})`,
        );
      }

      const changed = after !== null && before !== after;
      const status = changed ? 'updated' : 'up-to-date';
      onProgress?.(index, { state: 'success', before, after });
      return { agent, status, before, after };
    }),
  );
  return results;
}
