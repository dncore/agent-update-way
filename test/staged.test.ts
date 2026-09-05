import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, installPackageStaged } from '../src/update.js';
import type { DetectedAgent } from '../src/types.js';

/** Full staged install against the real npm registry (no locked files). */
describe('installPackageStaged (integration)', () => {
  it('packs, swaps and installs a newer version into targetDir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'auway-staged-it-'));
    try {
      // 1. install an old version under a fake node root
      const old = await runCommand(['npm', 'install', '--prefix', root, 'is-number@5.0.0'], 120_000);
      expect(old.code).toBe(0);

      const targetDir = join(root, 'node_modules', 'is-number');
      expect(existsSync(join(targetDir, 'package.json'))).toBe(true);

      const agent = {
        def: {
          name: 'test-agent',
          label: 'Test Agent',
          nativeUpdate: [],
          versionCmd: ['node', '-e', ''],
          npmPackage: 'is-number',
        },
        binPath: join(root, 'bin', 'test-agent'),
        realPath: join(targetDir, 'index.js'),
        manager: 'npm',
        managerTarget: 'is-number',
        nodeRoot: root,
        version: '5.0.0',
      } as DetectedAgent;

      const getVersion = async (): Promise<string | null> => {
        const p = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8')) as { version?: string };
        return p.version ?? null;
      };

      // 2. staged update to latest
      const result = await installPackageStaged(targetDir, agent, getVersion);

      // Directory-level checks
      expect(result.status).toBe('updated');
      expect(result.before).toBe('5.0.0');
      expect(result.after).toMatch(/^\d+\.\d+\.\d+$/);
      expect(existsSync(join(targetDir, 'package.json'))).toBe(true);
      // old version dir swapped away (kept until cleanup) then removed
      expect(existsSync(`${targetDir}.auway.bak`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});