import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractVersion } from './detect.js';
import type { DetectedAgent, TaskUpdate, UpdateResult } from './types.js';

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

/** Run one command, capturing output. Resolves even on non-zero exit. */
export function runCommand(
  cmd: string[],
  timeoutMs = 300_000,
): Promise<{ code: number; output: string; stdout: string; stderr: string }> {
  const [bin, ...args] = cmd;
  return new Promise((resolve) => {
    if (!bin) {
      resolve({ code: 1, output: 'empty command', stdout: '', stderr: 'empty command' });
      return;
    }
    execFile(
      bin,
      args,
      { timeout: timeoutMs, encoding: 'utf8' },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (error) {
          resolve({ code: typeof error.code === 'number' ? error.code : 1, output, stdout, stderr });
        } else {
          resolve({ code: 0, output, stdout, stderr });
        }
      },
    );
  });
}

export interface UpdateOptions {
  /** Called with the agent index whenever its progress changes (running → terminal state). */
  onProgress?: (index: number, update: TaskUpdate) => void;
  /** Override version re-check after update (mostly for tests). */
  getVersion?: (a: DetectedAgent) => Promise<string | null>;
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

/**
 * Precisely update a user-level install under ~/node_modules without touching
 * the rest of the tree. `npm install --prefix ~` / `bun add -g` would
 * re-resolve the whole ~/package.json dependency tree (churn 100+ unrelated
 * packages), so instead we:
 *
 *   1. npm view <pkg>@latest version        → compare against installed
 *   2. npm pack <pkg>@latest                 → download tarball (npm verifies
 *                                              the registry integrity hash)
 *   3. tar -xzf → package/                   → extract
 *   4. atomic swap into ~/node_modules/<pkg> (keep a .bak for rollback)
 *   5. npm install --prefix <pkgdir> --omit=dev --no-save
 *      → installs the package's dependencies nested inside its own dir, so
 *        unrelated packages in ~/node_modules are never touched
 *
 * All subprocesses inherit the proxy env, so the proxy-only network works.
 */
async function updateUserLevelInstall(
  agent: DetectedAgent,
  getVersion: (a: DetectedAgent) => Promise<string | null>,
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

  if (!pkg) return fail('no npm package name for user-level install', 'skipped');
  const nmIdx = agent.realPath.indexOf('/node_modules/');
  if (nmIdx === -1) return fail('cannot locate node_modules root', 'skipped');
  const targetDir = join(agent.realPath.slice(0, nmIdx), 'node_modules', ...pkg.split('/'));

  // 1. latest version
  const v = await runCommand(['npm', 'view', pkg, 'version']);
  if (v.code !== 0) return fail(`npm view failed: ${v.output.split('\n')[0]}`);
  const latest = v.output.trim();
  if (!latest) return fail('npm view returned no version');

  if (before && compareVersions(latest, before) <= 0) {
    return { agent, status: 'up-to-date', before, after: before };
  }

  const tmp = mkdtempSync(join(tmpdir(), 'auway-user-'));
  try {
    // 2. download tarball via npm pack --json (registry integrity verified by
    //    npm; JSON output keeps the filename clean of stderr noise)
    const pack = await runCommand([
      'npm',
      'pack',
      `${pkg}@latest`,
      '--pack-destination',
      tmp,
      '--json',
    ]);
    if (pack.code !== 0) return fail(`npm pack failed: ${pack.output.split('\n')[0]}`);
    let tarballName: string | undefined;
    try {
      const arr = JSON.parse(pack.stdout) as { filename?: string }[];
      tarballName = arr[0]?.filename;
    } catch {
      tarballName = undefined;
    }
    if (!tarballName) return fail('npm pack produced no tarball');

    // 3. extract
    const extractDir = join(tmp, 'x');
    mkdirSync(extractDir, { recursive: true });
    const x = await runCommand(['tar', '-xzf', join(tmp, tarballName), '-C', extractDir]);
    if (x.code !== 0) return fail(`extract failed: ${x.output.split('\n')[0]}`);
    const pkgDir = join(extractDir, 'package');
    if (!existsSync(pkgDir)) return fail('tarball has no package/ directory');

    // 4. atomic swap with backup for rollback
    const bak = `${targetDir}.auway.bak`;
    if (existsSync(bak)) rmSync(bak, { recursive: true, force: true });
    if (existsSync(targetDir)) renameSync(targetDir, bak);
    try {
      renameSync(pkgDir, targetDir);
    } catch {
      if (existsSync(bak)) renameSync(bak, targetDir);
      return fail('failed to swap package directory');
    }

    // 5. nested dependencies (isolated from ~/node_modules)
    const dep = await runCommand(
      ['npm', 'install', '--prefix', targetDir, '--omit=dev', '--no-save', '--package-lock=false'],
      600_000,
    );
    if (dep.code !== 0) {
      // rollback to previous version
      rmSync(targetDir, { recursive: true, force: true });
      if (existsSync(bak)) renameSync(bak, targetDir);
      return fail(`dependency install failed: ${dep.output.split('\n')[0]}`);
    }

    rmSync(bak, { recursive: true, force: true });
    const after = await getVersion(agent);
    return { agent, status: 'updated', before, after };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Update agents concurrently. Each agent's update is independent; failures in
 * one do not block others. Progress is streamed via `onProgress` so renderers
 * can paint live per-task status.
 */
export async function updateAgents(agents: DetectedAgent[], opts: UpdateOptions = {}): Promise<UpdateResult[]> {
  const { onProgress, getVersion } = opts;
  const getVersionAfter = getVersion ?? (async (a: DetectedAgent) => {
    // re-run version command after update
    const [bin, ...rest] = a.def.versionCmd;
    if (!bin) return null;
    try {
      const { execFileSync } = await import('node:child_process');
      const raw = execFileSync(bin, rest, {
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

      const cmd = buildUpdateCommand(agent);
      if (!cmd) {
        return fail('skipped', agent.skipReason ?? 'no update command available');
      }

      onProgress?.(index, { state: 'running', before });
      const { code, output } = await runCommand(cmd);
      if (code !== 0) {
        return fail('failed', output.split('\n').slice(0, 8).join('\n') || `exit code ${code}`);
      }

      const after = await getVersionAfter(agent);
      const changed = after !== null && before !== after;
      const status = changed ? 'updated' : 'up-to-date';
      onProgress?.(index, { state: 'success', before, after });
      return { agent, status, before, after };
    }),
  );
  return results;
}
