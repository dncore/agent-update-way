#!/usr/bin/env node
import { detectAllAsync, managerLabel } from './detect.js';
import { updateAgents } from './update.js';
import { detectPiExtensions, updatePiExtensions, extensionsStatusLine } from './pi-extensions.js';
import type { PiExtensionsInfo } from './types.js';
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

/* ---------- pi extensions (list + update helpers) ---------- */

/** Is pi among the detected agents? */
function piInstalled(agents: { def: { name: string } }[]): boolean {
  return agents.some((a) => a.def.name === 'pi');
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

/* ---------- commands ---------- */

async function cmdList(): Promise<void> {
  const spinner = createSpinner('Detecting AI agents');
  const agents = await detectAllAsync();
  spinner.done(`Detected ${agents.length} agent(s)`);
  if (!agents.length) {
    console.log(color.yellow('No known AI agents found in PATH.'));
    console.log(
      color.dim(
        'Known agents: ' + ['pi', 'claude', 'opencode', 'codex', 'copilot', 'cursor-agent', 'agy'].join(', '),
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

  if (piInstalled(agents)) {
    console.log('');
    printPiExtensions(await detectPiExtensions());
  }
}

async function cmdUpdate(targets: string[]): Promise<void> {
  const spinner = createSpinner('Detecting AI agents');
  const t0 = Date.now();
  let agents = await detectAllAsync();
  spinner.done(`Detected ${agents.length} agent(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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

  // pi extensions are checked & updated alongside pi: always when pi is
  // installed (even if pi itself is up to date), unless the user scoped the
  // update to specific agents that exclude pi.
  const withExtensions = piInstalled(agents) && (targets.length === 0 || targets.includes('pi'));
  const itemCount = agents.length + (withExtensions ? 1 : 0);

  console.log(color.bold(`Updating ${itemCount} item(s) concurrently...\n`));
  const renderer = createRenderer({ tty: isTTY });
  agents.forEach((a) => renderer.add(a.def.label));
  let extIndex = -1;
  if (withExtensions) extIndex = renderer.add('Pi Extensions');

  await Promise.all([
    updateAgents(agents, {
      onProgress: (index, update) => renderer.update(index, update),
    }),
    withExtensions ? runPiExtensionsTask(renderer, extIndex) : Promise.resolve(),
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

Agents: pi, claude, opencode, codex, copilot, cursor-agent, agy

auway updates each agent via the install manager that provides it:
  npm global → npm update -g <pkg>   brew → brew upgrade <formula>
  pnpm/bun   → add -g <pkg>          native → <agent> update

Pi Extensions: when pi is installed, auway also detects and updates pi's
  extension packages (every run, even if pi itself is up to date) via
  pi update --extensions. Pinned npm versions are skipped, git refs reconciled.
  Scoped updates like 'auway update claude' leave pi extensions untouched.

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
