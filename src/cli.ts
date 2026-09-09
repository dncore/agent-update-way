#!/usr/bin/env node
import { detectAllAsync, managerLabel } from './detect.js';
import { updateAgents, createSettleGate } from './update.js';
import { detectPiExtensions, updatePiExtensions, extensionsStatusLine } from './pi-extensions.js';
import {
  detectClaudePlugins,
  detectCodexPlugins,
  detectGrokPlugins,
  updateClaudePlugins,
  updateCodexPlugins,
  updateGrokPlugins,
  pluginsStatusLine,
  countUpdated,
} from './agent-plugins.js';
import { detectSkills, updateSkills, skillsStatusLine } from './skills.js';
import type { AgentPluginsInfo, PiExtensionsInfo } from './types.js';
import { createRenderer, createSpinner, color } from './render.js';
import type { Renderer } from './render.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = getVersion();

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const isTTY = process.stdout.isTTY && !process.env.CI;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/* ---------- ecosystem tasks (extensions / plugins / skills) ---------- */

/** Is the named agent among the detected agents? */
function agentInstalled(agents: { def: { name: string } }[], name: string): boolean {
  return agents.some((a) => a.def.name === name);
}

function printPiExtensions(ext: PiExtensionsInfo): void {
  if (!ext.total) {
    console.log(color.dim('Pi Extensions: none installed'));
    return;
  }
  console.log(
    color.bold(
      `Pi Extensions (${ext.total} package${ext.total === 1 ? '' : 's'}, ` +
        (ext.outdatedCount
          ? `${ext.outdatedCount} update${ext.outdatedCount === 1 ? '' : 's'} available):`
          : 'all up to date):'),
    ),
  );
  for (const p of ext.packages) {
    let ver: string;
    let tag: string;
    if (p.type === 'npm') {
      ver = p.outdated ? `${p.installed ?? '?'} → ${p.latest ?? '?'}` : (p.installed ?? '?');
      tag = p.pinned ? color.dim('pinned') : p.outdated ? color.yellow('update') : color.green('ok');
    } else {
      ver = p.installed ?? '?';
      tag = color.dim(p.type === 'git' ? `git${p.pinned ? ' (pinned)' : ''}` : 'local');
    }
    console.log(`  ${pad(p.name, 32)} ${pad(ver, 16)}${tag}`);
  }
}

function printAgentPlugins(title: string, info: AgentPluginsInfo): void {
  if (!info.total) {
    console.log(color.dim(`${title}: none installed`));
    return;
  }
  console.log(color.bold(`${title} (${info.total}):`));
  for (const p of info.plugins) {
    console.log(`  ${pad(p.id, 44)} ${pad(p.version ?? '?', 16)}${p.enabled ? '' : color.dim(' (disabled)')}`);
  }
}

/**
 * Run the aggregate "Pi Extensions" task inside the update panel: detect,
 * run `pi update --extensions`, re-detect, report. Even when pi itself is up
 * to date, extensions are checked and updated (git refs are reconciled too).
 */
async function runPiExtensionsTask(renderer: Renderer, index: number): Promise<void> {
  const before = await detectPiExtensions();
  if (!before.total) {
    renderer.update(index, {
      state: 'skipped',
      before: null,
      after: null,
      error: 'no pi extensions installed',
    });
    return;
  }
  renderer.update(index, { state: 'running', before: extensionsStatusLine(before) });
  const { code, output } = await updatePiExtensions();
  if (code !== 0) {
    renderer.update(index, {
      state: 'failed',
      before: extensionsStatusLine(before),
      after: extensionsStatusLine(before),
      error: output.split('\n').slice(0, 8).join('\n') || `exit code ${code}`,
    });
    return;
  }
  const after = await detectPiExtensions();
  renderer.update(index, {
    state: 'success',
    before: extensionsStatusLine(before),
    after: extensionsStatusLine(after),
  });
}

/** Generic plugin-task runner: detect → update via the agent's own flow → re-detect. */
async function runPluginsTask(
  renderer: Renderer,
  index: number,
  label: string,
  detect: () => Promise<AgentPluginsInfo>,
  update: (plugins: AgentPluginsInfo['plugins']) => Promise<{ code: number; output: string }>,
): Promise<void> {
  const before = await detect();
  if (!before.total) {
    renderer.update(index, {
      state: 'skipped',
      before: null,
      after: null,
      error: `no ${label.toLowerCase()} installed`,
    });
    return;
  }
  renderer.update(index, { state: 'running', before: pluginsStatusLine(before) });
  const { code, output } = await update(before.plugins);
  if (code !== 0) {
    renderer.update(index, {
      state: 'failed',
      before: pluginsStatusLine(before),
      after: pluginsStatusLine(before),
      error: output.split('\n').slice(0, 8).join('\n') || `exit code ${code}`,
    });
    return;
  }
  const after = await detect();
  renderer.update(index, {
    state: 'success',
    before: pluginsStatusLine(before),
    after: pluginsStatusLine(after, countUpdated(before, after)),
  });
}

