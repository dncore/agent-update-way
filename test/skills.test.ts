import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectSkills, skillsStatusLine, updateSkills, buildSkill } from '../src/skills.js';
import { runCommand } from '../src/update.js';

// updateSkills spawns git via runCommand — mock it; detection itself is pure fs.
vi.mock('../src/update.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/update.js')>();
  return { ...mod, runCommand: vi.fn() };
});

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'auway-skills-test-'));
}

function makeSkill(root: string, name: string, git = false): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`);
  if (git) {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  }
  return dir;
}

beforeEach(() => {
  vi.mocked(runCommand).mockReset();
});

describe('detectSkills', () => {
  it('scans .claude and .agents roots, dedupes symlinks by real path, classifies git vs plain', () => {
    const home = tempHome();
    const agentsRoot = join(home, '.agents', 'skills');
    const claudeRoot = join(home, '.claude', 'skills');
    makeSkill(agentsRoot, 'plain-one');
    const gitDir = makeSkill(agentsRoot, 'git-one', true);
    mkdirSync(claudeRoot, { recursive: true });
    // claude view: symlink to the same plain skill + a claude-only plain skill
    symlinkSync(join(agentsRoot, 'plain-one'), join(claudeRoot, 'plain-one'));
    makeSkill(claudeRoot, 'claude-only');

    const info = detectSkills({ home });
    expect(info.total).toBe(3); // plain-one counted once
    expect(info.gitCount).toBe(1);
    expect(info.plainCount).toBe(2);
    const git = info.skills.find((s) => s.name === 'git-one')!;
    expect(git.source).toBe('git');
    expect(git.rev).toMatch(/^[0-9a-f]{7,}$/);
    expect(git.path).toBe(realpathSync(gitDir)); // realpath canonicalizes (/var → /private/var on macOS)
    rmSync(home, { recursive: true, force: true });
  });

  it('skips dangling symlinks and missing roots', () => {
    const home = tempHome();
    const claudeRoot = join(home, '.claude', 'skills');
    mkdirSync(claudeRoot, { recursive: true });
    symlinkSync(join(home, '.agents', 'skills', 'nope'), join(claudeRoot, 'dangling'));
    const info = detectSkills({ home });
    expect(info.total).toBe(0);
    expect(info.summary).toBe('no skills found');
    rmSync(home, { recursive: true, force: true });
  });
});

describe('buildSkill', () => {
  it('marks a dir with .git as git even when rev is unreadable', () => {
    const home = tempHome();
    const dir = join(home, 'fake-git');
    mkdirSync(join(dir, '.git'), { recursive: true });
    const s = buildSkill('fake-git', dir);
    expect(s.source).toBe('git');
    expect(s.rev).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});

describe('skillsStatusLine', () => {
  it('formats totals and updates', () => {
    const info = { skills: [], total: 52, gitCount: 0, plainCount: 52, summary: '' };
    expect(skillsStatusLine(info)).toBe('52 skills · 0 git');
    expect(skillsStatusLine(info, 3)).toBe('52 skills · 0 git · 3 updated');
    expect(skillsStatusLine({ skills: [], total: 0, gitCount: 0, plainCount: 0, summary: '' })).toBe(
      '0 skills',
    );
  });
});

describe('updateSkills', () => {
  it('reports honestly when no git-backed skills exist', async () => {
    const info = { skills: [], total: 5, gitCount: 0, plainCount: 5, summary: '' };
    const r = await updateSkills(info);
    expect(r.code).toBe(0);
    expect(r.updated).toBe(0);
    expect(r.output).toContain('no git-backed skills');
    expect(r.output).toContain('5 have no update source');
    expect(vi.mocked(runCommand)).not.toHaveBeenCalled();
  });

  it('pulls every git skill with --ff-only and counts rev changes', async () => {
    const home = tempHome();
    const gitDir = makeSkill(join(home, '.agents', 'skills'), 'git-one', true);
    const info = detectSkills({ home });
    // simulate a successful pull that moves HEAD: report same rev → 0 updated
    vi.mocked(runCommand).mockResolvedValue({ code: 0, output: 'Already up to date.', stdout: '', stderr: '' });
    const r = await updateSkills(info);
    expect(r.code).toBe(0);
    expect(vi.mocked(runCommand).mock.calls[0]![0]).toEqual([
      'git',
      '-C',
      realpathSync(gitDir),
      'pull',
      '--ff-only',
    ]);
    expect(r.updated).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  it('aggregates pull failures per skill', async () => {
    const home = tempHome();
    makeSkill(join(home, '.agents', 'skills'), 'git-one', true);
    const info = detectSkills({ home });
    vi.mocked(runCommand).mockResolvedValue({ code: 128, output: 'fatal: not possible to fast-forward', stdout: '', stderr: '' });
    const r = await updateSkills(info);
    expect(r.code).toBe(1);
    expect(r.output).toContain('git-one:');
    rmSync(home, { recursive: true, force: true });
  });
});
