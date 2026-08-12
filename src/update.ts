import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
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

/** Run one command, capturing combined output. Resolves even on non-zero exit. */
function runCommand(cmd: string[], timeoutMs = 300_000): Promise<{ code: number; output: string }> {
  const [bin, ...args] = cmd;
  return new Promise((resolve) => {
    if (!bin) {
      resolve({ code: 1, output: 'empty command' });
      return;
    }
    execFile(
      bin,
      args,
      { timeout: timeoutMs, encoding: 'utf8' },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (error) {
          resolve({ code: typeof error.code === 'number' ? error.code : 1, output });
        } else {
          resolve({ code: 0, output });
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
      const cmd = buildUpdateCommand(agent);

      const fail = (status: 'failed' | 'skipped', error: string): UpdateResult => {
        onProgress?.(index, { state: status, before, after: before, error });
        return { agent, status, before, after: before, error };
      };

      if (agent.manager === 'local') {
        return fail('skipped', agent.skipReason ?? 'project-local install');
      }
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