/** Skills task: git-backed skills are pulled; source-less copies are reported. */
async function runSkillsTask(renderer: Renderer, index: number): Promise<void> {
  const before = detectSkills();
  if (!before.total) {
    renderer.update(index, {
      state: 'skipped',
      before: null,
      after: null,
      error: 'no skills found',
    });
    return;
  }
  renderer.update(index, { state: 'running', before: skillsStatusLine(before) });
  const { code, output, updated } = await updateSkills(before);
  if (code !== 0) {
    renderer.update(index, {
      state: 'failed',
      before: skillsStatusLine(before),
      after: skillsStatusLine(before),
      error: output.split('\n').slice(0, 8).join('\n') || `exit code ${code}`,
    });
    return;
  }
  const after = detectSkills();
  renderer.update(index, {
    state: 'success',
    before: skillsStatusLine(before),
    after: skillsStatusLine(after, updated),
  });
}

/* ---------- commands ---------- */

async function cmdList(): Promise<void> {
  const spinner = createSpinner('Detecting AI agents');
  const agents = await detectAllAsync();
  spinner.done(`Detected ${agents.length} agent(s)`);
  if (!agents.length) {
    console.log(color.yellow('No known AI agents found in PATH.'));
    console.log(
      color.dim(
        'Known agents: ' +
          ['pi', 'claude', 'opencode', 'codex', 'copilot', 'cursor-agent', 'agy', 'grok'].join(', '),
      ),
    );
    return;
  }

  console.log(color.bold(`${agents.length} agent(s) detected:\n`));
  console.log(color.dim(pad('AGENT', 22) + pad('VERSION', 14) + pad('MANAGER', 14) + 'PATH'));
  for (const a of agents) {
    const name = a.manager === 'local' ? color.yellow(`${a.def.label} (skip)`) : a.def.label;
    const ver = a.version ?? '?';
    const mgr =
      a.manager === 'local' ? color.yellow(managerLabel(a.manager)) : color.cyan(managerLabel(a.manager));
    const path = a.manager === 'local' ? color.dim(a.realPath) : a.realPath;
    console.log(pad(name, 22) + pad(ver, 14) + pad(mgr, 14) + path);
    if (a.manager === 'local') {
      console.log('  ' + color.yellow(`  ${a.skipReason ?? ''}`));
    }
  }

  if (agentInstalled(agents, 'pi')) {
    console.log('');
    printPiExtensions(await detectPiExtensions());
  }
  if (agentInstalled(agents, 'claude')) {
    console.log('');
    printAgentPlugins('Claude Plugins', await detectClaudePlugins());
  }
  if (agentInstalled(agents, 'codex')) {
    console.log('');
    printAgentPlugins('Codex Plugins', await detectCodexPlugins());
  }
  if (agentInstalled(agents, 'grok')) {
    console.log('');
    printAgentPlugins('Grok Plugins', await detectGrokPlugins());
  }

  const skills = detectSkills();
  if (skills.total) {
    console.log('');
    console.log(color.bold(`Skills (${skills.summary}):`));
    const gitSkills = skills.skills.filter((s) => s.source === 'git');
    for (const s of gitSkills) {
      console.log(`  ${pad(s.name, 32)} ${pad(s.rev ?? '?', 12)}${color.green('ok')}`);
    }
    if (!gitSkills.length) {
      console.log(color.dim('  (no git-backed skills; plain copies have no update source)'));
    }
  }
}

