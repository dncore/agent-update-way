import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './update.js';
import type { SkillInfo, SkillsInfo } from './types.js';

/**
 * Local skills support.
 *
 * Skills are plain directories (SKILL.md + assets). Claude Code reads them
 * from `~/.claude/skills/*`, which on many setups is a set of symlinks into
 * the cross-agent `~/.agents/skills/*` tree. There is no official updater
 * and no recorded install provenance, so the honest rule is:
 *
 * - a skill that IS a git clone has a real source → updated via
 *   `git pull --ff-only` (exactly how it was installed);
 * - a plain copied directory has no source to update from → reported as
 *   "no update source" and skipped. We never guess an origin.
 */

/** Scan one skills root and yield its entries (dirs or symlinks to dirs). */
function scanRoot(root: string): SkillInfo[] {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const dir = join(root, name);
    let real: string;
    try {
      // resolve symlink chains (~/.claude/skills/x → ~/.agents/skills/x)
      real = realpathSync(dir);
    } catch {
      continue; // dangling symlink
    }
    if (!isDirectory(real)) continue;
    out.push(buildSkill(name, real));
  }
  return out;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Classify one skill directory (git clone vs plain copy) and read its rev. */
export function buildSkill(name: string, realDir: string): SkillInfo {
  const isGit = existsSync(join(realDir, '.git'));
  return {
    name,
    path: realDir,
    source: isGit ? 'git' : 'plain',
    rev: isGit ? gitShortRev(realDir) : null,
  };
}

/** Short HEAD rev of a git clone, or null. */
function gitShortRev(dir: string): string | null {
  try {
    return (
      execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export interface SkillsOptions {
  /** Override home dir (tests). */
  home?: string;
}

/**
 * Detect locally installed skills: union of `~/.claude/skills/*` and
 * `~/.agents/skills/*`, deduplicated by real path (the claude tree is often
 * a symlink view of the .agents tree).
 */
export function detectSkills(opts: SkillsOptions = {}): SkillsInfo {
  const home = opts.home ?? homedir();
  const byReal = new Map<string, SkillInfo>();
  for (const root of [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')]) {
    for (const s of scanRoot(root)) {
      if (!byReal.has(s.path)) byReal.set(s.path, s);
    }
  }
  const skills = [...byReal.values()].sort((a, b) => a.name.localeCompare(b.name));
  const gitCount = skills.filter((s) => s.source === 'git').length;
  const total = skills.length;
  const plainCount = total - gitCount;
  return {
    skills,
    total,
    gitCount,
    plainCount,
    summary:
      total === 0
        ? 'no skills found'
        : `${total} skill${total === 1 ? '' : 's'} (${gitCount} git, ${plainCount} no update source)`,
  };
}

/** One-line status for the aggregate renderer row. */
export function skillsStatusLine(info: SkillsInfo, updated?: number): string {
  if (!info.total) return '0 skills';
  const base = `${info.total} skill${info.total === 1 ? '' : 's'} · ${info.gitCount} git`;
  return updated && updated > 0 ? `${base} · ${updated} updated` : base;
}

export interface UpdateSkillsResult {
  code: number;
  output: string;
  /** How many git skills moved to a new HEAD. */
  updated: number;
}

/**
 * Update git-backed skills via `git pull --ff-only` (in parallel — each clone
 * is independent). Plain-copy skills are skipped: without provenance there is
 * nothing to update from, and guessing an origin is exactly what auway
 * refuses to do.
 */
export async function updateSkills(info: SkillsInfo, timeoutMs = 120_000): Promise<UpdateSkillsResult> {
  const gitSkills = info.skills.filter((s) => s.source === 'git');
  if (!gitSkills.length) {
    return {
      code: 0,
      output: info.plainCount
        ? `no git-backed skills (${info.plainCount} have no update source)`
        : 'no skills',
      updated: 0,
    };
  }

  const errors: string[] = [];
  let updated = 0;
  await Promise.all(
    gitSkills.map(async (s) => {
      const before = s.rev;
      const pull = await runCommand(['git', '-C', s.path, 'pull', '--ff-only'], timeoutMs);
      if (pull.code !== 0) {
        errors.push(`${s.name}: ${(pull.output.split('\n')[0] ?? '').trim() || `exit code ${pull.code}`}`);
        return;
      }
      const after = gitShortRev(s.path);
      if (before && after && before !== after) updated++;
    }),
  );

  return errors.length
    ? { code: 1, output: errors.join('\n'), updated }
    : { code: 0, output: `${gitSkills.length} git skill(s) checked`, updated };
}