async function cmdUpdate(targets: string[]): Promise<void> {
  const spinner = createSpinner('Detecting AI agents');
  const t0 = Date.now();
  const allDetected = await detectAllAsync();
  spinner.done(`Detected ${allDetected.length} agent(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  let agents = allDetected;
  if (targets.length) {
    const names = new Set(targets);
    const unknown = targets.filter((t) => !agents.some((a) => a.def.name === t));
    if (unknown.length) {
      console.log(color.yellow(`not installed: ${unknown.join(', ')}`));
    }
    agents = agents.filter((a) => names.has(a.def.name));
    if (!agents.length) {
      console.log(color.yellow('Nothing to update.'));
      return;
    }
  }

  // Ecosystem tasks run alongside their host agent — always on a full run
  // (even when the agent itself is up to date), and on scoped runs only when
  // the scope includes the host (pi precedent). Skills are host-less and only
  // run on full updates.
  interface ExtraTask {
    label: string;
    /** Host agent whose own update must settle before this task spawns it. */
    host?: string;
    run: (renderer: Renderer, index: number) => Promise<void>;
  }
  const inScope = (host: string): boolean =>
    targets.length === 0 || targets.includes(host);
  const extraTasks: ExtraTask[] = [];
  if (agentInstalled(allDetected, 'pi') && inScope('pi')) {
    extraTasks.push({ label: 'Pi Extensions', host: 'pi', run: runPiExtensionsTask });
  }
  if (agentInstalled(allDetected, 'claude') && inScope('claude')) {
    extraTasks.push({
      label: 'Claude Plugins',
      host: 'claude',
      run: (r, i) => runPluginsTask(r, i, 'Claude Plugins', detectClaudePlugins, updateClaudePlugins),
    });
  }
  if (agentInstalled(allDetected, 'codex') && inScope('codex')) {
    extraTasks.push({
      label: 'Codex Plugins',
      host: 'codex',
      run: (r, i) => runPluginsTask(r, i, 'Codex Plugins', detectCodexPlugins, updateCodexPlugins),
    });
  }
  if (agentInstalled(allDetected, 'grok') && inScope('grok')) {
    extraTasks.push({
      label: 'Grok Plugins',
      host: 'grok',
      run: (r, i) =>
        runPluginsTask(r, i, 'Grok Plugins', detectGrokPlugins, () => updateGrokPlugins()),
    });
  }
  if (targets.length === 0 && detectSkills().total > 0) {
    extraTasks.push({ label: 'Skills', run: runSkillsTask });
  }

  const itemCount = agents.length + extraTasks.length;

  console.log(color.bold(`Updating ${itemCount} item(s) concurrently...\n`));
  const renderer = createRenderer({ tty: isTTY });
  agents.forEach((a) => renderer.add(a.def.label));
  const taskIndices = extraTasks.map((t) => renderer.add(t.label));

  // Race fix: an ecosystem task spawns its host agent's CLI while the host's
  // own update (npm update -g / native self-update) may be swapping the bin
  // symlink — spawning inside that window fails with ENOENT. Each task's
  // settle gate holds it until the host's terminal event, which fires only
  // after the post-update version re-check, so the binary is verifiably back
  // on PATH before we spawn it.
  const gates = extraTasks.map((t) => createSettleGate(t.host && agentInstalled(agents, t.host) ? t.host : undefined));

  // Agent self-updates download large binaries (claude ~150MB+); 300s was
  // observed killing `claude update` mid-install behind a proxy, so the
  // default budget is 10min. Override: AUWAY_TIMEOUT_MS=900000 auway
  const timeoutMs = Number(process.env.AUWAY_TIMEOUT_MS) || 600_000;

  await Promise.all([
    updateAgents(agents, {
      onProgress: (index, update) => {
        renderer.update(index, update);
        for (const g of gates) g.observe(index, agents[index]?.def.name, update);
      },
      timeoutMs,
    }),
    ...extraTasks.map((t, i) => (async () => {
      await gates[i]!.settled;
      await t.run(renderer, taskIndices[i]!);
    })()),
  ]);

  const summary = renderer.stop();
  console.log('\n' + summary);
}

function cmdHelp(): void {
  console.log(`auway v${VERSION} - update all your AI coding agents

Usage:
  auway                      update all detected agents
  auway update [agents...]   update all, or only the named agents
  auway list                 list detected agents (version, manager, path)
  auway --version            print version
  auway --help               print this help

Agents: pi, claude, opencode, codex, copilot, cursor-agent, agy, grok

auway updates each agent via the install manager that provides it:
  npm global → npm update -g <pkg>   brew → brew upgrade <formula>
  pnpm/bun   → add -g <pkg>          native → <agent> update

Ecosystem tasks (run alongside their host agent, every full update):
  Pi Extensions    pi update --extensions
  Claude Plugins   claude plugin marketplace update + claude plugin update <id> -y
  Codex Plugins    codex plugin marketplace upgrade + codex plugin add <id> (no
                   per-plugin update command exists; re-add pulls the latest)
  Grok Plugins     grok plugin update (all installed)
  Skills           git-backed skill dirs get git pull --ff-only; plain copies
                   have no recorded source and are reported, never guessed

Scoped updates like 'auway update claude' cover that agent's ecosystem tasks
only (claude → its plugins); skills run on full updates.

Environment:
  AUWAY_TIMEOUT_MS   per-command timeout in ms (default 600000). Raise it for
                     slow networks: AUWAY_TIMEOUT_MS=900000 auway

Project-local node_modules installs are always skipped.`);
}

/* ---------- entry ---------- */

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    await cmdUpdate([]);
    return;
  }
  switch (args[0]) {
    case 'list':
    case 'ls':
      await cmdList();
      return;
    case 'update':
    case 'up':
      await cmdUpdate(args.slice(1));
      return;
    case '--version':
    case '-v':
      console.log(VERSION);
      return;
    case '--help':
    case '-h':
    case 'help':
      cmdHelp();
      return;
    default:
      console.log(color.red(`Unknown command: ${args[0]}`));
      cmdHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(color.red(`auway error: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
